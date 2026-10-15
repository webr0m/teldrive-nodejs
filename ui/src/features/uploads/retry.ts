export function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function retryUploadPart<T>(
  send: () => Promise<T>,
  signal: AbortSignal,
  refresh: () => Promise<boolean>,
  maxRetries = 5,
  delay = abortableDelay,
) {
  let refreshed = false,
    retries = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await send();
    } catch (error) {
      signal.throwIfAborted();
      const failure = error as { status?: number; retryAfterMilliseconds?: number };
      if (failure.status === 401 && !refreshed) {
        refreshed = true;
        if (await refresh()) continue;
      }
      if (![undefined, 0, 429, 503].includes(failure.status) || retries >= maxRetries) throw error;
      const milliseconds = Math.max(
        1000,
        Math.min(60000, failure.retryAfterMilliseconds || 1000 * 2 ** retries),
      );
      retries++;
      await delay(milliseconds, signal);
    }
  }
}
