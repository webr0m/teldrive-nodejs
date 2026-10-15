import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { config as readConfig } from './config.mjs';
import { Store, fail, now, id, hash, token, date, page, number, expires, expired } from './core.mjs';
import { Auth, cookies } from './auth.mjs';
import { Catalog } from './catalog.mjs';
import { Telegram } from './telegram.mjs';
import { Storage } from './storage.mjs';
import { Uploads } from './uploads.mjs';
import { Shares } from './shares.mjs';
import { Access } from './access.mjs';
import { Jobs } from './jobs.mjs';
import { Rclone } from './rclone.mjs';
import { Settings } from './settings.mjs';
import { Playback } from './playback.mjs';
import { Media } from './media.mjs';
import { gateway } from './gateway.mjs';
import { PostgresStore } from './postgres.mjs';
import { SupabaseStore } from './supabase.mjs';
import { AssetCache } from './assets.mjs';
import packageInfo from '../package.json' with { type: 'json' };

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export const routes = [];
const definitions = [];
function route(method, pattern, handler, { public: open = false, raw = false, ticket = false } = {}) {
  definitions.push({ method, pattern, handler, open, raw, ticket, regex: new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), params: [...pattern.matchAll(/:([a-zA-Z]+)/g)].map(m => m[1]) });
  routes.push({ method, path: pattern });
}
const result = (body, status = 200, headers = {}) => ({ body, status, headers });
const empty = () => result(undefined, 204);
const admin = user => { if (!['owner', 'admin'].includes(user.role)) fail(403, 'administrator_required'); };
const validateIds = body => { if (!Array.isArray(body.fileIds) || !body.fileIds.length || body.fileIds.length > 500 || body.fileIds.some(v => typeof v !== 'string')) fail(422, 'invalid_file_ids'); return [...new Set(body.fileIds)]; };
const metadata = (c, file, status = 200) => result(c.catalog.public(file), status, { ETag: c.catalog.etag(file), ...(status === 201 ? { Location: `/api/v1/files/${file.id}` } : {}) });
const publicShare = c => c.shares.resolve(c.params.shareToken, c.req.headers['x-share-password'], cookies(c.req).td_share_session);
const parentOwner = (c, parentId, ownerId = c.user.id) => {
  if (!parentId) { if (String(ownerId) !== String(c.user.id)) fail(403, 'shared_destination_required'); return c.user.id; }
  return c.access.authorize(c.user.id, parentId, true).ownerId;
};

