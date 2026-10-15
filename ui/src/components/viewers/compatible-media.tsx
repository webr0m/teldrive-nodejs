import { t } from "@/lib/localization";
import { Button } from "@heroui/react";
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/api/client";
import { userMessage } from "@/api/errors";
import type { FileEntry } from "@/api/types";
import { CastDialog } from "./cast-dialog";
import { apiUrl } from "@/lib/client-runtime";
import type { AirPlayVideo } from "@/lib/casting";
import { isDemoActive, demoContentUrl } from "@/lib/client-demo";

const VideoViewer = lazy(() => import("./video-viewer").then((m) => ({ default: m.VideoViewer })));
export type PlaybackSession = { ticket: string; expiresAt: string; conversionAvailable: boolean };
export function playbackUrl(
  ticket: string,
  mode = "original",
  start = 0,
  audio?: number,
  subtitle?: number,
  video?: number,
) {
  if (isDemoActive()) return demoContentUrl(ticket);
  return apiUrl(`/api/v1/playback?${new URLSearchParams({ ticket, mode, start: String(start), ...(audio !== undefined ? { audio: String(audio) } : {}), ...(subtitle !== undefined ? { subtitle: String(subtitle) } : {}), ...(video !== undefined ? { video: String(video) } : {}) })}`);
}
type Track = {
  index: number;
  kind: "audio" | "video" | "subtitle";
  codec: string;
  language: string;
  title: string;
  default: boolean;
  bitmap: boolean;
};
function trackLabel(track: Track) {
  return `${track.title || `${track.kind === "audio" ? t("Audio") : t("Subtítulos")} ${track.index + 1}`} · ${track.language || t("sin idioma")} · ${track.codec}${track.default ? t(" (predeterminada)") : ""}${track.bitmap ? t(" · imagen") : ""}`;
}

