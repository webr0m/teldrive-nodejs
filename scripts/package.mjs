import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const { zipSync, unzipSync } = createRequire(new URL('../ui/package.json', import.meta.url))('fflate');
await readFile('ui/dist/index.html');
await mkdir('artifacts', { recursive: true });
const output = path.resolve('artifacts/teldrive-nodejs.zip');
const result = spawnSync('git', ['archive', '--format=zip', 'HEAD'], { maxBuffer: 128 * 1024 ** 2 });
if (result.status) { process.stderr.write(result.stderr); process.exit(result.status); }
const entries = unzipSync(result.stdout);
async function add(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await add(filename);
    else if (entry.isFile()) entries[filename.replaceAll('\\', '/')] = new Uint8Array(await readFile(filename));
  }
}
await add('ui/dist');
await writeFile(output, zipSync(entries, { level: 6 }));
console.log(output);
