import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { staticCacheControl } from '../src/static-assets.mjs';

test('CDN policy only caches actual public interface resources', () => {
  const config = { staticDir: path.resolve('ui/dist'), staticAssetMaxAge: 120 };
  const policy = name => staticCacheControl(path.resolve(config.staticDir, name), config);
  assert.equal(policy('assets/index-AbCdEfG1.js'), 'public, max-age=31536000, immutable');
  for (const name of ['fonts/geist.woff2', 'pdfjs/cmaps/Adobe-Japan1.bcmap', 'pdfjs/wasm/openjpeg.wasm', 'images/logo.svg', 'demo/video.mp4', 'client-pages.css']) {
    assert.equal(policy(name), 'public, max-age=120, must-revalidate', name);
  }
  for (const name of ['index.html', 'privacy.html', 'assets/index.html', '.env', 'config.toml', '../secret.js', 'uploads/private.pdf', 'api/v1/files/test.png']) {
    assert.equal(policy(name), 'no-store', name);
  }
  config.staticAssetMaxAge = 0;
  assert.equal(policy('fonts/geist.woff2'), 'no-store');
  assert.equal(policy('assets/index-AbCdEfG1.js'), 'public, max-age=31536000, immutable');
});
