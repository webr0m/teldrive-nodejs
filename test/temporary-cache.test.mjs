import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { TemporaryCache, mediaCacheKey } from '../src/temporary-cache.mjs';
import { Media } from '../src/media.mjs';
import { config } from '../src/config.mjs';
import { ServerConfiguration, KEEP_SECRET } from '../src/server-configuration.mjs';

const key = n => String(n).padStart(64, '0');
const settings = () => ({ key: randomBytes(32), cacheBackend: 'postgres', cachePostgresUrl: 'postgresql://localhost/test', cacheSchema: 'teldrive_cache', cachePoolSize: 1, cacheMaxEntries: 2 });
class TestPool extends EventEmitter {
  constructor(db) { super(); this.db = db; }
  async connect() { return { query: (sql, values) => this.db.query(sql, values), release() {} }; }
  async end() {}
}
const flush = cache => Promise.all([...cache.pending]);

test('temporary memory cache expires, bounds size, isolates returned values and rejects large payloads', async () => {
  let now = 1000;
  const cache = new TemporaryCache({ cacheMemoryEntries: 2, cacheTtlSeconds: 60, cacheMaxValueBytes: 1024 }, { clock: () => now });
  cache.set(key(1), { tracks: [{ title: 'original' }] });
  const copy = await cache.load(key(1)); copy.tracks[0].title = 'changed';
  assert.equal(cache.get(key(1)).tracks[0].title, 'original');
  cache.set(key(2), {}); cache.set(key(3), {});
  assert.equal(cache.get(key(1)), undefined); assert.equal(cache.memory.size, 2);
  cache.set(key(4), 'x'.repeat(1025)); assert.equal(cache.get(key(4)), undefined);
  now += 60001; assert.equal(await cache.load(key(3)), undefined);
  await cache.close();
});

test('PostgreSQL cache survives app restart, encrypts metadata and enforces TTL and row limits with real SQL', async () => {
  const db = new PGlite(), c = settings(), pool = new TestPool(db);
  const first = new TemporaryCache(c, { pool }); let second;
  try {
    assert.equal(await first.initialize(), true);
    const value = { tracks: [{ title: 'private-media-title', kind: 'audio' }], copyVideo: [], format: { duration: 12 } };
    first.set(key(1), value); await flush(first);
    const stored = (await db.query('SELECT payload FROM teldrive_cache.media_metadata_v1')).rows[0].payload;
    assert.equal(Buffer.from(stored).includes(Buffer.from('private-media-title')), false);
    assert.equal((await db.query("SELECT relpersistence FROM pg_class WHERE relname='media_metadata_v1'")).rows[0].relpersistence, 'u');
    second = new TemporaryCache(c, { pool }); await second.initialize();
    assert.deepEqual(await second.load(key(1)), value); assert.equal(second.status().postgresHits, 1);
    first.set(key(2), value); await flush(first); first.set(key(3), value); await flush(first);
    assert.equal(Number((await db.query('SELECT count(*) FROM teldrive_cache.media_metadata_v1')).rows[0].count), 2);
    await db.query("UPDATE teldrive_cache.media_metadata_v1 SET expires_at=now()-interval '1 second'");
    second.clear(); assert.equal(await second.load(key(3)), undefined);
    await second.operation(client => second.prune(client));
    assert.equal(Number((await db.query('SELECT count(*) FROM teldrive_cache.media_metadata_v1')).rows[0].count), 0);
  } finally { await first.close(); await second?.close(); await db.close(); }
});

test('encrypted cache binds the key and expiry; tampered or differently encrypted entries become misses', async () => {
  const db = new PGlite(), c = settings(), pool = new TestPool(db);
  let now = Date.now(); const first = new TemporaryCache(c, { pool, clock: () => now }); let second;
  try {
    await first.initialize(); first.set(key(1), { tracks: [] }); await flush(first);
    await db.query("UPDATE teldrive_cache.media_metadata_v1 SET expires_at=now()+interval '30 days'");
    now += 86400001; first.clear(); assert.equal(await first.load(key(1)), undefined, 'SQL timestamp cannot extend encrypted expiry');
    second = new TemporaryCache({ ...c, key: randomBytes(32) }, { pool }); await second.initialize();
    assert.equal(await second.load(key(1)), undefined); assert.equal(second.status().failures, 1);
    assert.equal(second.status().connected, false);
  } finally { await first.close(); await second?.close(); await db.close(); }
});

