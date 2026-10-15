import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "lat.webrom.teldrive.client",
  appName: "Teldrive Cloud",
  webDir: "dist-mobile",
  android: { allowMixedContent: false, backgroundColor: "#10121a" },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#10121a",
    limitsNavigationsToAppBoundDomains: false,
  },
  server: { androidScheme: "https" },
  plugins: {
    CapacitorHttp: { enabled: true },
    SplashScreen: { launchAutoHide: true },
  },
};
export default config;
