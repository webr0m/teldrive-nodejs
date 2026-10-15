import { createHmac } from 'node:crypto';
import { id, token, hash, now, date, expires, expired, fail, passwordHash, passwordMatches, number } from './core.mjs';

export class Shares {
  constructor(store, catalog, config) { this.store = store; this.catalog = catalog; this.config = config; }
  // Domain-separated, recoverable credentials without storing plaintext tokens.
  secret(s) { return createHmac('sha256', this.config.key).update(JSON.stringify(['teldrive:public-share:v1', s.ownerId, s.id])).digest('base64url'); }
  summary(s) { return { id: s.id, fileId: s.fileId, publicUrl: `${this.config.publicUrl}/share/${this.secret(s)}`, passwordProtected: !!s.passwordHash, expiresAt: s.expiresAt, maxDownloads: s.maxDownloads, downloadCount: s.downloadCount, permission: 'read', createdAt: s.createdAt, revokedAt: s.revokedAt }; }
  create(userId, fileId, body) {
    this.catalog.get(userId, fileId, true);
    if (body.permission && body.permission !== 'read') fail(422, 'edit_shares_not_supported');
    const expiresAt = body.expiresAt === undefined ? undefined : date(body.expiresAt), maxDownloads = body.maxDownloads === undefined ? undefined : number(body.maxDownloads, 1);
    const encodedPassword = body.password === undefined ? undefined : passwordHash(body.password);
    const existing = this.store.list('shares', String(userId)).find(s => s.fileId === fileId && !s.revokedAt && !expired(s.expiresAt) && (s.maxDownloads === undefined || s.downloadCount < s.maxDownloads) && s.expiresAt === expiresAt && s.maxDownloads === maxDownloads && (s.passwordHash ? passwordMatches(body.password, s.passwordHash) : body.password === undefined));
    if (existing) return { ...this.summary(existing), token: this.secret(existing) };
    const s = { id: id(), ownerId: String(userId), fileId, passwordHash: encodedPassword, expiresAt, maxDownloads, downloadCount: 0, createdAt: now() }, secret = this.secret(s);
    s.tokenHash = hash(secret);
    this.store.put('shares', s);
    return { ...this.summary(s), token: secret, publicUrl: `${this.config.publicUrl}/share/${secret}` };
  }
  get(userId, shareId) { const s = this.store.get('shares', shareId); if (!s || s.ownerId !== String(userId)) fail(404, 'share_not_found'); return s; }
  update(userId, shareId, body) {
    const s = this.get(userId, shareId);
    if (body.permission && body.permission !== 'read') fail(422, 'edit_shares_not_supported');
    if (body.clearPassword) delete s.passwordHash; else if (body.password !== undefined) s.passwordHash = passwordHash(body.password);
    if (body.clearExpiresAt) delete s.expiresAt; else if (body.expiresAt !== undefined) s.expiresAt = date(body.expiresAt);
    if (body.clearMaxDownloads) delete s.maxDownloads; else if (body.maxDownloads !== undefined) s.maxDownloads = number(body.maxDownloads, 1);
    this.store.put('shares', s); return this.summary(s);
  }
  resolve(secret, password, cookie) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail(404, 'share_not_found');
    const digest = hash(secret);
    // Keep original hash-only URLs working alongside the recoverable owner URL.
    const s = this.store.list('shares').find(s => s.tokenHash === digest || (!s.revokedAt && hash(this.secret(s)) === digest));
    if (!s || s.revokedAt) fail(404, 'share_not_found');
    if (expired(s.expiresAt) || (s.maxDownloads !== undefined && s.downloadCount >= s.maxDownloads)) fail(410, 'share_expired');
    const access = cookie && this.store.get('share-sessions', hash(cookie));
    const unlocked = access && access.shareId === s.id && !expired(access.expiresAt) && access.passwordHash === s.passwordHash;
    if (s.passwordHash && !unlocked && !passwordMatches(password, s.passwordHash)) fail(401, 'share_password_required');
    if (this.store.get('users', s.ownerId)?.disabled) fail(404, 'share_not_found');
    this.catalog.get(s.ownerId, s.fileId, true); return s;
  }
  unlock(secret, password, res) {
    const share = this.resolve(secret, password), credential = token();
    this.store.put('share-sessions', { id: hash(credential), shareId: share.id, passwordHash: share.passwordHash, expiresAt: expires(3600000) });
    res.setHeader('Set-Cookie', `td_share_session=${credential}; Path=/api/v1/public/shares/${secret}; HttpOnly; SameSite=Lax; Max-Age=3600${this.config.production ? '; Secure' : ''}`);
  }
  file(s, fileId = s.fileId) {
    // Playback ranges need only this ancestry, never the entire drive catalog.
    const file = this.catalog.get(s.ownerId, fileId, true), seen = new Set(); let current = file;
    while (current && !seen.has(current.id)) {
      if (current.id === s.fileId) return file;
      seen.add(current.id); current = current.parentId ? this.store.get('files', current.parentId) : undefined;
    }
    fail(404, 'file_not_in_share');
  }
  download(s) {
    const current = this.store.get('shares', s.id);
    if (!current || current.revokedAt || expired(current.expiresAt) || (current.maxDownloads !== undefined && current.downloadCount >= current.maxDownloads)) fail(410, 'share_expired');
    current.downloadCount++; this.store.put('shares', current);
  }
}
