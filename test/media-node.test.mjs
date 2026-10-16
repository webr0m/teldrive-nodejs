import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.mjs';
import { Store } from '../src/core.mjs';
import { createApp } from '../src/server.mjs';
import { Telegram } from '../src/telegram.mjs';
import { createMediaBalancer, mediaNodeRoute } from '../edge/media-balancer.mjs';

const secret = randomBytes(32).toString('base64url');
const env = { PUBLIC_ORIGIN: 'https://cloud.example.com', MEDIA_NODE_ENABLED: 'true', MEDIA_NODE_ORIGIN: 'https://pc.example.com', MEDIA_NODE_SECRET: secret, MEDIA_NODE_WEIGHT: '10' };
const read = () => new Request(`${env.PUBLIC_ORIGIN}/api/v1/playback?ticket=private`, { headers: { Range: 'bytes=10-19', Cookie: 'session=private' } });
function fixture({ secondaryStatus = 206, primaryStatus = 206, secondaryDown = false, busy = false } = {}) {
  const calls = [];
  const router = createMediaBalancer({ now: () => 0, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init); calls.push(request);
    const url = new URL(request.url), pc = url.origin === env.MEDIA_NODE_ORIGIN;
    if (url.pathname === '/internal/media/health') {
      if (secondaryDown) throw new Error('PC offline');
      return Response.json({ status: busy ? 'busy' : 'ok', role: 'media', load: busy ? 1 : 0 });
    }
    if (url.pathname === '/api/health/ready') return Response.json({ status: 'ok' });
    return new Response(pc ? 'secondary' : 'primary', { status: pc ? secondaryStatus : primaryStatus, headers: { 'Content-Range': 'bytes 10-19/100', ETag: 'file-1' } });
  } });
  return { router, calls, content: () => calls.filter(r => !r.url.includes('/health')) };
}

test('balancer preserves range/auth headers, streams the selected origin and caches only health', async () => {
  const { router, calls, content } = fixture();
  const response = await router.fetch(read(), env);
  assert.equal(response.status, 206); assert.equal(await response.text(), 'secondary');
  assert.equal(response.headers.get('Content-Range'), 'bytes 10-19/100');
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Teldrive-Origin'), 'secondary');
  assert.equal(content()[0].headers.get('Range'), 'bytes=10-19'); assert.equal(content()[0].headers.get('Cookie'), 'session=private');
  assert.equal(content()[0].headers.get('X-Teldrive-Media-Node'), secret);
  await router.fetch(read(), env); assert.equal(calls.filter(r => r.url.includes('/health')).length, 2);
});

test('PC offline, busy, disabled or less suitable keeps media on the primary', async () => {
  for (const options of [{ secondaryDown: true }, { busy: true }, { weight: '0.05' }, { disabled: true }]) {
    const { router, content } = fixture(options);
    const response = await router.fetch(read(), { ...env, ...(options.weight ? { MEDIA_NODE_WEIGHT: options.weight } : {}), ...(options.disabled ? { MEDIA_NODE_ENABLED: 'false' } : {}) });
    assert.equal(await response.text(), 'primary'); assert.equal(content().length, 1);
    assert.equal(content()[0].headers.has('X-Teldrive-Media-Node'), false);
  }
});

test('fallback handles a failed secondary before exposing bytes, but never retries an authorization rejection', async () => {
  const failed = fixture({ secondaryStatus: 503 });
  const response = await failed.router.fetch(read(), env); assert.equal(await response.text(), 'primary'); assert.equal(failed.content().length, 2);
  await failed.router.fetch(read(), env); assert.equal(failed.content().length, 3, 'a failed PC enters a cooldown');
  const rejected = fixture({ secondaryStatus: 401 });
  assert.equal((await rejected.router.fetch(read(), env)).status, 401); assert.equal(rejected.content().length, 1);
});

test('uploads, login, administration, public shares and all writes bypass balancing exactly once', async () => {
  for (const [method, pathname] of [['PUT', '/api/v1/files/abc/content'], ['POST', '/api/v1/uploads'], ['POST', '/api/v1/mobile/google/start'], ['GET', '/api/v1/admin/users'], ['GET', '/api/v1/public/shares/abc/content'], ['GET', '/api/v1/files/abc']]) {
    assert.equal(mediaNodeRoute(method, pathname), false);
    const { router, calls } = fixture();
    await router.fetch(new Request(env.PUBLIC_ORIGIN + pathname, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'once' } : {}), headers: { 'X-Teldrive-Media-Node': 'spoof' } }), env);
    assert.equal(calls.length, 1); assert.equal(calls[0].headers.has('X-Teldrive-Media-Node'), false);
    if (method === 'POST' || method === 'PUT') assert.equal(await calls[0].text(), 'once');
  }
});