route('GET', '/api/health/live', () => result({ status: 'ok', version: `node-${packageInfo.version}` }), { public: true });
route('GET', '/api/health/ready', c => { c.store.ready(); return result({ status: 'ok', version: `node-${packageInfo.version}` }); }, { public: true });
route('GET', '/api/config', c => result({ mode: 'native', storage: c.config.backend, demo: c.config.demo, partSize: c.config.partSize, maxFileSize: c.config.maxFileSize, maxConcurrentTransfers: c.config.concurrency, uploadRetryAttempts: c.config.uploadRetryAttempts, rcloneAgentOrigin: c.config.rcloneAgentOrigin }), { public: true });
route('POST', '/api/v1/rclone/actions', async c => {
  admin(c.user); if(c.apiKey) fail(403, 'session_required');
  return result(await c.rclone.request(c.user.id, c.body.method, c.body.params));
});
route('PUT', '/api/v1/rclone/staging/:filename', async c => { admin(c.user); if(c.apiKey)fail(403,'session_required'); return result(await c.rclone.stage(c.user.id,c.params.filename,c.req),201); }, { raw: true });
route('GET','/api/v1/rclone/local-content',async c=>{admin(c.user);if(c.apiKey)fail(403,'session_required');const file=await c.rclone.localPath(c.user.id,c.query.get('path'));const info=await stat(file);if(!info.isFile())fail(422,'not_a_file');c.res.setHeader('Content-Type','application/octet-stream');c.res.setHeader('Content-Length',info.size);c.res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);await pipeline(createReadStream(file),c.res);});
route('POST', '/api/dev/login', c => { if (!c.config.demo) fail(404, 'not_found'); return result(c.auth.publish(c.auth.finish({ id: 1, firstName: 'Demo local' }), c.res, true)); }, { public: true });
route('POST', '/api/v1/auth/telegram/start', async c => { if (c.config.backend !== 'telegram') fail(503, 'telegram_not_configured'); return result(await c.telegram.start(c.body.phoneNumber), 201); }, { public: true });
route('POST', '/api/v1/auth/telegram/qr/start', async c => { if (c.config.backend !== 'telegram') fail(503, 'telegram_not_configured'); return result(await c.telegram.start(undefined, true), 201); }, { public: true });
for (const [suffix, type] of [['verify-code', 'code'], ['verify-password', 'password'], ['qr/poll', 'qr']]) {
  for (const cookie of [false, true]) {
    route('POST', `/api/v1/auth/${cookie ? 'cookie/' : ''}telegram/${suffix}`, async c => {
      if (c.config.backend !== 'telegram') fail(503, 'telegram_not_configured');
      const response = await c.telegram.verify(c.body.flowId, type, c.body[type], (me, session) => c.auth.finish(me, session));
      return response.pending ? result(response.pending, 202) : result(c.auth.publish(response.pair, c.res, cookie));
    }, { public: true });
  }
}
for (const cookie of [false, true]) route('POST', `/api/v1/auth/${cookie ? 'cookie/' : ''}refresh`, c => result(c.auth.publish(c.auth.refresh(cookie ? cookies(c.req).teldrive_refresh : c.body.refreshToken), c.res, cookie)), { public: true });
for (const p of ['/api/v1/auth/logout', '/api/v1/auth/cookie/logout']) route('POST', p, c => { c.auth.revoke(c.session); c.auth.clear(c.res); return empty(); });
route('GET', '/api/v1/me', c => result(c.auth.profile(c.user)));
route('GET', '/api/v1/me/photo', () => empty());
route('GET', '/api/v1/sessions', c => result(page(c.store.list('sessions', c.user.id).filter(s => !s.revokedAt).map(s => ({ id: s.id, current: s.id === c.session?.id, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt })), c.query)));
route('DELETE', '/api/v1/sessions/:sessionId', c => { const s = c.store.get('sessions', c.params.sessionId); if (!s || s.userId !== c.user.id) fail(404, 'session_not_found'); c.auth.revoke(s); return empty(); });
route('POST', '/api/v1/api-keys', c => {
  if (c.apiKey) fail(403, 'session_required');
  if (typeof c.body.name !== 'string' || !c.body.name.trim() || c.body.name.length > 120) fail(422, 'invalid_key_name');
  const secret = token(), key = { id: hash(secret), keyId: id(), userId: c.user.id, name: c.body.name, createdAt: now(), expiresAt: c.body.expiresAt === undefined ? undefined : date(c.body.expiresAt) };
  c.store.put('keys', key); return result({ id: key.keyId, name: key.name, secret, createdAt: key.createdAt, expiresAt: key.expiresAt }, 201);
});
route('GET', '/api/v1/api-keys', c => result(page(c.store.list('keys', c.user.id).filter(k => !k.revokedAt).map(({ id, keyId, userId, ...k }) => ({ id: keyId, ...k })), c.query)));
route('DELETE', '/api/v1/api-keys/:keyId', c => { const k = c.store.list('keys', c.user.id).find(k => k.keyId === c.params.keyId); if (!k) fail(404, 'key_not_found'); k.revokedAt = now(); c.store.put('keys', k); return empty(); });
route('GET', '/api/v1/admin/settings', c => { admin(c.user); return result(c.settings.read()); });
route('GET', '/api/v1/jobs', c => { admin(c.user); c.jobs.wake(); return result(c.jobs.list(c.user.id,c.query)); });
route('POST', '/api/v1/jobs', c => { admin(c.user); return result(c.jobs.create(c.user.id,c.body),201); });
route('GET', '/api/v1/jobs/statistics', c => { admin(c.user); return result(c.jobs.statistics(c.user.id)); });
route('GET', '/api/v1/jobs/queues', c => { admin(c.user); return result(c.jobs.queues(c.user.id)); });
for (const action of ['pause','resume']) route('POST',`/api/v1/jobs/queues/:queue/${action}`,c=>{admin(c.user);c.jobs.pause(c.user.id,c.params.queue,action==='pause');if(action==='resume')c.jobs.wake();return empty();});
route('DELETE','/api/v1/jobs/purge',c=>{admin(c.user);return result(c.jobs.purge(c.user.id,c.query.get('status')));});
route('GET','/api/v1/jobs/:jobId',c=>{admin(c.user);return result(c.jobs.public(c.jobs.get(c.user.id,c.params.jobId)));});
for(const action of ['cancel','retry'])route('POST',`/api/v1/jobs/:jobId/${action}`,c=>{admin(c.user);return result(c.jobs[action](c.user.id,c.params.jobId));});
route('DELETE','/api/v1/jobs/:jobId',c=>{admin(c.user);c.jobs.delete(c.user.id,c.params.jobId);return empty();});
route('PATCH', '/api/v1/admin/settings', c => result(c.settings.update(c.user, c.body)));
route('GET', '/api/v1/admin/users', c => { admin(c.user); return result(c.store.list('users').map(u => ({ ...c.auth.profile(u), disabled: !!u.disabled, updatedAt: u.updatedAt }))); });
route('PATCH', '/api/v1/admin/users/:userId', c => {
  admin(c.user); const user = c.store.get('users', c.params.userId); if (!user) fail(404, 'user_not_found');
  if (user.role === 'owner' || c.body.role === 'owner') fail(403, 'owner_role_protected');
  if (c.body.role !== undefined && !['user', 'admin'].includes(c.body.role)) fail(422, 'invalid_role');
  if (c.user.role !== 'owner' && c.body.role !== undefined) fail(403, 'owner_required');
  if (c.body.disabled !== undefined && typeof c.body.disabled !== 'boolean') fail(422, 'invalid_disabled');
  Object.assign(user, { role: c.body.role ?? user.role, disabled: c.body.disabled ?? user.disabled, updatedAt: now() }); c.store.put('users', user);
  return result({ ...c.auth.profile(user), disabled: !!user.disabled, updatedAt: user.updatedAt });
});
route('POST', '/api/v1/admin/users/:userId/revoke-access', c => { admin(c.user); const user = c.store.get('users', c.params.userId); if (!user) fail(404, 'user_not_found'); if (user.role === 'owner') fail(403, 'owner_role_protected'); for (const s of c.store.list('sessions', user.id)) c.auth.revoke(s); for (const key of c.store.list('keys', user.id)) { key.revokedAt = now(); c.store.put('keys', key); } return empty(); });
route('GET', '/api/v1/users/search', c => { if (!c.query.get('search')) fail(422, 'search_required'); return result(c.store.list('users').filter(u => !u.disabled && `${u.id} ${u.username || ''} ${u.displayName}`.toLowerCase().includes(c.query.get('search').toLowerCase())).slice(0, 100).map(u => ({ userId: Number(u.id), displayName: u.displayName, username: u.username }))); });

