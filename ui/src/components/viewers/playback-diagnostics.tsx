import { useEffect, useId, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "@heroui/react";
import { apiFetch } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { FileEntry } from "@/api/types";
import { botLabel } from "@/lib/bot-identity";
import { isDemoActive } from "@/lib/client-demo";

export type DiagnosticTrack = {
  index: number;
  kind: string;
  codec: string;
  title?: string;
  language?: string;
  default?: boolean;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: number;
  bit_rate?: number;
  duration?: number;
  profile?: string;
  pix_fmt?: string;
  avg_frame_rate?: string;
  channel_layout?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  bits_per_raw_sample?: number;
  field_order?: string;
};
type Format = { name?: string; duration?: number; bit_rate?: number };
type Conversion = {
  video?: string;
  audio?: string;
  fps?: number;
  speed?: number;
  out_time_us?: number;
  total_size?: number;
  drop_frames?: number;
  dup_frames?: number;
  threads?: number;
  maxWidth?: number;
  finished?: boolean;
};
type Flow = {
  activeReads?: number;
  peakReads?: number;
  reader?: { parallel: number; buffers: number; globalLimit: number };
  id: string;
  mode: string;
  purpose: string;
  state: string;
  startedAt: number;
  finishedAt?: number;
  firstByteMs?: number;
  rangeStart?: number;
  rangeEnd?: number;
  outputBytes: number;
  bytesPerSecond: number;
  sourceIds: string[];
  conversion?: Conversion;
};
type Source = {
  activeReads?: number;
  peakReads?: number;
  id: string;
  kind: string;
  botId?: string;
  name?: string;
  username?: string;
  active: number;
  attempts: number;
  failures: number;
  inputBytes: number;
  forwardedBytes: number;
  bytesPerSecond: number;
  lastByteAt?: number;
};
type NodeSnapshot = {
  role: string;
  capturedAt: number;
  enabled: boolean;
  activeRequests: number;
  requests: number;
  outputBytes: number;
  inputBytes: number;
  errors: number;
  streams: Flow[];
  sources: Source[];
};
type ServerSnapshot = {
  file: { parts: number; encryption: boolean };
  metadata?: { tracks: DiagnosticTrack[]; format?: Format };
  nodes: NodeSnapshot[];
  unavailableNodes: string[];
};
type BrowserSnapshot = {
  position: number;
  duration: number;
  ready: number;
  network: number;
  paused: boolean;
  seeking: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  bufferAhead: number;
  buffered: string;
  width?: number;
  height?: number;
  frames?: number;
  dropped?: number;
  corrupted?: number;
  fps?: number;
  stalls: number;
  waitingSeconds: number;
  error?: number;
};
const number = (value?: number) =>
  value !== undefined && Number.isFinite(value)
    ? value.toLocaleString("es", { maximumFractionDigits: 2 })
    : "No disponible";
function bytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "No disponible";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"],
    index = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10)));
  return `${number(value / 1024 ** index)} ${units[index]}`;
}
const seconds = (value?: number) =>
  value !== undefined && Number.isFinite(value) ? `${number(value)} s` : "No disponible";
const speed = (value?: number) =>
  value !== undefined ? `${bytes(value)}/s · ${number((value * 8) / 1e6)} Mb/s` : "No disponible";
const nodeName = (role: string) =>
  role === "secondary" ? "Nodo PC/secundario" : "Servidor principal";
const flowName = (purpose: string) =>
  ({
    playback: "Hacia el reproductor",
    probe: "Análisis de pistas",
    "conversion-input": "Entrada de FFmpeg",
    "subtitle-input": "Subtítulos",
  })[purpose] || purpose;
const stateName = (state: string) =>
  ({
    preparing: "Preparando / en cola",
    streaming: "Transfiriendo",
    completed: "Completado",
    cancelled: "Cancelado por el cliente",
    error: "Error",
  })[state] || state;
