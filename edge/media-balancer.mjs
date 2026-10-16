// Web-standard APIs only: this module also runs as a Cloudflare Worker.
export function mediaNodeRoute(method, pathname) {
  return ['GET', 'HEAD'].includes(method) && (
    /^\/api\/v1\/files\/[^/]+\/content(?:\/[^/]+)?$/.test(pathname) ||
    /^\/api\/v1\/playback(?:\/(?:tracks|subtitles))?$/.test(pathname));
}

const retryable = status => status >= 500 || status === 429;
function milliseconds(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
export function createMediaBalancer({ fetch: fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  const health = new Map();
  async function probe(origin, secret, timeout, ttl, secondary) {
    const key = `${origin}:${secondary}`, previous = health.get(key);
    if (previous && previous.until > now()) return previous.pending || previous;
    const pending = (async () => {
      const start = now();
      try {
        const response = await fetcher(`${origin}${secondary ? '/internal/media/health' : '/api/health/ready'}`, {
          headers: secondary ? { 'X-Teldrive-Media-Node': secret } : {}, redirect: 'manual',
          signal: AbortSignal.timeout(timeout), cache: 'no-store',
        });
        const body = response.ok ? await response.json() : undefined;
        if (!response.ok) await response.body?.cancel();
        const load = secondary ? Number(body?.load) : 0;
        const state = { ok: response.ok && body?.status === 'ok' && (!secondary || body?.role === 'media' && Number.isFinite(load) && load >= 0 && load < 1),
          latency: Math.max(1, now() - start), load, until: now() + ttl };
        health.set(key, state); return state;
      } catch { const state = { ok: false, until: now() + ttl }; health.set(key, state); return state; }
    })();
    health.set(key, { until: now() + ttl, pending });
    return pending;
  }
  return {
    async fetch(request, env) {
      // A route subrequest to the same zone continues to its existing origin.
      // Login, uploads, public shares and administration always use that path.
      const url = new URL(request.url), primary = env.PUBLIC_ORIGIN;
      const primaryRequest = () => {
        const headers = new Headers(request.headers); headers.delete('X-Teldrive-Media-Node'); headers.delete('X-Teldrive-PC-Portal');
        return fetcher(new Request(request, { headers, redirect: 'manual' }));
      };
      // Optional PC portal: normal Teldrive sign-in still applies. The edge
      // secret is added server-side and never sent to the browser.
      if (env.MEDIA_NODE_ADMIN === 'true' && url.origin === env.MEDIA_NODE_PORTAL_ORIGIN) {
        const target = new URL(request.url), origin = new URL(env.MEDIA_NODE_ORIGIN);
        if (origin.protocol !== 'https:' || origin.origin === url.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !/^[A-Za-z0-9_-]{43,128}$/.test(env.MEDIA_NODE_SECRET || '')) return new Response('Portal unavailable', { status: 503 });
        target.host = origin.host;
        const headers = new Headers(request.headers); headers.delete('Host'); headers.set('X-Teldrive-Media-Node', env.MEDIA_NODE_SECRET); headers.set('X-Teldrive-PC-Portal', '1');
        return fetcher(new Request(new Request(target, request), { headers, redirect: 'manual' }));
      }
      if (url.origin !== primary) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      if (!mediaNodeRoute(request.method, url.pathname) || env.MEDIA_NODE_ENABLED !== 'true') return primaryRequest();
      let secondary;
      try {
        secondary = new URL(env.MEDIA_NODE_ORIGIN);
        if (secondary.protocol !== 'https:' || secondary.origin === primary || secondary.username || secondary.password || secondary.pathname !== '/' || secondary.search || secondary.hash || !/^[A-Za-z0-9_-]{43,128}$/.test(env.MEDIA_NODE_SECRET || '')) return primaryRequest();
      } catch { return primaryRequest(); }
      const ttl = milliseconds(env.HEALTH_TTL_MS, 15000, 1000, 60000);
      const timeout = milliseconds(env.HEALTH_TIMEOUT_MS, 2500, 100, 10000);
      const headerTimeout = milliseconds(env.MEDIA_HEADER_TIMEOUT_MS, 15000, 1000, 60000);
      const [a, b] = await Promise.all([probe(primary, '', timeout, ttl, false), probe(secondary.origin, env.MEDIA_NODE_SECRET, timeout, ttl, true)]);
      const weight = milliseconds(env.MEDIA_NODE_WEIGHT, 1, 0.05, 10);
      const preferSecondary = b.ok && (!a.ok || (b.latency + 20) * (1 + b.load * 2) / weight < a.latency + 20);
      async function fromSecondary() {
        const target = new URL(request.url); target.host = secondary.host;
        const headers = new Headers(request.headers); headers.delete('Host'); headers.delete('X-Teldrive-PC-Portal'); headers.set('X-Teldrive-Media-Node', env.MEDIA_NODE_SECRET);
        const controller = new AbortController(), abort = () => controller.abort();
        request.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, headerTimeout);
        try {
          const response = await fetcher(new Request(target, { method: request.method, headers, redirect: 'manual', signal: controller.signal }));
          return response;
        } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
      }
      let response, node;
      const order = preferSecondary ? ['secondary', 'primary'] : b.ok ? ['primary', 'secondary'] : ['primary'];
      for (const [index, candidate] of order.entries()) {
        if (request.signal.aborted) throw new Error('Client disconnected');
        try { response = await (candidate === 'secondary' ? fromSecondary() : primaryRequest()); }
        catch { response = undefined; }
        const failed = !response || retryable(response.status);
        if (candidate === 'secondary' && failed) health.set(`${secondary.origin}:true`, { ok: false, until: now() + ttl });
        // Only bodyless reads enter this module. Try each host at most once,
        // before exposing any response bytes. Never retry authorization errors.
        if (!failed || index === order.length - 1) { node = candidate; break; }
        await response?.body?.cancel(); response = undefined;
      }
      if (!response) return new Response('Media origins unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      const headers = new Headers(response.headers);
      headers.delete('X-Teldrive-Media-Node'); headers.set('Cache-Control', 'no-store'); headers.set('X-Teldrive-Origin', node);
      // Stream directly; never buffer media or cache private responses.
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}
export default createMediaBalancer();
