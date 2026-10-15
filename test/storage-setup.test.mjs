import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

test('storage onboarding requires a selected channel, keeps bots optional and uses the destination owner for shared uploads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-storage-setup-'));
  const c = config({ CONFIG_FILE: 'none', DATA_DIR: directory, DATA_KEY: randomBytes(32).toString('base64'), TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef', MEDIA_ENABLED: 'false', OWNER_USER_ID: '7', PORT: '0' });
  const app = createApp(c);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const { auth, store, catalog, access } = app.context;
  const owner = auth.finish({ id: 7, firstName: 'Owner' }), guest = auth.finish({ id: 8, firstName: 'Guest' });
  for (const pair of [owner, guest]) auth.publish(pair, {}, false);
  const request = (pair, endpoint, method = 'GET', body) => fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${pair.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.deepEqual(await (await request(owner, '/me/storage')).json(), { requiresChannel: true, configured: false });
    const uploadBody = { name: 'sample.txt', size: 3 };
    assert.equal((await request(owner, '/uploads', 'POST', uploadBody)).status, 409);
    assert.equal(store.list('uploads').length, 0);
    store.put('channels', { id: '99', ownerId: '7', name: 'Private disk', selected: false });
    assert.equal((await request(owner, '/uploads', 'POST', uploadBody)).status, 409, 'merely syncing a channel is insufficient');
    assert.equal((await request(owner, '/channels/99/select', 'POST')).status, 200);
    assert.equal(store.list('bots', '7').length, 0);
    assert.deepEqual(await (await request(owner, '/me/storage')).json(), { requiresChannel: true, configured: true });
    const created = await (await request(owner, '/uploads', 'POST', uploadBody)).json();
    assert.equal(store.get('uploads', created.id).channelId, '99', 'a configured account needs no bots');
    store.put('channels', { id: '100', ownerId: '7', name: 'Another disk', selected: false });
    await request(owner, '/channels/100/select', 'POST');
    assert.equal(store.get('uploads', created.id).channelId, '99', 'the upload keeps its initial destination');
    const folder = catalog.create('7', { name: 'Shared destination' });
    assert.equal((await request(guest, `/me/storage?parentId=${folder.id}`)).status, 404, 'foreign destinations require access');
    access.create('7', folder.id, { granteeUserId: 8, permission: 'edit' });
    assert.deepEqual(await (await request(guest, '/me/storage')).json(), { requiresChannel: true, configured: false });
    assert.deepEqual(await (await request(guest, `/me/storage?parentId=${folder.id}`)).json(), { requiresChannel: true, configured: true });
    assert.equal((await request(guest, '/uploads', 'POST', { ...uploadBody, parentId: folder.id })).status, 201);
    const client = auth.session('8', { scope: 'client' }); auth.publish(client, {}, false);
    assert.equal((await request(client, '/me/storage')).status, 200);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