route('GET', '/api/v1/files', c => {
  const parentId = c.query.get('parentId'), file = parentId ? c.access.authorize(c.user.id, parentId) : undefined;
  if (file && file.ownerId !== c.user.id && (c.query.has('path') || c.query.get('scope') === 'drive' || (c.query.get('status') || 'active') !== 'active')) fail(422, 'shared_parent_required');
  return result(page(c.catalog.list(file?.ownerId || c.user.id, c.query), c.query));
});
route('GET', '/api/v1/files/statistics/drive', c => result(c.catalog.statistics(c.user.id)));
route('GET', '/api/v1/files/statistics/categories', c => result(c.catalog.categories(c.user.id)));
route('GET', '/api/v1/storage/stats', c => result(c.catalog.dashboard(c.user.id)));
route('POST', '/api/v1/folders', c => metadata(c, c.catalog.create(parentOwner(c, c.body.parentId), c.body), 201));
for (const method of ['POST', 'DELETE']) route(method, '/api/v1/files/bookmarks', c => { const fileIds = validateIds(c.body); c.store.transaction(() => { for (const fileId of fileIds) { const f = c.catalog.get(c.user.id, fileId, true); f.bookmark = method === 'POST'; c.store.put('files', f); } }); return empty(); });
for (const action of ['move', 'trash','spam']) route('POST', `/api/v1/files/bulk/${action}`, c => result({ items: c.store.transaction(() => validateIds(c.body).map(fileId => c.catalog.public(action === 'move' ? c.catalog.move(c.user.id, fileId, c.body) : c.catalog[action](c.user.id, fileId)))) }));
route('DELETE', '/api/v1/files/trash', async c => { for (const f of c.catalog.all(c.user.id).filter(f => f.status === 'trashed')) if (c.store.get('files', f.id)) await c.uploads.purge(c.user.id, f.id); return empty(); });
route('GET', '/api/v1/files/:fileId', c => metadata(c, c.access.authorize(c.user.id, c.params.fileId, false, false)));
route('PATCH', '/api/v1/files/:fileId', c => metadata(c, c.catalog.update(c.access.authorize(c.user.id, c.params.fileId, true).ownerId, c.params.fileId, c.body, c.req.headers['if-match'])));
route('POST', '/api/v1/files/:fileId/move', c => c.store.transaction(() => {
  const source = c.access.authorize(c.user.id, c.params.fileId, true), destinationOwner = parentOwner(c, c.body.parentId, source.ownerId);
  if (destinationOwner !== source.ownerId) fail(422, 'cross_owner_move_not_supported');
  return metadata(c, c.catalog.move(source.ownerId, source.id, c.body, c.req.headers['if-match']));
}));
route('POST', '/api/v1/files/:fileId/copy', async c => metadata(c, await c.uploads.copy(c.user.id, c.params.fileId, c.body), 201));
route('DELETE', '/api/v1/files/:fileId', c => { c.catalog.trash(c.access.authorize(c.user.id, c.params.fileId, true).ownerId, c.params.fileId); return empty(); });
route('POST', '/api/v1/files/:fileId/restore', c => metadata(c, c.catalog.restore(c.user.id, c.params.fileId)));
route('DELETE', '/api/v1/files/:fileId/purge', async c => { await c.uploads.purge(c.user.id, c.params.fileId); return empty(); });
route('GET', '/api/v1/files/:fileId/view-state', c => { const file = c.access.authorize(c.user.id, c.params.fileId); const state = c.store.get('views', `${c.user.id}:${file.id}`) || (file.ownerId === c.user.id ? c.store.get('views', file.id) : undefined); return state ? result(state.body) : empty(); });
route('PUT', '/api/v1/files/:fileId/view-state', c => {
  c.access.authorize(c.user.id, c.params.fileId);
  if (!['image', 'video', 'audio', 'pdf', 'ebook', 'text'].includes(c.body.kind) || (c.body.bookmarks && (!Array.isArray(c.body.bookmarks) || c.body.bookmarks.length > 500))) fail(422, 'invalid_view_state');
  const body = { fileId: c.params.fileId, kind: c.body.kind, position: c.body.position || {}, preferences: c.body.preferences || {}, bookmarks: c.body.bookmarks || [], updatedAt: now() };
  c.store.put('views', { id: `${c.user.id}:${c.params.fileId}`, ownerId: c.user.id, body }); return result(body);
});
route('DELETE', '/api/v1/files/:fileId/view-state', c => { const file = c.access.authorize(c.user.id, c.params.fileId); c.store.delete('views', `${c.user.id}:${file.id}`); if (file.ownerId === c.user.id) c.store.delete('views', file.id); return empty(); });

