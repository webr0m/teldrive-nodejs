// This flag selects an entirely local transport. It never grants server access.
const key = "teldrive-client-demo";
export const isDemoActive = () => sessionStorage.getItem(key) === "1";
export function beginClientDemo() {
  sessionStorage.setItem(key, "1");
}
export function endClientDemo() {
  sessionStorage.removeItem(key);
}
export const demoUrls = new Map<string, string>();
export const demoContentUrl = (id: string) => demoUrls.get(id) ?? "";
