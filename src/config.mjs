import path from 'node:path';
import { existsSync } from 'node:fs';
import { tomlEnvironment } from './toml.mjs';

export function config(env = process.env) {
  const filename = env.CONFIG_FILE === 'none' ? undefined : env.CONFIG_FILE || (existsSync('config.toml') ? 'config.toml' : undefined);
  if (filename) env = tomlEnvironment(filename, env);
  const integer = (name, fallback, min, max) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  const c = {
    production: env.NODE_ENV === 'production', host: env.HOST || '127.0.0.1',
    port: integer('PORT', 3000, 0, 65535), mode: env.MODE || 'native',
    backend: env.STORAGE_BACKEND || 'telegram', dataDir: path.resolve(env.DATA_DIR || './var'),
    staticDir: path.resolve(env.STATIC_DIR || './ui/dist'),
    key: Buffer.from(env.DATA_KEY || '', 'base64'), demo: env.DEMO_AUTH === 'true',
    apiId: Number(env.TELEGRAM_API_ID), apiHash: env.TELEGRAM_API_HASH,
    databaseUrl: env.DATABASE_URL, databaseLayout: env.DATABASE_LAYOUT || 'native',
    databaseTransport: env.DATABASE_TRANSPORT || 'postgres', supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_SECRET_KEY,
    databaseSchema: env.DATABASE_SCHEMA || 'teldrive', metadataSchema: env.NODE_DATABASE_SCHEMA || 'teldrive_node',
    databasePoolSize: integer('DATABASE_POOL_SIZE', 2, 1, 100),
    legacyEncryptionKey: env.LEGACY_ENCRYPTION_KEY,
    legacyKeyring: env.LEGACY_KEYRING ? JSON.parse(env.LEGACY_KEYRING) : {},
    encryptionKeyVersion: Number(env.ENCRYPTION_KEY_VERSION || 1),
    ownerUserId: env.OWNER_USER_ID,
    allowedUsers: (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
    publicUrl: new URL(env.PUBLIC_URL || `http://127.0.0.1:${env.PORT || 3000}`).origin,
    cors: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    allowIframe: env.ALLOW_IFRAME === 'true', upstream: env.UPSTREAM_URL,
    partSize: integer('PART_SIZE', 16 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
    maxFileSize: integer('MAX_FILE_SIZE', 100 * 1024 ** 3, 0, Number.MAX_SAFE_INTEGER),
    concurrency: integer('MAX_CONCURRENT_TRANSFERS', 2, 1, 64),
    uploadTtlHours: integer('UPLOAD_TTL_HOURS', 168, 1, 8760),
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MINUTE', 300, 10, 100000),
    loginRatePerMinute: integer('LOGIN_RATE_PER_MINUTE', 10, 1, 1000),
    jsonMaxBytes: integer('JSON_MAX_BYTES', 1048576, 4096, 16777216),
  };
  if (!['native', 'gateway'].includes(c.mode)) throw new Error('MODE must be native or gateway');
  if (c.mode === 'gateway') {
    const url = new URL(c.upstream || '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') throw new Error('UPSTREAM_URL must be an HTTP(S) origin');
    if (c.production && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote upstream requires HTTPS');
  } else {
    if (c.key.length !== 32) throw new Error('DATA_KEY must contain 32 random bytes encoded as base64');
    if (!['telegram', 'local'].includes(c.backend)) throw new Error('Invalid STORAGE_BACKEND');
    if (c.backend === 'telegram' && (!Number.isSafeInteger(c.apiId) || c.apiId < 1 || !/^[a-f0-9]{32}$/i.test(c.apiHash || ''))) throw new Error('Configure TELEGRAM_API_ID and TELEGRAM_API_HASH');
    if (c.production && c.allowedUsers.length === 0 && !c.databaseUrl && !c.supabaseUrl) throw new Error('Set ALLOWED_USERS before production deployment');
    c.existingUsersOnly = c.production && !c.allowedUsers.length && !!(c.databaseUrl || c.supabaseUrl);
    if (c.demo && (c.production || c.backend !== 'local' || !['127.0.0.1', 'localhost', '::1'].includes(c.host))) throw new Error('Demo authentication requires non-production, local storage and loopback binding');
  }
  if (!['native', 'legacy', 'v2', 'auto'].includes(c.databaseLayout)) throw new Error('Invalid DATABASE_LAYOUT');
  if (c.databaseLayout !== 'native' && ((!c.databaseUrl && !c.supabaseUrl) || c.backend !== 'telegram')) throw new Error('Existing database requires a database connection and Telegram storage');
  if (!['postgres', 'supabase'].includes(c.databaseTransport)) throw new Error('Invalid DATABASE_TRANSPORT');
  if (c.databaseTransport === 'supabase') {
    if (c.databaseSchema !== 'teldrive' || c.metadataSchema !== 'teldrive_node' || c.backend !== 'telegram') throw new Error('Supabase RPC requires the teldrive v2 schema and Telegram storage');
    const url = new URL(c.supabaseUrl || '');
    if (url.protocol !== 'https:' || url.origin !== c.supabaseUrl || !c.supabaseKey) throw new Error('Configure SUPABASE_URL (HTTPS origin) and SUPABASE_SECRET_KEY');
    c.databaseLayout = 'v2';
  }
  if (c.production && c.databaseUrl?.startsWith('pglite:')) throw new Error('PGlite is only a test harness');
  for (const schema of [c.databaseSchema, c.metadataSchema]) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
  if (c.databaseSchema === c.metadataSchema) throw new Error('Use a separate schema for Node-specific metadata');
  if (c.production && !c.publicUrl.startsWith('https:')) throw new Error('Production PUBLIC_URL must use HTTPS');
  for (const origin of c.cors) if (new URL(origin).origin !== origin) throw new Error('CORS_ORIGINS requires exact origins');
  return c;
}
