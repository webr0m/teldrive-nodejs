import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

const mappings = {
  'server.port': 'PORT', 'tg.app-id': 'TELEGRAM_API_ID', 'tg.app-hash': 'TELEGRAM_API_HASH',
  'db.data-source': 'DATABASE_URL', 'db.pool.max-open-connections': 'DATABASE_POOL_SIZE',
  'jwt.allowed-users': 'ALLOWED_USERS', 'tg.uploads.encryption-key': 'LEGACY_ENCRYPTION_KEY',
  'node.host': 'HOST', 'node.public-url': 'PUBLIC_URL', 'node.mode': 'MODE',
  'node.storage-backend': 'STORAGE_BACKEND', 'node.data-dir': 'DATA_DIR', 'node.data-key': 'DATA_KEY',
  'node.database-layout': 'DATABASE_LAYOUT', 'node.database-schema': 'DATABASE_SCHEMA',
  'node.metadata-schema': 'NODE_DATABASE_SCHEMA', 'node.owner-user-id': 'OWNER_USER_ID',
  'node.upstream-url': 'UPSTREAM_URL', 'node.cors-origins': 'CORS_ORIGINS',
  'node.allow-iframe': 'ALLOW_IFRAME', 'node.demo-auth': 'DEMO_AUTH',
  'node.limits.part-size': 'PART_SIZE', 'node.limits.max-file-size': 'MAX_FILE_SIZE',
  'node.limits.concurrent-transfers': 'MAX_CONCURRENT_TRANSFERS',
  'node.limits.upload-ttl-hours': 'UPLOAD_TTL_HOURS',
  'node.limits.rate-limit-per-minute': 'RATE_LIMIT_PER_MINUTE',
  'node.limits.login-rate-per-minute': 'LOGIN_RATE_PER_MINUTE',
  'node.limits.json-max-bytes': 'JSON_MAX_BYTES',
  'http.public-url': 'PUBLIC_URL',
  'database.url': 'DATABASE_URL', 'database.schema': 'DATABASE_SCHEMA',
  'database.max-connections': 'DATABASE_POOL_SIZE',
  'telegram.app-id': 'TELEGRAM_API_ID', 'telegram.app-hash': 'TELEGRAM_API_HASH',
  'security.data-key': 'DATA_KEY', 'security.allowed-users': 'ALLOWED_USERS',
};
export function tomlEnvironment(filename, env) {
  const parsed = parse(readFileSync(filename, 'utf8')), mapped = {};
  for (const [key, target] of Object.entries(mappings)) {
    const value = key.split('.').reduce((obj, part) => obj?.[part], parsed);
    if (value !== undefined) mapped[target] = Array.isArray(value) ? value.join(',') : String(value);
  }
  if (mapped.DATABASE_URL) mapped.DATABASE_LAYOUT ??= parsed.database ? 'auto' : 'legacy';
  if (parsed.http?.address && !mapped.PORT) {
    const match = /^(.*):(\d+)$/.exec(parsed.http.address);
    if (match) { mapped.HOST = match[1]; mapped.PORT = match[2]; }
  }
  // The configured active content key can encrypt new legacy-format parts. Older
  // content keys remain a separate read keyring, never returned by the admin API.
  if (parsed.encryption?.keys) {
    mapped.LEGACY_KEYRING = JSON.stringify(parsed.encryption.keys);
    mapped.ENCRYPTION_KEY_VERSION = String(parsed.encryption['active-key-version']);
    mapped.LEGACY_ENCRYPTION_KEY = parsed.encryption.keys[String(parsed.encryption['active-key-version'])];
  }
  // [node] values override equivalents inherited from an existing v1/v2 TOML.
  for (const [key, target] of Object.entries(mappings).filter(([k]) => k.startsWith('node.'))) {
    const value = key.split('.').reduce((obj, part) => obj?.[part], parsed);
    if (value !== undefined) mapped[target] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return { ...mapped, ...env };
}
