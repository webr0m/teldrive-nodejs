// Explicitly install only the two pinned multimedia packages' binaries.
// General dependency lifecycle scripts remain disabled.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
for (const name of ['ffmpeg-static','@derhuerst/ffprobe-static']) {
  const result = spawnSync(process.execPath,[require.resolve(`${name}/install.js`)],{stdio:'inherit',windowsHide:true,env:{...process.env,CI:'true'}});
  if(result.status !== 0) process.exit(result.status || 1);
}