test('cache outage falls back to memory and retries without an unbounded SQL queue', async () => {
  const pool = new EventEmitter(); let attempts = 0;
  pool.connect = async () => { attempts++; throw new Error('private connection string must not escape'); }; pool.end = async () => {};
  const cache = new TemporaryCache(settings(), { pool });
  await cache.initialize(); assert.equal(cache.status().connected, false);
  for (let i = 0; i < 100; i++) assert.equal(await cache.load(key(i)), undefined);
  assert.equal(attempts, 1, 'circuit breaker avoids hammering unavailable PostgreSQL');
  cache.set(key(1), { tracks: [] }); assert.deepEqual(await cache.load(key(1)), { tracks: [] });
  assert.equal(JSON.stringify(cache.status()).includes('private'), false);
  cache.connected = true; cache.active = 1;
  assert.equal(await cache.operation(() => assert.fail('must not queue')), undefined);
  cache.active = 0; await cache.close();
});

test('cached media never bypasses fresh ticket authorization and changes to file content invalidate its key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-cache-media-'));
  const c = { dataDir: directory, publicUrl: 'http://127.0.0.1:3000', mediaEnabled: true, ffprobePath: process.execPath, ffmpegPath: process.execPath };
  let allowed = true, probes = 0, file = { ownerId: '7', id: 'file', generation: 1, size: 4, parts: [{ messageId: 5 }] };
  const media = new Media(c, { resolve: () => { if (!allowed) throw new Error('revoked'); return { file }; } });
  media.collect = async () => { probes++; return JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac', index: 0 }] }); };
  try {
    const [a, b] = await Promise.all([media.tracks('ticket'), media.tracks('ticket')]);
    assert.deepEqual(a, b); assert.equal(probes, 1);
    allowed = false; await assert.rejects(() => media.tracks('ticket'), /revoked/);
    allowed = true; file = { ...file, generation: 2 }; await media.tracks('ticket'); assert.equal(probes, 2);
    assert.notEqual(mediaCacheKey(file, c), mediaCacheKey({ ...file, ownerId: '8' }, c));
    assert.notEqual(mediaCacheKey(file, c), mediaCacheKey({ ...file, parts: [{ messageId: 6 }] }, c));
  } finally { await media.cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('owner TOML supports separate cache settings and redacts its connection secret', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-cache-config-'));
  const env = { CONFIG_FILE: 'none', SERVER_CONFIG_FILE: path.join(directory, 'config.admin.toml'), DATA_KEY: randomBytes(32).toString('base64'), STORAGE_BACKEND: 'local' };
  try {
    const manager = new ServerConfiguration(config(env)), initial = manager.read();
    manager.save({ revision: initial.revision, toml: '[node.cache]\nbackend="postgres"\npostgres-url="postgresql://user:cache-password@127.0.0.1/only_cache"\nttl-seconds=120\nmax-entries=25' });
    assert.equal(config(env).cacheBackend, 'postgres'); assert.equal(config(env).cacheTtlSeconds, 120);
    assert.equal(config(env).databaseUrl, undefined, 'main DB configuration remains independent');
    assert.ok(manager.read().toml.includes(KEEP_SECRET)); assert.ok(!manager.read().toml.includes('cache-password'));
    assert.throws(() => config({ ...env, SERVER_CONFIG_FILE: 'none', CACHE_BACKEND: 'postgres', CACHE_POSTGRES_URL: 'postgresql://remote.example/cache' }), /verify-full/);
    assert.throws(() => config({ ...env, SERVER_CONFIG_FILE: 'none', CACHE_POSTGRES_SCHEMA: 'public' }), /separate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