test('the PC portal uses a separate tunnel origin, preserves one-shot writes and keeps its edge key off public responses', async () => {
  const calls = [];
  const router = createMediaBalancer({ fetch: async request => { calls.push(request); return new Response('ok'); } });
  const portalEnv = { ...env, MEDIA_NODE_ADMIN: 'true', MEDIA_NODE_PORTAL_ORIGIN: 'https://portal.example.com' };
  const request = new Request('https://portal.example.com/api/v1/auth/refresh', { method: 'POST', body: 'once', headers: { Cookie: 'session=private', Origin: 'https://portal.example.com' } });
  const response = await router.fetch(request, portalEnv);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, env.MEDIA_NODE_ORIGIN + '/api/v1/auth/refresh');
  assert.equal(await calls[0].text(), 'once'); assert.equal(calls[0].headers.get('X-Teldrive-PC-Portal'), '1');
  assert.equal(calls[0].headers.get('X-Teldrive-Media-Node'), secret); assert.equal(response.headers.has('X-Teldrive-Media-Node'), false);
  assert.equal((await router.fetch(new Request('https://preview.example.com/'), portalEnv)).status, 404);
});

test('a response stream failure after headers cannot replay the download on another host', async () => {
  let reads = 0;
  const router = createMediaBalancer({ now: () => 0, fetch: async input => {
    const url = new URL(input.url || input);
    if (url.pathname.includes('/health')) return Response.json({ status: 'ok', role: 'media', load: 0 });
    reads++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } }));
  } });
  const response = await router.fetch(read(), env);
  await assert.rejects(() => response.text(), /connection lost/); assert.equal(reads, 1);
});

