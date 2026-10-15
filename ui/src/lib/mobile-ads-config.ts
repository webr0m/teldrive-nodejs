export type OwnCampaign = {
  id: string;
  title: string;
  imageUrl: string;
  targetUrl: string;
  startsAt?: string;
  endsAt?: string;
};
export type MobileAdsConfig = {
  version: 1;
  refreshSeconds: number;
  own: {
    enabled: boolean;
    intervalSeconds: number;
    durationSeconds: number;
    firstDelaySeconds: number;
    campaigns: OwnCampaign[];
  };
  admob: { enabled: boolean; androidBannerId: string; iosBannerId: string };
};
export function publicHttps(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.hash)
      return url.toString();
  } catch {
    /* Invalid remote data is ignored. */
  }
}
function seconds(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}
export function parseMobileAds(input: unknown): MobileAdsConfig {
  if (!input || typeof input !== "object" || (input as { version?: unknown }).version !== 1)
    throw new Error("Configuración de publicidad incompatible");
  const raw = input as Record<string, unknown>;
  const own = raw.own && typeof raw.own === "object" ? (raw.own as Record<string, unknown>) : {};
  const admob =
    raw.admob && typeof raw.admob === "object" ? (raw.admob as Record<string, unknown>) : {};
  const campaigns: OwnCampaign[] = [];
  for (const candidate of Array.isArray(own.campaigns) ? own.campaigns.slice(0, 50) : []) {
    if (!candidate || typeof candidate !== "object") continue;
    const imageUrl = publicHttps(candidate.imageUrl),
      targetUrl = publicHttps(candidate.targetUrl);
    if (
      !imageUrl ||
      !targetUrl ||
      typeof candidate.id !== "string" ||
      !/^[\w-]{1,64}$/.test(candidate.id)
    )
      continue;
    const startsAt =
      typeof candidate.startsAt === "string" && Number.isFinite(Date.parse(candidate.startsAt))
        ? new Date(candidate.startsAt).toISOString()
        : undefined;
    const endsAt =
      typeof candidate.endsAt === "string" && Number.isFinite(Date.parse(candidate.endsAt))
        ? new Date(candidate.endsAt).toISOString()
        : undefined;
    if (
      (candidate.startsAt && !startsAt) ||
      (candidate.endsAt && !endsAt) ||
      (startsAt && endsAt && startsAt >= endsAt) ||
      campaigns.some((item) => item.id === candidate.id)
    )
      continue;
    campaigns.push({
      id: candidate.id,
      imageUrl,
      targetUrl,
      title: typeof candidate.title === "string" ? candidate.title.slice(0, 100) : "Publicidad",
      startsAt,
      endsAt,
    });
  }
  const unit = (value: unknown) =>
    typeof value === "string" && /^ca-app-pub-\d{16}\/\d{10}$/.test(value) ? value : "";
  return {
    version: 1,
    refreshSeconds: seconds(raw.refreshSeconds, 600, 60, 86400),
    own: {
      enabled: own.enabled === true,
      intervalSeconds: seconds(own.intervalSeconds, 300, 30, 86400),
      durationSeconds: seconds(own.durationSeconds, 15, 5, 120),
      firstDelaySeconds: seconds(own.firstDelaySeconds, 60, 5, 86400),
      campaigns,
    },
    admob: {
      enabled: admob.enabled === true,
      androidBannerId: unit(admob.androidBannerId),
      iosBannerId: unit(admob.iosBannerId),
    },
  };
}
export function eligibleCampaigns(config: MobileAdsConfig, time = Date.now()) {
  return config.own.enabled
    ? config.own.campaigns.filter(
        (item) =>
          (!item.startsAt || Date.parse(item.startsAt) <= time) &&
          (!item.endsAt || Date.parse(item.endsAt) > time),
      )
    : [];
}
export async function fetchMobileAds(url: string, signal: AbortSignal) {
  if (!publicHttps(url)) throw new Error("La configuración remota necesita HTTPS");
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) throw new Error("Publicidad remota no disponible");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error("La configuración supera 64 KiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.length;
  }
  return parseMobileAds(JSON.parse(new TextDecoder().decode(bytes)));
}
