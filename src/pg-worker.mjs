// Dedicated I/O worker keeps the catalog's synchronous transaction boundary consistent.
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import { pgOptions } from './pg-options.mjs';
const embedded = workerData.url.startsWith('pglite:');
const pool = embedded ? null : new pg.Pool({ ...pgOptions(workerData.url), max: 1, connectionTimeoutMillis: 10000, query_timeout: 30000 });
let client;
let initialize = (async () => {
  if (embedded) {
    const { PGlite } = await import('@electric-sql/pglite');
    client = new PGlite(); await client.waitReady;
    if (workerData.fixture) await client.exec(workerData.fixture);
  }
})();
parentPort.on('message', async ({ sql, values, control, output, close }) => {
  if (close) { if (embedded) await client?.close(); else { client?.release(); await pool.end(); } return; }
  const flags = new Int32Array(control), buffer = new Uint8Array(output);
  let result;
  try {
    await initialize;
    client ??= await pool.connect();
    const response = embedded && !values.length && sql.includes(';') ? await client.exec(sql) : await client.query(sql, values);
    result = { rows: Array.isArray(response) ? response.at(-1).rows : response.rows };
  } catch (error) { result = { error: { code: error.code || 'postgres_error', message: 'PostgreSQL operation failed' } }; }
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > buffer.length) {
    const failure = Buffer.from(JSON.stringify({ error: { code: 'postgres_result_too_large', message: 'PostgreSQL result exceeds the catalog buffer; reduce catalog size or use gateway mode' } }));
    buffer.set(failure); Atomics.store(flags, 1, failure.length);
  } else { buffer.set(bytes); Atomics.store(flags, 1, bytes.length); }
  Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
});
