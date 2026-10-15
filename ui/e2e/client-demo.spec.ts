import { expect, test } from "@playwright/test";

test("review demo isolates account API, previews media, uploads locally and resets on reload", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    apiRequests.push(route.request().url());
    return route.fulfill({
      status: 401,
      json: { error: { code: "unauthorized", message: "No account" } },
    });
  });
  await page.goto("/login?client=mobile");
  await expect(page.getByRole("button", { name: "Explorar demostración" })).toBeVisible();
  // The login page may check public Google availability before entering the demo.
  await page.waitForLoadState("networkidle");
  apiRequests.length = 0;
  await page.getByRole("button", { name: "Explorar demostración" }).click();
  await expect(page.getByRole("complementary", { name: "Demostración local" })).toBeVisible();
  await page.getByRole("button", { name: "Omitir recorrido" }).click();
  await expect(page.getByRole("row", { name: /Bienvenido\.txt/ })).toBeVisible();
  await page.getByRole("row", { name: /Bienvenido\.txt/ }).dblclick();
  await expect(page.getByRole("dialog")).toContainText("Esta unidad de demostración vive solo");
  await page.keyboard.press("Escape");
  await page.getByRole("row", { name: /Vídeo de ejemplo/ }).dblclick();
  await expect
    .poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Subir", exact: true }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Subir archivos" }).click();
  await (await chooserPromise).setFiles({
    name: "prueba-local.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Local only"),
  });
  await expect(page.getByRole("row", { name: /prueba-local\.txt/ }).first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Progreso total de subida" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  await page.getByRole("link", { name: "Ajustes", exact: true }).click();
  await page.getByRole("link", { name: "Canales de Telegram", exact: true }).click();
  await page.getByRole("button", { name: "Usar canal", exact: true }).click();
  await expect(
    page.getByText("Canal seleccionado para las nuevas subidas", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "Archivos", exact: true }).click();
  await expect(page.getByRole("row", { name: /Bienvenido\.txt/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /prueba-local\.txt/ })).toHaveCount(0);
  expect(apiRequests).toEqual([]);
  await page.getByRole("button", { name: "Salir de la demo", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => sessionStorage.getItem("teldrive-client-demo"))).toBeNull();
});

test("demo transport denies external/account actions and oversized uploads without network fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("teldrive-client-demo", "1");
    sessionStorage.setItem("teldrive-client-preview", "mobile");
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });
  await page.goto("/files");
  await expect(page.getByRole("complementary", { name: "Demostración local" })).toBeVisible();
  const result = await page.evaluate(async () => {
    const { apiFetch } = await import("/src/api/client.ts");
    const errors = [];
    for (const path of ["/v1/bots", "/v1/mobile/google/start", "/v1/system/users"]) {
      try {
        await apiFetch(path, { method: "POST", body: "{}" });
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      await apiFetch("/v1/uploads", {
        method: "POST",
        body: JSON.stringify({ name: "large", size: 9 * 1024 * 1024 }),
      });
    } catch (error) {
      errors.push(String(error));
    }
    return errors;
  });
  expect(result).toHaveLength(4);
  expect(requests).toEqual([]);
});
