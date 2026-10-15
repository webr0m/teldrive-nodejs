// A request-local index: never retain shared database rows between requests.
export class FileTree {
  constructor(files, ownerId) {
    this.files = files; this.ownerId = String(ownerId);
    this.byId = new Map(files.map(file => [file.id, file]));
    this.children = new Map(); this.states = new Map();
    for (const file of files) {
      const siblings = this.children.get(file.parentId) || [];
      siblings.push(file); this.children.set(file.parentId, siblings);
    }
  }
  status(file) {
    const chain = [], seen = new Set(); let current = file, status;
    while (current) {
      if (this.states.has(current.id)) { status = this.states.get(current.id); break; }
      if (current.ownerId !== this.ownerId || seen.has(current.id)) break;
      seen.add(current.id); chain.push(current);
      if (!current.parentId) { status = 'active'; break; }
      current = this.byId.get(current.parentId);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (status === 'active') status = chain[i].status;
      this.states.set(chain[i].id, status);
    }
    return status;
  }
  active(file) { return this.status(file) === 'active'; }
  descendants(fileId) {
    const found = new Set([fileId]), queue = [fileId];
    for (let i = 0; i < queue.length; i++) for (const child of this.children.get(queue[i]) || []) {
      if (!found.has(child.id)) { found.add(child.id); queue.push(child.id); }
    }
    return found;
  }
  parentPath(file) {
    const names = [], seen = new Set(); let current = this.byId.get(file.parentId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id); names.push(current.name); current = this.byId.get(current.parentId);
    }
    return '/' + names.reverse().join('/');
  }
}
