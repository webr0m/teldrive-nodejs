import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.mjs';
import { ServerConfiguration, KEEP_SECRET } from '../src/server-configuration.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-configuration-'));
  const env = { CONFIG_FILE: 'none', SERVER_CONFIG_FILE: path.join(directory, 'private.toml'), SERVER_RESTART_FILE: path.join(directory, 'tmp/restart.txt'),
    DATA_KEY: randomBytes(32).toString('base64'), DATA_DIR: directory, STORAGE_BACKEND: 'local', MEDIA_ENABLED: 'false', PORT: '0', OWNER_USER_ID: '7',
    TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef', DATABASE_URL: '', PUBLIC_URL: 'http://127.0.0.1:3000' };
  try { await run(env); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('private TOML validates without writing, masks secrets, detects conflicts and restores across restart', () => fixture(async env => {
  const c = config(env), manager = new ServerConfiguration(c), initial = manager.read();
  assert.ok(initial.toml.includes(KEEP_SECRET)); assert.ok(!initial.toml.includes(env.DATA_KEY)); assert.ok(!initial.toml.includes(env.TELEGRAM_API_HASH));
  const request = { revision: initial.revision, toml: '[node]\npublic-url="https://next.example"\n[node.google]\nclient-id="test-client"\nclient-secret="test-server-secret"' };
  assert.equal(manager.save({ revision: initial.revision, toml: initial.toml }).restartRequired, false, 'saving unchanged configuration creates no pending restart');
  assert.equal(manager.validate(request).connectionTested, false);
  assert.equal(manager.read().revision, initial.revision);
  assert.throws(() => manager.save({ ...request, toml: '[node]\npublic-url = "secret-invalid-source' }), { code: 'invalid_toml' });
  assert.throws(() => manager.save({ ...request, toml: '[node]\ndata-key="changed"' }), { code: 'protected_configuration' });
  assert.throws(() => manager.save({ ...request, toml: '[node.limits]\nconcurrent-transfers=0' }), { code: 'invalid_configuration' });
  assert.throws(() => manager.save({ ...request, toml: '[media]\nenabled="perhaps"' }), { code: 'invalid_configuration_boolean' });
  let saved = manager.save(request);
  assert.equal(saved.restartRequired, true); assert.equal(c.publicUrl, 'http://127.0.0.1:3000');
  assert.equal(saved.backups.length, 1); assert.ok(!saved.toml.includes('test-server-secret'));
  assert.throws(() => manager.save(request), { code: 'configuration_changed' });
  assert.equal(manager.read().revision, saved.revision);
  const restarted = config(env), second = new ServerConfiguration(restarted);
  assert.equal(restarted.publicUrl, 'https://next.example'); assert.equal(restarted.googleClientSecret, 'test-server-secret'); assert.equal(second.read().restartRequired, false);
  saved = second.save({ revision: saved.revision, toml: saved.toml.replace('https://next.example', 'https://third.example') });
  assert.equal(config(env).googleClientSecret, 'test-server-secret', 'redacted editor retains the actual secret');
  assert.throws(() => second.restore({ revision: saved.revision, backupId: '../private.toml' }), { code: 'configuration_backup_not_found' });
  const restored = second.restore({ revision: saved.revision, backupId: saved.backups.at(-1).id, confirmDatabaseChange: true });
  assert.equal(config(env).publicUrl, 'http://127.0.0.1:3000'); assert.ok(!restored.toml.includes('test-client'));
  second.restart({ revision: restored.revision }); assert.ok(await readFile(env.SERVER_RESTART_FILE, 'utf8'));
  if (process.platform !== 'win32') assert.equal((await stat(env.SERVER_CONFIG_FILE)).mode & 0o777, 0o600);
}));

test('database changes require explicit confirmation and preserve existing keys; unsupported imports need acknowledgement', () => fixture(async env => {
  const manager = new ServerConfiguration(config(env)), initial = manager.read();
  const request = { revision: initial.revision, toml: '[database]\nurl="postgresql://user:test-db-password@db.example/drive"\n[node]\ndatabase-layout="native"\n[logging]\nlog-level="info"' };
  const checked = manager.validate(request);
  assert.equal(checked.databaseChanged, true); assert.deepEqual(checked.ignored, ['logging.log-level']);
  assert.throws(() => manager.save(request), { code: 'unsupported_configuration' });
  assert.throws(() => manager.save({ ...request, discardUnsupported: true }), { code: 'database_change_confirmation_required' });
  const saved = manager.save({ ...request, discardUnsupported: true, confirmDatabaseChange: true });
  assert.ok(!saved.toml.includes('test-db-password')); assert.equal(config(env).key.toString('base64'), env.DATA_KEY);
  assert.equal(config(env).databaseUrl, 'postgresql://user:test-db-password@db.example/drive');
}));

test('only the pinned owner can manage limits, users or server TOML; client sessions and API keys cannot edit credentials', () => fixture(async env => {
  const c = config(env), app = createApp(c);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const auth = app.context.auth;
  const other = auth.finish({ id: 8, firstName: 'First visitor', username: 'webrom' });
  assert.equal(app.context.store.get('users', '8').role, 'user', 'the first visitor cannot become owner when an ID is pinned');
  const owner = auth.finish({ id: 7, firstName: 'Owner' });
  for (const pair of [other, owner]) auth.publish(pair, {}, false);
  const user = app.context.store.get('users', '8'); user.role = 'admin'; app.context.store.put('users', user);
  assert.ok(!auth.profile(user).capabilities.includes('system.manageUsers'));
  assert.ok(!auth.profile(user).capabilities.includes('system.configureServer'));
  async function request(pair, route, method = 'GET', body, headers = {}) {
    return fetch(base + route, { method, headers: { Authorization: `Bearer ${pair.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  }
  try {
    const paths = [['/admin/settings', 'GET'], ['/admin/settings', 'PATCH', { concurrency: 3 }], ['/admin/users', 'GET'], ['/admin/users/7', 'PATCH', { disabled: true }], ['/admin/users/7/revoke-access', 'POST'], ['/admin/configuration', 'GET'], ['/admin/configuration/save', 'POST', {}]];
    for (const role of ['admin', 'user', 'owner']) {
      user.role = role; app.context.store.put('users', user);
      for (const [route, method, body] of paths) assert.equal((await request(other, route, method, body)).status, 403, `${role} cannot ${method} ${route}`);
    }
    assert.equal((await request(owner, '/admin/users')).status, 200);
    assert.equal((await request(owner, '/admin/settings')).status, 200);
    const state = await (await request(owner, '/admin/configuration')).json();
    const body = { revision: state.revision, toml: '[node]\npublic-url="https://next.example"' };
    assert.equal((await request(owner, '/admin/configuration/save', 'POST', body)).status, 403, 'requires a custom CSRF header');
    assert.equal((await request(owner, '/admin/configuration/save', 'POST', body, { 'X-Teldrive-Config': '1' })).status, 200);
    const client = auth.session('7', { scope: 'client' }); auth.publish(client, {}, false);
    assert.equal((await request(client, '/admin/configuration')).status, 403);
    assert.equal((await request(client, '/admin/users')).status, 403);
    const key = await (await request(owner, '/api-keys', 'POST', { name: 'Test' })).json();
    assert.equal((await fetch(base + '/admin/configuration', { headers: { 'X-Api-Key': key.secret } })).status, 403);
  } finally { await app.close(); }
}));
