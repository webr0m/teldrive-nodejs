import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { id, token, CryptoBox, fail } from './core.mjs';
import { encryptLegacy, decryptLegacyRange, plainSize } from './legacy-crypto.mjs';
import { traceTransfer, recordTransferInput, recordTransferForwarded } from './playback-diagnostics.mjs';

export class Storage {
  constructor(config, telegram) { this.config = config; this.telegram = telegram; this.root = path.join(config.dataDir, 'objects'); this.box = new CryptoBox(config.key); }
  async put(userId, diskPath, size, encryption, encryptionId, channelId) {
    let storedPath = diskPath;
    const legacy = ['legacy', 'v2'].includes(this.config.databaseLayout), salt = legacy && encryption ? token() : undefined;
    const keyVersion = this.config.databaseLayout === 'legacy' ? 1 : this.config.encryptionKeyVersion;
    const password = this.config.legacyKeyring[keyVersion] || this.config.legacyEncryptionKey;
    try {
      if (encryption) {
        if (legacy && !password) fail(422, 'legacy_encryption_key_required');
        storedPath = `${diskPath}.encrypted`;
        const input = await readFile(diskPath), bytes = legacy ? encryptLegacy(input, password, salt) : this.box.seal(input, `part:${encryptionId}`);
        await writeFile(storedPath, bytes, { mode: 0o600 });
      }
      const storedSize = (await stat(storedPath)).size;
      if (this.config.backend === 'telegram') {
        const result = await this.telegram.upload(userId, `${id()}.bin`, storedPath, storedSize, channelId);
        return { ...result, plainSize: size, legacy: legacy || undefined, legacySalt: salt, encryptionKeyVersion: legacy && encryption ? keyVersion : undefined, encryptionId: encryption && !legacy ? encryptionId : undefined };
      }
      const objectId = id(); await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.root, objectId), await readFile(storedPath), { mode: 0o600, flag: 'wx' });
      return { backend: 'local', objectId, size: storedSize, plainSize: size, encryptionId: encryption ? encryptionId : undefined };
    } finally { if (storedPath !== diskPath) await unlink(storedPath).catch(() => {}); }
  }
  async clone(userId, part) { return this.telegram.clone(userId, part); }
  async read(userId, part, offset, length, write, signal) {
    if (part.legacySalt) {
      const password = this.config.legacyKeyring[part.encryptionKeyVersion || 1] || this.config.legacyEncryptionKey;
      if (!password) fail(503, 'legacy_encryption_key_required');
      await decryptLegacyRange((start, count, callback) => this.rawRead(userId, part, start, count, callback, signal), part.size, offset, length, password, part.legacySalt, write); return;
    }
    if (part.encryptionId) {
      const chunks = [];
      await this.rawRead(userId, part, 0, part.size, b => { chunks.push(b); }, signal);
      if (signal?.aborted) return;
      const bytes = this.box.open(Buffer.concat(chunks), `part:${part.encryptionId}`);
      await write(bytes.subarray(offset, offset + length)); return;
    }
    return this.rawRead(userId, part, offset, length, write, signal);
  }
  async rawRead(userId, part, offset, length, write, signal) {
    if (!length) return;
    if (part.backend === 'telegram') return this.telegram.read(userId, part, offset, length, write, signal);
    if (!/^[a-f0-9-]{36}$/.test(part.objectId)) fail(503, 'invalid_object');
    return traceTransfer({ kind: 'local' }, async () => {
      let remaining = length;
      const stream = createReadStream(path.join(this.root, part.objectId), { start: offset, end: offset + length - 1, signal });
      for await (const bytes of stream) { remaining -= bytes.length; recordTransferInput(bytes.length); await write(bytes); recordTransferForwarded(bytes.length); }
      if (remaining) fail(503, 'part_truncated');
    });
  }
  async remove(userId, part) {
    if (part.backend === 'telegram') return this.telegram.remove(userId, part);
    if (/^[a-f0-9-]{36}$/.test(part.objectId)) await unlink(path.join(this.root, part.objectId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async hydrate(file) {
    if (!file.parts?.some(p => p.plainSize === undefined)) return file;
    const descriptors = await this.telegram.describe(file.ownerId, file.parts);
    const parts = file.parts.map((p, index) => ({ ...p, size: descriptors[index], plainSize: p.legacySalt ? plainSize(descriptors[index]) : descriptors[index] }));
    if (parts.reduce((n, p) => n + p.plainSize, 0) !== file.size) fail(503, 'legacy_file_size_mismatch');
    return { ...file, parts };
  }
}
