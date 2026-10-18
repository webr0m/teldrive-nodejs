import { nativeClient, serverOrigin, apiUrl, clientOnly } from "./client-runtime";
import { isDemoActive } from "./client-demo";
type Pair = { accessToken: string; refreshToken: string; tokenType: string; expiresIn: number };
let pair: Pair | undefined;
let restored: Promise<void> | undefined;
let refreshing: Promise<boolean> | undefined;
const storageKey = `teldrive-session:${serverOrigin}`;
export async function restoreNativeSession() {
  if (!nativeClient) return;
  restored ??= (async () => {
    const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
    const value = await SecureStorage.get(storageKey);
    if (value && typeof value === "object" && "refreshToken" in value && "accessToken" in value)
      pair = value as unknown as Pair;
  })().catch(() => {
    pair = undefined;
  });
  await restored;
}
export async function saveNativeSession(value: Pair) {
  if (!nativeClient) throw new Error("La sesión nativa necesita la aplicación móvil");
  const { SecureStorage, KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
  await SecureStorage.set(
    storageKey,
    value as unknown as Record<string, unknown>,
    false,
    false,
    KeychainAccess.whenUnlockedThisDeviceOnly,
  );
  pair = value;
}
export async function clearNativeSession() {
  pair = undefined;
  if (nativeClient)
    await (await import("@aparajita/capacitor-secure-storage")).SecureStorage.remove(
      storageKey,
      false,
    );
}
export function clientHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  if (clientOnly) headers.set("X-Teldrive-Client", "mobile");
  if (nativeClient && pair) headers.set("Authorization", `Bearer ${pair.accessToken}`);
  return headers;
}
export async function nativeRefresh() {
  if (isDemoActive()) return true;
  if (!nativeClient) return false;
  refreshing ??= (async () => {
    await restoreNativeSession();
    if (!pair) return false;
    const response = await fetch(apiUrl("/api/v1/auth/refresh"), {
      method: "POST",
      headers: clientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refreshToken: pair.refreshToken }),
      credentials: "omit",
    });
    if (!response.ok) {
      await clearNativeSession();
      return false;
    }
    await saveNativeSession(await response.json());
    return true;
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}
export async function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = new Request(input instanceof Request ? input : apiUrl(String(input)), init);
  let url = new URL(source.url);
  if (url.origin !== serverOrigin)
    throw new Error("La petición de la cuenta debe usar el servidor configurado");
  if (isDemoActive()) return (await import("./demo-transport")).demoRequest(source);
  await restoreNativeSession();
  if (nativeClient && url.pathname.includes("/auth/cookie/"))
    url = new URL(url.toString().replace("/auth/cookie/", "/auth/"));
  const mapped =
    url.toString() === source.url
      ? source
      : new Request(url, {
          method: source.method,
          headers: source.headers,
          signal: source.signal,
          body: ["GET", "HEAD"].includes(source.method) ? undefined : await source.blob(),
        });
  const request = new Request(mapped, {
    headers: clientHeaders(mapped.headers),
    credentials: nativeClient ? "omit" : "same-origin",
  });
  const privateRequest = url.pathname === "/api/v1/playback/diagnostics" || !["/auth/", "/public/", "/mobile/google/", "/playback"].some((part) =>
    url.pathname.includes(part),
  );
  const retry = nativeClient && privateRequest ? request.clone() : undefined;
  try {
    let response = await fetch(request);
    if (response.status === 401 && retry && (await nativeRefresh())) {
      void response.body?.cancel();
      response = await fetch(new Request(retry, { headers: clientHeaders(retry.headers) }));
    }
    if (
      nativeClient &&
      response.ok &&
      /\/auth\/(telegram\/verify-(code|password)|telegram\/qr\/poll)$/.test(url.pathname)
    ) {
      const value = await response.clone().json();
      if (value.accessToken && value.refreshToken) await saveNativeSession(value);
      if (value.accessToken)
        return Response.json({
          authenticated: true,
          expiresAt: new Date(Date.now() + value.expiresIn * 1000).toISOString(),
        });
    }
    if (nativeClient && response.ok && url.pathname.endsWith("/auth/logout"))
      await clearNativeSession();
    return response;
  } finally {
    if (retry && !retry.bodyUsed) void retry.body?.cancel().catch(() => {});
  }
}
