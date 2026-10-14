import { parentPort, workerData } from 'node:worker_threads';
parentPort.on('message', async ({ request, control, output }) => {
  const flags = new Int32Array(control), buffer = new Uint8Array(output);
  let result;
  try {
    const response = await fetch(`${workerData.url}/rest/v1/rpc/catalog`, {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { apikey: workerData.key, ...(workerData.key.startsWith('eyJ') ? { Authorization: `Bearer ${workerData.key}` } : {}), 'Content-Type': 'application/json', 'Content-Profile': 'teldrive_node_api', 'Accept-Profile': 'teldrive_node_api' },
      body: JSON.stringify({ request }),
    });
    const body = await response.json();
    if (!response.ok) {
      const conflict = body.code === '23505' || body.message === 'generation_changed';
      result = { error: { status: conflict ? 409 : 503, code: body.message === 'generation_changed' ? 'generation_changed' : conflict ? 'name_conflict' : 'supabase_unavailable' } };
    } else result = { value: body };
  } catch { result = { error: { status: 503, code: 'supabase_unavailable' } }; }
  let bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > buffer.length) bytes = Buffer.from(JSON.stringify({ error: { status: 503, code: 'supabase_result_too_large' } }));
  buffer.set(bytes); Atomics.store(flags, 1, bytes.length); Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
});
