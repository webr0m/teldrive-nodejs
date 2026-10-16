import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

export const mappings = {
  'server.port': 'PORT', 'tg.app-id': 'TELEGRAM_API_ID', 'tg.app-hash': 'TELEGRAM_API_HASH',
  'db.data-source': 'DATABASE_URL', 'db.pool.max-open-connections': 'DATABASE_POOL_SIZE',
  'jwt.allowed-users': 'ALLOWED_USERS', 'tg.uploads.encryption-key': 'LEGACY_ENCRYPTION_KEY',
  'node.host': 'HOST', 'node.public-url': 'PUBLIC_URL', 'node.mode': 'MODE',
  'node.storage-backend': 'STORAGE_BACKEND', 'node.data-dir': 'DATA_DIR', 'node.data-key': 'DATA_KEY',
  'node.database-url': 'DATABASE_URL', 'node.database-layout': 'DATABASE_LAYOUT', 'node.database-schema': 'DATABASE_SCHEMA',
  'node.metadata-schema': 'NODE_DATABASE_SCHEMA', 'node.owner-user-id': 'OWNER_USER_ID',
  'node.database-transport': 'DATABASE_TRANSPORT', 'node.supabase-url': 'SUPABASE_URL', 'node.supabase-key': 'SUPABASE_SECRET_KEY',
  'node.upstream-url': 'UPSTREAM_URL', 'node.cors-origins': 'CORS_ORIGINS',
  'node.allow-iframe': 'ALLOW_IFRAME', 'node.demo-auth': 'DEMO_AUTH',
  'node.google.client-id': 'GOOGLE_CLIENT_ID', 'node.google.client-secret': 'GOOGLE_CLIENT_SECRET',
  'node.mobile.ads-config-url': 'MOBILE_ADS_CONFIG_URL', 'node.mobile.privacy-url': 'MOBILE_PRIVACY_URL', 'node.mobile.support-url': 'MOBILE_SUPPORT_URL',
  'node.limits.part-size': 'PART_SIZE', 'node.limits.max-file-size': 'MAX_FILE_SIZE',
  'node.limits.concurrent-transfers': 'MAX_CONCURRENT_TRANSFERS',
  'node.rclone.executable': 'RCLONE_EXECUTABLE', 'node.rclone.mount-root': 'RCLONE_MOUNT_ROOT', 'node.rclone.mount-enabled': 'RCLONE_MOUNT_ENABLED', 'node.rclone.agent-origin': 'RCLONE_AGENT_ORIGIN',
  'node.limits.rclone-max-jobs': 'RCLONE_MAX_JOBS', 'node.limits.rclone-max-cache-gib': 'RCLONE_MAX_CACHE_GIB', 'node.limits.rclone-max-cache-hours': 'RCLONE_MAX_CACHE_HOURS', 'node.limits.rclone-request-seconds': 'RCLONE_REQUEST_SECONDS', 'node.limits.rclone-workspace-bytes': 'RCLONE_WORKSPACE_BYTES',
  'node.limits.upload-ttl-hours': 'UPLOAD_TTL_HOURS',
  'node.limits.rate-limit-per-minute': 'RATE_LIMIT_PER_MINUTE',
  'node.limits.login-rate-per-minute': 'LOGIN_RATE_PER_MINUTE',
  'node.limits.json-max-bytes': 'JSON_MAX_BYTES',
  'node.limits.static-cache-bytes': 'STATIC_CACHE_BYTES',
  'node.limits.static-asset-max-age': 'STATIC_ASSET_MAX_AGE',
  'node.limits.job-poll-seconds': 'JOB_POLL_SECONDS', 'node.limits.job-lease-seconds': 'JOB_LEASE_SECONDS', 'node.limits.job-batch-limit': 'JOB_BATCH_LIMIT', 'node.limits.pending-retention-days': 'PENDING_RETENTION_DAYS',
  'http.public-url': 'PUBLIC_URL',
  'database.url': 'DATABASE_URL', 'database.schema': 'DATABASE_SCHEMA',
  'database.max-connections': 'DATABASE_POOL_SIZE',
  'telegram.app-id': 'TELEGRAM_API_ID', 'telegram.app-hash': 'TELEGRAM_API_HASH',
  'telegram.download-bots': 'DOWNLOAD_BOTS', 'tg.stream.bots': 'DOWNLOAD_BOTS',
  'node.limits.download-bots': 'DOWNLOAD_BOTS', 'node.limits.bot-attempts': 'BOT_ATTEMPTS', 'node.limits.bot-retry-seconds': 'BOT_RETRY_SECONDS',
  'node.limits.bot-client-pool-size': 'BOT_CLIENT_POOL_SIZE', 'node.limits.bot-client-idle-seconds': 'BOT_CLIENT_IDLE_SECONDS', 'node.limits.upload-retry-attempts': 'UPLOAD_RETRY_ATTEMPTS',
  'node.limits.playback-ttl-minutes': 'PLAYBACK_TTL_MINUTES',
  'node.telegram-instance-id': 'TELEGRAM_INSTANCE_ID',
  'node.media-node.enabled': 'MEDIA_NODE', 'node.media-node.secret': 'MEDIA_NODE_SECRET',
  'node.media-node.administration': 'MEDIA_NODE_ADMIN', 'node.media-node.primary-origin': 'MEDIA_NODE_PRIMARY_ORIGIN',
  'media.enabled': 'MEDIA_ENABLED', 'media.ffmpeg-path': 'FFMPEG_PATH', 'media.ffprobe-path': 'FFPROBE_PATH', 'media.max-concurrent': 'MEDIA_CONCURRENCY',
  'media.ca-file': 'MEDIA_CA_FILE',
  'node.limits.media-concurrency': 'MEDIA_CONCURRENCY', 'node.limits.media-threads': 'MEDIA_THREADS', 'node.limits.media-max-width': 'MEDIA_MAX_WIDTH',
  'node.limits.media-copy-video': 'MEDIA_COPY_VIDEO', 'node.limits.media-analyze-seconds': 'MEDIA_ANALYZE_SECONDS',
  'node.limits.media-timeout-seconds': 'MEDIA_TIMEOUT_SECONDS', 'node.limits.media-probe-timeout-seconds': 'MEDIA_PROBE_TIMEOUT_SECONDS', 'node.limits.media-probe-bytes': 'MEDIA_PROBE_BYTES',
  'security.data-key': 'DATA_KEY', 'security.allowed-users': 'ALLOWED_USERS',
};
export function tomlEnvironment(filename, env) {
  return { ...mapToml(parse(readFileSync(filename, 'utf8'))), ...env };
}
export function mapToml(parsed) {
  const mapped = {};
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
  return mapped;
}
