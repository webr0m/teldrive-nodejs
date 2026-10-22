import { Pool } from 'pg';
import { hkdfSync } from 'node:crypto';
import { CryptoBox, hash } from './core.mjs';

// Authorization, Telegram credentials and file bytes never enter this cache.
export function mediaCacheKey(file, config) {
  const database = config.databaseUrl ? new URL(config.databaseUrl) : undefined;
  return hash(JSON.stringify(['media-probe-v1', config.databaseSchema, config.supabaseUrl || (database ? database.host + database.pathname : config.dataDir),
    file.ownerId, file.id, file.generation, file.size, file.parts,
    config.mediaAnalyzeSeconds, config.mediaProbeBytes]));
}

export class TemporaryCache {
  constructor(config, overrides = {}) {
    this.config = config; this.clock = overrides.clock || Date.now;
    this.memory = new Map(); this.pending = new Set(); this.active = 0;
    this.counts = { memoryHits: 0, postgresHits: 0, misses: 0, writes: 0, failures: 0, skipped: 0 };
    this.ttl = (config.cacheTtlSeconds ?? 86400) * 1000;
    this.memoryLimit = config.cacheMemoryEntries ?? 200;
    this.rowLimit = config.cacheMaxEntries ?? 1000;
    this.valueLimit = config.cacheMaxValueBytes ?? 65536;
    this.parallel = config.cachePoolSize ?? 2;
    if (config.cacheBackend !== 'postgres') return;
    const schema = config.cacheSchema || 'teldrive_cache';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid cache schema');
    this.schema = `"${schema}"`; this.table = `${this.schema}.media_metadata_v1`;
    this.box = new CryptoBox(Buffer.from(hkdfSync('sha256', config.key, Buffer.alloc(0), 'teldrive-temporary-cache-v1', 32)));
    this.pool = overrides.pool || new Pool({ connectionString: config.cachePostgresUrl,
      max: this.parallel, connectionTimeoutMillis: config.cacheTimeoutMs ?? 250,
      statement_timeout: config.cacheTimeoutMs ?? 250, query_timeout: (config.cacheTimeoutMs ?? 250) + 50,
      idleTimeoutMillis: 30000, allowExitOnIdle: true, application_name: 'teldrive-cache',
      ...(new URL(config.cachePostgresUrl).searchParams.get('sslmode') === 'verify-full' ? { ssl: { rejectUnauthorized: true } } : {}) });
    this.pool.on('error', () => this.failed());
    void this.initialize();
    this.timer = setInterval(() => { if (this.connected) void this.operation(client => this.prune(client)); },
      (config.cacheCleanupSeconds ?? 60) * 1000).unref();
  }
  failed() {
    this.counts.failures++; this.connected = false;
    this.retryAt = this.clock() + (this.config.cacheRetrySeconds ?? 30) * 1000;
  }
  initialize() {
    if (!this.pool || this.closed || this.clock() < (this.retryAt || 0)) return Promise.resolve(false);
    if (this.initializing) return this.initializing;
    this.initializing = this.operation(async client => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`REVOKE ALL ON SCHEMA ${this.schema} FROM PUBLIC`);
      await client.query(`CREATE UNLOGGED TABLE IF NOT EXISTS ${this.table} (
        key text PRIMARY KEY CHECK(length(key)=64), payload bytea NOT NULL CHECK(octet_length(payload)<=1049600),
        expires_at timestamptz NOT NULL)`);
      await client.query(`REVOKE ALL ON TABLE ${this.table} FROM PUBLIC`);
      await client.query(`CREATE INDEX IF NOT EXISTS media_metadata_v1_expiry ON ${this.table}(expires_at)`);
      this.connected = true; return true;
    }, true).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  async operation(fn, initializing = false) {
    if (this.closed || !this.pool || this.active >= this.parallel || !initializing && !this.connected) {
      this.counts.skipped++; return;
    }
    this.active++;
    let client;
    try { client = await this.pool.connect(); return await fn(client); }
    catch { this.failed(); }
    finally { client?.release(); this.active--; }
  }
  get(key) {
    const entry = this.memory.get(key);
    if (!entry) return;
    if (entry.expiresAt <= this.clock()) { this.memory.delete(key); return; }
    this.memory.delete(key); this.memory.set(key, entry); this.counts.memoryHits++;
    return structuredClone(entry.value);
  }
  remember(key, value, expiresAt) {
    this.memory.delete(key);
    while (this.memory.size >= this.memoryLimit) this.memory.delete(this.memory.keys().next().value);
    this.memory.set(key, { value: structuredClone(value), expiresAt });
  }
  async load(key) {
    const cached = this.get(key); if (cached !== undefined) return cached;
    if (!this.connected) { void this.initialize(); this.counts.misses++; return; }
    const entry = await this.operation(async client => {
      const result = await client.query(`SELECT payload FROM ${this.table} WHERE key=$1 AND expires_at>now()`, [key]);
      if (!result.rows.length) return;
      const bytes = Buffer.from(result.rows[0].payload);
      if (bytes.length > this.valueLimit + 1024) return;
      // The encrypted expiry cannot be extended by modifying the SQL timestamp.
      const item = JSON.parse(this.box.open(bytes, `media-metadata:${key}`).toString());
      if (!Number.isFinite(item.expiresAt) || item.expiresAt <= this.clock()) return;
      return item;
    });
    if (!entry) { this.counts.misses++; return; }
    this.counts.postgresHits++; this.remember(key, entry.value, entry.expiresAt);
    return structuredClone(entry.value);
  }
  set(key, value) {
    if (this.closed || !/^[a-f0-9]{64}$/.test(key)) return;
    const serialized = JSON.stringify(value); if (serialized === undefined || Buffer.byteLength(serialized) > this.valueLimit) return;
    const expiresAt = this.clock() + this.ttl;
    this.remember(key, value, expiresAt);
    if (!this.connected) { void this.initialize(); return; }
    const payload = this.box.seal(Buffer.from(JSON.stringify({ value, expiresAt })), `media-metadata:${key}`);
    const task = this.operation(async client => {
      await client.query('BEGIN');
      try {
        const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [this.table]);
        if (!lock.rows[0].locked) { await client.query('ROLLBACK'); this.counts.skipped++; return; }
        await client.query(`INSERT INTO ${this.table}(key,payload,expires_at) VALUES($1,$2,$3)
          ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at`, [key, payload, new Date(expiresAt)]);
        await this.prune(client);
        await client.query('COMMIT'); this.counts.writes++;
      } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    });
    this.pending.add(task); void task.finally(() => this.pending.delete(task));
  }
  async prune(client) {
    await client.query(`DELETE FROM ${this.table} WHERE expires_at<=now()`);
    await client.query(`DELETE FROM ${this.table} WHERE key IN
      (SELECT key FROM ${this.table} ORDER BY expires_at DESC,key OFFSET $1)`, [this.rowLimit]);
  }
  clear() { this.memory.clear(); }
  status() {
    return { backend: this.config.cacheBackend || 'memory', connected: !!this.connected,
      memoryEntries: this.memory.size, ttlSeconds: this.ttl / 1000, maxEntries: this.rowLimit,
      maxValueBytes: this.valueLimit, active: this.active, ...this.counts };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.clear();
    await this.initializing; await Promise.allSettled([...this.pending]); await this.pool?.end();
  }
}
