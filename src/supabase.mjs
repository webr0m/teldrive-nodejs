import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresStore } from './postgres.mjs';
import { fail } from './core.mjs';
const revision = Symbol('databaseRevision');
class MissingRead { constructor(request, key) { this.request = request; this.key = key; } }
const unavailable = () => Object.assign(new Error('Supabase unavailable'), { status: 503, code: 'supabase_unavailable' });

// A transaction is sent as one restricted RPC batch. The read overlay provides
// read-your-writes semantics without holding a PostgreSQL transaction across HTTP requests.
export class SupabaseStore {
  constructor(config, overrides = {}) {
    this.config = config; this.overrides = overrides; this.timeoutMs = overrides.timeoutMs ?? 30000; config.databaseLayout = 'v2';
    this.readScopes = new AsyncLocalStorage(); this.asyncCalls = new Map(); this.nextAsyncId = 0;
    if (overrides.rpc) this.rpc = overrides.rpc;
    else {
      this.startWorker();
    }
    try { this.ready(); } catch (error) { this.close(); throw error; }
  }
  startWorker() {
    // A late response from a timed-out worker must never overwrite the next call.
    this.rejectAsync(); this.worker?.terminate(); this.failed = false;
    this.control = new SharedArrayBuffer(8); this.output = new SharedArrayBuffer(32 * 1024 ** 2);
    const worker = this.overrides.workerFactory ? this.overrides.workerFactory() : new Worker(new URL('./supabase-worker.mjs', import.meta.url), { execArgv: [], workerData: { url: this.config.supabaseUrl, key: this.config.supabaseKey } });
    this.worker = worker; worker.unref();
    worker.on('error',()=>{if(this.worker===worker){this.failed=true;this.rejectAsync();}});
    worker.on('exit',()=>{if(this.worker===worker){this.failed=true;this.rejectAsync();}});
    worker.on('message',({asyncId,result})=>{
      if(this.worker!==worker)return;
      const call=this.asyncCalls.get(asyncId);if(!call)return;
      this.asyncCalls.delete(asyncId);clearTimeout(call.timer);
      if(result.error)call.reject(Object.assign(unavailable(),result.error));else call.resolve(result.value);
    });
  }
  rejectAsync() { for(const call of this.asyncCalls.values()){clearTimeout(call.timer);call.reject(unavailable());}this.asyncCalls.clear(); }
  rpcAsync(request) {
    if(this.closed)return Promise.reject(unavailable());
    if(this.overrides.rpcAsync)return this.overrides.rpcAsync(request);
    if(this.overrides.rpc)return Promise.resolve().then(()=>this.rpc(request));
    if(this.failed)this.startWorker();
    if(this.asyncCalls.size>=256)return Promise.reject(unavailable());
    return new Promise((resolve,reject)=>{
      const asyncId=++this.nextAsyncId;
      const timer=setTimeout(()=>{this.asyncCalls.delete(asyncId);reject(unavailable());},this.timeoutMs);
      this.asyncCalls.set(asyncId,{resolve,reject,timer});
      try{this.worker.postMessage({request,asyncId});}catch{clearTimeout(timer);this.asyncCalls.delete(asyncId);reject(unavailable());}
    });
  }
  readScope(fn) {
    const scope={cache:new Map(),prefetch:false,closed:false};
    const close=()=>{scope.closed=true;scope.cache.clear();};
    try{const value=this.readScopes.run(scope,fn);if(value?.then)return value.finally(close);close();return value;}
    catch(error){close();throw error;}
  }
  read(request) {
    const scope=this.readScopes.getStore();if(!scope||scope.closed)return this.rpc(request);
    const key=JSON.stringify(request);
    if(scope.cache.has(key))return structuredClone(scope.cache.get(key));
    if(scope.prefetch)throw new MissingRead(request,key);
    const value=this.rpc(request);scope.cache.set(key,structuredClone(value));return value;
  }
  // Only explicitly read-only, synchronous computations may be replayed to hydrate
  // their missing records asynchronously. No cross-request authorization cache.
  async readAsync(fn) {
    const scope=this.readScopes.getStore();if(!scope||scope.closed)return this.readScope(()=>this.readAsync(fn));
    for(let n=0;n<256;n++){
      let missing;
      scope.prefetch=true;
      try{const result=fn();if(result?.then)throw new Error('Read computation must be synchronous');return result;}
      catch(error){if(!(error instanceof MissingRead))throw error;missing=error;}
      finally{scope.prefetch=false;}
      scope.cache.set(missing.key,structuredClone(await this.rpcAsync(missing.request)));
    }
    throw unavailable();
  }
  rpc(request) {
    if (this.closed) fail(503,'supabase_unavailable');
    if (this.failed) this.startWorker();
    const flags = new Int32Array(this.control); Atomics.store(flags, 0, 0);
    this.worker.postMessage({ request, control: this.control, output: this.output });
    if (Atomics.wait(flags, 0, 0, this.timeoutMs) === 'timed-out') { this.startWorker(); fail(503, 'supabase_timeout'); }
    const result = JSON.parse(Buffer.from(this.output, 0, Atomics.load(flags, 1)).toString());
    if (result.error) fail(result.error.status, result.error.code);
    return result.value;
  }
  v2() { return true; }
  ready() { const result = this.rpc({ action: 'ready' }); if (result.layout !== 'v2') fail(503, 'supabase_schema_not_ready'); }
  map(bucket, row) {
    if (bucket === 'bots') return PostgresStore.prototype.bot.call(this, row);
    if (bucket === 'files') { const file = PostgresStore.prototype.file.call(this, row); file[revision] = { id: file.id, generation: file.generation }; return file; }
    if (bucket === 'users') return PostgresStore.prototype.user.call(this, row);
    if (bucket === 'channels') return { id: String(row.channel_id), ownerId: String(row.user_id), name: row.name, selected: row.selected, health: row.health, createdAt: new Date(row.created_at).toISOString() };
    return row;
  }
  claimJob(jobId, workerId, leaseSeconds) { return this.rpc({action:'claim-job',id:jobId,workerId,leaseSeconds}).items[0]; }
  get(bucket, key) {
    const pending = this.pending?.findLast(op => op.bucket === bucket && op.id === String(key));
    if (pending) return pending.action === 'delete' ? undefined : structuredCopy(pending.value);
    const row = this.read({ action: 'get', bucket, id: String(key) }).items[0];
    return row && this.map(bucket, row);
  }
  list(bucket, owner) {
    const cacheKey = `${bucket}:${owner ?? '*'}`;
    let rows = this.readCache?.get(cacheKey);
    if (!rows) { rows = this.read({ action: 'list', bucket, owner: owner === undefined ? null : String(owner) }).items.map(row => this.map(bucket, row)); this.readCache?.set(cacheKey, rows); }
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
    if(this.readScopes.getStore()?.prefetch)throw new Error('Read computation cannot write');
    this.readScopes.getStore()?.cache.clear();
    if (!this.pending) return this.transaction(() => this.put(bucket, value));
    const previous = this.pending.find(op => op.action === 'put' && op.bucket === bucket && op.id === String(value.id) && (bucket !== 'channels' || op.owner === String(value.ownerId)));
    if (previous) { previous.value = structuredCopy(value); return value; }
    this.pending.push({ action: 'put', bucket, id: String(value.id), owner: String(value.ownerId ?? value.userId ?? ''), value: structuredCopy(value), expectedGeneration: previous ? previous.expectedGeneration : value[revision]?.id === value.id ? value[revision].generation : null });
    return value;
  }
  delete(bucket, key, owner, generation) {
    if(this.readScopes.getStore()?.prefetch)throw new Error('Read computation cannot write');
    this.readScopes.getStore()?.cache.clear();
    if (!this.pending) return this.transaction(() => this.delete(bucket, key, owner, generation));
    this.pending.push({ action: 'delete', bucket, id: String(key), owner: owner === undefined ? null : String(owner), expectedGeneration: generation });
  }
  transaction(fn) {
    if (this.pending) return fn();
    this.pending = []; this.readCache = new Map();
    try { const value = fn(); if (value?.then) throw new Error('Store transactions must be synchronous'); if (this.pending.length) this.rpc({ action: 'commit', operations: this.pending }); return value; }
    finally { this.pending = undefined; this.readCache = undefined; }
  }
  close() { this.closed = true; this.rejectAsync(); this.worker?.terminate(); }
}
function structuredCopy(value) {
  // Preserve the non-JSON revision marker used for optimistic concurrency.
  const copy = structuredClone(value); if (value[revision]) copy[revision] = value[revision]; return copy;
}