route('POST', '/api/v1/uploads', c => { const u = c.uploads.create(parentOwner(c, c.body.parentId), c.body); if (u.ownerId !== c.user.id) { u.createdBy = c.user.id; c.store.put('uploads', u); } return result(c.uploads.public(u), 201); });
route('GET', '/api/v1/uploads', c => result(page(c.store.list('uploads', c.user.id).filter(u => !c.query.has('state') || u.state === c.query.get('state')).map(u => c.uploads.public(u)), c.query)));
route('GET', '/api/v1/uploads/statistics', c => {
  const days = number(Number(c.query.get('days') || 30), 1, 366), dates = new Map();
  for (const u of c.store.list('uploads', c.user.id).filter(u => u.state === 'completed' && Date.parse(u.completedAt) > Date.now() - days * 86400_000)) {
    const key = u.completedAt.slice(0, 10), d = dates.get(key) || { date: key, uploadedBytes: 0, completedFiles: 0 };
    d.uploadedBytes += u.parts.reduce((n, p) => n + p.plainSize, 0); d.completedFiles++; dates.set(key, d);
  }
  return result([...dates.values()].sort((a, b) => a.date.localeCompare(b.date)));
});
route('GET', '/api/v1/uploads/:uploadId', c => result(c.uploads.public(c.uploads.get(c.user.id, c.params.uploadId))));
route('GET', '/api/v1/uploads/:uploadId/parts', c => { const u = c.uploads.get(c.user.id, c.params.uploadId); return result(page(u.parts.map(p => c.uploads.partPublic(u, p)), c.query)); });
route('PUT', '/api/v1/uploads/:uploadId/parts/:partNo', async c => { const r = await c.uploads.putPart(c.user.id, c.params.uploadId, Number(c.params.partNo), c.req); return result(r.part, r.status); }, { raw: true });
route('POST', '/api/v1/uploads/:uploadId/complete', async c => { const r = await c.uploads.complete(c.user.id, c.params.uploadId); return metadata(c, r.file, r.status); });
route('DELETE', '/api/v1/uploads/:uploadId', async c => { await c.uploads.abort(c.user.id, c.params.uploadId); return empty(); });
route('GET', '/api/v1/bots', c => result(page(c.store.list('bots', c.user.id).map(bot => c.telegram.botSummary(bot)), c.query)));
route('POST', '/api/v1/bots', async c => { if (c.config.backend !== 'telegram') fail(503, 'telegram_not_configured'); return result(await c.telegram.addBots(c.user.id, c.body.tokens)); });
route('DELETE', '/api/v1/bots/:botId', c => {
  const bot = c.store.get('bots', c.params.botId); if (!bot || bot.ownerId !== c.user.id) fail(404, 'bot_not_found');
  c.store.transaction(() => { c.store.delete('bots', bot.id, c.user.id); for(const state of c.store.list('bot-state',c.user.id)) if(state.botId===bot.id || state.id===bot.id) c.store.delete('bot-state',state.id); }); return empty();
});
route('GET', '/api/v1/channels', c => result(page(c.store.list('channels', c.user.id).map(({ ownerId, ...channel }) => ({ ...channel, id: Number(channel.id) })), c.query)));
route('GET', '/api/v1/channels/discover', async c => { if (c.config.backend !== 'telegram') fail(503, 'telegram_not_configured'); return result((await c.telegram.discover(c.user.id)).map(ch => ({ ...ch, id: Number(ch.id) }))); });
route('POST', '/api/v1/channels', async c => {
  if (c.config.backend !== 'telegram') fail(503, 'telegram_not_configured');
  if (c.body.name && (typeof c.body.name !== 'string' || c.body.name.length > 120)) fail(422, 'invalid_channel_name');
  const created = await c.telegram.channel(c.user.id, c.body), channel = { ...created, ownerId: c.user.id, selected: c.body.selected !== false, health: 'healthy', createdAt: now() };
  c.store.transaction(() => { if (channel.selected) for (const ch of c.store.list('channels', c.user.id)) { ch.selected = false; c.store.put('channels', ch); } c.store.put('channels', channel); });
  const { ownerId, ...data } = channel; return result({ ...data, id: Number(data.id) }, 201);
});
route('POST', '/api/v1/channels/sync', async c => {
  if (!Array.isArray(c.body.channelIds) || c.body.channelIds.length > 200) fail(422, 'invalid_channels');
  const discovered = await c.telegram.discover(c.user.id), selected = c.body.channelIds.map(wanted => discovered.find(ch => ch.id === String(wanted)) || fail(404, 'channel_not_found'));
  const saved = c.store.transaction(() => selected.map(ch => c.store.put('channels', c.store.list('channels', c.user.id).find(old => old.id === ch.id) || { ...ch, ownerId: c.user.id, selected: false, health: 'healthy', createdAt: now() })));
  return result(saved.map(({ ownerId, ...ch }) => ({ ...ch, id: Number(ch.id) })));
});
route('POST', '/api/v1/channels/:channelId/select', c => {
  const channel = c.store.list('channels', c.user.id).find(ch => ch.id === c.params.channelId); if (!channel) fail(404, 'channel_not_found');
  c.store.transaction(() => { for (const ch of c.store.list('channels', c.user.id).filter(ch => ch.selected)) { ch.selected = false; c.store.put('channels', ch); } channel.selected = true; c.store.put('channels', channel); });
  const { ownerId, ...data } = { ...channel, selected: true }; return result({ ...data, id: Number(data.id) });
});
route('DELETE', '/api/v1/channels/:channelId', c => {
  const channel = c.store.list('channels', c.user.id).find(ch => ch.id === c.params.channelId); if (!channel) fail(404, 'channel_not_found');
  if ([...c.catalog.all(c.user.id), ...c.store.list('uploads', c.user.id)].some(f => f.parts?.some(p => p.channelId === channel.id))) fail(409, 'channel_in_use');
  c.store.delete('channels', channel.id, c.user.id); return empty();
});
route('POST', '/api/v1/files/:fileId/shares', c => result(c.shares.create(c.user.id, c.params.fileId, c.body), 201));
route('POST', '/api/v1/files/:fileId/grants', c => result(c.access.create(c.user.id, c.params.fileId, c.body), 201));
route('GET', '/api/v1/files/:fileId/grants', c => { c.catalog.get(c.user.id, c.params.fileId, true); return result(c.store.list('grants', c.user.id).filter(g => g.fileId === c.params.fileId && c.access.live(g)).map(g => c.access.public(g))); });
route('PATCH', '/api/v1/grants/:grantId', c => result(c.access.update(c.user.id, c.params.grantId, c.body)));
route('DELETE', '/api/v1/grants/:grantId', c => { const g = c.access.get(c.user.id, c.params.grantId); g.revokedAt = now(); c.store.put('grants', g); return empty(); });
route('GET', '/api/v1/files/:fileId/shares', c => { c.catalog.get(c.user.id, c.params.fileId); return result(page(c.store.list('shares', c.user.id).filter(s => s.fileId === c.params.fileId && !s.revokedAt).map(s => c.shares.summary(s)), c.query)); });
route('PATCH', '/api/v1/shares/:shareId', c => result(c.shares.update(c.user.id, c.params.shareId, c.body)));
route('DELETE', '/api/v1/shares/:shareId', c => { const s = c.shares.get(c.user.id, c.params.shareId); s.revokedAt = now(); c.store.put('shares', s); return empty(); });
route('GET', '/api/v1/shared', c => { const fileIds = new Set([...c.store.list('shares', c.user.id).filter(s => !s.revokedAt && !expired(s.expiresAt) && (s.maxDownloads === undefined || s.downloadCount < s.maxDownloads)), ...c.store.list('grants', c.user.id).filter(g => c.access.live(g))].map(s => s.fileId)), tree = c.catalog.tree(c.user.id); return result(tree.files.filter(f => fileIds.has(f.id) && tree.active(f)).map(f => c.catalog.public(f))); });
route('GET', '/api/v1/shared/with-me', c => result(c.access.incoming(c.user.id)));
route('GET', '/api/v1/shared/spam', c => result(c.access.incoming(c.user.id, true).map(e => e.file)));
route('POST', '/api/v1/shared/spam/:fileId', c => { c.access.quarantine(c.user.id, c.params.fileId, 'spam'); return empty(); });
route('DELETE', '/api/v1/shared/spam/:fileId', c => { c.access.quarantine(c.user.id, c.params.fileId, 'restore'); return empty(); });
route('DELETE', '/api/v1/shared/spam/:fileId/dismiss', c => { c.access.quarantine(c.user.id, c.params.fileId, 'dismiss'); return empty(); });
route('POST', '/api/v1/public/shares/:shareToken/unlock', c => { c.shares.unlock(c.params.shareToken, c.body.password, c.res); return empty(); }, { public: true });
route('GET', '/api/v1/public/shares/:shareToken', c => { const s = publicShare(c); return result({ id: s.id, file: c.catalog.public(c.shares.file(s)), passwordProtected: !!s.passwordHash, expiresAt: s.expiresAt, permission: 'read' }); }, { public: true });
route('GET', '/api/v1/public/shares/:shareToken/files', c => {
  const s = publicShare(c), root = c.shares.file(s); if (root.kind !== 'folder') fail(422, 'not_a_folder');
  const tree = c.catalog.tree(s.ownerId), parentId = c.catalog.resolve(s.ownerId, c.query.get('path') || '/', s.fileId, tree);
  return result(page(tree.files.filter(f => f.parentId === parentId && tree.active(f) && f.name.toLowerCase().includes((c.query.get('search') || '').toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).map(f => c.catalog.public(f)), c.query));
}, { public: true });

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || !size) fail(416, 'invalid_range');
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!m[1] && Number(m[2]) === 0)) fail(416, 'invalid_range');
  return { start, end, partial: true };
}
async function content(c, file, share) {
  if (file.kind !== 'file') fail(422, 'not_a_file');
  file = await c.storage.hydrate(file);
  const etag = c.catalog.etag(file);
  if (c.req.headers['if-none-match'] === etag) return result(undefined, 304, { ETag: etag });
  let range;
  try { range = byteRange(c.req.method === 'HEAD' ? undefined : c.req.headers.range, file.size); }
  catch (error) { c.res.setHeader('Content-Range', `bytes */${file.size}`); throw error; }
  const safeInline = /^(image\/(png|jpeg|gif|webp|avif)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf)$/.test(file.mimeType);
  c.res.setHeader('Content-Type', safeInline ? file.mimeType : 'application/octet-stream');
  c.res.setHeader('Content-Disposition', `${c.query.get('download') || !safeInline ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()]/g, v => '%' + v.charCodeAt(0).toString(16))}`);
  c.res.setHeader('Content-Security-Policy', 'sandbox');
  c.res.setHeader('Content-Length', Math.max(0, range.end - range.start + 1));
  c.res.setHeader('Accept-Ranges', 'bytes'); c.res.setHeader('ETag', etag); c.res.setHeader('Last-Modified', new Date(file.modTime).toUTCString());
  if (range.partial) c.res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
  if (c.req.method === 'HEAD' || !file.size) { c.res.statusCode = range.partial ? 206 : 200; c.res.end(); return; }
  if (share) c.shares.download(share);
  await c.uploads.transfers.run(async () => {
    c.res.statusCode = range.partial ? 206 : 200;
    const controller = new AbortController(); c.res.on('close', () => controller.abort());
    const write = async bytes => { if (controller.signal.aborted) return; if (!c.res.write(bytes)) await once(c.res, 'drain', { signal: controller.signal }); };
    let offset = 0;
    for (const p of file.parts || []) {
      const start = Math.max(range.start, offset), end = Math.min(range.end, offset + p.plainSize - 1);
      if (start <= end) await c.storage.read(file.ownerId, p, start - offset, end - start + 1, write, controller.signal);
      offset += p.plainSize; if (offset > range.end || controller.signal.aborted) break;
    }
    if (!controller.signal.aborted) c.res.end();
  });
}
for (const method of ['GET', 'HEAD']) {
  for (const suffix of ['/content', '/content/:fileName']) route(method, `/api/v1/files/:fileId${suffix}`, c => content(c, c.access.authorize(c.user.id, c.params.fileId)));
  for (const middle of ['', '/files/:fileId']) for (const suffix of ['/content', '/content/:fileName']) route(method, `/api/v1/public/shares/:shareToken${middle}${suffix}`, c => { const s = publicShare(c); return content(c, c.shares.file(s, c.params.fileId), s); }, { public: true });
}
route('POST', '/api/v1/files/:fileId/playback', c => result(c.playback.create(c.access.authorize(c.user.id, c.params.fileId), c.session, undefined, c.user.id), 201));
route('POST', '/api/v1/public/shares/:shareToken/files/:fileId/playback', c => { const share = publicShare(c); return result(c.playback.create(c.shares.file(share, c.params.fileId), undefined, share), 201); }, { public: true });
for (const method of ['GET','HEAD']) route(method, '/api/v1/playback', c => {
  const { file, share } = c.playback.resolve(c.query.get('ticket'));
  const mode = c.query.get('mode') || 'original';
  if (!['original','audio','video'].includes(mode)) fail(422, 'invalid_playback_mode');
  if (mode !== 'original') {
    if(c.req.method === 'HEAD') { if(!c.media.available()) fail(503,'media_conversion_unavailable'); return result(undefined,200,{'Content-Type':mode==='audio'?'audio/mpeg':'video/mp4','Accept-Ranges':'none'}); }
    return c.media.stream(c);
  }
  if (c.req.method !== 'HEAD') c.playback.consume(c.query.get('ticket'));
  return content(c, file);
}, { public: true });
route('GET', '/api/v1/playback/tracks', async c => result(await c.media.tracks(c.query.get('ticket'))), { public: true });
route('GET', '/api/v1/playback/subtitles', c => c.media.subtitles(c), { public: true });
route('POST', '/api/v1/casting/relay', c => {
  const { file, grant } = c.playback.resolve(c.body.ticket); if (file.ownerId !== c.user.id) fail(403, 'ticket_owner_required');
  return result({ addresses: [`${c.config.publicUrl}/api/v1`], expiresAt: grant.expiresAt }, 201);
});