test('the PC portal forwards sign-in and global administration without its internal key, preserving owner-only permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-pc-portal-'));
  const common = { CONFIG_FILE: 'none', DATA_KEY: randomBytes(32).toString('base64'), TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef', MEDIA_ENABLED: 'false', PORT: '0', OWNER_USER_ID: '7' };
  const shared = path.join(directory, 'shared');
  const primaryConfig = config({ ...common, DATA_DIR: path.join(directory, 'primary') });
  const primary = createApp(primaryConfig, { store: new Store(shared) });
  await new Promise(resolve => primary.server.listen(0, '127.0.0.1', resolve));
  primaryConfig.publicUrl = `http://127.0.0.1:${primary.server.address().port}`;
  const pcConfig = config({ ...common, DATA_DIR: path.join(directory, 'pc'), MEDIA_NODE: 'true', MEDIA_NODE_ADMIN: 'true', MEDIA_NODE_PRIMARY_ORIGIN: 'https://primary.example.com', PUBLIC_URL: 'https://pc.example.com', MEDIA_NODE_SECRET: secret, TELEGRAM_INSTANCE_ID: 'portal-pc', DATABASE_URL: 'postgres://localhost/test' });
  // The production validator requires HTTPS. Only this isolated fixture uses
  // a loopback HTTP primary, so no network credentials or TLS bypass is needed.
  pcConfig.mediaNodePrimaryOrigin = primaryConfig.publicUrl;
  const pc = createApp(pcConfig, { store: new Store(shared) });
  await new Promise(resolve => pc.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${pc.server.address().port}`, seen = [];
  primary.server.on('request', req => seen.push({ path: req.url, headers: req.headers }));
  try {
    const owner = primary.context.auth.finish({ id: 7 }), guest = primary.context.auth.finish({ id: 8 });
    for (const pair of [owner, guest]) primary.context.auth.publish(pair, {}, false);
    const headers = pair => ({ Authorization: `Bearer ${pair.accessToken}`, 'X-Teldrive-Media-Node': secret, Origin: pcConfig.publicUrl });
    assert.equal((await fetch(base + '/api/v1/me', { headers: headers(owner) })).status, 200);
    assert.equal((await fetch(base + '/api/v1/admin/users', { headers: headers(owner) })).status, 200);
    assert.equal(seen.at(-1).headers['x-teldrive-media-node'], undefined); assert.equal(seen.at(-1).headers.origin, primaryConfig.publicUrl);
    assert.equal((await fetch(base + '/api/v1/admin/users', { headers: headers(guest) })).status, 403);
    const count = seen.length;
    assert.equal((await fetch(base + '/api/v1/admin/users', { headers: { ...headers(owner), Origin: 'https://untrusted.example.com' } })).status, 403);
    assert.equal(seen.length, count, 'an untrusted browser origin never reaches the primary');
    const refresh = await fetch(base + '/api/v1/auth/refresh', { method: 'POST', headers: { ...headers(owner), 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: owner.refreshToken }) });
    assert.equal(refresh.status, 200); const pair = await refresh.json(); assert.ok(pair.accessToken);
    assert.equal((await fetch(base + '/api/v1/me', { headers: headers(pair) })).status, 200);
  } finally { await pc.close(); await primary.close(); await rm(directory, { recursive: true, force: true }); }
});

test('media node closes non-media routes, requires edge secret and cannot open a personal Telegram session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-media-node-'));
  const c = config({ CONFIG_FILE: 'none', DATA_DIR: directory, DATA_KEY: randomBytes(32).toString('base64'), TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef', MEDIA_ENABLED: 'false', PORT: '0', MEDIA_NODE: 'true', MEDIA_NODE_SECRET: secret, TELEGRAM_INSTANCE_ID: 'isolated-pc', DATABASE_URL: 'postgres://localhost/test', OWNER_USER_ID: '7' });
  const store = new Store(directory);
  store.put('settings', { id: 'limits', values: { concurrency: 1, mediaThreads: 8 } });
  const app = createApp(c, { store });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { 'X-Teldrive-Media-Node': secret };
  try {
    assert.equal((await fetch(base + '/internal/media/health')).status, 404);
    assert.equal((await fetch(base + '/api/v1/admin/users', { headers })).status, 503);
    assert.equal((await fetch(base + '/api/v1/auth/telegram/start', { method: 'POST', headers })).status, 503);
    assert.equal((await fetch(base + '/api/v1/files/file/content', { headers })).status, 401);
    const health = await (await fetch(base + '/internal/media/health', { headers })).json(); assert.equal(health.status, 'ok'); assert.equal(health.role, 'media');
    app.context.uploads.transfers.active = c.concurrency;
    assert.equal((await fetch(base + '/internal/media/health', { headers })).status, 503);
    app.context.uploads.transfers.active = 0;
    assert.equal(app.context.jobs.timer, undefined);
    assert.equal(c.concurrency, 2, 'a secondary keeps its own capacity profile'); assert.equal(c.mediaThreads, 1);
    let sessionOpened = false;
    const telegram = new Telegram({ get() { sessionOpened = true; }, list() { return []; } }, c);
    await assert.rejects(() => telegram.withClient('7', () => {}), { code: 'media_node_requires_bot' }); assert.equal(sessionOpened, false);
    await assert.rejects(() => telegram.withTransfer('7', 'download', () => {}), { code: 'media_node_requires_bot' }); assert.equal(sessionOpened, false);
    // Opting into an administrative portal preserves owner checks. Its local
    // settings must not alter the primary's shared-hosting limits.
    c.mediaNodeAdmin = true;
    const owner = app.context.auth.finish({ id: 7 }), guest = app.context.auth.finish({ id: 8 });
    for (const pair of [owner, guest]) app.context.auth.publish(pair, {}, false);
    const own = { ...headers, Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' };
    const other = { ...headers, Authorization: `Bearer ${guest.accessToken}` };
    assert.equal((await fetch(base + '/api/v1/admin/settings', { headers: own })).status, 200);
    assert.equal((await fetch(base + '/api/v1/admin/settings', { headers: other })).status, 403);
    const changed = await fetch(base + '/api/v1/admin/settings', { method: 'PATCH', headers: own, body: JSON.stringify({ concurrency: 4 }) });
    assert.equal(changed.status, 200); assert.equal(store.get('settings', 'limits').values.concurrency, 1);
    assert.equal(store.get('settings', 'limits:isolated-pc').values.concurrency, 4);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