export function CompatibleMedia({
  file,
  url,
  kind,
  session,
}: {
  file: FileEntry;
  url: string;
  kind: "audio" | "video";
  session?: PlaybackSession;
}) {
  const [grant, setGrant] = useState(session);
  const [source, setSource] = useState("");
  const [converted, setConverted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [start, setStart] = useState("0");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tracksNotice, setTracksNotice] = useState("");
  const [audio, setAudio] = useState<number>();
  const [videoTrack, setVideoTrack] = useState<number>();
  const [subtitle, setSubtitle] = useState<number>();
  const [sourceStart, setSourceStart] = useState(0);
  const [castStart, setCastStart] = useState(0);
  const [castOpen, setCastOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const getVideo = () => root.current?.querySelector("video") as AirPlayVideo | null;
  const grantRef = useRef({ fileId: file.id, value: session });
  const ensureGrant = useCallback(async () => {
    if (grantRef.current.fileId !== file.id) grantRef.current = { fileId: file.id, value: session };
    const cached = grantRef.current.value;
    if (cached && new Date(cached.expiresAt).getTime() > Date.now()) {
      setGrant(cached);
      return cached;
    }
    const next = (await (
      await apiFetch(`/v1/files/${encodeURIComponent(file.id)}/playback`, { method: "POST" })
    ).json()) as PlaybackSession;
    grantRef.current.value = next;
    setGrant(next);
    return next;
  }, [file.id, session]);
  useEffect(() => {
    let active = true;
    void ensureGrant()
      .then(async (next) => {
        if (!active) return;
        if (kind !== "video") { setSource(playbackUrl(next.ticket)); return; }
        const data = (await (
          await apiFetch(`/v1/playback/tracks?${new URLSearchParams({ ticket: next.ticket })}`)
        ).json()) as { available: boolean; tracks: Track[] };
        if (active) {
          setTracks(data.tracks);
          const audioTracks = data.tracks.filter((track) => track.kind === "audio");
          const preferred = audioTracks.find((track) => track.default) ?? audioTracks[0];
          setAudio(preferred?.index);
          const videos = data.tracks.filter(track => track.kind === "video");
          const preferredVideo = videos.find(track => track.default) ?? videos[0];
          setVideoTrack(preferredVideo?.index);
          // Some browsers decode an MKV's video while silently dropping its audio.
          // Select its declared default track and convert before playback starts.
          const containerNeedsConversion = /\.(mkv|avi|wmv|flv|m2ts|ts|vob)$/i.test(file.name);
          const audioNeedsConversion =
            preferred && !["aac", "mp3", "opus", "vorbis", "flac"].includes(preferred.codec);
          const nonFirstDefault = preferred && preferred.index !== audioTracks[0]?.index;
          if (
            next.conversionAvailable &&
            (containerNeedsConversion || audioNeedsConversion || nonFirstDefault)
          ) {
            setSource(playbackUrl(next.ticket, "video", 0, preferred?.index, undefined, preferredVideo?.index));
            setConverted(true);
          } else setSource(playbackUrl(next.ticket));
          if (!data.available)
            setTracksNotice(
              t(
                "Reproducción del archivo original. La selección de pistas y la conversión aún no están disponibles en este servidor.",
              ),
            );
        }
      })
      .catch((cause) => {
        if (active) { setTracksNotice(userMessage(cause)); const next = grantRef.current.value; if(next) setSource(playbackUrl(next.ticket)); }
      });
    return () => {
      active = false;
    };
  }, [ensureGrant, kind, file.name]);
  const chooseTracks = async (nextAudio: number | undefined, nextSubtitle: number | undefined, nextVideo = videoTrack) => {
    nextAudio ??=
      tracks.find((track) => track.kind === "audio" && track.default)?.index ??
      tracks.find((track) => track.kind === "audio")?.index;
    setAudio(nextAudio);
    setVideoTrack(nextVideo);
    setSubtitle(nextSubtitle);
    const selected = tracks.find((track) => track.index === nextSubtitle);
    if (nextAudio === undefined && !selected?.bitmap && !converted) return;
    setPending(true);
    setError(undefined);
    try {
      const next = await ensureGrant();
      if (!next.conversionAvailable)
        throw new Error(
          t("La selección de pistas del contenedor necesita FFmpeg. Desktop lo incluye."),
        );
      const element = getVideo();
      const finished = element?.ended || (Number.isFinite(element?.duration) && !!element && element.currentTime >= element.duration - 0.1);
      const seconds = finished ? 0 : Math.min(86400, sourceStart + (element?.currentTime || 0));
      setSourceStart(seconds);
      setStart(String(Math.floor(seconds)));
      setSource(
        playbackUrl(
          next.ticket,
          "video",
          seconds,
          nextAudio,
          selected?.bitmap ? nextSubtitle : undefined,
          nextVideo,
        ),
      );
      setConverted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : userMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const convert = async () => {
    if (pending) return;
    const seconds = Number(start);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
      setError(t("Introduce una posición entre 0 y 86400 segundos."));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const next = await ensureGrant();
      setGrant(next);
      if (!next.conversionAvailable)
        throw new Error(
          t(
            "La reproducción compatible necesita FFmpeg en el servidor. El programa de Windows ya lo incluye.",
          ),
        );
      setSourceStart(seconds);
      setSource(
        playbackUrl(
          next.ticket,
          kind,
          seconds,
          audio,
          tracks.find((track) => track.index === subtitle)?.bitmap ? subtitle : undefined,
          videoTrack,
        ),
      );
      setConverted(true);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== "ApiError" ? cause.message : userMessage(cause),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div ref={root} className="flex h-full min-h-0 w-full flex-col bg-black text-white">
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        {!source ? <p className="p-6">{t("Preparando reproducción…")}</p> : kind === "video" ? (
          <Suspense fallback={<p className="p-6">{t("Cargando vídeo…")}</p>}>
            <VideoViewer
              file={file}
              url={source}
              type={converted ? "video/mp4" : undefined}
              subtitles={
                grant &&
                subtitle !== undefined &&
                !tracks.find((track) => track.index === subtitle)?.bitmap
                  ? [
                      {
                        id: `embedded-${subtitle}`,
                        src: apiUrl(`/api/v1/playback/subtitles?${new URLSearchParams({ ticket: grant.ticket, track: String(subtitle), start: String(converted ? sourceStart : 0) })}`),
                        lang: tracks.find((track) => track.index === subtitle)?.language || "und",
                        label: t("Pista seleccionada"),
                        default: true,
                      },
                    ]
                  : []
              }
              onError={() =>
                setError(
                  converted
                    ? t("La conversión falló. Puedes reintentar o descargar el archivo.")
                    : t(
                        "El navegador no puede reproducir este formato o códec. Prueba la reproducción compatible.",
                      ),
                )
              }
            />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="w-full max-w-xl text-center">
              <div className="mb-6 text-6xl">♪</div>
              <h3 className="truncate text-lg">{file.name}</h3>
              {/* biome-ignore lint/a11y/useMediaCaption: audio uploaded by the user has no caption resource */}
              <audio
                key={source}
                className="mt-7 w-full"
                src={source}
                controls
                onError={() =>
                  setError(
                    converted
                      ? t("La conversión falló. Puedes reintentar o descargar el archivo.")
                      : t("Este audio necesita otro códec. Prueba la reproducción compatible."),
                  )
                }
              />
            </div>
          </div>
        )}
      </div>
      <div className="relative z-10 flex max-h-[45vh] shrink-0 flex-wrap items-center gap-3 overflow-y-auto border-t border-white/20 bg-black/90 p-3">
        {kind === "video" ? (
          <>
            <Button
              className="min-h-11"
              variant="secondary"
              isDisabled={pending}
              onPress={() => {
                void ensureGrant()
                  .then(() => {
                    setCastStart(sourceStart + (getVideo()?.currentTime || 0));
                    setCastOpen(true);
                  })
                  .catch((cause) => setError(userMessage(cause)));
              }}
            >
              {t("Transmitir")}
            </Button>
            {tracks.some((track) => track.kind === "audio") ? (
              <label className="flex items-center gap-2 text-sm">
                {t("Audio")}
                <select
                  aria-label={t("Pista de audio")}
                  className="min-h-11 max-w-64 rounded-lg border border-white/30 bg-black px-3"
                  value={audio ?? ""}
                  disabled={pending}
                  onChange={(event) =>
                    void chooseTracks(
                      event.target.value === "" ? undefined : Number(event.target.value),
                      subtitle,
                    )
                  }
                >
                  <option value="">{t("Predeterminada")}</option>
                  {tracks
                    .filter((track) => track.kind === "audio")
                    .map((track) => (
                      <option key={track.index} value={track.index}>
                        {trackLabel(track)}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {tracks.filter(track => track.kind === "video").length > 1 ? (
              <label className="flex items-center gap-2 text-sm">
                {t("Vídeo")}
                <select aria-label={t("Pista de vídeo")} className="min-h-11 max-w-64 rounded-lg border border-white/30 bg-black px-3" value={videoTrack ?? ""} disabled={pending} onChange={event => void chooseTracks(audio, subtitle, Number(event.target.value))}>
                  {tracks.filter(track => track.kind === "video").map(track => <option key={track.index} value={track.index}>{track.title || `Vídeo ${track.index + 1}`} · {track.codec}</option>)}
                </select>
              </label>
            ) : null}
            {tracks.some((track) => track.kind === "subtitle") ? (
              <label className="flex items-center gap-2 text-sm">
                {t("Subtítulos")}
                <select
                  aria-label={t("Pista de subtítulos")}
                  className="min-h-11 max-w-64 rounded-lg border border-white/30 bg-black px-3"
                  value={subtitle ?? ""}
                  disabled={pending}
                  onChange={(event) =>
                    void chooseTracks(
                      audio,
                      event.target.value === "" ? undefined : Number(event.target.value),
                    )
                  }
                >
                  <option value="">{t("Desactivados")}</option>
                  {tracks
                    .filter((track) => track.kind === "subtitle")
                    .map((track) => (
                      <option key={track.index} value={track.index}>
                        {trackLabel(track)}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {tracksNotice ? <p className="w-full text-xs text-white/70">{tracksNotice}</p> : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="w-full text-sm text-amber-200">
            {error}
          </p>
        ) : null}
        <Button
          className="min-h-11"
          variant="secondary"
          isDisabled={pending}
          onPress={() => void convert()}
        >
          {pending
            ? t("Preparando…")
            : converted
              ? t("Reiniciar desde esta posición")
              : t("Reproducción compatible")}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          {t("Comenzar en (segundos)")}
          <input
            aria-label={t("Comenzar en segundos")}
            type="number"
            min="0"
            max="86400"
            className="min-h-11 w-28 rounded-lg border border-white/30 bg-black px-3"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        {converted ? (
          <Button
            className="min-h-11"
            variant="secondary"
            onPress={() => {
              setSource(grant ? playbackUrl(grant.ticket) : url);
              setConverted(false);
              setSourceStart(0);
              setAudio(undefined);
              setSubtitle(undefined);
              setError(undefined);
            }}
          >
            {t("Versión original")}
          </Button>
        ) : null}
      </div>
      {kind === "video" ? (
        <CastDialog
          open={castOpen}
          onOpenChange={setCastOpen}
          grant={grant}
          title={file.name}
          mime={file.mimeType || "video/mp4"}
          video={getVideo}
          start={castStart}
          audio={audio}
          subtitle={subtitle}
          onAirPlaySource={(next) => {
            const element = getVideo();
            if (element) {
              element.src = next;
              element.load();
            }
            setSource(next);
            setConverted(true);
          }}
        />
      ) : null}
    </div>
  );
}
