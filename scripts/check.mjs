import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
async function files(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : path.join(dir, entry.name)))).flat(); }
for (const file of ['app.js', 'packages/rclone-teldrive/index.mjs', ...(await files('examples')), ...(await files('src')), ...(await files('edge')), ...(await files('scripts')), ...(await files('public'))].filter(f => /\.(mjs|js)$/.test(f))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (result.status) { process.stderr.write(result.stderr); process.exit(result.status); }
}
await import('../src/server.mjs');
console.log('JavaScript syntax and runtime imports passed');
