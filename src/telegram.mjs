import { createRequire } from 'node:module';
import { id, now, expires, expired, fail, CryptoBox, Locks } from './core.mjs';
const require = createRequire(import.meta.url);
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { computeCheck } = require('teleproto/Password');
const { CustomFile } = require('teleproto/client/uploads');

export function telegramError(error) {
  const text = error.errorMessage || '';
  if (/FLOOD|SLOWMODE/.test(text)) fail(429, 'telegram_rate_limit', `Telegram requires a wait of ${error.seconds || 'several'} seconds`);
  if (/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID/.test(text)) fail(401, 'invalid_code_or_password');
  if (/PHONE_CODE_EXPIRED/.test(text)) fail(410, 'login_expired');
  if (/EMAIL|CAPTCHA|SIGNUP/.test(text)) fail(422, 'telegram_challenge_unsupported', 'Complete the additional Telegram challenge in an official client');
  if (/AUTH_KEY|SESSION_REVOKED/.test(text)) fail(401, 'telegram_session_revoked');
  fail(503, 'telegram_unavailable', 'Telegram request failed; retry later');
}
export class Telegram {
  constructor(store, config) { this.store = store; this.config = config; this.box = new CryptoBox(config.key); this.locks = new Locks(); }
  make(session = '') {
    const client = new TelegramClient(new StringSession(session), this.config.apiId, this.config.apiHash, { connectionRetries: 3, requestRetries: 3, floodSleepThreshold: 0, useWSS: true });
    client.setLogLevel('none');
    return client;
  }
  async withClient(userId, fn) {
    return this.locks.run(`client:${userId}`, async () => {
      const user = this.store.get('users', userId);
      if (!user?.telegramSession) fail(401, 'telegram_login_required');
      const client = this.make(this.box.decode(user.telegramSession, `telegram:${userId}`));
      try { await client.connect(); return await fn(client); }
      catch (error) { if (error.status) throw error; telegramError(error); }
      finally { await client.disconnect(); }
    });
  }
  persistFlow(flow, client) { flow.state = this.box.encode({ ...flow.state, session: client.session.save() }, `flow:${flow.id}`); this.store.put('flows', flow); }
  flowResponse(flow) { return { flowId: flow.id, expiresAt: flow.expiresAt, passwordRequired: !!flow.passwordRequired, ...(flow.qr ? { state: flow.passwordRequired ? 'password_required' : 'pending', qrUrl: flow.qrUrl, qrExpiresAt: flow.qrExpiresAt } : {}) }; }
  async start(phoneNumber, qr = false) {
    if (!qr && !/^\+[1-9][0-9]{7,14}$/.test(phoneNumber || '')) fail(422, 'invalid_phone');
    const client = this.make();
    const flow = { id: id(), expiresAt: expires(600_000), createdAt: now(), qr, state: { phoneNumber } };
    try {
      await client.connect();
      if (qr) {
        const result = await client.invoke(new Api.auth.ExportLoginToken({ apiId: this.config.apiId, apiHash: this.config.apiHash, exceptIds: [] }));
        flow.qrUrl = `tg://login?token=${result.token.toString('base64url')}`; flow.qrExpiresAt = new Date(result.expires * 1000).toISOString();
      } else {
        const result = await client.sendCode({ apiId: this.config.apiId, apiHash: this.config.apiHash }, phoneNumber);
        flow.state.phoneCodeHash = result.phoneCodeHash;
      }
      this.persistFlow(flow, client); return this.flowResponse(flow);
    } catch (error) { if (error.status) throw error; telegramError(error); }
    finally { await client.disconnect(); }
  }
  async verify(flowId, type, value, finish) {
    return this.locks.run(`flow:${flowId}`, async () => {
      const flow = this.store.get('flows', flowId);
      if (!flow || expired(flow.expiresAt) || flow.used) fail(410, 'login_expired');
      flow.state = this.box.decode(flow.state, `flow:${flow.id}`);
      const client = this.make(flow.state.session);
      try {
        await client.connect();
        let result;
        if (type === 'code') {
          if (typeof value !== 'string' || !/^[0-9]{3,16}$/.test(value) || flow.qr) fail(422, 'invalid_code');
          result = await client.invoke(new Api.auth.SignIn({ phoneNumber: flow.state.phoneNumber, phoneCodeHash: flow.state.phoneCodeHash, phoneCode: value }));
        } else if (type === 'password') {
          if (!flow.passwordRequired || typeof value !== 'string' || !value || value.length > 1024) fail(422, 'invalid_password');
          const password = await client.invoke(new Api.account.GetPassword());
          result = await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(password, value) }));
        } else {
          if (!flow.qr) fail(422, 'invalid_flow_type');
          result = await client.invoke(new Api.auth.ExportLoginToken({ apiId: this.config.apiId, apiHash: this.config.apiHash, exceptIds: [] }));
          if (result instanceof Api.auth.LoginTokenMigrateTo) {
            await client._switchDC(result.dcId);
            result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
          }
          if (result instanceof Api.auth.LoginToken) {
            flow.qrUrl = `tg://login?token=${result.token.toString('base64url')}`; flow.qrExpiresAt = new Date(result.expires * 1000).toISOString();
            this.persistFlow(flow, client); return { pending: this.flowResponse(flow) };
          }
        }
        if (result instanceof Api.auth.AuthorizationSignUpRequired) fail(422, 'signup_not_supported');
        const me = await client.getMe(), pair = finish(me, client.session.save());
        flow.used = true; this.persistFlow(flow, client); return { pair };
      } catch (error) {
        if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') { flow.passwordRequired = true; this.persistFlow(flow, client); return { pending: this.flowResponse(flow) }; }
        if (error.status) throw error; telegramError(error);
      } finally { await client.disconnect(); }
    });
  }
  async discover(userId) {
    return this.withClient(userId, async client => (await client.getDialogs({ limit: 200 })).filter(d => d.entity instanceof Api.Channel && d.entity.broadcast && (d.entity.creator || d.entity.adminRights?.postMessages)).map(d => ({ id: String(d.entity.id), name: d.title })));
  }
  async channel(userId, body = {}) {
    return this.withClient(userId, async client => {
      const result = await client.invoke(new Api.channels.CreateChannel({ title: body.name || 'Teldrive Node.js', about: 'Private file storage', broadcast: true, megagroup: false }));
      const channel = result.chats.find(c => c instanceof Api.Channel);
      if (!channel) fail(503, 'channel_create_failed');
      return { id: String(channel.id), name: channel.title };
    });
  }
  async entity(client, channelId) {
    // Resolve each user's own dialogs; never rely on another user's entity cache.
    const dialogs = await client.getDialogs({ limit: 200 });
    const dialog = dialogs.find(d => String(d.entity.id) === String(channelId));
    if (!dialog || !(dialog.entity instanceof Api.Channel)) fail(404, 'channel_not_found');
    return dialog.entity;
  }
  async selected(userId) {
    let channel = this.store.list('channels', userId).find(c => c.selected);
    if (!channel) {
      const result = await this.channel(userId);
      channel = { ...result, ownerId: String(userId), selected: true, health: 'healthy', createdAt: now() };
      this.store.put('channels', channel);
    }
    return channel;
  }
  async upload(userId, filename, diskPath, size, channelId) {
    const channel = channelId ? { id: channelId } : await this.selected(userId);
    return this.withClient(userId, async client => {
      const entity = await this.entity(client, channel.id);
      const message = await client.sendFile(entity, { file: new CustomFile(filename, size, diskPath), forceDocument: true, workers: 1 });
      return { backend: 'telegram', channelId: channel.id, messageId: message.id, size };
    });
  }
  async clone(userId, part) {
    return this.withClient(userId, async client => {
      const entity = await this.entity(client, part.channelId);
      const [original] = await client.getMessages(entity, { ids: [part.messageId] });
      if (!original?.media?.document) fail(503, 'telegram_part_missing');
      const message = await client.sendFile(entity, { file: original.media, forceDocument: true });
      return { ...part, messageId: message.id };
    });
  }
  async read(userId, part, offset, length, write, signal) {
    return this.withClient(userId, async client => {
      const entity = await this.entity(client, part.channelId);
      const [message] = await client.getMessages(entity, { ids: [part.messageId] });
      if (!message?.media) fail(503, 'telegram_part_missing');
      let remaining = length;
      for await (const bytes of client.iterDownload(message, { offset, limit: length, requestSize: 512 * 1024, signal, requestTimeout: 30000 })) {
        if (signal?.aborted) break;
        const chunk = bytes.subarray(0, remaining); remaining -= chunk.length; await write(chunk);
        if (!remaining) break;
      }
      if (remaining && !signal?.aborted) fail(503, 'telegram_part_truncated');
    });
  }
  async describe(userId, parts) {
    return this.withClient(userId, async client => {
      const sizes = [];
      for (const part of parts) {
        const [message] = await client.getMessages(await this.entity(client, part.channelId), { ids: [part.messageId] });
        if (!message?.media?.document) fail(503, 'telegram_part_missing');
        const size = Number(message.media.document.size); if (!Number.isSafeInteger(size) || size < 0) fail(503, 'telegram_part_size_invalid'); sizes.push(size);
      }
      return sizes;
    });
  }
  async remove(userId, part) { return this.withClient(userId, async client => client.deleteMessages(await this.entity(client, part.channelId), [part.messageId], { revoke: true })); }
}
