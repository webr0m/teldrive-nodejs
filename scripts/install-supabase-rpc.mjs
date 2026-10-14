import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../src/config.mjs';
import { pgOptions } from '../src/pg-options.mjs';
const c = config({ ...process.env, CONFIG_FILE: process.argv[2] || 'config.toml' });
const client = new pg.Client({ ...pgOptions(c.databaseUrl), connectionTimeoutMillis: 10000, query_timeout: 30000 });
try {
  await client.connect();
  const before = (await client.query('SELECT count(*)::text AS files FROM teldrive.files')).rows[0].files;
  const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='teldrive' AND table_name='files'")).rows.map(row => row.column_name);
  if (!columns.includes('kind') || columns.includes('normalized_name')) throw new Error('Unsupported v2 schema');
  await client.query("SET lock_timeout='5s'");
  await client.query(await readFile(new URL('../db/supabase-rpc.sql', import.meta.url), 'utf8'));
  const after = (await client.query('SELECT count(*)::text AS files FROM teldrive.files')).rows[0].files;
  const ready = (await client.query("SELECT teldrive_node_api.catalog('{\"action\":\"ready\"}'::jsonb) AS ready")).rows[0].ready;
  console.log(JSON.stringify({ installed: true, beforeFiles: before, afterFiles: after, ready }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code || 'install_error', errorType: error.constructor.name })); process.exitCode = 1; }
finally { await client.end(); }
