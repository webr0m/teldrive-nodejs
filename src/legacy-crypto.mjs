// Compatible with the MIT-licensed Teldrive main branch TELDRIVE\0\0 file format.
import { scryptSync, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { fail } from './core.mjs';
const magic = Buffer.from('TELDRIVE\0\0'), block = 65536, headerSize = magic.length + 24;
function key(password, salt) { return scryptSync(password, salt, 80, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).subarray(0, 32); }
function increment(nonce) { for (let i = 0; i < nonce.length; i++) { nonce[i] = (nonce[i] + 1) & 255; if (nonce[i]) break; } }
export function encryptedSize(size) { return headerSize + size + Math.ceil(size / block) * 16; }
export function plainSize(size) { const remaining = size - headerSize; if (remaining < 0) fail(503, 'legacy_cipher_truncated'); return remaining - Math.ceil(remaining / (block + 16)) * 16; }
export function encryptLegacy(bytes, password, salt, nonce = randomBytes(24)) {
  const k = key(password, salt), counter = Buffer.from(nonce), chunks = [magic, Buffer.from(nonce)];
  for (let offset = 0; offset < bytes.length; offset += block) { chunks.push(Buffer.from(nacl.secretbox(bytes.subarray(offset, offset + block), counter, k))); increment(counter); }
  return Buffer.concat(chunks);
}
export function decryptLegacy(bytes, password, salt) {
  if (bytes.length < headerSize || !bytes.subarray(0, magic.length).equals(magic)) fail(503, 'legacy_cipher_header');
  const k = key(password, salt), counter = Buffer.from(bytes.subarray(magic.length, headerSize)), chunks = [];
  for (let offset = headerSize; offset < bytes.length; offset += block + 16) {
    const plain = nacl.secretbox.open(bytes.subarray(offset, offset + block + 16), counter, k);
    if (!plain) fail(503, 'legacy_cipher_authentication'); chunks.push(Buffer.from(plain)); increment(counter);
  }
  return Buffer.concat(chunks);
}
export async function decryptLegacyRange(read, storedSize, offset, length, password, salt, write) {
  const headerChunks = []; await read(0, headerSize, bytes => { headerChunks.push(bytes); });
  const header = Buffer.concat(headerChunks);
  if (header.length !== headerSize || !header.subarray(0, magic.length).equals(magic)) fail(503, 'legacy_cipher_header');
  const first = Math.floor(offset / block), last = Math.floor((offset + length - 1) / block);
  const counter = Buffer.from(header.subarray(magic.length)), k = key(password, salt);
  let addition = BigInt(first);
  for (let i = 0; i < counter.length; i++) { addition += BigInt(counter[i]); counter[i] = Number(addition & 255n); addition >>= 8n; }
  const start = headerSize + first * (block + 16), end = Math.min(storedSize, headerSize + (last + 1) * (block + 16));
  let pending = Buffer.alloc(0), current = first, remaining = end - start;
  await read(start, remaining, async bytes => {
    remaining -= bytes.length; pending = Buffer.concat([pending, bytes]);
    while (pending.length >= block + 16 || (!remaining && pending.length)) {
      const size = Math.min(block + 16, pending.length), sealed = pending.subarray(0, size);
      const plain = nacl.secretbox.open(sealed, counter, k); if (!plain) fail(503, 'legacy_cipher_authentication');
      const plainStart = current * block, from = Math.max(0, offset - plainStart), to = Math.min(plain.length, offset + length - plainStart);
      if (to > from) await write(Buffer.from(plain.subarray(from, to)));
      pending = pending.subarray(size); current++; increment(counter);
    }
  });
}
