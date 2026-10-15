import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { blake3 } from '@noble/hashes/blake3.js';
import { id, now, expires, expired, fail, name, date, number, Locks, Semaphore } from './core.mjs';

export class Uploads {
  constructor(store, catalog, storage, config) { this.store = store; this.catalog = catalog; this.storage = storage; this.config = config; this.locks = new Locks(); this.transfers = new Semaphore(config.concurrency); }
  public(u) { const { ownerId, parts, ...rest } = u; return rest; }
  get(userId, uploadId, open = false) {
    const u = this.store.get('uploads', uploadId);
    if (!u || u.ownerId !== String(userId)) fail(404, 'upload_not_found');
    if (open && (expired(u.expiresAt) || u.state === 'expired')) fail(410, 'upload_expired');
    if (open && u.state !== 'open') fail(409, 'upload_not_open');
    return u;
  }
  create(userId, body) {
    const size = number(body.size, -1, this.config.maxFileSize), filename = name(body.name), parentId = this.catalog.parent(userId, body.parentId);
    if (body.encryption !== undefined && typeof body.encryption !== 'boolean') fail(422, 'invalid_encryption');
    if (body.hash && (body.hash.algorithm !== 'blake3' || !/^[a-f0-9]{64}$/i.test(body.hash.value || ''))) fail(422, 'invalid_hash');
    const partSize = body.preferredPartSize === undefined ? this.config.partSize : Math.min(number(body.preferredPartSize, 1024 * 1024, 2147483648), this.config.partSize);
    if (!['fail', 'error', 'replace', 'rename'].includes(body.conflictPolicy || 'fail')) fail(422, 'invalid_conflict_policy');
    if (body.mimeType && (typeof body.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(body.mimeType))) fail(422, 'invalid_mime_type');
    const u = { id: id(), ownerId: String(userId), parentId, name: filename, expectedSize: size, maxFileSize: this.config.maxFileSize, expectedHash: body.hash, mimeType: body.mimeType || 'application/octet-stream', modTime: date(body.modTime), encryption: !!body.encryption, conflictPolicy: body.conflictPolicy || 'fail', partSize, state: 'open', expiresAt: expires(this.config.uploadTtlHours * 3600000), createdAt: now(), parts: [] };
    this.store.put('uploads', u); return u;
  }
  async putPart(userId, uploadId, partNo, req) {
    number(partNo, 1, 100000);
    return this.locks.run(uploadId, () => this.transfers.run(async () => {
      const u = this.get(userId, uploadId, true), expectedLength = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > u.partSize) fail(413, 'invalid_part_length');
      if (u.expectedSize >= 0 && ((partNo - 1) * u.partSize + expectedLength > u.expectedSize || ((partNo * u.partSize) < u.expectedSize && expectedLength !== u.partSize))) fail(422, 'invalid_part_size');
      const tempDir = path.join(this.config.dataDir, 'tmp'); await mkdir(tempDir, { recursive: true, mode: 0o700 });
      const temp = path.join(tempDir, id()), checksum = blake3.create(); let received = 0;
      try {
        const meter = new Transform({ transform(chunk, encoding, cb) { received += chunk.length; if (received > expectedLength) cb(Object.assign(new Error('Body exceeds Content-Length'), { status: 413, code: 'part_too_large' })); else { checksum.update(chunk); cb(null, chunk); } } });
        await pipeline(req, meter, createWriteStream(temp, { mode: 0o600, flags: 'wx' }));
        if (received !== expectedLength) fail(422, 'truncated_part');
        const digest = Buffer.from(checksum.digest()).toString('hex');
        if (req.headers['x-part-checksum'] && req.headers['x-part-checksum'].toLowerCase() !== digest) fail(422, 'checksum_mismatch');
        const existing = u.parts.find(p => p.partNo === partNo);
        if (existing) { if (existing.checksum !== digest || existing.plainSize !== received) fail(409, 'part_conflict'); return { status: 200, part: this.partPublic(u, existing) }; }
        if (u.parts.reduce((n, p) => n + p.plainSize, 0) + received > u.maxFileSize) fail(413, 'file_too_large');
        const encryptionId = id();
        if (this.config.databaseLayout === 'legacy' && !u.channelId) { u.channelId = (await this.storage.telegram.selected(userId)).id; this.store.put('uploads', u); }
        const descriptor = await this.storage.put(userId, temp, received, u.encryption, encryptionId, u.channelId);
        const part = { ...descriptor, partNo, plainSize: received, checksum: digest, createdAt: now(), updatedAt: now(), state: 'stored' };
        u.parts.push(part); this.store.put('uploads', u);
        return { status: 201, part: this.partPublic(u, part) };
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }));
  }
  partPublic(u, p) { return { uploadId: u.id, partNo: p.partNo, state: p.state, plainSize: p.plainSize, storedSize: p.size, checksum: p.checksum, createdAt: p.createdAt, updatedAt: p.updatedAt }; }
  async complete(userId, uploadId) {
    return this.locks.run(uploadId, async () => {
      const u = this.get(userId, uploadId);
      if (u.state === 'completed') return { status: 200, file: this.catalog.get(userId, u.fileId) };
      this.get(userId, uploadId, true); u.parts.sort((a, b) => a.partNo - b.partNo);
      let size = 0;
      for (let i = 0; i < u.parts.length; i++) {
        const p = u.parts[i]; if (p.partNo !== i + 1 || (i < u.parts.length - 1 && p.plainSize !== u.partSize)) fail(409, 'missing_or_short_parts'); size += p.plainSize;
      }
      if ((u.expectedSize >= 0 && u.expectedSize !== size) || size > u.maxFileSize) fail(409, 'size_mismatch');
      let fileHash;
      if (u.expectedHash) {
        // A real whole-file BLAKE3 hash, not a hash of part digests.
        const h = blake3.create();
        for (const p of u.parts) await this.storage.read(userId, p, 0, p.plainSize, bytes => { h.update(bytes); });
        fileHash = { algorithm: 'blake3', value: Buffer.from(h.digest()).toString('hex') };
        if (fileHash.value !== u.expectedHash.value.toLowerCase()) fail(422, 'file_hash_mismatch');
      }
      return this.store.transaction(() => {
        const file = this.catalog.create(userId, u, 'file', { size, mimeType: u.mimeType, encryption: u.encryption, encryptionKeyVersion: u.parts[0]?.encryptionKeyVersion ?? (u.encryption ? this.config.databaseLayout === 'legacy' ? 1 : this.config.encryptionKeyVersion : undefined), parts: u.parts, hash: fileHash });
        u.state = 'completed'; u.fileId = file.id; u.completedAt = now(); this.store.put('uploads', u); return { status: 201, file };
      });
    });
  }
  async abort(userId, uploadId) {
    return this.locks.run(uploadId, async () => {
      const u = this.get(userId, uploadId);
      if (u.state === 'completed') fail(409, 'upload_completed');
      u.state = 'aborted'; this.store.put('uploads', u);
      await this.cleanParts(userId, u.parts); u.parts = []; this.store.put('uploads', u);
    });
  }
  referencedParts() { return new Set(this.store.list('files').flatMap(file => (file.parts || []).map(part => part.objectId ? `local:${part.objectId}` : `telegram:${part.channelId}:${part.messageId}`))); }
  async cleanParts(userId, parts, referenced) {
    if (!parts.length) return;
    referenced ??= this.referencedParts();
    for (const p of parts) {
      const key = p.objectId ? `local:${p.objectId}` : `telegram:${p.channelId}:${p.messageId}`;
      if (!referenced.has(key)) await this.storage.remove(userId, p);
    }
  }
  queueCleanup(userId, parts) {
    return parts.map(part => { const record = { id: id(), ownerId: String(userId), part, createdAt: now() }; this.store.put('cleanup', record); return record.id; });
  }
  async drainCleanup() {
    return this.locks.run('cleanup', async () => {
      const records = this.store.list('cleanup').slice(0, 100);
      if (!records.length) return;
      const referenced = this.referencedParts();
      for (const record of records) {
        try { await this.cleanParts(record.ownerId, [record.part], referenced); this.store.delete('cleanup', record.id); }
        catch { /* Keep the complete descriptor for the next retry, including after a restart. */ }
      }
    });
  }
  async copy(userId, fileId, body) {
    return this.locks.run(`catalog:${userId}`, async () => {
      const original = this.catalog.get(userId, fileId, true), parent = this.catalog.parent(userId, body.parentId);
      const descendants = this.catalog.descendants(userId, fileId);
      if (descendants.has(parent)) fail(409, 'folder_cycle');
      if (!['legacy', 'v2'].includes(this.config.databaseLayout)) return this.catalog.copy(userId, fileId, body);
      name(body.name ?? original.name);
      const parts = new Map(), queued = [];
      try {
        return await this.locks.run('cleanup', async () => {
        const tree = this.catalog.tree(userId);
        for (const file of tree.files.filter(f => descendants.has(f.id) && tree.active(f))) {
          const clones = [];
          for (const part of file.parts || []) { const clone = await this.storage.clone(userId, part); clones.push(clone); queued.push(...this.queueCleanup(userId, [clone])); }
          parts.set(file.id, clones);
        }
        return this.store.transaction(() => { const file = this.catalog.copy(userId, fileId, body, parts); for (const key of queued) this.store.delete('cleanup', key); return file; });
        });
      } catch (error) { await this.drainCleanup(); throw error; }
    });
  }
  async purge(userId, fileId) {
    return this.locks.run(`catalog:${userId}`, async () => {
      const root = this.catalog.get(userId, fileId); if (!['trashed','spam'].includes(root.status)) fail(409, 'trash_first');
      const ids = this.catalog.descendants(userId, fileId), files = this.catalog.all(userId).filter(f => ids.has(f.id));
      const byId = new Map(files.map(f => [f.id, f]));
      const depth = f => { let d = 0; const seen = new Set(); while (byId.has(f.parentId) && !seen.has(f.parentId)) { seen.add(f.parentId); f = byId.get(f.parentId); d++; } return d; };
      files.sort((a, b) => depth(b) - depth(a));
      this.store.transaction(() => { for (const f of files) { this.queueCleanup(userId, f.parts || []); this.store.delete('files', f.id, userId, f.generation); for (const s of this.store.list('shares', userId).filter(s => s.fileId === f.id)) this.store.delete('shares', s.id); } });
      await this.drainCleanup();
    });
  }
}
