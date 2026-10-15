import { t } from "@/lib/localization";
import { nativeClient, serverOrigin } from "./client-runtime";
type MobileRequest = {
  id: string;
  method: "download" | "save";
  url?: string;
  filename: string;
  headers?: Record<string, string>;
  contents?: string;
  mime?: string;
};
type AndroidBridge = {
  postMessage: (message: string) => void;
  onmessage?: (event: { data: string }) => void;
};
const pending = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
>();
const activeCacheFiles = new Set<string>();

/** Saves a small local demo file without issuing a server download. */
export async function nativeBlobSave(blob: Blob, filename: string) {
  if (!nativeClient) return false;
  if (blob.size > 8 * 1024 * 1024) throw new Error("El archivo de demostración supera 8 MB");
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const path = `teldrive-${crypto.randomUUID()}-${filename.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_").slice(0, 180)}`;
  activeCacheFiles.add(path);
  try {
    const { uri } = await Filesystem.writeFile({ directory: Directory.Cache, path, data: btoa(binary) });
    await Share.share({ title: filename, files: [uri] });
  } catch (error) { await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(() => {}); throw error; }
  finally { activeCacheFiles.delete(path); }
  return true;
}

/** Returns false in a normal browser; native apps stream directly to device storage. */
export async function nativeFileDownload(
  url: string,
  filename: string,
  headers: HeadersInit = {},
): Promise<boolean> {
  if (nativeClient) {
    if (new URL(url).origin !== serverOrigin) throw new Error(t("La descarga debe pertenecer al servidor conectado."));
    const [{ Filesystem, Directory }, { FileTransfer }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"), import("@capacitor/file-transfer"), import("@capacitor/share"),
    ]);
    const name = filename.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_").slice(0, 180) || "archivo";
    const path = `teldrive-${crypto.randomUUID()}-${name}`;
    const { uri } = await Filesystem.getUri({ directory: Directory.Cache, path });
    activeCacheFiles.add(path);
    try {
      await FileTransfer.downloadFile({ url, path: uri, headers: Object.fromEntries(new Headers(headers)) });
      await Share.share({ title: name, files: [uri] });
    } catch (error) {
      await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(() => {});
      throw error;
    } finally { activeCacheFiles.delete(path); }
    return true;
  }
  return nativeRequest({
    id: crypto.randomUUID(),
    method: "download",
    url,
    filename,
    headers: Object.fromEntries(new Headers(headers)),
  });
}
export async function nativeTextSave(
  contents: string,
  filename: string,
  mime = "text/plain",
): Promise<boolean> {
  if (nativeClient) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
    const path = `teldrive-${crypto.randomUUID()}-${filename.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_").slice(0, 180)}`;
    activeCacheFiles.add(path);
    try {
      const { uri } = await Filesystem.writeFile({ directory: Directory.Cache, path, data: contents, encoding: Encoding.UTF8 });
      await Share.share({ title: filename, files: [uri] });
    } catch (error) { await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(() => {}); throw error; }
    finally { activeCacheFiles.delete(path); }
    return true;
  }
  return nativeRequest({ id: crypto.randomUUID(), method: "save", contents, filename, mime });
}
async function nativeRequest(request: MobileRequest): Promise<boolean> {
  const mobile = window as Window & {
    teldriveMobile?: AndroidBridge;
    webkit?: {
      messageHandlers?: {
        teldriveMobile?: { postMessage: (request: MobileRequest) => Promise<unknown> };
      };
    };
  };
  const ios = mobile.webkit?.messageHandlers?.teldriveMobile;
  if (ios) {
    await ios.postMessage(request);
    return true;
  }
  const android = mobile.teldriveMobile;
  if (!android) return false;
  android.onmessage = (event) => {
    try {
      const reply = JSON.parse(event.data) as { id: string; error?: string };
      const operation = pending.get(reply.id);
      if (!operation) return;
      clearTimeout(operation.timeout);
      pending.delete(reply.id);
      if (reply.error) operation.reject(new Error(reply.error));
      else operation.resolve();
    } catch {
      /* Ignore unrelated messages. */
    }
  };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        pending.delete(request.id);
        reject(new Error(t("La app no pudo completar el guardado.")));
      },
      request.method === "save" ? 300_000 : 15_000,
    );
    pending.set(request.id, { resolve, reject, timeout });
    try {
      android.postMessage(JSON.stringify(request));
    } catch (cause) {
      clearTimeout(timeout);
      pending.delete(request.id);
      reject(cause instanceof Error ? cause : new Error(t("No se pudo iniciar el guardado.")));
    }
  });
  return true;
}

export async function cleanClientCache(expiredOnly = false) {
  if (!nativeClient) return 0;
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { files } = await Filesystem.readdir({ directory: Directory.Cache, path: "" }); let removed = 0;
  for (const file of files) if (file.type === "file" && file.name.startsWith("teldrive-") && !activeCacheFiles.has(file.name) && (!expiredOnly || file.mtime < Date.now() - 86400000)) {
    await Filesystem.deleteFile({ directory: Directory.Cache, path: file.name }); removed++;
  }
  return removed;
}
