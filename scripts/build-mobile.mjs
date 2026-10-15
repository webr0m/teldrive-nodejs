import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const root = path.resolve(import.meta.dirname, '..'), ui = path.join(root, 'ui');
const origin = new URL(process.env.VITE_MOBILE_SERVER_URL || 'https://cloud.webrom.lat');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('VITE_MOBILE_SERVER_URL debe ser un origen HTTPS sin credenciales');
if (process.env.VITE_ADMOB_LIVE === 'true') {
  for (const variable of ['MOBILE_ADMOB_ANDROID_APP_ID', 'MOBILE_ADMOB_IOS_APP_ID']) if (!/^ca-app-pub-\d{16}~\d{10}$/.test(process.env[variable] || '') || process.env[variable].includes('3940256099942544')) throw new Error(`Configura ${variable} con tu aplicación AdMob real`);
}
const env = { ...process.env, VITE_CLIENT_ONLY: 'true', VITE_MOBILE_SERVER_URL: origin.origin };
function run(binary, args) {
  const result = spawnSync(process.execPath, [path.join(ui, 'node_modules', binary), ...args], { cwd: ui, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
run('vite/bin/vite.js', ['build', '--outDir', 'dist-mobile']);
run('typescript/bin/tsc', []);
run('@capacitor/cli/bin/capacitor', ['sync', ...process.argv.slice(2)]);
const version = JSON.parse(await readFile(path.join(root, 'package.json'))).version;
console.log(`Cliente ${version} preparado para ${origin.origin}; anuncios ${process.env.VITE_ADMOB_LIVE === 'true' ? 'reales' : 'de prueba'}.`);
