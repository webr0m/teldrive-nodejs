import { id, now, token, hash, expires, expired, fail, CryptoBox } from './core.mjs';

export function cookies(req) {
  const result = {};
  for (const item of (req.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index !== -1) result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}
export class Auth {
  constructor(store, config, telegram) { this.store = store; this.config = config; this.telegram = telegram; this.box = new CryptoBox(config.key); }
  user(userId) { const u = this.store.get('users', userId); if (!u || u.disabled) fail(401, 'invalid_session'); return u; }
  profile(u) { return { userId: Number(u.id), displayName: u.displayName, username: u.username, premium: !!u.premium, role: u.role, capabilities: ['files', 'uploads', 'shares', ...(['owner', 'admin'].includes(u.role) ? ['system.manageUsers'] : [])], createdAt: u.createdAt }; }
  finish(me, sessionString) {
    const userId = String(me.id);
    if (this.config.allowedUsers.length && !this.config.allowedUsers.includes(userId) && !this.config.allowedUsers.some(v => me.username && v.replace(/^@/, '').toLowerCase() === me.username.toLowerCase())) fail(403, 'user_not_allowed');
    let u = this.store.get('users', userId);
    if (this.config.existingUsersOnly && !u) fail(403, 'existing_user_required');
    const role = userId === this.config.ownerUserId ? 'owner' : u?.role || (this.store.list('users').length ? 'user' : 'owner');
    u = { ...u, id: userId, userId, displayName: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username, premium: !!me.premium, role, createdAt: u?.createdAt || now(), updatedAt: now(), disabled: u?.disabled || false };
    if (u.disabled) fail(403, 'user_disabled');
    if (sessionString) u.telegramSession = this.box.encode(sessionString, `telegram:${userId}`);
    this.store.put('users', u);
    return this.session(userId);
  }
  session(userId) {
    const accessToken = token(), refreshToken = token();
    const s = { id: id(), userId, accessHash: hash(accessToken), refreshHash: hash(refreshToken), accessExpiresAt: expires(15 * 60_000), expiresAt: expires(30 * 86400_000), createdAt: now(), lastUsedAt: now() };
    this.store.put('sessions', s);
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: 900, _session: s };
  }
  authenticate(req, query, allowTicket = false) {
    const key = req.headers['x-api-key'];
    if (key) {
      const k = this.store.get('keys', hash(key));
      if (!k || k.revokedAt || expired(k.expiresAt)) fail(401, 'invalid_api_key');
      k.lastUsedAt = now(); this.store.put('keys', k);
      return { user: this.user(k.userId), session: null, apiKey: true };
    }
    const bearer = req.headers.authorization;
    const credential = bearer ? bearer.match(/^Bearer (\S+)$/i)?.[1] : cookies(req).teldrive_access;
    if (credential) {
      const s = this.store.get('session-index', hash(credential));
      const session = s && this.store.get('sessions', s.sessionId);
      if (!session || session.revokedAt || expired(session.accessExpiresAt) || session.accessHash !== hash(credential)) fail(401, 'invalid_session');
      return { user: this.user(session.userId), session, apiKey: false };
    }
    if (allowTicket && query.has('ticket')) {
      const ticket = this.store.get('tickets', hash(query.get('ticket')));
      if (!ticket || expired(ticket.expiresAt)) fail(401, 'invalid_ticket');
      return { user: this.user(ticket.userId), session: null, apiKey: false };
    }
    fail(401, 'authentication_required');
  }
  publish(pair, res, cookieMode) {
    this.store.put('session-index', { id: pair._session.accessHash, sessionId: pair._session.id, userId: pair._session.userId });
    if (cookieMode) {
      const secure = this.config.production ? '; Secure' : '';
      res.setHeader('Set-Cookie', [`teldrive_access=${pair.accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure}`, `teldrive_refresh=${pair.refreshToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`]);
      return { authenticated: true, expiresAt: pair._session.accessExpiresAt };
    }
    const { _session, ...result } = pair; return result;
  }
  refresh(raw) {
    if (typeof raw !== 'string') fail(401, 'invalid_refresh');
    return this.store.transaction(() => {
      const s = this.store.list('sessions').find(s => s.refreshHash === hash(raw));
      if (!s || s.revokedAt || expired(s.expiresAt)) fail(401, 'invalid_refresh');
      this.user(s.userId);
      this.store.delete('session-index', s.accessHash);
      const accessToken = token(), refreshToken = token();
      s.accessHash = hash(accessToken); s.refreshHash = hash(refreshToken); s.accessExpiresAt = expires(900_000); s.lastUsedAt = now();
      this.store.put('sessions', s);
      return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: 900, _session: s };
    });
  }
  revoke(s) { if (!s) fail(403, 'session_required'); s.revokedAt = now(); this.store.put('sessions', s); this.store.delete('session-index', s.accessHash); }
  clear(res) { res.setHeader('Set-Cookie', ['teldrive_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', 'teldrive_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']); }
  ticket(user) { const secret = token(), result = { ticket: secret, expiresAt: expires(120_000) }; this.store.put('tickets', { id: hash(secret), userId: user.id, expiresAt: result.expiresAt }); return result; }
}
