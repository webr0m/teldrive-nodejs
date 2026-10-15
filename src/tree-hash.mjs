import { blake3 } from "@noble/hashes/blake3.js";

// Teldrive calls this "blake3" in its API: hash each 16 MiB block, then
// hash the concatenation of the raw block digests. It is not raw BLAKE3.
export const BLOCK_SIZE = 16 * 1024 * 1024;
export const TREE_HASH_SCHEME = "teldrive-tree-v1";
export class TreeHash {
  constructor() {
    this.block = blake3.create();
    this.length = 0;
    this.blocks = [];
  }
  update(bytes) {
    if (this.finished) throw new Error("Hash already finalized");
    for (let offset = 0; offset < bytes.length; ) {
      const size = Math.min(BLOCK_SIZE - this.length, bytes.length - offset);
      this.block.update(bytes.subarray(offset, offset + size));
      this.length += size;
      offset += size;
      if (this.length === BLOCK_SIZE) this.finishBlock();
    }
    return this;
  }
  finishBlock() {
    this.blocks.push(Buffer.from(this.block.digest()).toString("hex"));
    this.block = blake3.create();
    this.length = 0;
  }
  digest() {
    if (!this.finished) {
      if (this.length) this.finishBlock();
      this.finished = true;
    }
    return hashBlocks(this.blocks);
  }
}
export function hashBlocks(blocks) {
  const hash = blake3.create();
  for (const value of blocks) {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Invalid block hash");
    hash.update(Buffer.from(value, "hex"));
  }
  return Buffer.from(hash.digest()).toString("hex");
}
