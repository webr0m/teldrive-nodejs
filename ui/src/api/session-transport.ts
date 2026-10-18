type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createSessionTransport(fetcher: Fetcher, origin: string) {
  let refreshing: Promise<boolean> | undefined;
  let generation = 0;
  const refresh = () => {
    refreshing ??= fetcher(new URL("/api/v1/auth/cookie/refresh", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((response) => {
        void response.body?.cancel().catch(() => {});
        if (response.ok) generation++;
        return response.ok;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const makeRequest = () =>
      new Request(input instanceof Request ? input : new URL(String(input), origin), init);
    const first = makeRequest(),
      started = generation;
    const path = new URL(first.url).pathname;
    const canRefresh =
      !path.includes("/auth/") &&
      !path.startsWith("/api/v1/public/") &&
      (!path.startsWith("/api/v1/playback") || path === "/api/v1/playback/diagnostics");
    // Recreate Blob/string bodies instead of buffering a second copy of their stream.
    const retry =
      canRefresh && (input instanceof Request || init?.body instanceof ReadableStream)
        ? first.clone()
        : undefined;
    try {
      let response = await fetcher(first);
      if (response.status === 401 && canRefresh) {
        void response.body?.cancel().catch(() => {});
        if (generation !== started || (await refresh()))
          response = await fetcher(retry || makeRequest());
      }
      return response;
    } finally {
      if (retry && !retry.bodyUsed) void retry.body?.cancel().catch(() => {});
    }
  };
  return { request, refresh };
}
