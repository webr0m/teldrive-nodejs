import { parentPort, workerData } from 'node:worker_threads';
import https from 'node:https';

// Use the core HTTPS client: it also works under Passenger/LVE memory limits,
// where loading fetch's WebAssembly parser can fail before the request is sent.
async function requestRpc(request) {
  const body = Buffer.from(JSON.stringify({ request }));
  return new Promise((resolve, reject) => {
    const req = https.request(`${workerData.url}/rest/v1/rpc/catalog`, {
      method: 'POST', timeout: 25000,
      headers: { apikey: workerData.key, ...(workerData.key.startsWith('eyJ') ? { Authorization: `Bearer ${workerData.key}` } : {}), 'Content-Type': 'application/json', 'Content-Length': body.length, 'Content-Profile': 'teldrive_node_api', 'Accept-Profile': 'teldrive_node_api' },
    }, response => {
      let length = 0; const chunks = [];
      response.on('data', chunk => { length += chunk.length; if (length > 32 * 1024 ** 2) response.destroy(new Error('response_too_large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout'))); req.on('error', reject); req.end(body);
  });
}
parentPort.on('message', async ({ request, control, output }) => {
  const flags = new Int32Array(control), buffer = new Uint8Array(output);
  let result;
  try {
    const { status, body } = await requestRpc(request);
    if (status < 200 || status >= 300) {
      const conflict = body.code === '23505' || body.message === 'generation_changed';
      result = { error: { status: conflict ? 409 : 503, code: body.message === 'generation_changed' ? 'generation_changed' : conflict ? 'name_conflict' : 'supabase_unavailable' } };
    } else result = { value: body };
  } catch (error) { console.error(JSON.stringify({ event: 'supabase_transport_failed', type: error.name, code: error.code })); result = { error: { status: 503, code: 'supabase_unavailable' } }; }
  let bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > buffer.length) bytes = Buffer.from(JSON.stringify({ error: { status: 503, code: 'supabase_result_too_large' } }));
  buffer.set(bytes); Atomics.store(flags, 1, bytes.length); Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
});
