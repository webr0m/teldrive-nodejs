import { Button, Input, Spinner } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch, fetchClient } from "@/api/client";
import { userMessage } from "@/api/errors";
import { t } from "@/lib/localization";
import { SettingsSection } from "./settings-layout";

type Options = {
  apiHost: string;
  apiKey: string;
  chunkMiB: number;
  concurrency: number;
  encrypt: boolean;
  hash: boolean;
};
type Info = {
  configured: boolean;
  available: boolean;
  platform: string;
  driverInstalled: boolean;
  mountSupported: boolean;
  localRoot: string;
  maxCacheGiB: number;
  maxCacheHours: number;
};
type Entry = { Name: string; Path: string; IsDir: boolean; Size: number };
type Job = { id: string; label: string; status: string; log: string };
type Mount = {
  running: boolean;
  mountPoint: string;
  autoStart: boolean;
  readOnly: boolean;
  cacheGiB: number;
  cacheHours: number;
  drive?: string;
};
type Local = { items: { name: string; path: string; directory: boolean; size: number }[] };

export function RcloneControls({ options }: { options: Options }) {
  const [target, setTarget] = useState<"server" | "computer">("server");
  const [pair, setPair] = useState(
    () => sessionStorage.getItem("teldrive-rclone-agent-pair") || "",
  );
  const [agentOrigin, setAgentOrigin] = useState("http://127.0.0.1:5573");
  const [linked, setLinked] = useState(Boolean(pair));
  const [tab, setTab] = useState<"files" | "jobs" | "mount">("files");
  const [info, setInfo] = useState<Info>();
  const [readyFor, setReadyFor] = useState<string>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [local, setLocal] = useState<Local>();
  const [mount, setMount] = useState<Mount>();
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<Entry>();
  const [folder, setFolder] = useState("");
  const [drive, setDrive] = useState("T:");
  const [autoStart, setAutoStart] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [cacheGiB, setCacheGiB] = useState(10);
  const [cacheHours, setCacheHours] = useState(24);
  const [startup, setStartup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const title = target === "server" ? t("Servidor de Teldrive") : t("Mi PC");
  useEffect(() => {
    let active = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        if (active && c.rcloneAgentOrigin) setAgentOrigin(c.rcloneAgentOrigin);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const send = useCallback(
    async <T,>(method: string, params: unknown = {}): Promise<T> => {
      if (target === "server") {
        const result = await fetchClient.POST("/v1/rclone/actions", {
          body: { method, params: params as Record<string, unknown> },
        });
        if (result.error || !result.response.ok) throw new Error(userMessage(result.error));
        return result.data as T;
      }
      if (!pair)
        throw new Error(t("Introduce el código del componente local para vincular este equipo."));
      const response = await fetch(`${agentOrigin}/actions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pair}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || t("El componente local no respondió."));
      return result as T;
    },
    [target, pair, agentOrigin],
  );
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const data = await send<Info>("rclone.info");
    if (current !== generation.current) return;
    setInfo(data);
    const state = await send<Mount>("rclone.mount-state");
    if (current !== generation.current) return;
    setMount(state);
    setDrive(state.drive || "T:");
    setAutoStart(state.autoStart);
    setReadOnly(state.readOnly);
    setCacheGiB(state.cacheGiB);
    setCacheHours(state.cacheHours);
    if (target === "computer")
      setStartup((await send<{ enabled: boolean }>("rclone.startup")).enabled);
    if (current === generation.current) setReadyFor(target);
  }, [send, target]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("La operación de rclone falló.");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    generation.current++;
    setInfo(undefined);
    setReadyFor(undefined);
    setEntries([]);
    setSelected(undefined);
    setJobs([]);
    setLocal(undefined);
    setMount(undefined);
    setPath("");
    setError("");
    if (target === "computer" && !linked) return;
    let active = true;
    void refresh().catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      generation.current++;
    };
  }, [target, linked, refresh]);
  const browse = useCallback(async () => {
    const current = generation.current;
    const [files, workspace] = await Promise.all([
      send<Entry[]>("rclone.browse", { path }),
      send<Local>("rclone.local-folder"),
    ]);
    if (current !== generation.current) return;
    setEntries(files || []);
    setLocal(workspace);
    setSelected(undefined);
  }, [send, path]);
  useEffect(() => {
    let active = true;
    if (info?.configured && readyFor === target)
      void browse().catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [info?.configured, browse, readyFor, target]);
  useEffect(() => {
    if (!info?.configured || readyFor !== target) return;
    let active = true,
      pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await send<Job[]>("rclone.jobs");
        if (active) setJobs(value);
      } catch {
        /* Explicit refresh reports failures. */
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [send, info?.configured, readyFor, target]);
  const selectedPath = [path, selected?.Name].filter(Boolean).join("/");
  const downloadLocal = async (value: string, filename: string) => {
    const url =
      target === "server"
        ? `/api/v1/rclone/local-content?path=${encodeURIComponent(value)}`
        : `${agentOrigin}/local-content?path=${encodeURIComponent(value)}`;
    const init: RequestInit = {
      headers: target === "computer" ? { Authorization: `Bearer ${pair}` } : {},
      credentials: target === "server" ? "same-origin" : "omit",
    };
    const response =
      target === "server" ? await apiFetch(url.slice(4), init) : await fetch(url, init);
    if (!response.ok) throw new Error(t("No se pudo descargar el archivo temporal."));
    const link = URL.createObjectURL(await response.blob()),
      anchor = document.createElement("a");
    anchor.href = link;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(link), 1000);
  };
  return (
    <SettingsSection
      title={t("Control de rclone")}
      description={t(
        "Explora, transfiere y administra una unidad persistente en tu PC o en el servidor.",
      )}
    >
      <div className="space-y-4 p-5">
        <label className="flex flex-wrap items-center gap-3">
          {t("Ejecutar en")}
          <select
            aria-label={t("Equipo de rclone")}
            className="min-h-11 rounded-lg border border-border bg-field-background px-3"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value as typeof target)}
          >
            <option value="server">{t("Servidor de Teldrive")}</option>
            <option value="computer">{t("Mi PC (componente local)")}</option>
          </select>
        </label>
        <p className="text-sm text-muted">
          {target === "server"
            ? t(
                "Los archivos temporales y la unidad estarán en el servidor. Este control requiere una cuenta administradora.",
              )
            : t(
                "Los archivos y la unidad estarán en tu PC. El componente local debe estar ejecutándose; el navegador puede solicitar acceso a la red local.",
              )}
        </p>
        {target === "computer" ? (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm">
              {t(
                "Desde la carpeta de Teldrive Node, instala el cliente e inicia el componente local:",
              )}
            </p>
            <pre className="overflow-x-auto rounded-lg bg-default/30 p-3 text-xs">
              <code>{`npm run install:rclone\nnode scripts/rclone-agent.mjs --url ${window.location.origin} --show-pair-code`}</code>
            </pre>
            <a
              className="text-sm text-accent underline"
              href="https://github.com/webr0m/teldrive-nodejs/releases"
              target="_blank"
              rel="noreferrer"
            >
              {t("Descargar Teldrive Node y el componente local")}
            </a>
            <Input
              type="password"
              autoComplete="off"
              aria-label={t("Código de vinculación del equipo")}
              value={pair}
              onChange={(e) => {
                setPair(e.target.value);
                setLinked(false);
              }}
            />
            <Button
              isDisabled={busy || !pair}
              onPress={() =>
                void action(async () => {
                  await send("rclone.info");
                  sessionStorage.setItem("teldrive-rclone-agent-pair", pair);
                  setLinked(true);
                  await refresh();
                })
              }
            >
              {t("Vincular este equipo")}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg border border-danger/40 p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {busy ? <Spinner aria-label={t("Procesando rclone")} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            isDisabled={busy || !options.apiKey || (target === "computer" && !linked)}
            onPress={() =>
              void action(async () => {
                await send("rclone.configure", options);
                await refresh();
                toast.success(t("Conexión guardada cifrada"));
              })
            }
          >
            {target === "server"
              ? t("Guardar conexión en el servidor")
              : t("Guardar conexión en mi PC")}
          </Button>
          <Button
            variant="secondary"
            isDisabled={busy || (target === "computer" && !linked)}
            onPress={() =>
              void action(async () => {
                await refresh();
                if (info?.configured) await browse();
              })
            }
          >
            {t("Actualizar estado")}
          </Button>
        </div>
        {info && !info.available ? (
          <p className="text-sm text-warning">
            {t(
              "Falta el ejecutable compatible en este equipo. Ejecuta npm run install:rclone o configura su ruta.",
            )}
          </p>
        ) : null}
        {info?.configured ? (
          <p role="status" className="text-sm">
            {t("Conectado en {0}. Credencial guardada cifrada.", [title])}
          </p>
        ) : null}
        <fieldset className="flex flex-wrap gap-2" aria-label={t("Secciones de rclone web")}>
          {(["files", "jobs", "mount"] as const).map((value, index) => (
            <Button
              key={value}
              variant={tab === value ? "primary" : "secondary"}
              onPress={() => setTab(value)}
            >
              {[t("Archivos"), t("Transferencias"), t("Montajes persistentes")][index]}
            </Button>
          ))}
        </fieldset>
        {tab === "files" && info?.configured ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                isDisabled={busy || !path}
                onPress={() => setPath(path.split("/").slice(0, -1).join("/"))}
              >
                {t("Subir carpeta")}
              </Button>
              <span className="break-all text-sm">teldrive:/{path}</span>
              <Button variant="secondary" isDisabled={busy} onPress={() => void action(browse)}>
                {t("Actualizar archivos")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={t("Nueva carpeta de rclone")}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                className="max-w-xs"
              />
              <Button
                isDisabled={busy || !folder.trim() || /[/\\]/.test(folder)}
                onPress={() =>
                  void action(async () => {
                    await send("rclone.mkdir", { path: [path, folder].filter(Boolean).join("/") });
                    setFolder("");
                    await browse();
                  })
                }
              >
                {t("Crear carpeta")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button isDisabled={busy} onPress={() => picker.current?.click()}>
                {t("Subir desde el navegador")}
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy || !selected || selected.IsDir}
                onPress={() =>
                  void action(async () => {
                    await send("rclone.download", { path: selectedPath });
                    setTab("jobs");
                  })
                }
              >
                {t("Descargar en {0}", [title])}
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy || !selected}
                onPress={() =>
                  void action(async () => {
                    const url = await send<string>("rclone.link", { path: selectedPath });
                    await navigator.clipboard.writeText(url);
                    toast.success(t("Enlace copiado"));
                  })
                }
              >
                {t("Copiar enlace reutilizable")}
              </Button>
            </div>
            <input
              ref={picker}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file)
                  void action(async () => {
                    const endpoint =
                      target === "server"
                        ? `/api/v1/rclone/staging/${encodeURIComponent(file.name)}`
                        : `${agentOrigin}/staging/${encodeURIComponent(file.name)}`;
                    const init: RequestInit = {
                      method: "PUT",
                      headers: {
                        "Content-Type": "application/octet-stream",
                        ...(target === "computer" ? { Authorization: `Bearer ${pair}` } : {}),
                      },
                      body: file,
                    };
                    const response =
                      target === "server"
                        ? await apiFetch(endpoint.slice(4), init)
                        : await fetch(endpoint, init);
                    const result = await response.json();
                    if (!response.ok)
                      throw new Error(
                        result.error?.message || t("No se pudo preparar el archivo."),
                      );
                    await send("rclone.upload-local", {
                      path: result.path,
                      destination: path,
                      name: file.name,
                    });
                    setTab("jobs");
                  });
              }}
            />
            <ul
              aria-label={t("Archivos del drive de rclone")}
              className="max-h-96 overflow-y-auto rounded-xl border border-border"
            >
              {entries.map((entry) => (
                <li
                  key={entry.Path}
                  className={`flex items-center gap-2 border-b border-border p-2 ${selected?.Path === entry.Path ? "bg-accent/10" : ""}`}
                >
                  <input
                    type="radio"
                    name="web-rclone-selection"
                    aria-label={t("Seleccionar {0}", [entry.Name])}
                    checked={selected?.Path === entry.Path}
                    onChange={() => setSelected(entry)}
                  />
                  <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start text-left"
                    onPress={() =>
                      entry.IsDir
                        ? setPath([path, entry.Name].filter(Boolean).join("/"))
                        : setSelected(entry)
                    }
                  >
                    <span aria-hidden="true">{entry.IsDir ? "📁" : "📄"}</span>
                    <span className="truncate">{entry.Name}</span>
                    <small>{entry.IsDir ? t("Carpeta") : `${entry.Size.toLocaleString()} B`}</small>
                  </Button>
                </li>
              ))}
            </ul>
            {!entries.length ? (
              <p className="text-sm text-muted">{t("Esta carpeta está vacía.")}</p>
            ) : null}
            <details>
              <summary className="cursor-pointer py-2 text-sm">
                {t("Archivos temporales de {0}", [title])}
              </summary>
              <p className="break-all text-xs text-muted">{info.localRoot}</p>
              {local?.items
                .filter((item) => !item.directory)
                .map((item) => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{item.name}</span>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void action(() => downloadLocal(item.path, item.name))}
                    >
                      {t("Guardar en el navegador")}
                    </Button>
                  </div>
                ))}
            </details>
          </div>
        ) : null}
        {tab === "jobs" ? (
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl border border-border p-3">
                <p>{job.label}</p>
                <p className="text-sm text-muted">
                  {(
                    {
                      running: t("En curso"),
                      completed: t("Completada"),
                      failed: t("Fallida"),
                      interrupted: t("Interrumpida"),
                      cancelled: t("Detenida"),
                    } as Record<string, string>
                  )[job.status] || job.status}
                </p>
                <p className="text-xs">{job.log}</p>
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() =>
                    void action(async () => {
                      await send(job.status === "running" ? "rclone.stop" : "rclone.retry", {
                        id: job.id,
                      });
                      setJobs(await send<Job[]>("rclone.jobs"));
                    })
                  }
                >
                  {job.status === "running" ? t("Detener") : t("Reintentar")}
                </Button>
              </div>
            ))}
            {!jobs.length ? (
              <p className="text-sm text-muted">{t("No hay transferencias en este equipo.")}</p>
            ) : null}
          </div>
        ) : null}
        {tab === "mount" ? (
          <div className="space-y-4 rounded-xl border border-border p-4">
            <p className="font-medium">{t("Unidad en {0}", [title])}</p>
            <p role="status" className="text-sm">
              {mount?.running ? t("Unidad montada") : t("Unidad desmontada")}
            </p>
            <p className="text-sm text-muted">
              {info?.driverInstalled
                ? t("Controlador disponible.")
                : t(
                    "El montaje necesita WinFsp en Windows o acceso a FUSE en Linux. Puedes guardar su configuración aunque este hosting no lo permita.",
                  )}
            </p>
            {target === "computer" && info?.platform === "win32" ? (
              <Input
                aria-label={t("Letra de la unidad persistente")}
                value={drive}
                onChange={(e) => setDrive(e.target.value.toUpperCase())}
                className="max-w-32"
              />
            ) : (
              <p className="break-all text-xs">{mount?.mountPoint}</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="rclone-cache-gib" className="space-y-1 text-sm">
                {t("Máximo de caché (GiB)")}
                <Input
                  id="rclone-cache-gib"
                  aria-label={t("Caché de unidad (GiB)")}
                  type="number"
                  min={1}
                  max={info?.maxCacheGiB || 100}
                  value={String(cacheGiB)}
                  onChange={(e) => setCacheGiB(Number(e.target.value))}
                />
              </label>
              <label htmlFor="rclone-cache-hours" className="space-y-1 text-sm">
                {t("Retención de caché (horas)")}
                <Input
                  id="rclone-cache-hours"
                  aria-label={t("Retención de caché (horas)")}
                  type="number"
                  min={1}
                  max={info?.maxCacheHours || 720}
                  value={String(cacheHours)}
                  onChange={(e) => setCacheHours(Number(e.target.value))}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              {target === "computer"
                ? t("Restaurar el montaje al iniciar el componente local")
                : t("Restaurar el montaje al iniciar el servidor")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              {t("Montar en modo de solo lectura")}
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                isDisabled={busy || (!linked && target === "computer") || Boolean(mount?.running)}
                onPress={() =>
                  void action(async () => {
                    await send("rclone.mount-save", {
                      drive,
                      autoStart,
                      readOnly,
                      cacheGiB,
                      cacheHours,
                      start: false,
                    });
                    await refresh();
                    toast.success(t("Configuración del montaje guardada"));
                  })
                }
              >
                {t("Guardar montaje persistente")}
              </Button>
              <Button
                isDisabled={busy || !info?.configured || !info.mountSupported || mount?.running}
                onPress={() =>
                  void action(async () => {
                    await send("rclone.mount-save", {
                      drive,
                      autoStart,
                      readOnly,
                      cacheGiB,
                      cacheHours,
                    });
                    await refresh();
                  })
                }
              >
                {t("Montar ahora")}
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy || !mount?.running}
                onPress={() =>
                  void action(async () => {
                    await send("rclone.unmount", { disable: true });
                    await refresh();
                  })
                }
              >
                {t("Desmontar y desactivar inicio automático")}
              </Button>
            </div>
            {target === "computer" ? (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-sm">
                  {startup
                    ? t("El componente se iniciará al entrar a Windows.")
                    : t(
                        "Para restaurar la unidad después de reiniciar el PC, activa el inicio del componente con Windows.",
                      )}
                </p>
                <Button
                  variant="secondary"
                  isDisabled={busy || !linked || info?.platform !== "win32"}
                  onPress={() =>
                    void action(async () => {
                      const value = await send<{ enabled: boolean }>(
                        startup ? "rclone.startup-remove" : "rclone.startup-install",
                      );
                      setStartup(value.enabled);
                    })
                  }
                >
                  {startup
                    ? t("Desactivar inicio con Windows")
                    : t("Iniciar componente con Windows")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