async function json(req, max) {
  let length = 0, chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > max) fail(413, 'json_too_large'); chunks.push(chunk); }
  if (!length) return {};
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'json_content_type_required');
  try { const parsed = JSON.parse(Buffer.concat(chunks)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(422, 'json_object_required'); return parsed; }
  catch (error) { if (error.status) throw error; fail(400, 'invalid_json'); }
}
function send(res, r) {
  if (!r || res.writableEnded) return;
  for (const [key, value] of Object.entries(r.headers || {})) res.setHeader(key, value);
  res.statusCode = r.status;
  if (r.body === undefined) res.end();
  else { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(r.body)); }
}
export function createApp(config, overrides = {}) {
  const limits = new Map(), assets = new AssetCache(config), proxy = config.mode === 'gateway' ? gateway(config) : null;
  let context;
  if (!proxy) {
    const store = overrides.store || (config.databaseTransport === 'supabase' ? new SupabaseStore(config) : config.databaseUrl ? new PostgresStore(config) : new Store(config.dataDir)), catalog = new Catalog(store), telegram = overrides.telegram || new Telegram(store, config);
    const auth = new Auth(store, config, telegram), storage = overrides.storage || new Storage(config, telegram), uploads = new Uploads(store, catalog, storage, config), shares = new Shares(store, catalog, config), settings = new Settings(store, config, uploads);
    const access = new Access(store, catalog); uploads.access = access;
    context = { store, catalog, telegram, auth, storage, uploads, shares, settings, config, access, playback: new Playback(store, catalog, shares, config) };
    context.playback.access = access;
    context.jobs = new Jobs(store, uploads, config); context.jobs.start();
    context.rclone = new Rclone(config, { allowed: user => { const account = store.get('users', user); return !!account && !account.disabled && ['owner','admin'].includes(account.role); } }); context.rclone.start();
    context.media = new Media(config, context.playback); context.playback.media = context.media;
  }
  const cleanupTimer = context ? setInterval(() => { void context.uploads.drainCleanup().catch(() => {}); }, 60000).unref() : undefined;
  const server = http.createServer(async (req, res) => {
    const requestId = id(); res.setHeader('X-Request-Id', requestId); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    if (!config.allowIframe) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) fail(400, 'invalid_path');
      const url = new URL(req.url, config.publicUrl), origin = req.headers.origin;
      if (origin && origin !== config.publicUrl && !config.cors.includes(origin)) fail(403, 'origin_not_allowed');
      if (origin && config.cors.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Access-Control-Expose-Headers', 'ETag,Content-Range,Accept-Ranges,Location'); }
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Key,X-Share-Password,X-Part-Checksum,Idempotency-Key,If-Match,Range'); res.writeHead(204); res.end(); return; }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['sec-fetch-site'] === 'cross-site' && !config.cors.includes(origin)) fail(403, 'cross_site_request');
      if (url.pathname === '/healthz') { send(res, result({ status: 'ok', mode: config.mode })); return; }
      if (proxy) { proxy.request(req, res); return; }
      const ip = req.socket.remoteAddress, bucket = Math.floor(Date.now() / 60000), login = (url.pathname.includes('/auth/') && !url.pathname.endsWith('/qr/poll') && !url.pathname.endsWith('/refresh')) || url.pathname.startsWith('/api/dev/');
      const key = `${ip}:${login ? 'login' : 'all'}`, counter = limits.get(key) || { bucket, count: 0 };
      if (counter.bucket !== bucket) { counter.bucket = bucket; counter.count = 0; } counter.count++; limits.set(key, counter);
      if (limits.size > 10000) for (const [k, v] of limits) if (v.bucket !== bucket) limits.delete(k);
      if (counter.count > (login ? config.loginRatePerMinute : config.rateLimitPerMinute)) { res.setHeader('Retry-After', 60); fail(429, 'rate_limited'); }
      const found = definitions.find(d => d.method === req.method && d.regex.test(url.pathname));
      if (found) {
        const match = found.regex.exec(url.pathname), params = {};
        for (let i = 0; i < found.params.length; i++) { try { params[found.params[i]] = decodeURIComponent(match[i + 1]); } catch { fail(400, 'invalid_path_encoding'); } }
        const principal = found.open ? {} : context.auth.authenticate(req, url.searchParams, found.ticket);
        const body = found.raw ? undefined : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await json(req, config.jsonMaxBytes) : {};
        const c = { ...context, ...principal, req, res, params, query: url.searchParams, body };
        const idempotency = req.headers['idempotency-key'];
        if (idempotency && !found.raw && req.method === 'POST' && c.user) {
          if (!/^[a-f0-9-]{36}$/i.test(idempotency)) fail(422, 'invalid_idempotency_key');
          const key = hash(`${c.user.id}:${req.url}:${idempotency}`), fingerprint = hash(JSON.stringify(body)), saved = context.store.get('idempotency', key);
          if (saved && saved.fingerprint !== fingerprint) fail(409, 'idempotency_conflict');
          if (saved) { send(res, saved.response); return; }
          // Persistent reservation prevents concurrent duplicate side effects.
          const pending = context.store.get('idempotency-pending', key);
          if (pending && !expired(pending.expiresAt)) fail(409, 'request_in_progress');
          context.store.put('idempotency-pending', { id: key, expiresAt: expires(3600000) });
          try { const response = await found.handler(c); if (response?.status < 400) context.store.put('idempotency', { id: key, userId: c.user.id, fingerprint, response }); send(res, response); }
          finally { context.store.delete('idempotency-pending', key); }
        } else send(res, await found.handler(c));
        return;
      }
      if (url.pathname.startsWith('/api/')) fail(501, 'operation_not_available', 'Esta función todavía no está disponible en este servidor.');
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'method_not_allowed');
      if (config.demo && !cookies(req).teldrive_access) context.auth.publish(context.auth.finish({ id: 1, firstName: 'Demo local' }), res, true);
      let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { fail(400, 'invalid_path_encoding'); }
      if (pathname.includes('\\') || pathname.includes('\0')) fail(400, 'invalid_path');
      let filename = path.resolve(config.staticDir, '.' + pathname);
      if (filename !== config.staticDir && !filename.startsWith(config.staticDir + path.sep)) fail(403, 'invalid_path');
      if (pathname === '/embed.js') filename = path.join(publicDir, 'embed.js');
      else {
        try { if (!(await stat(filename)).isFile()) filename = path.join(config.staticDir, 'index.html'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; if (path.extname(pathname)) fail(404, 'asset_not_found'); filename = path.join(config.staticDir, 'index.html'); }
      }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self' blob:; connect-src 'self' ${config.rcloneAgentOrigin}; base-uri 'none'; form-action 'self'; ${config.allowIframe ? '' : "frame-ancestors 'self';"}`);
      const asset = await assets.read(filename);
      res.setHeader('ETag', asset.etag);
      if (url.pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(filename)) res.setHeader('Cache-Control','public, max-age=31536000, immutable');
      if (req.headers['if-none-match'] === asset.etag) { res.statusCode = 304; res.end(); return; }
      res.setHeader('Content-Length', asset.bytes.length); res.end(req.method === 'HEAD' ? undefined : asset.bytes);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.removeHeader('Content-Length');
      const known = error.status >= 400 && error.status <= 599;
      if (!known) console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId, errorType: error.constructor.name }));
      send(res, result({ error: { code: known ? error.code || 'request_failed' : 'internal_error', message: known ? error.message : 'Request failed', details: { requestId } } }, known ? error.status : 500));
    }
  });
  server.requestTimeout = 3600000; server.headersTimeout = 60000; server.keepAliveTimeout = 5000;
  if (proxy) server.on('upgrade', proxy.upgrade);
  return { server, context, async close() { clearInterval(cleanupTimer); await context?.rclone?.close(); await context?.jobs.close(); await new Promise(resolve => server.close(resolve)); await context?.telegram.close?.(); context?.store.close(); } };
}
export async function start() {
  const config = readConfig(), app = createApp(config);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(config.port, config.host, resolve); });
  console.log(JSON.stringify({ event: 'listening', host: config.host, port: app.server.address().port, mode: config.mode, storage: config.backend }));
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); return app;
}
