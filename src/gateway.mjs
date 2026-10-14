import http from 'node:http';
import https from 'node:https';
import { fail } from './core.mjs';

const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headers(source) {
  const result = { ...source };
  const nominated = String(result.connection || '').split(',').map(x => x.trim().toLowerCase());
  for (const key of [...hop, ...nominated]) delete result[key];
  return result;
}
export function gateway(config) {
  const origin = new URL(config.upstream), transport = origin.protocol === 'https:' ? https : http;
  const publicOrigin = new URL(config.publicUrl);
  const requestOptions = req => ({ protocol: origin.protocol, hostname: origin.hostname, port: origin.port || undefined, method: req.method, path: req.url, headers: { ...headers(req.headers), host: origin.host, 'x-forwarded-host': publicOrigin.host, 'x-forwarded-proto': publicOrigin.protocol.slice(0, -1), 'x-forwarded-for': req.socket.remoteAddress } });
  return {
    request(req, res) {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) fail(400, 'invalid_path');
      const upstream = transport.request(requestOptions(req), response => {
        res.writeHead(response.statusCode, headers(response.headers)); response.pipe(res);
        response.on('error', () => res.destroy());
      });
      upstream.setTimeout(3600000, () => upstream.destroy(new Error('Upstream timed out')));
      upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'The original Teldrive server is unavailable' } })); } else res.destroy(); });
      req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); req.pipe(upstream);
    },
    upgrade(req, socket, head) {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || (req.headers.origin && req.headers.origin !== config.publicUrl)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const options = requestOptions(req); options.headers.connection = 'Upgrade'; options.headers.upgrade = 'websocket';
      const request = transport.request(options);
      request.on('upgrade', (response, remote, remoteHead) => {
        socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`);
        for (const [k, v] of Object.entries(response.headers)) for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) socket.write(`${k}: ${value}\r\n`);
        socket.write('\r\n'); if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket); socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      });
      request.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Upstream rejected upgrade\r\n\r\n`); });
      request.on('error', () => socket.destroy()); request.end();
    },
  };
}
