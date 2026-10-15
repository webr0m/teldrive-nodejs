import { id, now, name, date, fail, category } from './core.mjs';
import { FileTree } from './file-tree.mjs';

export class Catalog {
  constructor(store) { this.store = store; }
  all(userId) { return this.store.list('files', userId); }
  tree(userId) { return new FileTree(this.all(userId), userId); }
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
  checkMatch(file, header) { if (header && header !== '*' && header !== this.etag(file) && header !== `"${file.generation}"`) fail(412, 'generation_changed'); }
  etag(file) { return `"${file.id}:${file.generation}"`; }
  conflict(userId, parentId, wanted, policy = 'fail', ignore) {
    if (policy === 'error') policy = 'fail';
    if (!['fail', 'rename', 'replace'].includes(policy)) fail(422, 'invalid_conflict_policy');
    const siblings = this.all(userId).filter(f => f.parentId === parentId && f.status === 'active' && f.id !== ignore);
    const existing = siblings.find(f => f.name === wanted);
    if (!existing) return wanted;
    if (policy === 'fail') fail(409, 'name_conflict');
    if (policy === 'replace') { existing.status = 'trashed'; this.save(existing); return wanted; }
    const names = new Set(siblings.map(f => f.name));
    for (let n = 1; n < 10000; n++) { const result = `${wanted} (${n})`; if (result.length > 255) fail(422, 'name_too_long'); if (!names.has(result)) return result; }
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
    return this.tree(userId).descendants(fileId);
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
    const tree = this.tree(userId), wanted = body.name === undefined ? original.name : name(body.name);
    if (tree.descendants(fileId).has(parentId)) fail(409, 'folder_cycle');
    return this.store.transaction(() => {
      const pending = [{ file: original, parent: parentId, filename: this.conflict(userId, parentId, wanted, body.conflictPolicy) }];
      let root;
      for (let i = 0; i < pending.length; i++) {
        const { file: f, parent, filename } = pending[i];
        const copy = { ...f, parts: clonedParts?.get(f.id) || f.parts, id: id(), parentId: parent, name: filename, generation: 1, createdAt: now(), updatedAt: now(), bookmark: false };
        this.store.put('files', copy); root ??= copy;
        for (const child of tree.children.get(f.id) || []) if (tree.active(child)) pending.push({file:child,parent:copy.id,filename:child.name});
      }
      return root;
    });
  }
  trash(userId, fileId) { const f = this.get(userId, fileId, true); f.status = 'trashed'; return this.save(f); }
  spam(userId, fileId) {
    const file = this.get(userId, fileId, true), ids = this.descendants(userId, fileId);
    for (const share of this.store.list('shares', userId)) if (ids.has(share.fileId) && !share.revokedAt) { share.revokedAt = now(); this.store.put('shares', share); }
    for (const grant of this.store.list('grants', userId)) if (ids.has(grant.fileId) && !grant.revokedAt) { grant.revokedAt = now(); this.store.put('grants', grant); }
    file.status = 'spam'; return this.save(file);
  }
  restore(userId, fileId) {
    const f = this.get(userId, fileId); if (!['trashed','spam'].includes(f.status)) fail(409, 'not_quarantined');
    this.parent(userId, f.parentId); this.conflict(userId, f.parentId, f.name, 'fail', f.id); f.status = 'active'; return this.save(f);
  }
  resolve(userId, drivePath, root, tree = this.tree(userId)) {
    if (typeof drivePath !== 'string' || drivePath.length > 4096) fail(422, 'invalid_path');
    let parent = root;
    for (const segment of drivePath.split('/').filter(Boolean)) {
      name(segment); const f = (tree.children.get(parent) || []).find(f => f.name === segment && tree.active(f));
      if (!f || f.kind !== 'folder') fail(404, 'folder_not_found'); parent = f.id;
    }
    return parent;
  }
  list(userId, q) {
    const status = q.get('status') || 'active', scope = q.get('scope') || 'folder';
    if (!['active', 'trashed','spam'].includes(status) || !['folder', 'drive', 'recursive'].includes(scope)) fail(422, 'invalid_filter');
    const tree = this.tree(userId);
    const parentId = q.has('path') ? this.resolve(userId, q.get('path'), undefined, tree) : q.get('parentId') || undefined;
    if (parentId && (!tree.byId.has(parentId) || tree.byId.get(parentId).kind !== 'folder' || !tree.active(tree.byId.get(parentId)))) fail(404, 'folder_not_found');
    const descendants = scope === 'recursive' && parentId ? tree.descendants(parentId) : null;
    if (q.get('searchType') === 'regex') fail(422, 'regex_not_supported', 'Use text search in the native API');
    const search = (q.get('search') || '').toLowerCase();
    const categories = q.getAll('category').flatMap(v => v.split(','));
    const all = tree.files;
    let files = all.filter(f => f.status === status && (status !== 'active' || tree.active(f)) && (scope === 'drive' || (scope === 'recursive' ? (!parentId || descendants.has(f.parentId)) : f.parentId === parentId)));
    files = files.filter(f => (!search || f.name.toLowerCase().includes(search)) && (!q.has('kind') || f.kind === q.get('kind')) && (!q.has('bookmarked') || q.get('bookmarked') !== 'true' || f.bookmark) && (!categories.length || categories.includes(category(f))));
    if (q.has('updatedAfter')) { const after = date(q.get('updatedAfter')); files = files.filter(f => f.updatedAt > after); }
    if (q.has('updatedBefore')) { const before = date(q.get('updatedBefore')); files = files.filter(f => f.updatedAt < before); }
    const sort = q.get('sort') || 'name', direction = q.get('order') === 'desc' ? -1 : 1;
    if (!['name', 'size', 'updatedAt', 'id'].includes(sort)) fail(422, 'invalid_sort');
    files.sort((a, b) => direction * (sort === 'size' ? (a.size || 0) - (b.size || 0) : String(a[sort]).localeCompare(String(b[sort]))) || a.id.localeCompare(b.id));
    return files.map(f => ({...this.public(f),...(scope !== 'folder' ? {parentPath:tree.parentPath(f)} : {})}));
  }
  statistics(userId) {
    const tree = this.tree(userId), files = tree.files, active = files.filter(f => tree.active(f));
    return { totalFiles: active.filter(f => f.kind === 'file').length, totalFolders: active.filter(f => f.kind === 'folder').length, totalBytes: active.reduce((sum, f) => sum + (f.size || 0), 0), trashedFiles: files.filter(f => f.kind === 'file' && tree.status(f) === 'trashed').length, activeShares: this.store.list('shares', userId).filter(s => !s.revokedAt && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now()) && (s.maxDownloads === undefined || s.downloadCount < s.maxDownloads) && tree.byId.has(s.fileId) && tree.active(tree.byId.get(s.fileId))).length, openUploads: this.store.list('uploads', userId).filter(u => u.state === 'open' && Date.parse(u.expiresAt) > Date.now()).length };
  }
  categories(userId, tree = this.tree(userId)) {
    const counts = new Map(['archive','audio','document','image','video','other'].map(c => [c,{category:c,totalFiles:0,totalSize:0}]));
    for (const file of tree.files) if (file.kind === 'file' && tree.active(file)) { const group = counts.get(category(file)); group.totalFiles++; group.totalSize += file.size || 0; }
    return [...counts.values()];
  }
  dashboard(userId) {
    const tree = this.tree(userId), all = tree.files;
    const active = all.filter(f => tree.active(f));
    const trash = all.filter(f => f.kind === 'file' && tree.status(f) === 'trashed');
    const spam = all.filter(f => f.kind === 'file' && tree.status(f) === 'spam');
    const bytes = files => files.reduce((sum, f) => sum + (f.size || 0), 0);
    const summary = { logicalBytes: bytes(active), activeFiles: active.filter(f => f.kind === 'file').length, activeFolders: active.filter(f => f.kind === 'folder').length, trashedFiles: trash.length, trashBytes: bytes(trash), spamBytes: bytes(spam) };
    const uploads = this.store.list('uploads', userId), stale = uploads.filter(u => u.state !== 'completed' && u.state !== 'aborted' && Date.parse(u.expiresAt) <= Date.now());
    const staleUploadBytes = stale.reduce((sum, u) => sum + u.parts.reduce((n, p) => n + p.plainSize, 0), 0);
    const channelParts = new Map();
    for (const file of all) for (const part of file.parts || []) {
      const unique = channelParts.get(part.channelId) || new Map(); unique.set(part.messageId, part); channelParts.set(part.channelId, unique);
    }
    const channels = this.store.list('channels', userId).map(ch => {
      const unique = [...(channelParts.get(ch.id)?.values() || [])];
      return { channelId: Number(ch.id), name: ch.name, selected: ch.selected, health: ch.health, partCount: unique.length, storedBytes: unique.reduce((n, p) => n + (p.size || 0), 0) };
    });
    const today = now().slice(0, 10);
    return { summary, categories: this.categories(userId, tree), channels, cleanup: { trashBytes: summary.trashBytes, staleUploadBytes, staleUploads: stale.length, totalReclaimableBytes: summary.trashBytes + summary.spamBytes + staleUploadBytes }, growth: [{ day: today, logicalBytes: summary.logicalBytes, addedBytes: bytes(active.filter(f => f.createdAt.slice(0, 10) === today)) }], activity: uploads.filter(u => u.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 20).map((u, i) => ({ id: i + 1, type: 'upload.completed', resourceType: 'upload', resourceId: u.id, label: u.name, occurredAt: u.completedAt })) };
  }
}
