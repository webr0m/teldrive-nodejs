// Bounded validation: never logs names, credentials or file contents. Catalog
// records are read only; Telegram stores its independent bot authorization.
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { SupabaseStore } from '../src/supabase.mjs';
import { PostgresStore } from '../src/postgres.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Storage } from '../src/storage.mjs';

if (existsSync('.env')) loadEnvFile('.env');
loadEnvFile('.env.media-node');
const c = config({ ...process.env, HOST: '127.0.0.1', MEDIA_NODE: 'true', MEDIA_NODE_ADMIN: 'false', SERVER_CONFIG_FILE: 'none',
  TELEGRAM_INSTANCE_ID: `${process.env.MEDIA_NODE_INSTANCE_ID}-verification`, PORT: process.env.MEDIA_NODE_PORT || '3010' });
if (!c.ownerUserId) throw new Error('Configure the pinned owner before validation');
let store, telegram;
try {
  store = c.databaseTransport === 'supabase' ? new SupabaseStore(c) : new PostgresStore(c);
  telegram = new Telegram(store, c);
  const storage = new Storage(c, telegram), bots = telegram.eligibleBots(c.ownerUserId, 'download');
  if (!bots.length) throw Object.assign(new Error('No eligible bots'), { code: 'media_node_requires_bot' });
  const file = store.list('files', c.ownerUserId).filter(f => f.kind === 'file' && f.status === 'active' && f.size >= 4096 && f.parts?.[0]?.backend === 'telegram' && f.parts[0].plainSize >= 4096).sort((a, b) => a.size - b.size)[0];
  if (!file) throw Object.assign(new Error('No bounded test file'), { code: 'no_test_file' });
  const read = async (offset, length) => {
    const chunks = [];
    await storage.read(file.ownerId, file.parts[0], offset, length, async bytes => chunks.push(Buffer.from(bytes)));
    return Buffer.concat(chunks);
  };
  const start = Date.now(), prefix = await read(0, 4096), range = await read(37, 1024);
  assert.equal(prefix.length, 4096); assert.deepEqual(range, prefix.subarray(37, 1061));
  console.log(JSON.stringify({ status: 'ok', backend: 'telegram-bots-only', bytesChecked: prefix.length + range.length, rangeVerified: true, ms: Date.now() - start }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code || 'media_verification_failed' })); process.exitCode = 1; }
finally { await telegram?.close(); store?.close(); }
