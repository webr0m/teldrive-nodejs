import { apiFetch } from "@/api/client";
import { nativeClient } from "./client-runtime";
import { saveNativeSession } from "./native-session";
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function googleClientLogin(link = false, signal?: AbortSignal) {
  if (!nativeClient)
    throw new Error("El acceso con Google está preparado para las aplicaciones Android e iOS.");
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const start = await (
    await apiFetch("/v1/mobile/google/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, link }),
      signal,
    })
  ).json();
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url: start.authUrl });
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Acceso cancelado", "AbortError");
      if (Date.now() >= Date.parse(start.expiresAt))
        throw new Error("El acceso con Google caducó. Inténtalo otra vez.");
      const result = await (
        await apiFetch("/v1/mobile/google/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: start.flowId, verifier, link }),
          signal,
        })
      ).json();
      if (result.state === "link_required")
        throw new Error(
          "Esta cuenta de Google aún no está vinculada. Entra con Telegram y abre Configuración → Cuenta → Vincular Google.",
        );
      if (result.accessToken) {
        await saveNativeSession(result);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(new DOMException("Acceso cancelado", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", stop);
          resolve();
        }, 2000);
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
  } finally {
    await Browser.close().catch(() => {});
  }
}
