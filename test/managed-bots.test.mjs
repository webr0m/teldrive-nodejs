import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ManagedBots } from '../src/managed-bots.mjs';
import { Telegram } from '../src/telegram.mjs';
const { Api } = createRequire(import.meta.url)('teleproto');

import { fixture } from './fixtures/managed-bots.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

test('real user-session wrapper preserves managed-bot RPC errors instead of replacing them with a generic server failure', async () => {
  const f=fixture();await f.managed.select('7','10001');
  f.store.put('users',{id:'7',telegramSession:f.telegram.box.encode('fixture','telegram:7')});
  f.telegram.withClient=Telegram.prototype.withClient;
  const owned=[f.administrator,...Array.from({length:39},(_,i)=>({id:20000+i,username:`existing_${i}_bot`}))];
  let code='BOT_CREATE_LIMIT_EXCEEDED',disconnected=0;
  f.telegram.make=()=>({connect:async()=>{},disconnect:async()=>{disconnected++},invoke:async request=>{
    request.getBytes();
    if(request instanceof Api.bots.GetAdminedBots)return owned;
    if(request instanceof Api.bots.CheckUsername)return true;
    assert.ok(request instanceof Api.bots.CreateBot);throw {errorMessage:code,seconds:31};
  }});
  for(const [rpc,status,expected] of [['BOT_CREATE_LIMIT_EXCEEDED',409,'bot_creation_limit'],['MANAGER_PERMISSION_MISSING',422,'bot_manager_mode_required'],['USERNAME_OCCUPIED',409,'bot_username_occupied'],['FLOOD_WAIT_31',429,'bot_rate_limit']]){
    code=rpc;await assert.rejects(()=>f.managed.create('7',f.input),error=>{
      assert.equal(error.status,status);assert.equal(error.code,expected);
      if(rpc==='BOT_CREATE_LIMIT_EXCEEDED'){assert.match(error.message,/40 bots/);assert.match(error.message,/BotFather/);assert.doesNotMatch(error.message,/fixture-token/);}
      return true;
    });
  }
  await assert.rejects(()=>f.telegram.withClient('7',()=>{throw {errorMessage:'UNKNOWN_RPC'}}),{status:503,code:'telegram_unavailable'});
  assert.equal(disconnected,5);assert.equal(f.managed.read('7').pending.length,0);
});

test('manager selection checks ownership and management mode, without exposing credentials or changing other accounts', async () => {
  const f = fixture();
  assert.equal(f.managed.read('7').configured, false);
  await assert.rejects(() => f.managed.select('8', '10001'), { code: 'bot_manager_not_found' });
  f.administrator.botCanManageBots = false;
  await assert.rejects(() => f.managed.select('7', '10001'), { code: 'bot_manager_mode_required' });
  assert.equal(f.managed.read('7').configured, false);
  f.administrator.botCanManageBots = true;
  const result = await f.managed.select('7', 10001);
  assert.equal(result.configured, true); assert.equal(result.bot.username, 'manager_bot');
  assert.equal(JSON.stringify(result).includes('token'), false); assert.equal(f.managed.read('8').configured, false);
  await f.managed.clear('7'); assert.equal(f.managed.read('7').configured, false); assert.ok(f.store.get('bots', '10001'));
});

test('creation validates user/channel ownership and inputs before making a bot in Telegram', async () => {
  const f = fixture();
  await assert.rejects(() => f.managed.create('7', f.input), { code: 'bot_manager_required' });
  await f.managed.select('7', '10001');
  for (const change of [{ name: '' }, { name: 'n'.repeat(65) }, { username: 'invalid' }, { username: 'a'.repeat(33) + 'bot' }]) {
    await assert.rejects(() => f.managed.create('7', { ...f.input, ...change }), error => error.status === 422);
  }
  await assert.rejects(() => f.managed.create('8', f.input), { code: 'bot_channel_not_found' });
  await assert.rejects(() => f.managed.create('7', { ...f.input, channelId: 'someone-else' }), { code: 'bot_channel_not_found' });
  f.telegram.entity = async () => ({ username: 'public_channel', creator: true });
  await assert.rejects(() => f.managed.create('7', f.input), { code: 'bot_private_channel_required' });
  f.telegram.entity = async () => ({ broadcast: true });
  await assert.rejects(() => f.managed.create('7', f.input), { code: 'bot_channel_permission' });
  assert.equal(f.count(), 0);
});

test('creation exports without rotating, encrypts the token, configures only the chosen channel and is recoverable by username', async () => {
  const f = fixture(); await f.managed.select('7', '10001');
  f.store.put('channels', { id: '100', ownerId: '7', name: 'Other channel' });
  const first = await f.managed.create('7', { ...f.input, username: '@My_Storage_Bot' });
  assert.equal(first.setupPending, false); assert.equal(first.bot.username, 'my_storage_bot'); assert.equal(f.count(), 1);
  const bot = f.store.get('bots', '10002');
  assert.notEqual(bot.tokenCiphertext, f.token); assert.equal(f.telegram.secureBlob.open(bot.tokenCiphertext, 'bot-token').toString(), f.token);
  assert.equal(JSON.stringify(first).includes(f.token), false);
  assert.deepEqual(f.store.get('bot-state', 'bot-channels:10002').channelIds, ['99']);
  assert.equal(f.calls.filter(request => request instanceof Api.channels.InviteToChannel).length, 1);
  const again = await f.managed.create('7', f.input);
  assert.equal(again.setupPending, false); assert.equal(f.count(), 1); assert.deepEqual(f.managed.read('7').pending, []);
  assert.equal(f.telegram.eligibleBots('7', 'download', ['99']).some(candidate => candidate.id === '10002'), true);
  assert.equal(f.telegram.eligibleBots('7', 'download', ['100']).some(candidate => candidate.id === '10002'), false);
});

