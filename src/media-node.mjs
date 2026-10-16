import { timingSafeEqual } from 'node:crypto';
import { fail } from './core.mjs';
import { mediaNodeRoute } from '../edge/media-balancer.mjs';
export { mediaNodeRoute } from '../edge/media-balancer.mjs';

export function guardMediaNode(config, req, pathname) {
  if (!config.mediaNode) return;
  const provided = req.headers['x-teldrive-media-node'];
  if (typeof provided !== 'string' || !config.mediaNodeSecret ||
      Buffer.byteLength(provided) !== Buffer.byteLength(config.mediaNodeSecret) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(config.mediaNodeSecret))) fail(404, 'not_found');
  if (!config.mediaNodeAdmin && !(req.method === 'GET' && pathname === '/internal/media/health') && !mediaNodeRoute(req.method, pathname)) fail(503, 'media_node_route_pinned');
}

export function mediaNodeLocalRoute(method, pathname) {
  return mediaNodeRoute(method, pathname) || !pathname.startsWith('/api/') ||
    pathname === '/api/v1/me' || /^\/api\/v1\/admin\/(?:settings|configuration)(?:\/|$)/.test(pathname);
}

export function mediaNodeHealth(context) {
  context.store.ready();
  const activeTransfers = context.uploads.transfers.active;
  const activeConversions = context.media.transfers.active;
  const transferCapacity = context.config.concurrency;
  const conversionCapacity = context.config.mediaConcurrency;
  const load = Math.max(activeTransfers / transferCapacity, activeConversions / conversionCapacity);
  return { status: load >= 1 ? 'busy' : 'ok', role: 'media', load, activeTransfers, activeConversions, transferCapacity, conversionCapacity };
}
