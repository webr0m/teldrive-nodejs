import { expect, test } from "@playwright/test";
import { installFileApi } from "./file-api.fixture";
test.beforeEach(async ({ page }) => {
  await installFileApi(page);
  await page.route("**/api/v1/mobile/config", (route) =>
    route.fulfill({ json: { googleEnabled: false, adsConfigUrl: "" } }),
  );
});
test("client tour can be skipped, repeated and remembered; bots remain while server options are blocked", async ({
  page,
  isMobile,
}) => {
  await page.goto("/files?client=mobile");
  const tour = page.getByRole("dialog").filter({ hasText: "Teldrive Cliente ·" });
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(tour).toContainText("2 de 8");
  await tour.getByRole("button", { name: "Omitir recorrido" }).click();
  await page.reload();
  await expect(tour).toHaveCount(0);
  await page.goto("/settings/help");
  await page.getByRole("textbox", { name: "Buscar en el manual" }).fill("bots");
  await expect(page.locator("details")).toHaveCount(1);
  await page.getByRole("button", { name: "Repetir recorrido" }).click();
  await expect(tour).toContainText("1 de 8");
  await tour.getByRole("button", { name: "Omitir recorrido" }).click();
  if (isMobile) await page.getByRole("button", { name: "Abrir menú de configuración" }).click();
  await expect(page.getByRole("link", { name: "Bots", exact: true })).toBeVisible();
  for (const name of [
    "Rclone",
    "Usuarios y permisos",
    "Límites del servidor",
    "Claves de API",
    "Tareas periódicas",
  ])
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  await page.goto("/settings/server");
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0);
});
test("bundled manual opens without an authenticated server connection", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.goto("/manual?client=mobile");
  await expect(page.getByRole("heading", { name: "Ayuda y manual" })).toBeVisible();
  await page.getByRole("textbox", { name: "Buscar en el manual" }).fill("contraseña");
  await expect(page.locator("details")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: "Repetir recorrido" })).toHaveCount(0);
});

test("own banners rotate on the configured interval and pause inside dialogs", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/v1/mobile/config", (route) =>
    route.fulfill({
      json: { googleEnabled: false, adsConfigUrl: "https://ads.example/config.json" },
    }),
  );
  await page.route("https://ads.example/config.json", (route) =>
    route.fulfill({
      json: {
        version: 1,
        own: {
          enabled: true,
          firstDelaySeconds: 5,
          intervalSeconds: 30,
          durationSeconds: 5,
          campaigns: [
            {
              id: "one",
              title: "Mi anuncio",
              imageUrl: "https://ads.example/banner.png",
              targetUrl: "https://ads.example/promo",
            },
          ],
        },
      },
    }),
  );
  await page.route("https://ads.example/banner.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  const manifest = page.waitForResponse("https://ads.example/config.json");
  await page.goto("/files?client=mobile");
  await page.getByRole("button", { name: "Omitir recorrido" }).click();
  await manifest;
  const banner = page.getByRole("complementary", { name: "Publicidad propia" });
  await page.clock.runFor(6000);
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Cerrar publicidad propia" }).click();
  await expect(banner).toHaveCount(0);
  await page.clock.runFor(31000);
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Abrir navegación", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await page.clock.runFor(6000);
  await expect(banner).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/settings/help");
  await expect(banner).toHaveCount(0);
});
