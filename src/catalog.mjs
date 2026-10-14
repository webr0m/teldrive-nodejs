import { id, now, name, date, fail, category } from './core.mjs';

export class Catalog {
  constructor(store) { this.store = store; }
  all(userId) { return this.store.list('files', userId); }
  get(userId, fileId, active = false) {
    const file = this.store.get('files', fileId);
    if (!file || String(file.ownerId) !== String(userId) || (active && !this.isActive(userId, file))) fail(404, 'file_not_found');
    if (file._legacyRoot) fail(404, 'file_not_found');
    return file;
  }
  isActive(userId, file, index) {
    const visited = new Set();
    while (file) {
      if (file.status !== 'active' || file.ownerId !== String(userId) || visited.has(file.id)) return false;
      visited.add(file.id); if (!file.parentId) return true; file = index ? index.get(file.parentId) : this.store.get('files', file.parentId);
    }
    return false;
  }
  parent(userId, parentId) {
    if (!parentId) return undefined;
    const parent = this.get(userId, parentId, true);
    if (parent.kind !== 'folder') fail(422, 'not_a_folder');
    return parent.id;
  }
  public(file) { const { ownerId, parts, bookmark, _legacyRoot, ...value } = file; return value; }
  checkMatch(file, header) { if (header && header !== '*' && header !== this.etag(file)) fail(412, 'generation_changed'); }
  etag(file) { return `"${file.id}:${file.generation}"`; }
  conflict(userId, parentId, wanted, policy = 'fail', ignore) {
    if (policy === 'error') policy = 'fail';
    if (!['fail', 'rename', 'replace'].includes(policy)) fail(422, 'invalid_conflict_policy');
    const siblings = this.all(userId).filter(f => f.parentId === parentId && f.status === 'active' && f.id !== ignore);
    const existing = siblings.find(f => f.name === wanted);
    if (!existing) return wanted;
    if (policy === 'fail') fail(409, 'name_conflict');
    if (policy === 'replace') { existing.status = 'trashed'; this.save(existing); return wanted; }
    for (let n = 1; n < 10000; n++) { const result = `${wanted} (${n})`; if (result.length > 255) fail(422, 'name_too_long'); if (!siblings.some(f => f.name === result)) return result; }
    fail(409, 'name_conflict');
  }
  create(userId, body, kind = 'folder', extra = {}) {
    const parentId = this.parent(userId, body.parentId), wanted = name(body.name);
    return this.store.transaction(() => {
      const filename = this.conflict(userId, parentId, wanted, body.conflictPolicy);
      const file = { id: id(), ownerId: String(userId), parentId, name: filename, kind, encryption: false, status: 'active', generation: 1, createdAt: now(), updatedAt: now(), modTime: date(body.modTime), ...extra };
      return this.store.put('files', file);
    });
  }
  save(file) { file.generation++; file.updatedAt = now(); return this.store.put('files', file); }
  update(userId, fileId, body, match) {
    return this.store.transaction(() => {
      const f = this.get(userId, fileId, true); this.checkMatch(f, match);
      if (body.name !== undefined) f.name = this.conflict(userId, f.parentId, name(body.name), 'fail', f.id);
      if (body.modTime !== undefined) f.modTime = date(body.modTime);
      return this.save(f);
    });
  }
  descendants(userId, fileId) {
    const files = this.all(userId), found = new Set([fileId]);
    for (let changed = true; changed;) { changed = false; for (const f of files) if (found.has(f.parentId) && !found.has(f.id)) { found.add(f.id); changed = true; } }
    return found;
  }
  move(userId, fileId, body, match) {
    const f = this.get(userId, fileId, true); this.checkMatch(f, match);
    const parentId = this.parent(userId, body.parentId);
    if (this.descendants(userId, fileId).has(parentId)) fail(409, 'folder_cycle');
    f.name = this.conflict(userId, parentId, f.name, body.conflictPolicy, f.id); f.parentId = parentId;
    return this.save(f);
  }
  copy(userId, fileId, body, clonedParts) {
    const original = this.get(userId, fileId, true), parentId = this.parent(userId, body.parentId);
    if (this.descendants(userId, fileId).has(parentId)) fail(409, 'folder_cycle');
    const files = this.all(userId), mapping = new Map(), wanted = body.name === undefined ? original.name : name(body.name);
    return this.store.transaction(() => {
      const clone = (f, parent, filename) => {
        const copy = { ...f, parts: clonedParts?.get(f.id) || f.parts, id: id(), parentId: parent, name: filename, generation: 1, createdAt: now(), updatedAt: now(), bookmark: false };
        mapping.set(f.id, copy.id); this.store.put('files', copy);
        for (const child of files.filter(c => c.parentId === f.id && c.status === 'active')) clone(child, copy.id, child.name);
        return copy;
      };
      return clone(original, parentId, this.conflict(userId, parentId, wanted, body.conflictPolicy));
    });
  }
  trash(userId, fileId) { const f = this.get(userId, fileId, true); f.status = 'trashed'; return this.save(f); }
  restore(userId, fileId) {
    const f = this.get(userId, fileId); if (f.status !== 'trashed') fail(409, 'not_trashed');
    this.parent(userId, f.parentId); this.conflict(userId, f.parentId, f.name, 'fail', f.id); f.status = 'active'; return this.save(f);
  }
  resolve(userId, drivePath, root) {
    let parent = root;
    for (const segment of drivePath.split('/').filter(Boolean)) {
      name(segment); const f = this.all(userId).find(f => f.parentId === parent && f.name === segment && this.isActive(userId, f));
      if (!f || f.kind !== 'folder') fail(404, 'folder_not_found'); parent = f.id;
    }
    return parent;
  }
  list(userId, q) {
    const status = q.get('status') || 'active', scope = q.get('scope') || 'folder';
    if (!['active', 'trashed'].includes(status) || !['folder', 'drive', 'recursive'].includes(scope)) fail(422, 'invalid_filter');
    const parentId = q.has('path') ? this.resolve(userId, q.get('path')) : this.parent(userId, q.get('parentId') || undefined);
    const descendants = scope === 'recursive' && parentId ? this.descendants(userId, parentId) : null;
    if (q.get('searchType') === 'regex') fail(422, 'regex_not_supported', 'Use text search in the native API');
    const search = (q.get('search') || '').toLowerCase();
    const categories = q.getAll('category').flatMap(v => v.split(','));
    const all = this.all(userId), index = new Map(all.map(f => [f.id, f]));
    let files = all.filter(f => f.status === status && (status === 'trashed' || this.isActive(userId, f, index)) && (scope === 'drive' || (scope === 'recursive' ? (!parentId || descendants.has(f.parentId)) : f.parentId === parentId)));
    files = files.filter(f => (!search || f.name.toLowerCase().includes(search)) && (!q.has('kind') || f.kind === q.get('kind')) && (!q.has('bookmarked') || q.get('bookmarked') !== 'true' || f.bookmark) && (!categories.length || categories.includes(category(f))));
    if (q.has('updatedAfter')) files = files.filter(f => f.updatedAt > date(q.get('updatedAfter')));
    if (q.has('updatedBefore')) files = files.filter(f => f.updatedAt < date(q.get('updatedBefore')));
    const sort = q.get('sort') || 'name', direction = q.get('order') === 'desc' ? -1 : 1;
    if (!['name', 'size', 'updatedAt', 'id'].includes(sort)) fail(422, 'invalid_sort');
    files.sort((a, b) => direction * (sort === 'size' ? (a.size || 0) - (b.size || 0) : String(a[sort]).localeCompare(String(b[sort]))) || a.id.localeCompare(b.id));
    return files.map(f => this.public(f));
  }
  statistics(userId) {
    const files = this.all(userId), index = new Map(files.map(f => [f.id, f])), active = files.filter(f => this.isActive(userId, f, index));
    return { totalFiles: active.filter(f => f.kind === 'file').length, totalFolders: active.filter(f => f.kind === 'folder').length, totalBytes: active.reduce((sum, f) => sum + (f.size || 0), 0), trashedFiles: files.filter(f => f.status === 'trashed').length, activeShares: this.store.list('shares', userId).filter(s => !s.revokedAt).length, openUploads: this.store.list('uploads', userId).filter(u => u.state === 'open').length };
  }
  categories(userId) { const all = this.all(userId), index = new Map(all.map(f => [f.id, f])); return ['archive', 'audio', 'document', 'image', 'video', 'other'].map(c => { const files = all.filter(f => f.kind === 'file' && this.isActive(userId, f, index) && category(f) === c); return { category: c, totalFiles: files.length, totalSize: files.reduce((n, f) => n + f.size, 0) }; }); }
  dashboard(userId) {
    const all = this.all(userId), index = new Map(all.map(f => [f.id, f]));
    const active = all.filter(f => this.isActive(userId, f, index));
    const status = f => {
      const visited = new Set(); let result = f.status;
      while (f?.parentId && !visited.has(f.id)) { visited.add(f.id); f = index.get(f.parentId); if (f && f.status !== 'active') result = f.status; }
      return result;
    };
    const trash = all.filter(f => f.kind === 'file' && status(f) === 'trashed');
    const spam = all.filter(f => f.kind === 'file' && status(f) === 'spam');
    const bytes = files => files.reduce((sum, f) => sum + (f.size || 0), 0);
    const summary = { logicalBytes: bytes(active), activeFiles: active.filter(f => f.kind === 'file').length, activeFolders: active.filter(f => f.kind === 'folder').length, trashedFiles: trash.length, trashBytes: bytes(trash), spamBytes: bytes(spam) };
    const uploads = this.store.list('uploads', userId), stale = uploads.filter(u => u.state !== 'completed' && u.state !== 'aborted' && Date.parse(u.expiresAt) <= Date.now());
    const staleUploadBytes = stale.reduce((sum, u) => sum + u.parts.reduce((n, p) => n + p.plainSize, 0), 0);
    const channels = this.store.list('channels', userId).map(ch => {
      const parts = all.flatMap(f => f.parts || []).filter(p => p.channelId === ch.id);
      const unique = [...new Map(parts.map(p => [p.messageId, p])).values()];
      return { channelId: Number(ch.id), name: ch.name, selected: ch.selected, health: ch.health, partCount: unique.length, storedBytes: unique.reduce((n, p) => n + (p.size || 0), 0) };
    });
    const today = now().slice(0, 10);
    return { summary, categories: this.categories(userId), channels, cleanup: { trashBytes: summary.trashBytes, staleUploadBytes, staleUploads: stale.length, totalReclaimableBytes: summary.trashBytes + summary.spamBytes + staleUploadBytes }, growth: [{ day: today, logicalBytes: summary.logicalBytes, addedBytes: bytes(active.filter(f => f.createdAt.slice(0, 10) === today)) }], activity: uploads.filter(u => u.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 20).map((u, i) => ({ id: i + 1, type: 'upload.completed', resourceType: 'upload', resourceId: u.id, label: u.name, occurredAt: u.completedAt })) };
  }
}
