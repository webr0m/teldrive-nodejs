// Read-only preflight. Outputs structure and counts; never URLs or credentials.
import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import pg from 'pg';
import { pgOptions } from '../src/pg-options.mjs';
const file = process.argv[2] || 'config.toml', parsed = parse(await readFile(file, 'utf8'));
const schema = parsed.database?.schema || 'teldrive';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid schema');
const client = new pg.Client({ ...pgOptions(parsed.database?.url || parsed.db?.['data-source']), connectionTimeoutMillis: 10000, query_timeout: 10000 });
try {
  await client.connect(); await client.query('BEGIN READ ONLY');
  const columns = (await client.query('SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position', [schema])).rows;
  const layout = columns.some(c => c.table_name === 'files' && c.column_name === 'kind') ? 'v2' : columns.some(c => c.table_name === 'files' && c.column_name === 'type') ? 'legacy-v1' : 'unknown';
  const counts = {};
  for (const table of ['users', 'files', 'channels']) if (columns.some(c => c.table_name === table)) counts[table] = (await client.query(`SELECT count(*)::text AS count FROM "${schema}"."${table}"`)).rows[0].count;
  const users = layout === 'v2' ? (await client.query(`SELECT role,count(*)::text AS count FROM "${schema}".users GROUP BY role`)).rows : [];
  await client.query('ROLLBACK'); console.log(JSON.stringify({ layout, counts, roles: users, columns: columns.filter(c => ['files', 'file_parts', 'users', 'channels'].includes(c.table_name)) }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code || 'connection_error', errorType: error.constructor.name })); process.exitCode = 1; }
finally { await client.end(); }
