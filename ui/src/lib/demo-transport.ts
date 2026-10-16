import type { FileEntry, UploadSession, ChannelSummary } from "@/api/types";
import { demoUrls as urls, demoContentUrl } from "./client-demo";

const now = () => new Date().toISOString();
const expires = () => new Date(Date.now() + 86400000).toISOString();
const files = new Map<string, FileEntry>();
const blobs = new Map<string, Blob>();
const uploads = new Map<string, { session: UploadSession; parts: Map<number, Blob> }>();
const channels: ChannelSummary[] = [
  { id: 1000001, name: "Unidad de ejemplo", selected: true, health: "healthy", createdAt: now() },
  { id: 1000002, name: "Archivo de ejemplo", selected: false, health: "healthy", createdAt: now() },
];
const maxBytes = 8 * 1024 * 1024;
const maxFiles = 100;
function entry(name: string, kind: FileEntry["kind"], extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id: crypto.randomUUID(),
    name,
    kind,
    status: "active",
    generation: 1,
    encryption: false,
    modTime: now(),
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  };
}
function add(value: FileEntry, blob?: Blob) {
  files.set(value.id, value);
  if (blob) {
    blobs.set(value.id, blob);
    urls.set(value.id, URL.createObjectURL(blob));
  }
  return value;
}
const folder = add(entry("Documentos de ejemplo", "folder"));
const welcome = new Blob(
  [
    "Bienvenido a Teldrive Cloud\n\nEsta unidad de demostración vive solo en la memoria de la aplicación.\nPuedes buscar, crear carpetas, renombrar, copiar, mover, subir archivos pequeños y usar la papelera.\nLos canales y bots son ejemplos. No existe conexión con Telegram, Google, tu cuenta ni el servidor.\nLas subidas de prueba tienen un límite total de 8 MB. Al recargar se restablecen los ejemplos.\nPara compartir enlaces públicos, vincular Google y configurar bots reales, sal de la demo e inicia sesión con Telegram.\n",
  ],
  { type: "text/plain" },
);
add(entry("Bienvenido.txt", "file", { mimeType: welcome.type, size: welcome.size }), welcome);
const notes = new Blob(
  [
    "Carpetas y canales\n\nEn Ajustes → Canales puedes elegir el destino de nuevas subidas.\nCambiar de canal no mueve los archivos anteriores.\nLos bots necesitan permisos de administrador en el canal elegido.\n",
  ],
  { type: "text/plain" },
);
add(
  entry("Canales y bots.txt", "file", {
    parentId: folder.id,
    mimeType: notes.type,
    size: notes.size,
  }),
  notes,
);
// Packaged examples are part of the application, not remote user content.
const image = add(entry("Imagen de ejemplo.png", "file", { mimeType: "image/png", size: 1 }));
const video = add(entry("Vídeo de ejemplo.mp4", "file", { mimeType: "video/mp4", size: 1 }));
urls.set(image.id, new URL("/demo/image.png", window.location.origin).href);
urls.set(video.id, new URL("/demo/video.mp4", window.location.origin).href);

