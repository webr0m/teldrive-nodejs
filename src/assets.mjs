import { readFile, stat } from 'node:fs/promises';
import { hash } from './core.mjs';

export class AssetCache {
  constructor(config) { this.config = config; this.entries = new Map(); this.pending = new Map(); this.bytes = 0; }
  discard(filename) { const entry = this.entries.get(filename); if (entry) { this.bytes -= entry.bytes.length; this.entries.delete(filename); } }
  async read(filename) {
    if (this.pending.has(filename)) return this.pending.get(filename);
    const loading = this.load(filename); this.pending.set(filename, loading);
    try { return await loading; } finally { this.pending.delete(filename); }
  }
  async load(filename) {
    const maximum = this.config.staticCacheBytes ?? 16777216;
    while (this.bytes > maximum && this.entries.size) this.discard(this.entries.keys().next().value);
    const info = await stat(filename), cached = this.entries.get(filename);
    if (cached && cached.mtime === info.mtimeMs && cached.bytes.length === info.size) {
      this.entries.delete(filename); this.entries.set(filename, cached); return cached;
    }
    this.discard(filename);
    const bytes = await readFile(filename), entry = { bytes, mtime: info.mtimeMs, etag: `"${hash(bytes)}"` };
    while (this.bytes + bytes.length > maximum && this.entries.size) this.discard(this.entries.keys().next().value);
    if (bytes.length <= maximum) { this.entries.set(filename, entry); this.bytes += bytes.length; }
    return entry;
  }
}
