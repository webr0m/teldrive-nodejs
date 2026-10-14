import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
const dataDir = path.resolve('var/demo'); await mkdir(dataDir, { recursive: true, mode: 0o700 });
const keyFile = path.join(dataDir, 'key'); let key;
try { key = await readFile(keyFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; key = randomBytes(32).toString('base64'); await writeFile(keyFile, key, { mode: 0o600, flag: 'wx' }); }
const c = config({ CONFIG_FILE: 'none', NODE_ENV: 'development', STORAGE_BACKEND: 'local', DEMO_AUTH: 'true', DATA_KEY: key, DATA_DIR: dataDir, PORT: process.env.PORT || '3000', PUBLIC_URL: `http://127.0.0.1:${process.env.PORT || 3000}` });
const app = createApp(c); app.server.listen(c.port, c.host, () => console.log(`Demo local disponible: ${c.publicUrl}`));
process.on('SIGINT', async () => { await app.close(); process.exit(0); });