test('a partial channel failure survives refresh and retry without creating another bot or leaking its token', async () => {
  const f = fixture(); await f.managed.select('7', '10001'); f.failPermission(true);
  const partial = await f.managed.create('7', f.input);
  assert.equal(partial.setupPending, true); assert.equal(f.count(), 1); assert.match(partial.message, /mismo usuario/);
  assert.equal(f.store.get('bots', '10002'), undefined); assert.equal(f.managed.read('7').pending[0].username, f.input.username);
  assert.equal(f.managed.read('8').pending.length, 0);
  assert.equal(JSON.stringify([...f.store.list('settings', '7')]).includes(f.token), false);
  f.failPermission(false);
  const recovered = await new ManagedBots(f.store, f.telegram).create('7', f.input);
  assert.equal(recovered.setupPending, false); assert.equal(f.count(), 1);
});

test('lost creation responses and concurrent repeated submissions reuse the Telegram-owned bot', async () => {
  const f = fixture(); await f.managed.select('7', '10001'); f.loseResponse();
  await assert.rejects(() => f.managed.create('7', f.input), { code: 'bot_telegram_unavailable' });
  const [a, b] = await Promise.all([f.managed.create('7', f.input), f.managed.create('7', f.input)]);
  assert.equal(a.bot.id, b.bot.id); assert.equal(a.setupPending, false); assert.equal(f.count(), 1);
});

test('Telegram creation limits and unavailable usernames return useful errors without a false success', async () => {
  const f = fixture(); await f.managed.select('7', '10001');
  f.telegram.withClient = async (_user, fn) => fn({ invoke: async request => {
    if (request instanceof Api.bots.GetAdminedBots) return [f.administrator];
    throw { errorMessage: 'BOT_CREATE_LIMIT_EXCEEDED' };
  } });
  await assert.rejects(() => f.managed.create('7', f.input), { code: 'bot_creation_limit', status: 409 });
  f.telegram.withClient = async (_user, fn) => fn({ invoke: async () => { throw { errorMessage: 'USERNAME_OCCUPIED' }; } });
  await assert.rejects(() => f.managed.checkUsername('7', 'other_storage_bot'), { code: 'bot_username_occupied', status: 409 });
  assert.equal(f.count(), 0);
});

test('HTTP bot management supports client sessions, rejects foreign managers and replays creation without exposing credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'td-managed-bots-'));
  const f = fixture();
  const c = config({ CONFIG_FILE: 'none', DATA_DIR: directory, DATA_KEY: randomBytes(32).toString('base64'), PORT: '0', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: '0'.repeat(32), MEDIA_ENABLED: 'false', OWNER_USER_ID: '7' });
  const app = createApp(c, { store: f.store, telegram: f.telegram });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1/bots`;
  const own = app.context.auth.finish({ id: 7 }), other = app.context.auth.finish({ id: 8 });
  for (const pair of [own, other]) app.context.auth.publish(pair, {}, false);
  const headers = pair => ({ Authorization: `Bearer ${pair.accessToken}`, 'Content-Type': 'application/json', 'X-Teldrive-Client': 'mobile' });
  try {
    assert.equal((await fetch(base + '/manager')).status, 401);
    assert.equal((await fetch(base + '/manager', { method: 'POST', headers: headers(other), body: JSON.stringify({ botId: 10001 }) })).status, 404);
    assert.equal((await fetch(base + '/manager', { method: 'POST', headers: headers(own), body: JSON.stringify({ botId: 10001 }) })).status, 200);
    const body = JSON.stringify(f.input), idempotent = { ...headers(own), 'Idempotency-Key': 'f1b30aad-e67d-4143-92bb-8fb3ffda4932' };
    const first = await fetch(base + '/managed', { method: 'POST', headers: idempotent, body });
    assert.equal(first.status, 201); const firstBody = await first.text(); assert.equal(firstBody.includes(f.token), false);
    const replay = await fetch(base + '/managed', { method: 'POST', headers: idempotent, body });
    assert.equal(replay.status, 201); assert.equal(await replay.text(), firstBody); assert.equal(f.count(), 1);
    const listed = await (await fetch(base, { headers: headers(own) })).json();
    assert.deepEqual(listed.items.map(({ id, name, username }) => ({ id, name, username })), [
      { id: 10001, name: 'Administrador de archivos', username: 'manager_bot' },
      { id: 10002, name: f.input.name, username: f.input.username },
    ]);
    assert.equal(JSON.stringify(listed).includes(f.token), false);
    const otherRead = await (await fetch(base + '/manager', { headers: headers(other) })).json();
    assert.equal(otherRead.configured, false); assert.equal(otherRead.pending.length, 0);
    const rejected = await fetch(base + '/managed', { method: 'POST', headers: headers(other), body }); assert.equal(rejected.status, 404);
  } finally {
    await app.close();
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('td-managed-bots-')) throw new Error('Invalid test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});
