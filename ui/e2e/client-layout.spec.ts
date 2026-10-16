import { expect, test } from "@playwright/test";
import { installFileApi } from "./file-api.fixture";

test.beforeEach(async ({ page }) => {
  await installFileApi(page);
  await page.addInitScript(() => localStorage.setItem("teldrive-tour-v1:1", "seen"));
  await page.route("**/api/v1/mobile/config", (route) =>
    route.fulfill({ json: { googleEnabled: true, adsConfigUrl: "" } }),
  );
  await page.route("**/api/v1/bots*", (route) => route.fulfill({ json: { items: [] } }));
  let selected = 101;
  await page.route("**/api/v1/channels**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/discover"))
      return route.fulfill({ json: [{ id: 103, name: "Canal nuevo descubierto" }] });
    if (path.endsWith("/sync")) {
      expect(route.request().postDataJSON()).toEqual({ channelIds: [103] });
      return route.fulfill({
        json: [{ id: 103, name: "Canal nuevo descubierto", selected: false }],
      });
    }
    const channelId = path.match(/channels\/(\d+)\/select$/)?.[1];
    if (channelId) {
      selected = Number(channelId);
      return route.fulfill({ json: { id: selected, name: "Canal", selected: true } });
    }
    return route.fulfill({
      json: {
        items: [
          { id: 101, name: "Canal de almacenamiento original", selected: selected === 101 },
          {
            id: 102,
            name: "Canal alternativo con nombre bastante largo para pantallas pequeñas",
            selected: selected === 102,
          },
          ...(selected === 103
            ? [{ id: 103, name: "Canal nuevo descubierto", selected: true }]
            : []),
        ],
      },
    });
  });
});

test("mobile navigation has one menu per purpose and a reachable personal channel picker", async ({
  page,
}) => {
  await page.goto("/files?client=mobile&split=true");
  const nav = page.getByRole("navigation", { name: "Navegación de la aplicación", exact: true });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir navegación", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Abrir vista dividida", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("file-pane-secondary")).toHaveCount(0);
  await nav.getByRole("button", { name: "Más opciones de la aplicación" }).click();
  const more = page.getByRole("navigation", { name: "Más secciones" });
  for (const name of ["Compartido conmigo", "Papelera", "Spam", "Almacenamiento"])
    await expect(more.getByRole("link", { name, exact: true })).toHaveCount(1);
  for (const name of ["Archivos", "Compartidos", "Ajustes"])
    await expect(more.getByRole("link", { name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await nav.getByRole("link", { name: "Ajustes", exact: true }).click();
  await expect(page.getByRole("link", { name: /^Bots/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Abrir menú de configuración" })).toHaveCount(0);
  await page.getByRole("link", { name: /^Canales de Telegram/ }).click();
  await expect(
    page.getByRole("heading", { name: "Canales de Telegram", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Usar canal", exact: true }).click();
  await expect(
    page.getByText("Canal seleccionado para las nuevas subidas", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Canal alternativo con nombre bastante largo para pantallas pequeñas")
      .locator("..")
      .locator(".."),
  ).toContainText("En uso");
  await page.getByRole("button", { name: "Buscar canales en Telegram" }).click();
  await page
    .getByText("Canal nuevo descubierto")
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Usar canal" })
    .click();
  await expect(page.getByText("Canal nuevo descubierto").locator("..").locator("..")).toContainText(
    "En uso",
  );
  await page.getByRole("button", { name: "Volver", exact: true }).click();
  await page.getByRole("link", { name: /^Ayuda y manual/ }).click();
  await page.getByRole("textbox", { name: "Buscar en el manual" }).fill("Elegir el canal");
  await expect(
    page.locator("details").filter({
      has: page.locator("summary").filter({ hasText: /^Elegir el canal de tu unidad$/ }),
    }),
  ).toContainText("Cambiar de canal no mueve ni elimina");
});

test("client screens and touch controls fit narrow portrait and landscape viewports", async ({
  page,
}, info) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of [
      "/files",
      "/settings",
      "/settings/channels",
      "/settings/appearance",
      "/settings/help",
    ]) {
      await page.goto(`${path}?client=mobile`);
      await expect(
        page.getByRole("navigation", { name: "Navegación de la aplicación", exact: true }),
      ).toBeVisible();
      const overflowing = await page.locator(".client-shell").evaluate((shell) =>
        [...shell.querySelectorAll('button, a, input, [role="button"]')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              (rect.left < -1 || rect.right > innerWidth + 1)
            );
          })
          .map((element) => element.getAttribute("aria-label") || element.textContent?.trim())
          .filter(Boolean),
      );
      expect(overflowing, `${path} at ${viewport.width}x${viewport.height}`).toEqual([]);
      const navBounds = await page
        .getByRole("navigation", { name: "Navegación de la aplicación", exact: true })
        .boundingBox();
      expect(navBounds!.y + navBounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?client=mobile");
  await page.screenshot({ path: info.outputPath("client-settings.png") });
});

test("the compact search entry still submits a query", async ({ page }) => {
  await page.goto("/files?client=mobile");
  await page.getByRole("button", { name: "Buscar archivos", exact: true }).click();
  await page.getByRole("textbox", { name: "Buscar archivos", exact: true }).fill("alpha");
  await page.getByRole("textbox", { name: "Buscar archivos", exact: true }).press("Enter");
  await expect(page).toHaveURL(/q=alpha/);
  await expect(page.getByRole("row", { name: /alpha\.txt/ })).toBeVisible();
});
