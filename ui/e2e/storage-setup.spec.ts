import { expect, test } from "@playwright/test";
import { installFileApi } from "./file-api.fixture";

test.beforeEach(async ({ page }) => {
  await installFileApi(page);
  await page.route("**/api/v1/mobile/config", (route) =>
    route.fulfill({ json: { googleEnabled: false, adsConfigUrl: "" } }),
  );
});
const title = "Configura tu disco virtual de Telegram";

test("missing channel is explained on login, links to the manual, and is checked again on an upload attempt", async ({
  page,
}) => {
  await page.route("**/api/v1/me/storage**", (route) =>
    route.fulfill({ json: { requiresChannel: true, configured: false } }),
  );
  let uploads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/(uploads|folders)$/.test(new URL(request.url()).pathname)
    )
      uploads++;
  });
  await page.goto("/files?split=false");
  const popup = page.getByRole("dialog", { name: title });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("canal privado de Telegram");
  await expect(popup).toContainText("no necesitas bots para empezar");
  await popup.getByRole("button", { name: "Abrir manual", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/help/);
  await page.getByRole("textbox", { name: "Buscar en el manual" }).fill("disco virtual");
  await expect(page.locator("details")).toContainText("canal privado");
  await page.goto("/files?split=false");
  await expect(popup).toBeVisible(); // A new page load starts a new welcome check.
  await popup.getByRole("button", { name: "Ahora no", exact: true }).click();
  await page.getByRole("button", { name: "Subir", exact: true }).click();
  await page.getByRole("menuitem", { name: "Subir archivos", exact: true }).click();
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("La subida no ha comenzado");
  expect(uploads).toBe(0);
});

test("mobile tour finishes before the storage notice, with no overlapping dialogs or horizontal overflow", async ({ page }, info) => {
  await page.route("**/api/v1/me/storage**", (route) =>
    route.fulfill({ json: { requiresChannel: true, configured: false } }),
  );
  await page.addInitScript(() => {
    localStorage.removeItem("teldrive-tour-v1:1");
    (window as unknown as { maxSetupDialogs: number }).maxSetupDialogs = 0;
    new MutationObserver(() => {
      const state = window as unknown as { maxSetupDialogs: number };
      state.maxSetupDialogs = Math.max(
        state.maxSetupDialogs,
        document.querySelectorAll('[role="dialog"]').length,
      );
    }).observe(document, { childList: true, subtree: true });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/files?client=mobile");
  const tour = page.getByRole("dialog").filter({ hasText: "Teldrive Cliente ·" });
  const popup = page.getByRole("dialog", { name: title });
  await expect(tour).toBeVisible();
  await expect(popup).toHaveCount(0);
  await tour.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(tour).toContainText("2 de 9");
  await expect(popup).toHaveCount(0);
  await tour.getByRole("button", { name: "Omitir recorrido", exact: true }).click();
  await expect(popup).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { maxSetupDialogs: number }).maxSetupDialogs),
  ).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath("storage-setup-mobile.png") });
  await popup.getByRole("button", { name: "Abrir manual", exact: true }).click();
  await page.getByRole("button", { name: "Repetir recorrido", exact: true }).click();
  await expect(tour).toBeVisible();
  await expect(popup).toHaveCount(0);
});

test("a fresh channel check prevents file selection from creating an upload until the destination is configured", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("teldrive-tour-v1:1", "seen"));
  let configured = true;
  let uploads = 0;
  await page.route("**/api/v1/me/storage**", (route) =>
    route.fulfill({ json: { requiresChannel: true, configured } }),
  );
  await page.route("**/api/v1/channels**", (route) => {
    if (route.request().method() === "POST") {
      configured = true;
      return route.fulfill({ json: { id: 99, name: "Disco privado", selected: true } });
    }
    return route.fulfill({
      json: { items: [{ id: 99, name: "Disco privado", selected: configured }] },
    });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
      uploads++;
  });
  await page.goto("/files?client=mobile");
  await expect(page.getByRole("row", { name: /alpha\.txt/ })).toBeVisible();
  await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
  configured = false;
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "blocked.txt", mimeType: "text/plain", buffer: Buffer.from("example") });
  const popup = page.getByRole("dialog", { name: title });
  await expect(popup).toBeVisible();
  expect(uploads).toBe(0);
  await popup.getByRole("button", { name: "Configurar canal", exact: true }).click();
  await page.getByRole("button", { name: "Usar canal", exact: true }).click();
  await expect(page.getByText("En uso", { exact: true })).toBeVisible();
  await page.goto("/files?client=mobile");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "ready.txt", mimeType: "text/plain", buffer: Buffer.from("example") });
  await expect.poll(() => uploads).toBe(1);
  await expect(popup).toHaveCount(0);
});
