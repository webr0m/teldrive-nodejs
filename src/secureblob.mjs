import { randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

// Teldrive v2 internal/secureblob: version byte, 24-byte nonce, ciphertext/tag.
// Purpose is authenticated, so a bot session cannot be substituted for its token.
export class SecureBlob {
  constructor(key) { this.key = key; }
  seal(value, purpose) {
    const nonce = randomBytes(24);
    return Buffer.concat([Buffer.from([1]), nonce, Buffer.from(xchacha20poly1305(this.key, nonce, Buffer.from(purpose)).encrypt(Buffer.from(value)))]);
  }
  open(value, purpose) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.replace(/^\\x/, ''), 'hex');
    if (bytes.length < 41 || bytes[0] !== 1) throw new Error('Unsupported Teldrive credential');
    return Buffer.from(xchacha20poly1305(this.key, bytes.subarray(1, 25), Buffer.from(purpose)).decrypt(bytes.subarray(25)));
  }
}
