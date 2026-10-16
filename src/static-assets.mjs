import path from 'node:path';

// Only built-in interface resources are public. A file extension alone must
// never make an authenticated download or a SPA fallback cacheable.
const directories = new Set(['assets', 'fonts', 'images', 'pdfjs', 'demo']);
const extensions = new Set(['.js', '.mjs', '.css', '.json', '.wasm', '.woff2', '.woff', '.ttf', '.otf', '.pfb', '.bcmap', '.icc', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.avif', '.mp4', '.pdf', '.txt']);

export function staticCacheControl(filename, config) {
  const relative = path.relative(config.staticDir, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'no-store';
  const parts = relative.split(path.sep), extension = path.extname(filename).toLowerCase();
  if (!extensions.has(extension)) return 'no-store';
  if (parts[0] === 'assets' && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(filename)) {
    return 'public, max-age=31536000, immutable';
  }
  if (directories.has(parts[0]) || relative === 'client-pages.css') {
    const seconds = config.staticAssetMaxAge ?? 3600;
    return seconds ? `public, max-age=${seconds}, must-revalidate` : 'no-store';
  }
  return 'no-store';
}
