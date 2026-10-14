import { token, hash, expires, expired, fail } from './core.mjs';

export class Playback {
  constructor(store, catalog, shares, config) { Object.assign(this, { store, catalog, shares, config }); }
  create(file, session, share) {
    if (file.kind !== 'file') fail(404, 'file_not_found');
    const secret = token(), expiresAt = expires((this.config.playbackTtlMinutes ?? 60) * 60000);
    this.store.put('tickets', { id: hash(secret), purpose: 'playback', userId: file.ownerId, fileId: file.id, sessionId: session?.id, shareId: share?.id, sharePasswordHash: share?.passwordHash, expiresAt });
    return { ticket: secret, expiresAt, conversionAvailable: this.media?.available() ?? false };
  }
  resolve(secret) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail(401, 'invalid_ticket');
    const grant = this.store.get('tickets', hash(secret));
    if (!grant || grant.purpose !== 'playback' || expired(grant.expiresAt)) fail(401, 'invalid_ticket');
    const user = this.store.get('users', grant.userId);
    if (!user || user.disabled) fail(401, 'invalid_ticket');
    if (grant.sessionId) {
      const session = this.store.get('sessions', grant.sessionId);
      if (!session || session.revokedAt || expired(session.expiresAt)) fail(401, 'invalid_ticket');
    }
    let share;
    if (grant.shareId) {
      share = this.shares.get(grant.userId, grant.shareId);
      if (share.revokedAt || expired(share.expiresAt) || share.passwordHash !== grant.sharePasswordHash || (!grant.downloadCounted && share.maxDownloads !== undefined && share.downloadCount >= share.maxDownloads)) fail(401, 'invalid_ticket');
      return { grant, share, file: this.shares.file(share, grant.fileId) };
    }
    return { grant, file: this.catalog.get(grant.userId, grant.fileId, true) };
  }
  consume(secret) {
    return this.store.transaction(() => {
      const resolved = this.resolve(secret);
      if (resolved.share && !resolved.grant.downloadCounted) {
        this.shares.download(resolved.share); resolved.grant.downloadCounted = true;
        this.store.put('tickets', resolved.grant);
      }
      return resolved;
    });
  }
}
