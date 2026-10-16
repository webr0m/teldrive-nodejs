import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (existsSync('.env')) loadEnvFile('.env');
loadEnvFile('.env.media-node');
const c = config({ ...process.env, NODE_ENV: 'production', MEDIA_NODE: 'true', HOST: '127.0.0.1',
  PORT: process.env.MEDIA_NODE_PORT || '3010',
  PUBLIC_URL: process.env.MEDIA_NODE_PUBLIC_ORIGIN || process.env.PUBLIC_URL,
  CORS_ORIGINS: process.env.MEDIA_NODE_PRIMARY_ORIGIN || '',
  SERVER_CONFIG_FILE: './var/media-node/config.admin.toml',
  SERVER_RESTART_FILE: './var/media-node/restart',
  DATA_DIR: process.env.MEDIA_NODE_DATA_DIR || './var/media-node',
  TELEGRAM_INSTANCE_ID: process.env.MEDIA_NODE_INSTANCE_ID,
  MEDIA_ENABLED: 'true', FFMPEG_PATH: process.env.MEDIA_NODE_FFMPEG || '', FFPROBE_PATH: process.env.MEDIA_NODE_FFPROBE || '',
  MEDIA_CONCURRENCY: process.env.MEDIA_NODE_CONCURRENCY || '2', MEDIA_THREADS: process.env.MEDIA_NODE_THREADS || '2',
  MAX_CONCURRENT_TRANSFERS: process.env.MEDIA_NODE_TRANSFERS || '4',
  BOT_CLIENT_POOL_SIZE: process.env.MEDIA_NODE_BOT_POOL || '4',
  RATE_LIMIT_PER_MINUTE: process.env.MEDIA_NODE_RATE_LIMIT || '3000',
  RCLONE_MOUNT_ENABLED: 'false', DEMO_AUTH: 'false',
});
const app = createApp(c);
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(c.port, c.host, resolve); });
console.log(JSON.stringify({ event: 'media_node_listening', host: c.host, port: c.port, transfers: c.concurrency, conversions: c.mediaConcurrency, instance: c.telegramInstanceId }));
const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let stopping = false;
const { watchFile, unwatchFile } = await import('node:fs');
watchFile(path.resolve('./var/media-node/restart'), { interval: 1000, persistent: false }, (current, previous) => {
  if (!stopping && current.mtimeMs > 0 && current.mtimeMs !== previous.mtimeMs) { stopping = true; unwatchFile(path.resolve('./var/media-node/restart')); stop(); }
});
