import { fail } from './core.mjs';

const abortError = () => Object.assign(new Error('Download cancelled'), { name: 'AbortError' });

// Bound outstanding Telegram RPCs across streams, with a finite, cancellable queue.
export class DownloadGate {
  constructor(max = 16) { this.max = max; this.active = 0; this.queue = []; }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.max) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= 256) fail(429, 'transfer_busy', 'Download capacity is busy');
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: () => {
        const index = this.queue.indexOf(entry); if (index < 0) return;
        this.queue.splice(index, 1); reject(abortError());
      } };
      this.queue.push(entry); signal?.addEventListener('abort', entry.abort, { once: true });
    });
  }
  release() {
    this.active--;
    while (this.active < this.max && this.queue.length) {
      const entry = this.queue.shift(); entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(abortError()); continue; }
      this.active++; entry.resolve();
    }
  }
  async run(fn, signal) { await this.acquire(signal); try { return await fn(); } finally { this.release(); } }
}

export function cancellable(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortError()); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Read ahead by at most `buffers` blocks; emit strictly in byte order. No file-size allocation.
// A failed attempt is fully stopped before the caller resumes from its last emitted byte.
export async function orderedDownload({ offset, length, parallel, buffers, fetch, write, signal, chunkSize = 512 * 1024 }) {
  const controller = new AbortController(), cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const results = new Map(), pending = new Set();
  let position = offset, remaining = length, launched = 0, emitted = 0, active = 0, stopped = false, failure, wake;
  const notify = () => { wake?.(); wake = undefined; };
  const launch = () => {
    while (!stopped && !failure && !controller.signal.aborted && remaining > 0 && active < parallel && launched - emitted < buffers) {
      const skip = position % chunkSize, count = Math.min(remaining, chunkSize - skip);
      const plan = { offset: position - skip, skip, length: count, requestSize: chunkSize }, seq = launched++;
      position += count; remaining -= count; active++;
      const task = Promise.resolve().then(() => fetch(plan, controller.signal)).then(
        bytes => { if (!stopped && !failure) results.set(seq, bytes); },
        error => { if (!failure) { failure = error; controller.abort(); } },
      ).finally(() => { active--; pending.delete(task); notify(); launch(); });
      pending.add(task);
    }
  };
  const onAbort = () => { failure ||= abortError(); notify(); };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    launch();
    while (emitted < launched || remaining > 0) {
      if (failure) throw failure;
      if (controller.signal.aborted) throw abortError();
      if (!results.has(emitted)) { await new Promise(resolve => { wake = resolve; }); continue; }
      const bytes = results.get(emitted); results.delete(emitted);
      await write(bytes); emitted++; launch();
    }
  } finally {
    stopped = true; controller.abort(); notify();
    signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', onAbort);
    await Promise.allSettled(pending); results.clear();
  }
}