export function demoBlob(id: string) {
  return blobs.get(id);
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (message: string, status = 403) =>
  json({ error: { code: "demo_limit", message } }, status);
const all = () => [...files.values()];
function pathFor(file: FileEntry): string {
  const parent = file.parentId && files.get(file.parentId);
  return parent ? `${pathFor(parent) === "/" ? "" : pathFor(parent)}/${parent.name}` : "/";
}
const category = (file: FileEntry) =>
  file.mimeType?.startsWith("image/")
    ? "image"
    : file.mimeType?.startsWith("video/")
      ? "video"
      : file.mimeType?.startsWith("audio/")
        ? "audio"
        : /text|pdf|epub/.test(file.mimeType ?? "")
          ? "document"
          : "other";
const usedBytes = () =>
  [...blobs.values()].reduce((sum, blob) => sum + blob.size, 0) +
  [...uploads.values()]
    .filter((value) => value.session.state === "open")
    .reduce((sum, value) => sum + value.session.expectedSize, 0);
function touch(value: FileEntry) {
  value.updatedAt = now();
  value.generation++;
  return value;
}
function descendants(id: string): FileEntry[] {
  return all()
    .filter((file) => file.parentId === id)
    .flatMap((file) => [file, ...descendants(file.id)]);
}
function uniqueName(name: string, parentId?: string, exclude?: string) {
  let candidate = name,
    index = 1;
  while (
    all().some(
      (file) =>
        file.id !== exclude &&
        file.status === "active" &&
        file.parentId === parentId &&
        file.name.toLowerCase() === candidate.toLowerCase(),
    )
  )
    candidate = `${name} (${index++})`;
  return candidate;
}

/** Closed transport: unsupported requests fail here; nothing falls through to fetch. */
export async function demoRequest(request: Request): Promise<Response> {
  if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const url = new URL(request.url),
    path = url.pathname.replace(/^\/api/, ""),
    method = request.method;
  const body = async () => request.json();
  if (path === "/v1/me" && method === "GET")
    return json({
      userId: -1,
      displayName: "Demostración local",
      username: "demo",
      premium: false,
      role: "user",
      capabilities: ["files.read", "files.write", "files.share", "files.manageGrants"],
      createdAt: now(),
    });
  if (path === "/v1/mobile/config" && method === "GET")
    return json({ googleEnabled: false, adsConfigUrl: "" });
  if (path === "/v1/mobile/account" && method === "GET")
    return json({ enabled: false, linked: false });
  if (/\/auth\/(cookie\/)?logout$/.test(path) && method === "POST")
    return new Response(null, { status: 204 });
  if (/\/auth\/(cookie\/)?refresh$/.test(path) && method === "POST")
    return json({ authenticated: true, expiresAt: expires() });
  if (path === "/v1/channels" && method === "GET") return json({ items: channels });
  if (path === "/v1/channels/discover" && method === "GET")
    return json(channels.map(({ id, name }) => ({ id, name })));
  const selection = path.match(/^\/v1\/channels\/(\d+)\/select$/);
  if (selection && method === "POST") {
    const channel = channels.find((item) => item.id === Number(selection[1]));
    if (!channel) return error("Canal de ejemplo inexistente", 404);
    channels.forEach((item) => {
      item.selected = item === channel;
    });
    return json(channel);
  }
  if (path === "/v1/bots/manager" && method === "GET") return json({ configured: false, supported: false, pending: [] });
  if (path === "/v1/bots" && method === "GET")
    return json({
      items: [{ id: 1000003, username: "bot_de_ejemplo", enabled: true, createdAt: now() }],
    });
  if (path === "/v1/sessions" && method === "GET")
    return json({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          current: true,
          createdAt: now(),
          expiresAt: expires(),
        },
      ],
    });
  if (
    [
      "/v1/shared",
      "/v1/shared/with-me",
      "/v1/shared/spam",
      "/v1/uploads/statistics/daily",
    ].includes(path) &&
    method === "GET"
  )
    return json([]);
  if (path === "/v1/uploads" && method === "GET")
    return json({ items: [...uploads.values()].map((value) => value.session) });
  if (path === "/v1/files/statistics/drive" && method === "GET")
    return json({
      totalFiles: all().filter((file) => file.kind === "file").length,
      totalFolders: all().filter((file) => file.kind === "folder").length,
      totalBytes: usedBytes(),
      trashedFiles: all().filter((file) => file.status === "trashed").length,
      activeShares: 0,
      openUploads: [...uploads.values()].filter((value) => value.session.state === "open").length,
    });
  if (path === "/v1/files/statistics/categories" && method === "GET")
    return json(
      ["image", "video", "audio", "document", "archive", "other"].map((value) => ({
        category: value,
        totalFiles: all().filter((file) => file.kind === "file" && category(file) === value).length,
        totalSize: all()
          .filter((file) => category(file) === value)
          .reduce((sum, file) => sum + (file.size ?? 0), 0),
      })),
    );
  if (path === "/v1/files" && method === "GET") {
    const q = url.searchParams,
      search = q.get("search")?.toLowerCase(),
      parentId = q.get("parentId") || undefined;
    const items = all().filter(
      (file) =>
        file.status === (q.get("status") ?? "active") &&
        (q.get("scope") === "drive" ||
          (parentId
            ? file.parentId === parentId ||
              (q.get("scope") === "recursive" &&
                descendants(parentId).some((child) => child.id === file.id))
            : q.get("path")
              ? pathFor(file) === q.get("path")
              : !file.parentId)) &&
        (!search || file.name.toLowerCase().includes(search)) &&
        (!q.get("kind") || file.kind === q.get("kind")) &&
        (!q.get("category") || q.getAll("category").includes(category(file))),
    );
    const sort = q.get("sort"),
      reverse = q.get("order") === "desc" ? -1 : 1;
    items.sort(
      (a, b) =>
        reverse *
        (sort === "size"
          ? (a.size ?? 0) - (b.size ?? 0)
          : String(sort === "updatedAt" ? a.updatedAt : a.name).localeCompare(
              String(sort === "updatedAt" ? b.updatedAt : b.name),
            )),
    );
    return json({ items: items.map((file) => ({ ...file, parentPath: pathFor(file) })) });
  }
  if (path === "/v1/folders" && method === "POST") {
    if (files.size >= maxFiles) return error("La demo admite hasta 100 elementos", 413);
    const data = await body();
    return json(
      add(
        entry(uniqueName(String(data.name).slice(0, 255), data.parentId), "folder", {
          parentId: data.parentId,
        }),
      ),
      201,
    );
  }
  if (path === "/v1/uploads" && method === "POST") {
    const data = await body();
    if (
      !Number.isSafeInteger(data.size) ||
      data.size < 0 ||
      usedBytes() + data.size > maxBytes ||
      files.size >= maxFiles ||
      uploads.size >= maxFiles
    )
      return error(
        "La demo admite hasta 8 MB en total y 100 elementos. Inicia sesión para subir a tu unidad.",
        413,
      );
    const session: UploadSession = {
      id: crypto.randomUUID(),
      name: String(data.name).slice(0, 255),
      parentId: data.parentId,
      expectedSize: data.size,
      mimeType: data.mimeType,
      modTime: now(),
      encryption: false,
      conflictPolicy: "rename",
      partSize: maxBytes,
      state: "open",
      createdAt: now(),
      expiresAt: expires(),
    };
    uploads.set(session.id, { session, parts: new Map() });
    return json(session, 201);
  }
  const upload = path.match(/^\/v1\/uploads\/([^/]+)(?:\/parts(?:\/(\d+))?|\/(complete))?$/);
  if (upload) {
    const value = uploads.get(upload[1]);
    if (!value) return error("Subida de prueba inexistente", 404);
    if (method === "DELETE") {
      uploads.delete(upload[1]);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") return json(path.endsWith("/parts") ? { items: [] } : value.session);
    if (method === "PUT" && upload[2] !== undefined && value.session.state === "open") {
      const blob = await request.blob();
      if (blob.size > value.session.expectedSize || value.parts.size)
        return error("Fragmento de prueba inválido", 413);
      value.parts.set(Number(upload[2]), blob);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && upload[3] && value.session.state === "open") {
      const blob = new Blob(
        [...value.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part),
        { type: value.session.mimeType || "application/octet-stream" },
      );
      if (blob.size !== value.session.expectedSize)
        return error("La subida de prueba está incompleta", 409);
      const file = add(
        entry(uniqueName(value.session.name, value.session.parentId), "file", {
          parentId: value.session.parentId,
          mimeType: blob.type,
          size: blob.size,
        }),
        blob,
      );
      value.session.state = "completed";
      value.session.fileId = file.id;
      value.parts.clear();
      return json(file);
    }
  }
  if (path.startsWith("/v1/files/bulk/") && method === "POST") {
    const data = await body(),
      operation = path.split("/").pop();
    const selected = all().filter((file) => data.fileIds?.includes(file.id));
    for (const file of selected) {
      if (operation === "trash" || operation === "spam")
        [file, ...descendants(file.id)].forEach((child) => {
          child.status = operation === "trash" ? "trashed" : "spam";
          touch(child);
        });
      else if (
        operation === "move" &&
        ![file.id, ...descendants(file.id).map((child) => child.id)].includes(data.parentId)
      ) {
        file.parentId = data.parentId;
        touch(file);
      }
    }
    return json({ items: selected });
  }
  const match = path.match(/^\/v1\/files\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const file = files.get(match[1]),
      action = match[2];
    if (!file) return error("Archivo de ejemplo inexistente", 404);
    if (action === "playback" && method === "POST")
      return json({ ticket: file.id, expiresAt: expires(), conversionAvailable: false });
    if (action && ["shares", "grants"].includes(action) && method === "GET")
      return json(action === "shares" ? { items: [] } : []);
    if (action === "view-state" && method === "GET")
      return json({
        fileId: file.id,
        kind: "text",
        position: {},
        preferences: {},
        bookmarks: [],
        updatedAt: now(),
      });
    if (action === "view-state" && method === "PUT")
      return json({ fileId: file.id, ...(await body()), updatedAt: now() });
    if (!action && method === "GET") return json(file);
    if (!action && method === "PATCH") {
      const data = await body();
      if (data.name)
        file.name = uniqueName(String(data.name).slice(0, 255), file.parentId, file.id);
      return json(touch(file));
    }
    if (action === "restore" && method === "POST") {
      [file, ...descendants(file.id)].forEach((child) => {
        child.status = "active";
        touch(child);
      });
      return json(file);
    }
    if (action === "copy" && method === "POST") {
      const data = await body();
      if (file.kind === "folder")
        return error(
          "En la demo puedes copiar archivos. Las carpetas completas requieren una cuenta real.",
        );
      if (files.size >= maxFiles || usedBytes() + (blobs.get(file.id)?.size ?? 0) > maxBytes)
        return error("Se alcanzó el límite de la demo", 413);
      const copy = add(
        entry(uniqueName(data.name || file.name, data.parentId), file.kind, {
          parentId: data.parentId,
          mimeType: file.mimeType,
          size: file.size,
        }),
        blobs.get(file.id),
      );
      if (!blobs.has(file.id)) urls.set(copy.id, demoContentUrl(file.id));
      return json(copy, 201);
    }
    if (action === "move" && method === "POST") {
      const data = await body();
      if ([file.id, ...descendants(file.id).map((child) => child.id)].includes(data.parentId))
        return error("No puedes mover una carpeta dentro de sí misma", 409);
      file.parentId = data.parentId;
      return json(touch(file));
    }
    if (!action && method === "DELETE") {
      for (const child of [file, ...descendants(file.id)]) {
        files.delete(child.id);
        blobs.delete(child.id);
        if (urls.get(child.id)?.startsWith("blob:")) URL.revokeObjectURL(urls.get(child.id)!);
        urls.delete(child.id);
      }
      return new Response(null, { status: 204 });
    }
  }
  if (path === "/v1/playback/tracks" && method === "GET")
    return json({ available: false, tracks: [] });
  if (path === "/v1/users/search" && method === "GET") return json([]);
  return error(
    "Esta función necesita una cuenta real. La demo no conecta con Telegram, Google ni tu servidor.",
  );
}
