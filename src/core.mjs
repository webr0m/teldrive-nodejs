import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const expires = ms => new Date(Date.now() + ms).toISOString();
export const expired = value => value && new Date(value).getTime() <= Date.now();
export function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\x00-\x1f/\\]/.test(value) || ['.', '..'].includes(value)) fail(422, 'invalid_name');
  return value;
}
export function date(value, fallback = now()) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(422, 'invalid_date');
  return new Date(value).toISOString();
}
export function number(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(422, 'invalid_number');
  return value;
}
export function passwordHash(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) fail(422, 'invalid_password');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 32).toString('hex')}`;
}
export function passwordMatches(value, encoded) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const [salt, expected] = encoded.split(':');
  return timingSafeEqual(scryptSync(value, salt, 32), Buffer.from(expected, 'hex'));
}
export class CryptoBox {
  constructor(key) { this.key = key; }
  seal(bytes, purpose) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([Buffer.from('TDN1'), nonce, cipher.getAuthTag(), body]);
  }
  open(bytes, purpose) {
    if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'TDN1') throw new Error('Invalid encrypted blob');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
    cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]);
  }
  encode(value, purpose) { return this.seal(Buffer.from(JSON.stringify(value)), purpose).toString('base64'); }
  decode(value, purpose) { return JSON.parse(this.open(Buffer.from(value, 'base64'), purpose)); }
}
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'catalog.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket,id)); CREATE INDEX IF NOT EXISTS owner_index ON records(bucket,owner);');
  }
  get(bucket, key) { const r = this.db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get(bucket, String(key)); return r ? JSON.parse(r.body) : undefined; }
  put(bucket, value, owner = value.ownerId ?? value.userId ?? '') {
    const key = bucket === 'channels' ? `${owner}:${value.id}` : String(value.id);
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET owner=excluded.owner,body=excluded.body').run(bucket, key, String(owner), JSON.stringify(value)); return value;
  }
  list(bucket, owner) {
    const rows = owner === undefined ? this.db.prepare('SELECT body FROM records WHERE bucket=? ORDER BY id').all(bucket) : this.db.prepare('SELECT body FROM records WHERE bucket=? AND owner=? ORDER BY id').all(bucket, String(owner));
    return rows.map(r => JSON.parse(r.body));
  }
  delete(bucket, key, owner) { this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, bucket === 'channels' ? `${owner}:${key}` : String(key)); }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  close() { this.db.close(); }
  claimJob(jobId, workerId, leaseSeconds) {
    return this.transaction(() => {
      const job=this.get('jobs',jobId);if(!job)return;
      const renewing=job.status==='running'&&job.workerId===workerId;
      if (!renewing && !(job.status==='running'&&expired(job.leaseExpiresAt)) && !(['pending','scheduled','available','retryable'].includes(job.status)&&expired(job.scheduledAt))) return;
      if(!renewing){job.attempt++;job.startedAt=now();job.attemptedBy=[workerId];}job.status='running';job.workerId=workerId;job.leaseExpiresAt=expires(leaseSeconds*1000);this.put('jobs',job);return job;
    });
  }
  ready() { this.db.prepare('SELECT 1').get(); }
}
export class Locks {
  constructor() { this.locks = new Map(); }
  async run(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release; const current = new Promise(resolve => { release = resolve; }); this.locks.set(key, current);
    await previous;
    try { return await fn(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
}
export class Semaphore {
  constructor(max) { this.max = max; this.active = 0; }
  async run(fn) {
    // Reject excess work so cPanel cannot build an unbounded queue of uploads.
    if (this.active >= this.max) fail(429, 'transfer_busy', 'Try again after current transfers finish');
    this.active++; try { return await fn(); } finally { this.active--; }
  }
}
export function page(items, query) {
  const limit = number(Number(query.get('limit') || 100), 1, 500);
  let offset = 0;
  if (query.has('cursor')) {
    const raw = Buffer.from(query.get('cursor'), 'base64url').toString();
    if (!/^\d+$/.test(raw)) fail(422, 'invalid_cursor');
    offset = number(Number(raw));
  }
  const result = { items: items.slice(offset, offset + limit) };
  if (offset + limit < items.length) result.nextCursor = Buffer.from(String(offset + limit)).toString('base64url');
  return result;
}
export function category(file) {
  const mime = file.mimeType || '';
  for (const type of ['image', 'video', 'audio']) if (mime.startsWith(`${type}/`)) return type;
  if (/zip|rar|tar|gzip|7z/.test(mime)) return 'archive';
  if (/pdf|text|document|epub|office/.test(mime)) return 'document';
  return 'other';
}
