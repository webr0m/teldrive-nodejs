import { startTeldriveRclone } from '../packages/rclone-teldrive/index.mjs';

if (!process.env.TELDRIVE_API_KEY) throw new Error('Set TELDRIVE_API_KEY to a dedicated key from Settings → API keys');
const drive = await startTeldriveRclone({
  apiHost: process.env.TELDRIVE_URL || 'https://cloud.webrom.lat',
  apiKey: process.env.TELDRIVE_API_KEY,
  executable: process.env.RCLONE_EXECUTABLE,
  chunkMiB: Number(process.env.RCLONE_CHUNK_MIB || 64),
  concurrency: Number(process.env.RCLONE_CONCURRENCY || 2),
});
try {
  const { list } = await drive.list(process.env.TELDRIVE_PATH || '');
  console.table(list.map(({ Name, Size, IsDir }) => ({ name: Name, bytes: Size, directory: IsDir })));
} finally { await drive.close(); }
