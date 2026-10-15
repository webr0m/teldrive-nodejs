import { useEffect, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Button } from "@heroui/react";
import { Capacitor } from "@capacitor/core";
import { apiFetch } from "@/api/client";
import { clientOnly, nativeClient } from "@/lib/client-runtime";
import { isDemoActive } from "@/lib/client-demo";
import {
  eligibleCampaigns,
  fetchMobileAds,
  type MobileAdsConfig,
  type OwnCampaign,
} from "@/lib/mobile-ads-config";
let consentReady: Promise<boolean> | undefined;
let bannerId = "";
let nativeOperations = Promise.resolve();
function serializeNative(operation: () => Promise<void>) {
  const next = nativeOperations.then(operation);
  nativeOperations = next.catch(() => {});
  return next;
}
async function hideNativeBanner() {
  if (bannerId)
    await (await import("@capacitor-community/admob")).AdMob.hideBanner().catch(() => {});
}
async function prepareAdMob() {
  consentReady ??= (async () => {
    const { AdMob, AdmobConsentStatus } = await import("@capacitor-community/admob");
    let consent = await AdMob.requestConsentInfo();
    if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED)
      consent = await AdMob.showConsentForm();
    if (!consent.canRequestAds) return false;
    await AdMob.initialize({ initializeForTesting: import.meta.env.VITE_ADMOB_LIVE !== "true" });
    return true;
  })().catch(() => {
    consentReady = undefined;
    return false;
  });
  return consentReady;
}
export async function reviewAdvertisingPrivacy() {
  if (!nativeClient || isDemoActive()) return;
  const { AdMob } = await import("@capacitor-community/admob");
  await serializeNative(async () => {
    await hideNativeBanner();
    await AdMob.requestConsentInfo();
    await AdMob.showPrivacyOptionsForm();
    consentReady = undefined;
  });
  window.dispatchEvent(new Event("teldrive-ad-consent-changed"));
}
export function MobileAdvertising() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [config, setConfig] = useState<MobileAdsConfig>(),
    [own, setOwn] = useState<OwnCampaign>();
  const [blocked, setBlocked] = useState(true),
    [bannerHeight, setBannerHeight] = useState(0);
  const cursor = useRef(0),
    remaining = useRef(60000),
    showing = useRef(0);
  const [consentRevision, setConsentRevision] = useState(0);
  useEffect(() => {
    const reset = () => setConsentRevision((value) => value + 1);
    window.addEventListener("teldrive-ad-consent-changed", reset);
    return () => window.removeEventListener("teldrive-ad-consent-changed", reset);
  }, []);
  const allowedPath = [
    "/files",
    "/shared",
    "/shared-with-me",
    "/storage",
    "/trash",
    "/spam",
  ].includes(pathname);
  useEffect(() => {
    if (!clientOnly) return;
    const update = () =>
      setBlocked(
        document.hidden ||
          !allowedPath ||
          Boolean(
            document.querySelector(
              '[data-content-viewer], [data-client-tour], [role="dialog"], [role="alertdialog"]',
            ),
          ),
      );
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [allowedPath]);
  useEffect(() => {
    if (!clientOnly) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let delay = 600000;
      try {
        const { adsConfigUrl } = await (
          await apiFetch("/v1/mobile/config", { signal: controller.signal })
        ).json();
        if (adsConfigUrl) {
          const value = await fetchMobileAds(adsConfigUrl, controller.signal);
          setConfig(value);
          delay = value.refreshSeconds * 1000;
        } else setConfig(undefined);
      } catch {
        setConfig(undefined);
      }
      if (!controller.signal.aborted) timer = setTimeout(load, delay);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    remaining.current = (config?.own.firstDelaySeconds || 60) * 1000;
    showing.current = 0;
    setOwn(undefined);
  }, [config]);
  useEffect(() => {
    if (!config || blocked) {
      if (showing.current > 0) remaining.current = (config?.own.intervalSeconds || 300) * 1000;
      showing.current = 0;
      setOwn(undefined);
      return;
    }
    const timer = setInterval(() => {
      if (showing.current > 0) {
        showing.current -= 1000;
        if (showing.current <= 0) {
          setOwn(undefined);
          remaining.current = config.own.intervalSeconds * 1000;
        }
        return;
      }
      remaining.current -= 1000;
      if (remaining.current <= 0) {
        const eligible = eligibleCampaigns(config);
        if (eligible.length) {
          setOwn(eligible[cursor.current++ % eligible.length]);
          showing.current = config.own.durationSeconds * 1000;
        } else remaining.current = config.own.intervalSeconds * 1000;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [config, blocked]);
  useEffect(() => {
    if (!nativeClient) return;
    let active = true;
    let removeListener: (() => Promise<void>) | undefined;
    const run = async () => {
      if (!active) return;
      if (blocked || own || !config?.admob.enabled) {
        await hideNativeBanner();
        if (active) setBannerHeight(0);
        return;
      }
      const { AdMob, BannerAdPluginEvents, BannerAdPosition, BannerAdSize } = await import(
        "@capacitor-community/admob"
      );
      if (!(await prepareAdMob()) || !active) return;
      const live = import.meta.env.VITE_ADMOB_LIVE === "true";
      const adId = live
        ? Capacitor.getPlatform() === "ios"
          ? config.admob.iosBannerId
          : config.admob.androidBannerId
        : Capacitor.getPlatform() === "ios"
          ? "ca-app-pub-3940256099942544/2934735716"
          : "ca-app-pub-3940256099942544/6300978111";
      if (!adId) return;
      const listener = await AdMob.addListener(BannerAdPluginEvents.SizeChanged, (info) => {
        if (active) setBannerHeight(Math.max(0, Math.min(250, info.height)));
      });
      removeListener = () => listener.remove();
      try {
        if (!active) return;
        if (bannerId === adId) await AdMob.resumeBanner();
        else {
          await AdMob.removeBanner().catch(() => {});
          await AdMob.showBanner({
            adId,
            adSize: BannerAdSize.ADAPTIVE_BANNER,
            position: BannerAdPosition.BOTTOM_CENTER,
            margin: Math.ceil(document.querySelector('.client-bottom-nav')?.getBoundingClientRect().height ?? 56),
            isTesting: !live,
            npa: true,
          });
          bannerId = adId;
        }
        if (active) setBannerHeight((height) => height || 60);
      } finally {
        if (!active) {
          await listener.remove();
          await hideNativeBanner();
        }
      }
    };
    void serializeNative(() =>
      run().catch(() => {
        if (active) setBannerHeight(0);
      }),
    );
    return () => {
      active = false;
      void serializeNative(async () => {
        await removeListener?.().catch(() => {});
        await hideNativeBanner();
      });
    };
  }, [blocked, own, config, consentRevision]);
  useEffect(() => {
    const height = blocked ? 0 : own ? 97 : bannerHeight;
    document.documentElement.style.setProperty("--client-ad-space", `${height}px`);
    return () => {
      document.documentElement.style.removeProperty("--client-ad-space");
    };
  }, [blocked, own, bannerHeight]);
  if (!clientOnly) return null;
  if (own && !blocked)
    return (
      <aside
        aria-label="Publicidad propia"
        className="relative flex shrink-0 items-center gap-3 border-t border-border bg-surface px-3 py-2"
      >
        <Button
          variant="ghost"
          className="h-20 min-w-0 flex-1 justify-start rounded-lg p-0"
          onPress={async () => {
            if (nativeClient)
              await (await import("@capacitor/browser")).Browser.open({ url: own.targetUrl });
            else window.open(own.targetUrl, "_blank", "noopener,noreferrer");
          }}
        >
          <img
            src={own.imageUrl}
            alt={own.title}
            className="h-20 max-w-[70%] object-contain"
            referrerPolicy="no-referrer"
            onError={() => {
              setOwn(undefined);
              showing.current = 0;
              remaining.current = (config?.own.intervalSeconds || 300) * 1000;
            }}
          />
          <span className="max-w-28 truncate text-xs">Publicidad · {own.title}</span>
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="tertiary"
          aria-label="Cerrar publicidad propia"
          onPress={() => {
            setOwn(undefined);
            showing.current = 0;
            remaining.current = (config?.own.intervalSeconds || 300) * 1000;
          }}
        >
          ×
        </Button>
      </aside>
    );
  return (
    <div aria-hidden="true" className="shrink-0" style={{ height: blocked ? 0 : bannerHeight }} />
  );
}
