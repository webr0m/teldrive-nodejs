import { Capacitor } from "@capacitor/core";

export const nativeClient = Capacitor.isNativePlatform();
const preview = new URLSearchParams(window.location.search).get("client");
if (preview === "mobile") sessionStorage.setItem("teldrive-client-preview", "mobile");
if (preview === "web") sessionStorage.removeItem("teldrive-client-preview");
export const clientOnly =
  nativeClient ||
  import.meta.env.VITE_CLIENT_ONLY === "true" ||
  sessionStorage.getItem("teldrive-client-preview") === "mobile";
const configuredOrigin = import.meta.env.VITE_MOBILE_SERVER_URL || "https://cloud.webrom.lat";
export const serverOrigin =
  nativeClient || import.meta.env.VITE_CLIENT_ONLY === "true"
    ? new URL(configuredOrigin).origin
    : window.location.origin;
if (
  (nativeClient || import.meta.env.PROD) &&
  !serverOrigin.startsWith("https:") &&
  !["localhost", "127.0.0.1"].includes(new URL(serverOrigin).hostname)
)
  throw new Error("El cliente necesita un servidor HTTPS");
export const apiUrl = (value: string) => new URL(value, serverOrigin).toString();
export const clientSettingsPaths = new Set([
  "/settings",
  "/settings/",
  "/settings/account",
  "/settings/channels",
  "/settings/bots",
  "/settings/sessions",
  "/settings/uploads",
  "/settings/appearance",
  "/settings/info",
  "/settings/help",
  "/settings/privacy",
]);
export function clientPathAllowed(pathname: string) {
  if (pathname.replace(/\/$/, "") === "/settings/privacy" && !nativeClient) return false;
  if (!clientOnly) return true;
  if (pathname.startsWith("/settings"))
    return clientSettingsPaths.has(pathname.replace(/\/$/, "") || "/settings");
  return !pathname.startsWith("/tasks");
}
