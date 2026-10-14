import { Worker } from 'node:worker_threads';
import { id, now, fail, category } from './core.mjs';

export class PostgresStore {
  constructor(config) {
    this.config = config; this.schema = `"${config.databaseSchema}"`; this.metadata = `"${config.metadataSchema}"`;
    this.worker = new Worker(new URL('./pg-worker.mjs', import.meta.url), { execArgv: [], workerData: { url: config.databaseUrl, fixture: config.testFixture } });
    this.control = new SharedArrayBuffer(8); this.output = new SharedArrayBuffer(32 * 1024 * 1024);
    this.worker.unref();
    if (config.databaseLayout !== 'native') {
      const columns = this.query('SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1', [config.databaseSchema]);
      const detected = columns.some(c => c.table_name === 'files' && c.column_name === 'kind') ? 'v2' : 'legacy';
      if (config.databaseLayout === 'auto') config.databaseLayout = detected;
      if (config.databaseLayout === 'v2') {
        for (const [table, required] of Object.entries({ files: ['kind', 'encryption', 'encryption_key_version', 'generation', 'mod_time', 'user_id'], file_parts: ['file_id', 'part_no', 'channel_id', 'message_id', 'salt'], users: ['user_id', 'display_name', 'username', 'premium', 'role', 'disabled_at'], channels: ['channel_id', 'user_id', 'name', 'selected'] })) {
          if (required.some(column => !columns.some(c => c.table_name === table && c.column_name === column))) { this.close(); throw new Error(`Unsupported v2 schema: ${table}`); }
        }
        this.normalizedNames = columns.some(c => c.table_name === 'files' && c.column_name === 'normalized_name');
      } else {
      for (const [table, required] of Object.entries({ files: ['id', 'name', 'type', 'mime_type', 'user_id', 'parent_id', 'status', 'parts', 'encrypted', 'size', 'channel_id', 'created_at', 'updated_at'], users: ['user_id', 'name', 'user_name', 'is_premium'], channels: ['channel_id', 'channel_name', 'user_id', 'selected'] })) {
        if (required.some(column => !columns.some(c => c.table_name === table && c.column_name === column))) { this.close(); throw new Error(`Unsupported legacy schema: ${table}. Use the fully migrated main-branch database, or gateway mode for v2`); }
      }
      if (!columns.some(c => c.table_name === 'files' && c.column_name === 'id' && c.data_type === 'uuid')) { this.close(); throw new Error('Legacy schema must have UUID file IDs (2024 migration or later)'); }
      this.hasHash = columns.some(c => c.table_name === 'files' && c.column_name === 'hash');
      }
    }
    this.query(`CREATE SCHEMA IF NOT EXISTS ${this.metadata}; CREATE TABLE IF NOT EXISTS ${this.metadata}.records (bucket text NOT NULL,id text NOT NULL,owner text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(bucket,id)); CREATE INDEX IF NOT EXISTS records_owner_idx ON ${this.metadata}.records(bucket,owner);`);
  }
  query(sql, values = []) {
    const control = this.control, output = this.output, flags = new Int32Array(control); Atomics.store(flags, 0, 0);
    this.worker.postMessage({ sql, values, control, output });
    if (Atomics.wait(flags, 0, 0, 35000) === 'timed-out') { this.worker.terminate(); fail(503, 'postgres_timeout'); }
    const response = JSON.parse(Buffer.from(output, 0, Atomics.load(flags, 1)).toString());
    if (response.error) { const error = Object.assign(new Error(response.error.message), response.error); if (response.error.code === '23505') { error.status = 409; error.code = 'name_conflict'; } throw error; }
    return response.rows;
  }
  ready() { this.query('SELECT 1'); }
  rawGet(bucket, key) { return this.query(`SELECT body FROM ${this.metadata}.records WHERE bucket=$1 AND id=$2`, [bucket, String(key)])[0]?.body; }
  rawPut(bucket, value, owner = value.ownerId ?? value.userId ?? '') { this.query(`INSERT INTO ${this.metadata}.records VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(bucket,id) DO UPDATE SET owner=excluded.owner,body=excluded.body`, [bucket, bucket === 'channels' ? `${owner}:${value.id}` : String(value.id), String(owner), JSON.stringify(value)]); return value; }
  legacy() { return this.config.databaseLayout === 'legacy'; }
  v2() { return this.config.databaseLayout === 'v2'; }
  existing() { return this.legacy() || this.v2(); }
  root(userId) {
    const roots = this.query(`SELECT id FROM ${this.schema}.files WHERE user_id=$1 AND parent_id IS NULL AND type='folder'`, [userId]);
    if (roots.length > 1) fail(409, 'ambiguous_legacy_root');
    return roots[0]?.id;
  }
  file(row, root) {
    const extra = row.node_meta || {}, legacyParts = row.parts || [];
    if (this.v2()) return { ...extra, hash: row.hash_algorithm ? { algorithm: row.hash_algorithm, value: row.hash_value } : extra.hash, id: row.id, ownerId: String(row.user_id), parentId: row.parent_id || undefined, name: row.name, kind: row.kind, mimeType: row.mime_type, size: row.kind === 'file' ? Number(row.size || 0) : undefined, status: row.status, encryption: row.encryption, encryptionKeyVersion: row.encryption_key_version, generation: Number(row.generation), modTime: new Date(row.mod_time).toISOString(), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), parts: (row.stored_parts || []).map(p => ({ backend: 'telegram', legacy: true, channelId: String(p.channel_id), messageId: Number(p.message_id), legacySalt: p.salt || undefined, encryptionKeyVersion: row.encryption_key_version, partNo: p.part_no, size: p.stored_size === null ? undefined : Number(p.stored_size), plainSize: p.plain_size === null ? undefined : Number(p.plain_size), checksum: p.checksum })) };
    const same = extra.parts?.length === legacyParts.length && legacyParts.every((p, index) => String(p.id) === String(extra.parts[index].messageId) && String(row.channel_id) === String(extra.parts[index].channelId));
    return { ...extra, id: row.id, ownerId: String(row.user_id), parentId: row.parent_id === root ? undefined : row.parent_id || undefined, name: row.name, kind: row.type, mimeType: row.mime_type, size: row.type === 'file' ? Number(row.size || 0) : undefined, status: row.status === 'pending_deletion' ? 'deletion_pending' : row.status, encryption: row.encrypted, generation: Date.parse(row.updated_at), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), modTime: extra.modTime || new Date(row.updated_at).toISOString(), parts: same ? extra.parts : legacyParts.map((p, index) => ({ backend: 'telegram', legacy: true, channelId: String(row.channel_id), messageId: Number(p.id), legacySalt: p.salt, partNo: index + 1, encryption: row.encrypted })), _legacyRoot: row.id === root };
  }
  user(row) { return { ...row.node_meta, id: String(row.user_id), userId: String(row.user_id), displayName: this.v2() ? row.display_name : row.name, username: this.v2() ? row.username : row.user_name, premium: this.v2() ? row.premium : row.is_premium, disabled: this.v2() ? !!row.disabled_at : !!row.node_meta?.disabled, role: this.v2() ? row.role : row.node_meta?.role || (String(row.user_id) === this.config.ownerUserId ? 'owner' : 'user'), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
  bot(row) {
    const hex = value => !value ? undefined : typeof value === 'string' ? value.replace(/^\\x/, '') : Buffer.from(value.data || value).toString('hex');
    return { id: String(row.bot_id), ownerId: String(row.user_id), username: row.username, enabled: row.enabled, tokenCiphertext: hex(row.token_ciphertext), sessionCiphertext: hex(row.session), createdAt: new Date(row.created_at).toISOString() };
  }
  selectFiles(where = '', values = []) {
    const parts = this.v2() ? `,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.part_no) FROM ${this.schema}.file_parts p WHERE p.file_id=f.id),'[]'::jsonb) AS stored_parts` : '';
    const rows = this.query(`SELECT f.*,n.body AS node_meta${parts} FROM ${this.schema}.files f LEFT JOIN ${this.metadata}.records n ON n.bucket='files' AND n.id=f.id::text ${where} ORDER BY f.id`, values);
    const roots = new Map(this.legacy() ? rows.filter(r => r.parent_id === null && r.type === 'folder').map(r => [String(r.user_id), r.id]) : []);
    return rows.map(row => this.file(row, this.legacy() ? roots.get(String(row.user_id)) || this.root(row.user_id) : undefined));
  }
  get(bucket, key) {
    if (this.v2() && bucket === 'bots') { const row = this.query(`SELECT * FROM ${this.schema}.bots WHERE bot_id=$1`, [key])[0]; return row && this.bot(row); }
    if (this.existing() && bucket === 'files') return this.selectFiles('WHERE f.id=$1::uuid', [key])[0];
    if (this.existing() && bucket === 'users') { const row = this.query(`SELECT u.*,n.body AS node_meta FROM ${this.schema}.users u LEFT JOIN ${this.metadata}.records n ON n.bucket='users' AND n.id=u.user_id::text WHERE u.user_id=$1`, [key])[0]; return row && this.user(row); }
    return this.rawGet(bucket, key);
  }
  list(bucket, owner) {
    if (this.v2() && bucket === 'bots') return this.query(`SELECT * FROM ${this.schema}.bots${owner === undefined ? '' : ' WHERE user_id=$1'} ORDER BY bot_id`, owner === undefined ? [] : [owner]).map(row => this.bot(row));
    if (this.existing() && bucket === 'files') return this.selectFiles(owner === undefined ? '' : 'WHERE f.user_id=$1', owner === undefined ? [] : [owner]).filter(f => !f._legacyRoot);
    if (this.existing() && bucket === 'users') return this.query(`SELECT u.*,n.body AS node_meta FROM ${this.schema}.users u LEFT JOIN ${this.metadata}.records n ON n.bucket='users' AND n.id=u.user_id::text ORDER BY u.user_id`).map(r => this.user(r));
    if (this.existing() && bucket === 'channels') return this.query(`SELECT * FROM ${this.schema}.channels${owner === undefined ? '' : ' WHERE user_id=$1'}`, owner === undefined ? [] : [owner]).map(r => ({ id: String(r.channel_id), ownerId: String(r.user_id), name: this.v2() ? r.name : r.channel_name, selected: r.selected, health: r.health || 'unknown', createdAt: r.created_at ? new Date(r.created_at).toISOString() : now() }));
    return this.query(`SELECT body FROM ${this.metadata}.records WHERE bucket=$1${owner === undefined ? '' : ' AND owner=$2'} ORDER BY id`, owner === undefined ? [bucket] : [bucket, String(owner)]).map(r => r.body);
  }
  put(bucket, value, owner) {
    if (this.v2() && bucket === 'bots') {
      const rows = this.query(`INSERT INTO ${this.schema}.bots(bot_id,user_id,username,token_ciphertext,enabled,created_at,updated_at) VALUES($1,$2,$3,decode($4,'hex'),$5,$6,now()) ON CONFLICT(bot_id) DO UPDATE SET username=excluded.username,token_ciphertext=excluded.token_ciphertext,enabled=excluded.enabled,updated_at=now() WHERE ${this.schema}.bots.user_id=excluded.user_id RETURNING bot_id`, [value.id,value.ownerId,value.username,value.tokenCiphertext,value.enabled,value.createdAt]);
      if (!rows.length) fail(409, 'bot_already_registered'); return value;
    }
    if (this.v2() && ['files', 'users', 'channels'].includes(bucket)) return this.putV2(bucket, value, owner);
    if (this.legacy() && ['files', 'users', 'channels'].includes(bucket)) return this.transaction(() => {
      if (bucket === 'files') {
        value.generation = Date.parse(value.updatedAt);
        if (value.parts?.some(p => p.backend !== 'telegram' || p.encryptionId)) fail(422, 'incompatible_legacy_part', 'Use Telegram storage and the original encryption format');
        const channelIds = new Set((value.parts || []).map(p => p.channelId)); if (channelIds.size > 1) fail(422, 'legacy_file_requires_one_channel');
        const parentId = value.parentId || this.root(value.ownerId); if (!parentId && !value._legacyRoot) fail(409, 'legacy_root_missing');
        const parts = (value.parts || []).map(p => ({ id: p.messageId, ...(p.legacySalt ? { salt: p.legacySalt } : {}) }));
        this.query(`INSERT INTO ${this.schema}.files (id,name,type,mime_type,size,user_id,parent_id,status,channel_id,parts,encrypted,created_at,updated_at,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,status=excluded.status,updated_at=excluded.updated_at`, [value.id, value.name, value.kind, value.mimeType || 'drive/folder', value.size ?? null, value.ownerId, value._legacyRoot ? null : parentId, value.status === 'deletion_pending' ? 'pending_deletion' : value.status, [...channelIds][0] || null, value.kind === 'file' ? JSON.stringify(parts) : null, !!value.encryption, value.createdAt, value.updatedAt, value.kind === 'file' ? category(value) : null]);
      } else if (bucket === 'users') {
        this.query(`INSERT INTO ${this.schema}.users (user_id,name,user_name,is_premium,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,user_name=excluded.user_name,is_premium=excluded.is_premium,updated_at=excluded.updated_at`, [value.id, value.displayName || '', value.username || '', !!value.premium, value.createdAt, value.updatedAt]);
        if (!this.root(value.id)) this.query(`INSERT INTO ${this.schema}.files (id,name,type,mime_type,user_id,status,encrypted,created_at,updated_at) VALUES ($1,'root','folder','drive/folder',$2,'active',false,$3,$3)`, [id(), value.id, now()]);
      } else {
        this.query(`INSERT INTO ${this.schema}.channels (channel_id,channel_name,user_id,selected,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(channel_id) DO UPDATE SET channel_name=excluded.channel_name,selected=excluded.selected WHERE ${this.schema}.channels.user_id=excluded.user_id`, [value.id, value.name, value.ownerId, value.selected, value.createdAt]);
      }
      return this.rawPut(bucket, value, owner);
    });
    return this.rawPut(bucket, value, owner);
  }
  putV2(bucket, value, owner) {
    return this.transaction(() => {
      if (bucket === 'files') {
        if (value.parts?.some(p => p.backend !== 'telegram' || p.encryptionId)) fail(422, 'incompatible_v2_part');
        const columns = ['id','user_id','parent_id','name','kind','mime_type','size','encryption','encryption_key_version','status','mod_time','generation','created_at','updated_at','deleted_at','hash_algorithm','hash_value'];
        const values = [value.id,value.ownerId,value.parentId || null,value.name,value.kind,value.mimeType || null,value.size ?? null,!!value.encryption,value.encryption ? value.encryptionKeyVersion ?? this.config.encryptionKeyVersion : null,value.status,value.modTime,value.generation,value.createdAt,value.updatedAt,value.status === 'active' ? null : value.updatedAt,value.hash?.algorithm || null,value.hash?.value || null];
        if (this.normalizedNames) { columns.push('normalized_name'); values.push(value.name.toLowerCase()); }
        const rows = this.query(`INSERT INTO ${this.schema}.files (${columns.join(',')}) VALUES (${values.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,status=excluded.status,mod_time=excluded.mod_time,generation=excluded.generation,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at${this.normalizedNames ? ',normalized_name=excluded.normalized_name' : ''} RETURNING id`, values);
        for (const p of value.parts || []) this.query(`INSERT INTO ${this.schema}.file_parts (file_id,part_no,channel_id,message_id,plain_size,stored_size,checksum,salt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(file_id,part_no) DO NOTHING`, [rows[0].id,p.partNo,p.channelId,p.messageId,p.plainSize ?? null,p.size ?? null,p.checksum || null,p.legacySalt || null]);
      } else if (bucket === 'users') this.query(`INSERT INTO ${this.schema}.users (user_id,display_name,username,premium,role,disabled_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,premium=excluded.premium,role=excluded.role,disabled_at=excluded.disabled_at,updated_at=excluded.updated_at`, [value.id,value.displayName || null,value.username || null,!!value.premium,value.role,value.disabled ? now() : null,value.createdAt,value.updatedAt]);
      else this.query(`INSERT INTO ${this.schema}.channels (channel_id,user_id,name,selected,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(user_id,channel_id) DO UPDATE SET name=excluded.name,selected=excluded.selected,updated_at=excluded.updated_at`, [value.id,value.ownerId,value.name,value.selected,value.createdAt]);
      return this.rawPut(bucket, value, owner);
    });
  }
  delete(bucket, key, owner) {
    if (this.v2() && bucket === 'bots') { if (owner === undefined) fail(422, 'bot_owner_required'); this.query(`DELETE FROM ${this.schema}.bots WHERE bot_id=$1 AND user_id=$2`, [key,owner]); }
    if (this.existing() && bucket === 'files') this.query(`DELETE FROM ${this.schema}.files WHERE id=$1::uuid`, [key]);
    if (this.existing() && bucket === 'channels') { if (owner === undefined) fail(422, 'channel_owner_required'); this.query(`DELETE FROM ${this.schema}.channels WHERE channel_id=$1 AND user_id=$2`, [key, owner]); }
    this.query(`DELETE FROM ${this.metadata}.records WHERE bucket=$1 AND id=$2`, [bucket, bucket === 'channels' ? `${owner}:${key}` : String(key)]);
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.query('BEGIN'); this.inTransaction = true;
    try { const result = fn(); this.query('COMMIT'); return result; }
    catch (e) { this.query('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  close() { this.worker.terminate(); }
}

