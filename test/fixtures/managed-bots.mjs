import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {ManagedBots} from '../../src/managed-bots.mjs';
import {Telegram} from '../../src/telegram.mjs';
const {Api}=createRequire(import.meta.url)('teleproto');

export function fixture() {
  const records = new Map(), calls = [];
  const store = {
    get: (bucket, id) => records.get(`${bucket}:${id}`),
    put: (bucket, record) => { records.set(`${bucket}:${record.id}`, structuredClone(record)); return record; },
    delete: (bucket, id) => records.delete(`${bucket}:${id}`),
    list: (bucket, owner) => [...records.entries()].filter(([key, record]) => key.startsWith(`${bucket}:`) && (owner === undefined || (record.ownerId ?? record.userId) === owner)).map(([, record]) => structuredClone(record)),
    transaction: fn => fn(),
    ready: () => {}, close: () => {},
  };
  const telegram = new Telegram(store, { key: randomBytes(32), apiId: 1, apiHash: '0'.repeat(32), telegramInstanceId: 'test-managed', botClientPoolSize: 0 });
  const administrator = new Api.User({ id: 10001, accessHash: 123, username: 'manager_bot', bot: true, botCanManageBots: true });
  const owned = [administrator];
  let count = 0, permissionFailure = false, loseCreationResponse = false;
  const token = `10002:${'x'.repeat(35)}`;
  store.put('bots', { id: '10001', ownerId: '7', username: administrator.username, enabled: true, createdAt: new Date().toISOString(), tokenCiphertext: 'encrypted-manager-token' });
  store.put('channels', { id: '99', ownerId: '7', name: 'Private storage', selected: true });
  const owner = {
    getInputEntity: async () => new Api.InputPeerUser({ userId: 10002, accessHash: 123 }),
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.bots.GetAdminedBots) return owned;
      if (request instanceof Api.bots.CheckUsername) return true;
      if (request instanceof Api.bots.CreateBot) {
        count++;
        const bot = new Api.User({ id: 10002, accessHash: 123, bot: true, username: request.username }); owned.push(bot);
        if (loseCreationResponse) throw new Error('Connection lost after Telegram created bot');
        return bot;
      }
      if (request instanceof Api.channels.EditAdmin && permissionFailure) throw { errorMessage: 'CHAT_ADMIN_REQUIRED' };
      return true;
    },
  };
  const managerClient = {
    getMe: async () => administrator,
    getInputEntity: async () => new Api.InputPeerUser({ userId: 10002, accessHash: 123 }),
    invoke: async request => { calls.push(request); assert.ok(request instanceof Api.bots.ExportBotToken); assert.equal(request.revoke, false); return { token }; },
  };
  telegram.withClient = async (_user, fn) => fn(owner);
  telegram.withBot = async (_bot, fn) => fn(managerClient);
  telegram.entity = async () => new Api.Channel({ id: 99, accessHash: 123, title: 'Private', date: 0, creator: true, broadcast: true });
  telegram.make = () => ({ connect: async () => {}, disconnect: async () => {}, session: { save: () => 'test-dedicated-key' }, invoke: async request => {
    assert.ok(request instanceof Api.auth.ImportBotAuthorization); assert.equal(request.botAuthToken, token);
    return { user: owned.at(-1) };
  } });
  const managed = new ManagedBots(store, telegram);
  return { managed, telegram, store, calls, administrator, owned, count: () => count, failPermission: value => permissionFailure = value, loseResponse: () => loseCreationResponse = true,
    input: { name: 'My storage', username: 'my_storage_bot', channelId: '99' }, token };
}
