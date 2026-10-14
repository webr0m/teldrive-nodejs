import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.mjs';
import { encryptLegacy, decryptLegacy, decryptLegacyRange, encryptedSize, plainSize } from '../src/legacy-crypto.mjs';
import { PostgresStore } from '../src/postgres.mjs';
import { Catalog } from '../src/catalog.mjs';
import { CryptoBox } from '../src/core.mjs';
import { Uploads } from '../src/uploads.mjs';
import { readFileSync } from 'node:fs';
import { SupabaseStore } from '../src/supabase.mjs';
import { Auth } from '../src/auth.mjs';

test('original TOML names and precedence are accepted with Node extensions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-toml-')), filename = path.join(directory, 'config.toml');
  try {
    await writeFile(filename, `[server]\nport=8080\n[db]\ndata-source='postgres://user:password@localhost/drive'\n[jwt]\nallowed-users=['webr0m']\n[tg]\napp-id=12345\napp-hash='0123456789abcdef0123456789abcdef'\n[tg.uploads]\nencryption-key='legacy-test-password'\n[node]\ndata-key='${randomBytes(32).toString('base64')}'\npublic-url='https://cloud.webrom.lat'\nowner-user-id='123'\n[node.limits]\nconcurrent-transfers=6\n`);
    const c = config({ CONFIG_FILE: filename, PORT: '3000' });
    assert.equal(c.port, 3000); assert.equal(c.apiId, 12345); assert.equal(c.databaseLayout, 'legacy'); assert.equal(c.concurrency, 6); assert.equal(c.legacyEncryptionKey, 'legacy-test-password'); assert.deepEqual(c.allowedUsers, ['webr0m']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const v2Fixture = `
CREATE SCHEMA teldrive;
CREATE TYPE teldrive.file_kind AS ENUM('file','folder');
CREATE TYPE teldrive.file_status AS ENUM('active','trashed','deletion_pending','spam');
CREATE TYPE teldrive.user_role AS ENUM('owner','admin','user');
CREATE TABLE teldrive.users(user_id bigint PRIMARY KEY,display_name text,username text,premium boolean NOT NULL DEFAULT false,role text NOT NULL,disabled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE teldrive.channels(channel_id bigint NOT NULL,user_id bigint REFERENCES teldrive.users(user_id),name text NOT NULL,selected boolean NOT NULL,health text DEFAULT 'unknown',created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(user_id,channel_id));
CREATE TABLE teldrive.bots(bot_id bigint PRIMARY KEY,user_id bigint REFERENCES teldrive.users(user_id),username text,token_ciphertext bytea NOT NULL,enabled boolean NOT NULL,session bytea,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE UNIQUE INDEX one_selected ON teldrive.channels(user_id) WHERE selected;
CREATE TABLE teldrive.files(id uuid PRIMARY KEY,user_id bigint REFERENCES teldrive.users(user_id),parent_id uuid,name text NOT NULL,kind text NOT NULL,mime_type text,size bigint,hash_algorithm text,hash_value text,encryption boolean NOT NULL,encryption_key_version integer,status text NOT NULL,mod_time timestamptz NOT NULL,generation bigint NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,deleted_at timestamptz,UNIQUE(id,user_id),FOREIGN KEY(parent_id,user_id) REFERENCES teldrive.files(id,user_id) ON DELETE RESTRICT,CHECK((NOT encryption AND encryption_key_version IS NULL) OR (encryption AND encryption_key_version IS NOT NULL)),CHECK((status='active' AND deleted_at IS NULL) OR (status<>'active' AND deleted_at IS NOT NULL)),CHECK((kind='folder' AND size IS NULL) OR (kind='file' AND size>=0)));
CREATE UNIQUE INDEX active_child_name ON teldrive.files(user_id,parent_id,name) WHERE status='active';
CREATE TABLE teldrive.file_parts(file_id uuid REFERENCES teldrive.files(id) ON DELETE CASCADE,part_no integer NOT NULL,channel_id bigint NOT NULL,message_id bigint NOT NULL,plain_size bigint,stored_size bigint,checksum text,salt text,PRIMARY KEY(file_id,part_no),UNIQUE(channel_id,message_id));
INSERT INTO teldrive.users(user_id,display_name,username,role) VALUES(7,'Owner','owner','owner'),(8,'User','user','user');
`;
test('restricted Supabase RPC keeps v2 writes atomic, rejects stale generations and hides the RPC from browser roles', () => {
  const database = new PostgresStore({ databaseUrl: 'pglite:test', databaseLayout: 'auto', databaseSchema: 'teldrive', metadataSchema: 'teldrive_node', testFixture: v2Fixture });
  try {
    database.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    database.query(readFileSync(new URL('../db/supabase-rpc.sql', import.meta.url), 'utf8'));
    const rpc = request => database.query('SELECT teldrive_node_api.catalog($1::jsonb) AS response', [JSON.stringify(request)])[0].response;
    const store = new SupabaseStore({}, { rpc }), catalog = new Catalog(store);
    assert.equal(store.get('settings', 'limits'), undefined);
    store.put('settings', { id: 'limits', values: { concurrency: 3 } });
    assert.equal(store.get('settings', 'limits').values.concurrency, 3);
    assert.equal(store.list('settings').length, 1);
    store.delete('settings', 'limits'); assert.equal(store.get('settings', 'limits'), undefined);
    const bot = { id: '12345', ownerId: '7', username: 'fixture_bot', tokenCiphertext: '010203', enabled: true, createdAt: new Date().toISOString() };
    store.put('bots', bot);
    assert.equal(store.list('bots', '7')[0].tokenCiphertext, '010203'); assert.equal(store.list('bots', '8').length, 0);
    assert.throws(() => store.put('bots', { ...bot, ownerId: '8' }));
    store.delete('bots', bot.id, '8'); assert.equal(store.list('bots', '7').length, 1);
    store.delete('bots', bot.id, '7'); assert.equal(store.list('bots', '7').length, 0);
    const auth = new Auth(store, { key: randomBytes(32), allowedUsers: [], production: false }, {});
    const pair = auth.finish({ id: 7, firstName: 'Existing owner' });
    auth.publish(pair, {}, false);
    assert.equal(auth.authenticate({ headers: { authorization: `Bearer ${pair.accessToken}` } }, new URLSearchParams()).user.role, 'owner');
    const renewed = auth.refresh(pair.refreshToken); auth.publish(renewed, {}, false);
    assert.throws(() => auth.refresh(pair.refreshToken));
    auth.revoke(renewed._session);
    assert.throws(() => auth.authenticate({ headers: { authorization: `Bearer ${renewed.accessToken}` } }, new URLSearchParams()));
    const folder = catalog.create('7', { name: 'HTTPS folder' });
    const file = catalog.create('7', { name: 'file.bin', parentId: folder.id }, 'file', { size: 10, encryption: true, encryptionKeyVersion: 2, parts: [{ backend: 'telegram', channelId: '99', messageId: 101, partNo: 1, plainSize: 10, size: 60, legacySalt: 'salt' }] });
    assert.equal(catalog.get('7', file.id).parts[0].legacySalt, 'salt');
    assert.throws(() => store.transaction(() => { catalog.update('7', file.id, { name: 'never.bin' }); catalog.create('7', { name: 'duplicate.bin', parentId: folder.id }, 'file', { size: 10, parts: [{ backend: 'telegram', channelId: '99', messageId: 101, partNo: 1 }] }); }));
    assert.equal(catalog.get('7', file.id).name, 'file.bin');
    const stale = catalog.get('7', file.id); catalog.update('7', file.id, { name: 'current.bin' });
    stale.name = 'stale.bin'; stale.generation++; assert.throws(() => store.put('files', stale), { code: 'P0001' });
    assert.equal(catalog.get('7', file.id).name, 'current.bin');
    store.transaction(() => { catalog.update('7', file.id, { name: 'first.bin' }); catalog.update('7', file.id, { name: 'second.bin' }); });
    assert.equal(catalog.get('7', file.id).name, 'second.bin');
    const permissions = database.query("SELECT has_function_privilege('anon','teldrive_node_api.catalog(jsonb)','EXECUTE') AS anon,has_function_privilege('authenticated','teldrive_node_api.catalog(jsonb)','EXECUTE') AS authenticated,has_function_privilege('service_role','teldrive_node_api.catalog(jsonb)','EXECUTE') AS service")[0];
    assert.deepEqual(permissions, { anon: false, authenticated: false, service: true });
    assert.equal(database.query('SELECT name FROM teldrive.files WHERE id=$1', [file.id])[0].name, 'second.bin');
  } finally { database.close(); }
});
test('v2 schema preserves roles, content keys, hashes and independent copy messages; cleanup survives failures', async () => {
  const c = { databaseUrl: 'pglite:test', databaseLayout: 'auto', databaseSchema: 'teldrive', metadataSchema: 'teldrive_node', encryptionKeyVersion: 2, concurrency: 2, testFixture: v2Fixture };
  const store = new PostgresStore(c);
  try {
    assert.equal(c.databaseLayout, 'v2'); assert.equal(store.get('users', '7').role, 'owner');
    const catalog = new Catalog(store), folder = catalog.create('7', { name: 'Folder' });
    const file = catalog.create('7', { name: 'encrypted.bin', parentId: folder.id }, 'file', { size: 10, encryption: true, encryptionKeyVersion: 1, mimeType: 'application/octet-stream', hash: { algorithm: 'blake3', value: 'a'.repeat(64) }, parts: [{ backend: 'telegram', channelId: '99', messageId: 123, partNo: 1, size: 60, plainSize: 10, legacySalt: 'original-salt' }] });
    const read = catalog.get('7', file.id); assert.equal(read.encryptionKeyVersion, 1); assert.equal(read.parts[0].legacySalt, 'original-salt'); assert.deepEqual(read.hash, file.hash);
    assert.throws(() => catalog.copy('7', folder.id, { name: 'Invalid shared message' }));
    assert.equal(catalog.all('7').length, 2, 'failed copy is atomic');
    let messageId = 500, unavailable = false;
    const removed = [], storage = { clone: async (owner, p) => ({ ...p, messageId: messageId++ }), remove: async (owner, p) => { if (unavailable) throw new Error('offline'); removed.push(p.messageId); } };
    const uploads = new Uploads(store, catalog, storage, c);
    const clone = await uploads.copy('7', folder.id, { name: 'Copied folder' });
    const copiedFile = catalog.all('7').find(f => f.parentId === clone.id);
    assert.equal(copiedFile.parts[0].messageId, 500); assert.equal(copiedFile.encryptionKeyVersion, 1); assert.equal(store.list('cleanup').length, 0);
    assert.equal(catalog.dashboard('7').summary.logicalBytes, 20);
    assert.throws(() => catalog.create('8', { name: 'Foreign parent', parentId: folder.id }));
    const timestamp = new Date().toISOString();
    for (const ownerId of ['7', '8']) store.put('channels', { id: '99', ownerId, name: 'Storage', selected: false, createdAt: timestamp });
    store.delete('channels', '99', '8'); assert.equal(store.list('channels', '7').length, 1); assert.equal(store.list('channels', '8').length, 0);
    unavailable = true; catalog.trash('7', clone.id); await uploads.purge('7', clone.id);
    assert.equal(store.list('cleanup').length, 1); assert.equal(catalog.all('7').length, 2);
    unavailable = false; await new Uploads(store, catalog, storage, c).drainCleanup();
    assert.equal(store.list('cleanup').length, 0); assert.deepEqual(removed, [500]); assert.equal(catalog.get('7', file.id).parts[0].messageId, 123);
  } finally { store.close(); }
});
test('legacy secretbox encryption covers empty data, block boundaries, nonce carry and tamper rejection', () => {
  for (const size of [0, 1, 65535, 65536, 65537, 131075]) {
    const bytes = randomBytes(size), nonce = Buffer.alloc(24, 255), encoded = encryptLegacy(bytes, 'password', 'salt', nonce);
    assert.equal(encoded.length, encryptedSize(size)); assert.equal(plainSize(encoded.length), size); assert.deepEqual(decryptLegacy(encoded, 'password', 'salt'), bytes);
    if (size) { const bad = Buffer.from(encoded); bad[bad.length - 1] ^= 1; assert.throws(() => decryptLegacy(bad, 'password', 'salt')); }
  }
  const box = new CryptoBox(randomBytes(32)), cipher = box.seal(Buffer.from('test'), 'session'); assert.throws(() => box.open(cipher, 'token'));
});
test('legacy range decryption streams across block boundaries with irregular chunk sizes', async () => {
  const input = randomBytes(3 * 65536 + 123), encoded = encryptLegacy(input, 'password', 'salt');
  for (const [offset, length] of [[0, 100], [65500, 1000], [130000, 50000], [encoded.length > 0 ? input.length - 30 : 0, 30]]) {
    const output = [];
    await decryptLegacyRange(async (start, size, write) => { for (let i = start; i < start + size; i += 997) await write(encoded.subarray(i, Math.min(i + 997, start + size))); }, encoded.length, offset, length, 'password', 'salt', bytes => { output.push(bytes); });
    assert.deepEqual(Buffer.concat(output), input.subarray(offset, offset + length));
  }
});
const fixture = `
CREATE SCHEMA teldrive;
CREATE TABLE teldrive.users(user_id bigint PRIMARY KEY,name text,user_name text NOT NULL,is_premium boolean NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE teldrive.files(id uuid PRIMARY KEY,name text NOT NULL,type text NOT NULL,mime_type text NOT NULL,size bigint,user_id bigint NOT NULL,parent_id uuid,status text NOT NULL,channel_id bigint,parts jsonb,encrypted boolean NOT NULL,category text,hash text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE teldrive.channels(channel_id bigint PRIMARY KEY,channel_name text NOT NULL,user_id bigint NOT NULL,selected boolean,created_at timestamptz);
CREATE TABLE teldrive.sessions(user_id bigint,hash text,session text,created_at timestamptz);
INSERT INTO teldrive.users VALUES (7,'Existing User','existing',false,now(),now());
INSERT INTO teldrive.files VALUES ('00000000-0000-4000-8000-000000000001','root','folder','drive/folder',null,7,null,'active',null,null,false,null,null,now(),now());
INSERT INTO teldrive.files VALUES ('00000000-0000-4000-8000-000000000002','existing.bin','file','application/octet-stream',10,7,'00000000-0000-4000-8000-000000000001','active',99,'[{"id":123}]',false,'other','preserve-old-tree-hash',now(),now());
`;
test('PostgreSQL legacy adapter reads and writes the original tables without losing part IDs or old hashes', () => {
  const store = new PostgresStore({ databaseUrl: 'pglite:test', databaseLayout: 'legacy', databaseSchema: 'teldrive', metadataSchema: 'teldrive_node', ownerUserId: '7', testFixture: fixture });
  try {
    const catalog = new Catalog(store), existing = catalog.all('7'); assert.equal(existing.length, 1); assert.equal(existing[0].parentId, undefined); assert.equal(existing[0].parts[0].messageId, 123); assert.equal(store.get('users', '7').role, 'owner');
    const folder = catalog.create('7', { name: 'Node folder' }); assert.ok(folder.id);
    const original = catalog.update('7', existing[0].id, { name: 'renamed.bin' }); assert.equal(original.name, 'renamed.bin');
    const row = store.query('SELECT * FROM teldrive.files WHERE id=$1', [existing[0].id])[0]; assert.equal(row.name, 'renamed.bin'); assert.equal(row.hash, 'preserve-old-tree-hash'); assert.deepEqual(row.parts, [{ id: 123 }]);
    const created = catalog.create('7', { name: 'new.bin', parentId: folder.id }, 'file', { size: 12, parts: [{ backend: 'telegram', channelId: '99', messageId: 456, plainSize: 12, size: 12 }], mimeType: 'application/octet-stream' });
    assert.equal(store.query('SELECT parts FROM teldrive.files WHERE id=$1', [created.id])[0].parts[0].id, 456);
    assert.throws(() => store.transaction(() => { catalog.update('7', created.id, { name: 'rollback.bin' }); throw new Error('Rollback'); }));
    assert.equal(catalog.get('7', created.id).name, 'new.bin');
    store.put('settings', { id: 'limits', values: { concurrency: 8 } }); assert.equal(store.get('settings', 'limits').values.concurrency, 8);
    assert.equal(store.query('SELECT count(*) FROM teldrive.sessions')[0].count, 0);
  } finally { store.close(); }
});