function Grid({ values }: { values: [string, unknown][] }) {
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-xs">
      {values.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-white/60">{label}</dt>
          <dd className="break-words font-mono text-white">
            {value === undefined || value === "" ? "No disponible" : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PlaybackDiagnostics({
  file,
  ticket,
  source,
  converted,
  root,
  sourceStart,
  audio,
  video,
  subtitle,
}: {
  file: FileEntry;
  ticket?: string;
  source: string;
  converted: boolean;
  root: RefObject<HTMLDivElement | null>;
  sourceStart: number;
  audio?: number;
  video?: number;
  subtitle?: number;
}) {
  const [open, setOpen] = useState(false),
    [browser, setBrowser] = useState<BrowserSnapshot>();
  const [server, setServer] = useState<ServerSnapshot>(),
    [metadata, setMetadata] = useState<{ tracks: DiagnosticTrack[]; format?: Format }>();
  const [notice, setNotice] = useState(""),
    [copied, setCopied] = useState(false),
    [fullscreen, setFullscreen] = useState<HTMLElement>();
  const id = useId();
  useEffect(() => {
    const change = () =>
      setFullscreen(
        document.fullscreenElement instanceof HTMLElement &&
          root.current?.contains(document.fullscreenElement)
          ? document.fullscreenElement
          : undefined,
      );
    document.addEventListener("fullscreenchange", change);
    change();
    return () => document.removeEventListener("fullscreenchange", change);
  }, [root]);
  useEffect(() => {
    setOpen(false);
    setServer(undefined);
    setMetadata(undefined);
    setBrowser(undefined);
    setNotice("");
  }, [file.id]);
  useEffect(() => {
    if (!open) return;
    let media: HTMLMediaElement | undefined,
      detach = () => {},
      lastFrames: number | undefined,
      lastSample = performance.now(),
      stalls = 0,
      waiting = 0,
      waitingAt: number | undefined;
    const finishWaiting = () => {
      if (waitingAt !== undefined) {
        waiting += (performance.now() - waitingAt) / 1000;
        waitingAt = undefined;
      }
    };
    const tick = () => {
      const element = root.current?.querySelector<HTMLMediaElement>("video, audio");
      if (!element) return;
      if (media !== element) {
        detach();
        media = element;
        lastFrames = undefined;
        const wait = () => {
          if (!element.paused && !element.seeking && waitingAt === undefined) {
            stalls++;
            waitingAt = performance.now();
          }
        };
        element.addEventListener("waiting", wait);
        element.addEventListener("stalled", wait);
        for (const event of ["playing", "pause", "ended", "seeking"])
          element.addEventListener(event, finishWaiting);
        detach = () => {
          finishWaiting();
          element.removeEventListener("waiting", wait);
          element.removeEventListener("stalled", wait);
          for (const event of ["playing", "pause", "ended", "seeking"])
            element.removeEventListener(event, finishWaiting);
        };
      }
      const ranges = [],
        now = performance.now();
      let ahead = 0;
      for (let i = 0; i < Math.min(20, element.buffered.length); i++) {
        const start = element.buffered.start(i),
          end = element.buffered.end(i);
        ranges.push(`${number(start)}–${number(end)} s`);
        if (start <= element.currentTime && end >= element.currentTime)
          ahead = end - element.currentTime;
      }
      const quality =
        element instanceof HTMLVideoElement ? element.getVideoPlaybackQuality?.() : undefined;
      const frames = quality?.totalVideoFrames,
        elapsed = (now - lastSample) / 1000;
      const fps =
        frames !== undefined && lastFrames !== undefined && elapsed > 0 && frames >= lastFrames
          ? (frames - lastFrames) / elapsed
          : undefined;
      lastFrames = frames;
      lastSample = now;
      setBrowser({
        position: element.currentTime,
        duration: element.duration,
        ready: element.readyState,
        network: element.networkState,
        paused: element.paused,
        seeking: element.seeking,
        rate: element.playbackRate,
        volume: element.volume,
        muted: element.muted,
        bufferAhead: ahead,
        buffered: ranges.join(" · ") || "Vacío",
        width: element instanceof HTMLVideoElement ? element.videoWidth : undefined,
        height: element instanceof HTMLVideoElement ? element.videoHeight : undefined,
        frames,
        dropped: quality?.droppedVideoFrames,
        corrupted: quality?.corruptedVideoFrames,
        fps,
        stalls,
        waitingSeconds: waiting + (waitingAt === undefined ? 0 : (now - waitingAt) / 1000),
        error: element.error?.code,
      });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      detach();
    };
  }, [open, source, root]);
  useEffect(() => {
    if (!open || !ticket || isDemoActive()) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const query = new URLSearchParams({ ticket });
    void apiFetch(`/v1/playback/tracks?${query}`, { signal: abort.signal })
      .then((r) => r.json())
      .then((data) => {
        if (active) setMetadata(data);
      })
      .catch(() => {});
    const poll = async () => {
      if (!active) return;
      if (document.hidden) {
        timer = setTimeout(poll, 2000);
        return;
      }
      try {
        const response = await apiFetch(`/v1/playback/diagnostics?${query}`, {
          signal: abort.signal,
        });
        const snapshot = (await response.json()) as ServerSnapshot;
        if (!active) return;
        setServer(snapshot);
        if (snapshot.metadata) setMetadata(snapshot.metadata);
        setNotice("");
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          setNotice(
            "Las estadísticas de bots requieren la sesión del propietario del archivo. Las mediciones del navegador siguen disponibles.",
          );
          return;
        }
        setNotice(
          "No se pudo actualizar el servidor. Los datos anteriores pueden estar desactualizados; se reintentará.",
        );
      }
      if (active) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [open, ticket]);
  const toggle = (
    <Button
      className="min-h-11"
      variant="secondary"
      aria-expanded={open}
      aria-controls={id}
      onPress={() => setOpen((value) => !value)}
    >
      Estadísticas · Desarrollador
    </Button>
  );
  const tracks = metadata?.tracks || [],
    format = metadata?.format,
    nodes = server?.nodes || [];
  const activeSources = nodes.flatMap((node) => node.sources).filter((s) => s.active > 0).length;
  const panel = open ? (
    <aside
      id={id}
      aria-label="Estadísticas de reproducción"
      className="absolute right-3 top-3 z-[100] max-h-[calc(100%_-_1.5rem)] w-[min(520px,calc(100%_-_1.5rem))] space-y-4 overflow-y-auto rounded-xl border border-white/25 bg-neutral-950/95 p-4 text-white shadow-2xl backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Estadísticas de reproducción</h3>
          <p className="mt-1 text-xs text-white/60">
            Navegador: 1 s · servidor: consulta cada 2 s · velocidades: últimos 3 s
          </p>
        </div>
        <button
          type="button"
          className="min-h-10 min-w-10 rounded border border-white/30"
          aria-label="Cerrar estadísticas"
          onClick={() => setOpen(false)}
        >
          ✕
        </button>
      </div>
      {notice && (
        <p role="status" className="text-xs text-amber-300">
          {notice}
        </p>
      )}
      {isDemoActive() && (
        <p className="text-xs text-amber-300">
          Demostración local: no hay transferencias reales de Telegram.
        </p>
      )}
      <details open>
        <summary className="mb-3 cursor-pointer text-sm font-medium">
          Archivo y reproducción
        </summary>
        <Grid
          values={[
            ["Archivo", file.name],
            ["Tamaño original", bytes(file.size)],
            ["MIME original", file.mimeType],
            ["Contenedor", format?.name],
            ["Ruta de reproducción", converted ? "Compatible / conversión" : "Original / directa"],
            [
              "Resolución decodificada",
              browser?.width && browser.height ? `${browser.width} × ${browser.height}` : undefined,
            ],
            [
              "Duración original",
              seconds(format?.duration ?? (!converted ? browser?.duration : undefined)),
            ],
            [
              "Posición en el archivo",
              seconds(browser ? sourceStart + browser.position : undefined),
            ],
            [
              "Bitrate del archivo",
              format?.bit_rate ? `${number(format.bit_rate / 1000)} kb/s` : undefined,
            ],
            ["Partes almacenadas", server?.file.parts],
            ["Cifrado de archivo", server ? (server.file.encryption ? "Sí" : "No") : undefined],
            [
              "Pistas seleccionadas (índices)",
              `Vídeo: ${video ?? "auto"} · audio: ${audio ?? "auto"} · subtítulos: ${subtitle ?? "ninguno"}`,
            ],
          ]}
        />
      </details>
      <details open>
        <summary className="mb-3 cursor-pointer text-sm font-medium">
          Búfer y decodificación
        </summary>
        <Grid
          values={[
            [
              "Estado",
              browser
                ? browser.seeking
                  ? "Buscando"
                  : browser.paused
                    ? "Pausado"
                    : "Reproduciendo"
                : "Esperando elemento multimedia",
            ],
            [
              "Datos preparados",
              browser
                ? ["Sin datos", "Metadatos", "Datos actuales", "Datos futuros", "Búfer suficiente"][
                    browser.ready
                  ]
                : undefined,
            ],
            [
              "Estado de red",
              browser
                ? ["Vacío", "Inactivo", "Cargando", "Sin origen"][browser.network]
                : undefined,
            ],
            ["Búfer por delante", seconds(browser?.bufferAhead)],
            ["Intervalos almacenados", browser?.buffered],
            ["Fotogramas totales", number(browser?.frames)],
            ["Fotogramas perdidos", number(browser?.dropped)],
            ["Fotogramas corruptos", number(browser?.corrupted)],
            ["FPS observados (aprox.)", number(browser?.fps)],
            ["Esperas desde abrir el panel", number(browser?.stalls)],
            ["Tiempo esperando datos", seconds(browser?.waitingSeconds)],
            ["Velocidad de reproducción", browser ? `${number(browser.rate)}×` : undefined],
            [
              "Volumen",
              browser
                ? browser.muted
                  ? "Silenciado"
                  : `${number(browser.volume * 100)} %`
                : undefined,
            ],
            ["Código de error multimedia", browser?.error ?? "Ninguno"],
          ]}
        />
      </details>
      <details open>
        <summary className="mb-3 cursor-pointer text-sm font-medium">
          Flujos y bots en tiempo real
        </summary>
        <p className="mb-3 text-xs text-white/65">
          {activeSources
            ? `${activeSources} orígenes transfiriendo.`
            : "Sin transferencias activas en la última muestra; el reproductor puede usar el búfer."}{" "}
          La descarga anticipada, el análisis y FFmpeg también pueden recibir datos.
        </p>
        {server?.unavailableNodes?.map((role) => (
          <p key={role} className="mb-2 text-xs text-amber-300">
            {nodeName(role)}: sin respuesta. Sus estadísticas no están disponibles.
          </p>
        ))}
        {!nodes.length && <p className="text-xs text-white/60">Esperando datos del servidor…</p>}
        {nodes.map((node) => (
          <section key={node.role} className="mb-3 space-y-3 rounded-lg border border-white/15 p-3">
            <h4 className="text-xs font-semibold">
              {nodeName(node.role)} · {new Date(node.capturedAt).toLocaleTimeString()}
            </h4>
            {!node.enabled && (
              <p className="text-xs text-amber-300">
                Estadísticas desactivadas por el propietario del servidor.
              </p>
            )}
            <Grid
              values={[
                [
                  "Lectura de almacenamiento",
                  speed(node.sources.reduce((n, s) => n + s.bytesPerSecond, 0)),
                ],
                ["Enviado al reproductor", bytes(node.outputBytes)],
                ["Recibido de almacenamiento", bytes(node.inputBytes)],
                ["Solicitudes activas / totales", `${node.activeRequests} / ${node.requests}`],
                ["Solicitudes con error", node.errors],
              ]}
            />
            {node.sources.map((s) => (
              <div key={s.id} className="space-y-2 border-t border-white/15 pt-3">
                <p className="break-words text-xs font-medium">
                  {s.kind === "bot"
                    ? botLabel({ id: s.botId || "?", name: s.name, username: s.username })
                    : s.kind === "account"
                      ? "Cuenta de Telegram (respaldo)"
                      : "Disco local del servidor"}
                </p>
                <Grid
                  values={[
                    [
                      "Estado del origen",
                      s.active ? `${s.active} flujos activos` : "Sin flujo activo",
                    ],
                    ["Velocidad recibida", speed(s.bytesPerSecond)],
                    ["Lecturas RPC activas / pico", `${s.activeReads ?? 0} / ${s.peakReads ?? 0}`],
                    ["Bytes recibidos", bytes(s.inputBytes)],
                    ["Bytes útiles de las lecturas", bytes(s.forwardedBytes)],
                    ["Intentos / fallos", `${s.attempts} / ${s.failures}`],
                    [
                      "Últimos datos",
                      s.lastByteAt ? new Date(s.lastByteAt).toLocaleTimeString() : "Aún sin datos",
                    ],
                  ]}
                />
              </div>
            ))}
            {!!node.streams.length && (
              <details>
                <summary className="cursor-pointer text-xs">
                  Solicitudes recientes ({node.streams.length}, máximo 64)
                </summary>
                <div className="mt-3 space-y-3">
                  {node.streams
                    .slice(-12)
                    .reverse()
                    .map((flow) => (
                      <div key={flow.id} className="space-y-2 border-t border-white/15 pt-2">
                        <p className="text-xs font-medium">
                          {flowName(flow.purpose)} · {flow.mode} · {stateName(flow.state)}
                        </p>
                        <Grid
                          values={[
                            ["Bytes de salida", bytes(flow.outputBytes)],
                            ["Velocidad de salida", speed(flow.bytesPerSecond)],
                            [
                              "Lecturas RPC activas / pico",
                              `${flow.activeReads ?? 0} / ${flow.peakReads ?? 0}`,
                            ],
                            [
                              "Paralelismo / bloques anticipados",
                              flow.reader
                                ? `${flow.reader.parallel} / ${flow.reader.buffers}`
                                : undefined,
                            ],
                            ["Límite global de lecturas", flow.reader?.globalLimit],
                            [
                              "Primer byte (servidor)",
                              flow.firstByteMs === undefined
                                ? "Pendiente"
                                : `${number(flow.firstByteMs)} ms`,
                            ],
                            [
                              "Rango solicitado",
                              flow.rangeStart === undefined
                                ? "Flujo convertido"
                                : `${number(flow.rangeStart)}–${number(flow.rangeEnd)}`,
                            ],
                            [
                              "Duración de la solicitud",
                              seconds(
                                ((flow.finishedAt ?? node.capturedAt) - flow.startedAt) / 1000,
                              ),
                            ],
                            ["Orígenes usados", flow.sourceIds.join(" → ") || "Preparando"],
                          ]}
                        />
                        {flow.conversion && (
                          <Grid
                            values={[
                              ["Vídeo de salida", flow.conversion.video],
                              ["Audio de salida", flow.conversion.audio],
                              ["FPS de FFmpeg", number(flow.conversion.fps)],
                              [
                                "Velocidad de FFmpeg",
                                flow.conversion.speed === undefined
                                  ? undefined
                                  : `${number(flow.conversion.speed)}×`,
                              ],
                              [
                                "Tiempo producido",
                                flow.conversion.out_time_us === undefined
                                  ? undefined
                                  : seconds(flow.conversion.out_time_us / 1e6),
                              ],
                              ["Bytes producidos por FFmpeg", bytes(flow.conversion.total_size)],
                              [
                                "Hilos / ancho máximo",
                                `${flow.conversion.threads ?? "—"} / ${flow.conversion.maxWidth ?? "—"}`,
                              ],
                              [
                                "Fotogramas descartados / duplicados",
                                `${flow.conversion.drop_frames ?? "—"} / ${flow.conversion.dup_frames ?? "—"}`,
                              ],
                            ]}
                          />
                        )}
                      </div>
                    ))}
                </div>
              </details>
            )}
          </section>
        ))}
      </details>
      <details>
        <summary className="mb-3 cursor-pointer text-sm font-medium">
          Pistas y códecs ({tracks.length})
        </summary>
        {!tracks.length && (
          <p className="text-xs text-white/60">
            No hay metadatos disponibles. El servidor necesita ffprobe para analizarlos.
          </p>
        )}
        {tracks.map((track) => (
          <section key={track.index} className="mb-3 space-y-2 rounded border border-white/15 p-3">
            <p className="text-xs font-medium">
              #{track.index} · {track.kind} · {track.codec}{" "}
              {track.default ? "· predeterminada" : ""}
            </p>
            <Grid
              values={[
                ["Título / idioma", `${track.title || "—"} / ${track.language || "und"}`],
                ["Perfil", track.profile],
                [
                  "Resolución",
                  track.width && track.height ? `${track.width} × ${track.height}` : undefined,
                ],
                ["FPS declarados (fracción)", track.avg_frame_rate],
                ["Formato de píxel", track.pix_fmt],
                ["Profundidad (bits)", track.bits_per_raw_sample],
                [
                  "Espacio / transferencia de color",
                  `${track.color_space || "—"} / ${track.color_transfer || "—"}`,
                ],
                [
                  "Primarios / campos",
                  `${track.color_primaries || "—"} / ${track.field_order || "—"}`,
                ],
                ["Muestreo", track.sample_rate ? `${number(track.sample_rate)} Hz` : undefined],
                [
                  "Canales / distribución",
                  track.channels ? `${track.channels} / ${track.channel_layout || "—"}` : undefined,
                ],
                ["Bitrate", track.bit_rate ? `${number(track.bit_rate / 1000)} kb/s` : undefined],
                ["Duración de pista", seconds(track.duration)],
              ]}
            />
          </section>
        ))}
      </details>
      <p className="text-[11px] leading-relaxed text-white/50">
        Las estadísticas del servidor corresponden a esta sesión. La entrada puede incluir
        alineación de bloques cifrados, reintentos y análisis; no equivale al bitrate del vídeo. Una
        velocidad cero durante reproducción con búfer es normal. No se incluyen tokens, sesiones de
        Telegram ni direcciones internas. Algunas mediciones dependen del navegador.
      </p>
      <button
        type="button"
        className="min-h-10 rounded border border-white/30 px-3 text-xs"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              JSON.stringify(
                {
                  file: { name: file.name, mimeType: file.mimeType, size: file.size },
                  browser,
                  server,
                },
                null,
                2,
              ),
            );
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Diagnóstico copiado" : "Copiar diagnóstico sin credenciales"}
      </button>
    </aside>
  ) : null;
  return (
    <>
      {toggle}
      {fullscreen &&
        createPortal(<div className="absolute left-3 top-3 z-[99]">{toggle}</div>, fullscreen)}
      {panel && (fullscreen || root.current) && createPortal(panel, fullscreen || root.current!)}
    </>
  );
}
