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
    staticCacheBytes: integer('STATIC_CACHE_BYTES', 16777216, 0, 67108864),
    key: Buffer.from(env.DATA_KEY || '', 'base64'), demo: env.DEMO_AUTH === 'true',
    apiId: Number(env.TELEGRAM_API_ID), apiHash: env.TELEGRAM_API_HASH,
    telegramInstanceId: env.TELEGRAM_INSTANCE_ID,
    downloadBots: integer('DOWNLOAD_BOTS', 20, 0, 200), botAttempts: integer('BOT_ATTEMPTS', 2, 1, 20),
    botRetrySeconds: integer('BOT_RETRY_SECONDS', 60, 1, 86400),
    botClientPoolSize: integer('BOT_CLIENT_POOL_SIZE', 2, 0, 64), botClientIdleSeconds: integer('BOT_CLIENT_IDLE_SECONDS', 30, 1, 600),
    uploadRetryAttempts: integer('UPLOAD_RETRY_ATTEMPTS', 5, 0, 10),
    jobPollSeconds: integer('JOB_POLL_SECONDS', 10, 1, 300), jobLeaseSeconds: integer('JOB_LEASE_SECONDS', 300, 30, 3600),
    jobBatchLimit: integer('JOB_BATCH_LIMIT', 1000, 1, 10000), pendingRetentionDays: integer('PENDING_RETENTION_DAYS', 30, 1, 3650),
    playbackTtlMinutes: integer('PLAYBACK_TTL_MINUTES', 60, 5, 1440),
    mediaEnabled: env.MEDIA_ENABLED !== 'false', ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH,
    mediaCaFile: env.MEDIA_CA_FILE,
    mediaConcurrency: integer('MEDIA_CONCURRENCY', 1, 1, 64), mediaThreads: integer('MEDIA_THREADS', 1, 1, 64),
    mediaCopyVideo: integer('MEDIA_COPY_VIDEO', 1, 0, 1),
    mediaAnalyzeSeconds: integer('MEDIA_ANALYZE_SECONDS', 1, 1, 60),
    mediaMaxWidth: integer('MEDIA_MAX_WIDTH', 1280, 128, 7680), mediaTimeoutSeconds: integer('MEDIA_TIMEOUT_SECONDS', 7200, 10, 86400),
    mediaProbeTimeoutSeconds: integer('MEDIA_PROBE_TIMEOUT_SECONDS', 60, 5, 600), mediaProbeBytes: integer('MEDIA_PROBE_BYTES', 8388608, 32768, 134217728),
    databaseUrl: env.DATABASE_URL, databaseLayout: env.DATABASE_LAYOUT || 'native',
    databaseTransport: env.DATABASE_TRANSPORT || 'postgres', supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_SECRET_KEY,
    databaseSchema: env.DATABASE_SCHEMA || 'teldrive', metadataSchema: env.NODE_DATABASE_SCHEMA || 'teldrive_node',
    databasePoolSize: integer('DATABASE_POOL_SIZE', 2, 1, 100),
    legacyEncryptionKey: env.LEGACY_ENCRYPTION_KEY,
    legacyKeyring: env.LEGACY_KEYRING ? JSON.parse(env.LEGACY_KEYRING) : {},
    encryptionKeyVersion: Number(env.ENCRYPTION_KEY_VERSION || 1),
    ownerUserId: env.OWNER_USER_ID,
    googleClientId: env.GOOGLE_CLIENT_ID || '', googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    mobileAdsUrl: env.MOBILE_ADS_CONFIG_URL || '',
    mobilePrivacyUrl: env.MOBILE_PRIVACY_URL || '', mobileSupportUrl: env.MOBILE_SUPPORT_URL || '',
    allowedUsers: (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
    publicUrl: new URL(env.PUBLIC_URL || `http://127.0.0.1:${env.PORT || 3000}`).origin,
    cors: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    allowIframe: env.ALLOW_IFRAME === 'true', upstream: env.UPSTREAM_URL,
    partSize: integer('PART_SIZE', 16 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
    maxFileSize: integer('MAX_FILE_SIZE', 100 * 1024 ** 3, 0, Number.MAX_SAFE_INTEGER),
    concurrency: integer('MAX_CONCURRENT_TRANSFERS', 2, 1, 64),
    rcloneExecutable: env.RCLONE_EXECUTABLE, rcloneMountRoot: env.RCLONE_MOUNT_ROOT,
    rcloneMountEnabled: env.RCLONE_MOUNT_ENABLED !== 'false',
    rcloneAgentOrigin: env.RCLONE_AGENT_ORIGIN || 'http://127.0.0.1:5573',
    rcloneMaxJobs: integer('RCLONE_MAX_JOBS', 2, 1, 64),
    rcloneMaxCacheGiB: integer('RCLONE_MAX_CACHE_GIB', 100, 1, 100000),
    rcloneMaxCacheHours: integer('RCLONE_MAX_CACHE_HOURS', 720, 1, 87600),
    rcloneRequestSeconds: integer('RCLONE_REQUEST_SECONDS', 120, 5, 3600),
    rcloneWorkspaceBytes: integer('RCLONE_WORKSPACE_BYTES', 1073741824, 1048576, Number.MAX_SAFE_INTEGER),
    uploadTtlHours: integer('UPLOAD_TTL_HOURS', 168, 1, 8760),
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MINUTE', 300, 10, 100000),
    loginRatePerMinute: integer('LOGIN_RATE_PER_MINUTE', 10, 1, 1000),
    jsonMaxBytes: integer('JSON_MAX_BYTES', 1048576, 4096, 16777216),
  };
  if (!['native', 'gateway'].includes(c.mode)) throw new Error('MODE must be native or gateway');
  if (!!c.googleClientId !== !!c.googleClientSecret) throw new Error('Configure both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  for (const value of [c.mobileAdsUrl, c.mobilePrivacyUrl, c.mobileSupportUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Mobile remote configuration requires HTTPS URLs without credentials or fragments');
  }
  const agent = new URL(c.rcloneAgentOrigin);
  if (!['127.0.0.1','localhost','[::1]'].includes(agent.hostname) || !['http:','https:'].includes(agent.protocol) || agent.username || agent.password || agent.pathname !== '/' || agent.search || agent.hash) throw new Error('RCLONE_AGENT_ORIGIN must be a loopback HTTP(S) origin');
  c.rcloneAgentOrigin = agent.origin;
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
