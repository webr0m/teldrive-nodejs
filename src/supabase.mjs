import { Worker } from 'node:worker_threads';
import { PostgresStore } from './postgres.mjs';
import { fail } from './core.mjs';
const revision = Symbol('databaseRevision');

// A transaction is sent as one restricted RPC batch. The read overlay provides
// read-your-writes semantics without holding a PostgreSQL transaction across HTTP requests.
export class SupabaseStore {
  constructor(config, overrides = {}) {
    this.config = config; config.databaseLayout = 'v2';
    this.control = new SharedArrayBuffer(8); this.output = new SharedArrayBuffer(32 * 1024 ** 2);
    if (overrides.rpc) this.rpc = overrides.rpc;
    else {
      this.worker = new Worker(new URL('./supabase-worker.mjs', import.meta.url), { execArgv: [], workerData: { url: config.supabaseUrl, key: config.supabaseKey } });
      this.worker.unref();
    }
    try { this.ready(); } catch (error) { this.close(); throw error; }
  }
  rpc(request) {
    const flags = new Int32Array(this.control); Atomics.store(flags, 0, 0);
    this.worker.postMessage({ request, control: this.control, output: this.output });
    if (Atomics.wait(flags, 0, 0, 30000) === 'timed-out') fail(503, 'supabase_timeout');
    const result = JSON.parse(Buffer.from(this.output, 0, Atomics.load(flags, 1)).toString());
    if (result.error) fail(result.error.status, result.error.code);
    return result.value;
  }
  v2() { return true; }
  ready() { const result = this.rpc({ action: 'ready' }); if (result.layout !== 'v2') fail(503, 'supabase_schema_not_ready'); }
  map(bucket, row) {
    if (bucket === 'files') { const file = PostgresStore.prototype.file.call(this, row); file[revision] = { id: file.id, generation: file.generation }; return file; }
    if (bucket === 'users') return PostgresStore.prototype.user.call(this, row);
    if (bucket === 'channels') return { id: String(row.channel_id), ownerId: String(row.user_id), name: row.name, selected: row.selected, health: row.health, createdAt: new Date(row.created_at).toISOString() };
    return row;
  }
  get(bucket, key) {
    const pending = this.pending?.findLast(op => op.bucket === bucket && op.id === String(key));
    if (pending) return pending.action === 'delete' ? undefined : structuredCopy(pending.value);
    const row = this.rpc({ action: 'get', bucket, id: String(key) }).items[0];
    return row && this.map(bucket, row);
  }
  list(bucket, owner) {
    const cacheKey = `${bucket}:${owner ?? '*'}`;
    let rows = this.readCache?.get(cacheKey);
    if (!rows) { rows = this.rpc({ action: 'list', bucket, owner: owner === undefined ? null : String(owner) }).items.map(row => this.map(bucket, row)); this.readCache?.set(cacheKey, rows); }
    const values = new Map(rows.map(value => [bucket === 'channels' ? `${value.ownerId}:${value.id}` : value.id, structuredCopy(value)]));
    for (const op of this.pending || []) {
      if (op.bucket !== bucket) continue;
      const key = bucket === 'channels' ? `${op.owner}:${op.id}` : op.id;
      if (op.action === 'delete') values.delete(key);
      else if (owner === undefined || String(op.value.ownerId ?? op.value.userId ?? '') === String(owner)) values.set(key, structuredCopy(op.value));
    }
    return [...values.values()];
  }
  put(bucket, value) {
    if (!this.pending) return this.transaction(() => this.put(bucket, value));
    const previous = this.pending.find(op => op.action === 'put' && op.bucket === bucket && op.id === String(value.id) && (bucket !== 'channels' || op.owner === String(value.ownerId)));
    if (previous) { previous.value = structuredCopy(value); return value; }
    this.pending.push({ action: 'put', bucket, id: String(value.id), owner: String(value.ownerId ?? value.userId ?? ''), value: structuredCopy(value), expectedGeneration: previous ? previous.expectedGeneration : value[revision]?.id === value.id ? value[revision].generation : null });
    return value;
  }
  delete(bucket, key, owner, generation) {
    if (!this.pending) return this.transaction(() => this.delete(bucket, key, owner, generation));
    this.pending.push({ action: 'delete', bucket, id: String(key), owner: owner === undefined ? null : String(owner), expectedGeneration: generation });
  }
  transaction(fn) {
    if (this.pending) return fn();
    this.pending = []; this.readCache = new Map();
    try { const value = fn(); if (value?.then) throw new Error('Store transactions must be synchronous'); if (this.pending.length) this.rpc({ action: 'commit', operations: this.pending }); return value; }
    finally { this.pending = undefined; this.readCache = undefined; }
  }
  close() { this.worker?.terminate(); }
}
function structuredCopy(value) {
  // Preserve the non-JSON revision marker used for optimistic concurrency.
  const copy = structuredClone(value); if (value[revision]) copy[revision] = value[revision]; return copy;
}

