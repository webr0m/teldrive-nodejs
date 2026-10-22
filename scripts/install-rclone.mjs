import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';

// Opt-in installer for development/CI. Never invoked by npm postinstall.
const version = 'v1.75.4';
const platform = { win32: 'windows', linux: 'linux', darwin: 'osx' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!platform || !arch) throw new Error('Download a compatible tgdrive/rclone build for this platform manually');
const name = `rclone-${version}-${platform}-${arch}`;
const directory = path.resolve('var', 'tools', 'rclone', name);
const executable = path.join(directory, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
const response = await fetch(`https://api.github.com/repos/tgdrive/rclone/releases/tags/${version}`, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'teldrive-nodejs-compatibility-check',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Cannot read official rclone release metadata: HTTP ${response.status}`);
const release = await response.json(), asset = release.assets.find(a => a.name === `${name}.zip`);
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !asset.browser_download_url.startsWith(`https://github.com/tgdrive/rclone/releases/download/${version}/`)) throw new Error('Missing verifiable release asset');
let archive;
const archivePath = `${directory}.zip`;
try { archive = await readFile(archivePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const matches = bytes => bytes && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === asset.digest;
if (!matches(archive)) {
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!download.ok) throw new Error(`Cannot download official rclone asset: HTTP ${download.status}`);
  archive = Buffer.from(await download.arrayBuffer());
  if (!matches(archive)) throw new Error('Official rclone SHA256 mismatch');
  await mkdir(path.dirname(directory), { recursive: true });
  await writeFile(archivePath, archive);
}
const filename = `${name}/${path.basename(executable)}`;
const entries = unzipSync(archive, { filter: entry => entry.name === filename });
if (!entries[filename]) throw new Error('Missing executable in the verified archive');
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(executable, entries[filename], { mode: 0o700 });
await chmod(executable, 0o700);
console.log(`Verified tgdrive/rclone ${version}: ${executable}`);
