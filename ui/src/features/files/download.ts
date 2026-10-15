import { t } from "@/lib/localization";
import type { FileEntry } from "@/api/types";
import { nativeClient, serverOrigin, apiUrl } from "@/lib/client-runtime";
import { apiFetch } from "@/api/client";
import { nativeFileDownload, nativeBlobSave } from "@/lib/mobile";
import { toast } from "sonner";
import { isDemoActive, demoContentUrl } from "@/lib/client-demo";

export function fileContentUrl(file: Pick<FileEntry, "id" | "name">, download = false) {
  if (isDemoActive()) return demoContentUrl(file.id);
  const path = `/api/v1/files/${encodeURIComponent(file.id)}/content/${encodeURIComponent(file.name)}`;
  return download ? `${path}?download=1` : path;
}

export function startFileDownload(file: Pick<FileEntry, "id" | "name">) {
  if (nativeClient && isDemoActive()) {
    void fetch(demoContentUrl(file.id)).then(response => response.blob()).then(blob => nativeBlobSave(blob, file.name))
      .catch(error => toast.error(t("No se pudo descargar el archivo"), { description: String(error.message || error) }));
    return;
  }
  if (nativeClient && !isDemoActive()) {
    void (async () => {
      const grant = await (await apiFetch(`/v1/files/${encodeURIComponent(file.id)}/playback`, { method: "POST" })).json();
      await nativeFileDownload(apiUrl(`/api/v1/playback?${new URLSearchParams({ ticket: grant.ticket, download: "1" })}`), file.name);
    })().catch(error => toast.error(t("No se pudo descargar el archivo"), { description: String(error.message || error) }));
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = fileContentUrl(file, true);
  anchor.download = file.name;
  anchor.click();
}

export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Clipboard API requires a secure context; the textarea path also works on HTTP IP hosts.
  }

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  activeElement?.focus();
  if (!copied) throw new Error(t("El portapapeles no está disponible"));
}

export function absoluteFileDownloadUrl(file: Pick<FileEntry, "id" | "name">) {
  return new URL(fileContentUrl(file, true), serverOrigin).toString();
}
