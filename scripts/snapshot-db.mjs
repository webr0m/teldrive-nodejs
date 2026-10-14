// Private, encrypted table snapshot before connecting an existing catalogue.
// This supplements a provider backup/pg_dump; it is not a complete PostgreSQL cluster backup.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { config } from '../src/config.mjs';
import { CryptoBox } from '../src/core.mjs';
import { pgOptions } from '../src/pg-options.mjs';
const c = config({ ...process.env, CONFIG_FILE: process.argv[2] || 'config.toml' });
const client = new pg.Client({ ...pgOptions(c.databaseUrl), connectionTimeoutMillis: 10000, query_timeout: 60000 });
try {
  await client.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name", [c.databaseSchema])).rows;
  const snapshot = { format: 'teldrive-table-snapshot-1', schema: c.databaseSchema, createdAt: new Date().toISOString(), tables: {} };
  for (const { table_name: table } of tables) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    snapshot.tables[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM "${c.databaseSchema}".${quoted} t`)).rows.map(r => r.row);
  }
  await client.query('ROLLBACK');
  const bytes = gzipSync(Buffer.from(JSON.stringify(snapshot))), box = new CryptoBox(c.key);
  const directory = path.join(c.dataDir, 'backups'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `catalog-${snapshot.createdAt.replace(/[:.]/g, '-')}.tdn`);
  await writeFile(filename, box.seal(bytes, 'database-snapshot'), { flag: 'wx', mode: 0o600 });
  const verified = box.open(await readFile(filename), 'database-snapshot');
  if (!verified.equals(bytes) || JSON.parse(gunzipSync(verified)).format !== snapshot.format) throw new Error('Snapshot verification failed');
  console.log(JSON.stringify({ file: filename, tableCount: tables.length, fileCount: snapshot.tables.files?.length, sha256: createHash('sha256').update(verified).digest('hex'), verified: true }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code || 'snapshot_error', errorType: error.constructor.name })); process.exitCode = 1; }
finally { await client.end(); }
