import { test, expect, type Page } from "@playwright/test";
import { installFileApi, alphaId } from "./file-api.fixture";

async function setup(page: Page, denied = false) {
  await installFileApi(page);
  await page.addInitScript(() => localStorage.setItem("teldrive-tour-v1:1", "seen"));
  const file = {
    id: alphaId,
    name: "prueba.wav",
    kind: "file",
    mimeType: "audio/wav",
    size: 16044,
    status: "active",
    generation: 1,
    encryption: false,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    modTime: "2026-07-01T00:00:00Z",
  };
  await page.route("**/api/v1/files**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/playback"))
      return route.fulfill({
        status: 201,
        json: {
          ticket: "b".repeat(43),
          expiresAt: "2099-01-01T00:00:00Z",
          conversionAvailable: false,
        },
      });
    if (path === `/api/v1/files/${alphaId}`) return route.fulfill({ json: file });
    if (path === "/api/v1/files") return route.fulfill({ json: { items: [file] } });
    return route.fallback();
  });
  let polls = 0;
  await page.route("**/api/v1/playback/diagnostics?**", (route) => {
    polls++;
    if (denied)
      return route.fulfill({
        status: 403,
        json: { error: { code: "playback_diagnostics_owner_required", message: "Owner required" } },
      });
    return route.fulfill({
      json: {
        file: { parts: 2, encryption: true },
        nodes: [
          {
            role: "primary",
            capturedAt: Date.now(),
            enabled: true,
            activeRequests: 1,
            requests: polls,
            outputBytes: 1048576,
            inputBytes: 2097152,
            errors: 0,
            streams: [],
            sources: [
              {
                id: "bot:10001",
                kind: "bot",
                botId: "10001",
                name: "Bot de prueba",
                username: "sample_bot",
                active: 1,
                attempts: 2,
                failures: 1,
                inputBytes: 2097152,
                forwardedBytes: 1048576,
                bytesPerSecond: 524288,
                lastByteAt: Date.now(),
              },
            ],
          },
        ],
        unavailableNodes: ["secondary"],
      },
    });
  });
  await page.route("**/api/v1/playback/tracks?**", (route) =>
    route.fulfill({
      json: {
        available: true,
        tracks: [
          {
            index: 0,
            kind: "audio",
            codec: "pcm_s16le",
            sample_rate: 8000,
            channels: 1,
            language: "spa",
            title: "Audio",
            default: true,
            bitmap: false,
          },
        ],
        format: { name: "wav", duration: 1, bit_rate: 128000 },
      },
    }),
  );
  await page.route("**/api/v1/playback?**", (route) =>
    route.fulfill({ contentType: "audio/wav", body: wave() }),
  );
  await page.goto("/files?view=list&client=mobile");
  await page
    .getByRole("row", { name: /prueba.wav/ })
    .locator('[data-slot="checkbox-control"]')
    .click();
  await page.getByRole("button", { name: "Vista previa", exact: true }).click();
  await expect(page.getByRole("dialog").locator("audio")).toBeVisible();
  return () => polls;
}
test("audio diagnostics display actual source fields, fit mobile and stop polling when closed", async ({
  page,
}) => {
  const polls = await setup(page);
  expect(polls()).toBe(0);
  await page.getByRole("button", { name: "Estadísticas · Desarrollador", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Estadísticas de reproducción" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Bot de prueba — @sample_bot — ID: 10001");
  await expect(panel).toContainText("2 / 1");
  await expect(panel).toContainText("sin respuesta");
  await expect(panel).not.toContainText("b".repeat(43));
  const overflow = await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "Cerrar estadísticas", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const stopped = polls();
  await page.waitForTimeout(2500);
  expect(polls()).toBe(stopped);
});
test("an unavailable owner session leaves browser diagnostics usable and does not repeatedly request private data", async ({
  page,
}) => {
  const polls = await setup(page, true);
  await page.getByRole("button", { name: "Estadísticas · Desarrollador", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Estadísticas de reproducción" });
  await expect(panel).toContainText("requieren la sesión del propietario");
  await expect(panel).toContainText("Búfer y decodificación");
  await expect(panel).not.toContainText("sample_bot");
  await page.waitForTimeout(2500);
  expect(polls()).toBe(1);
});
function wave() {
  const b = Buffer.alloc(16044);
  b.write("RIFF");
  b.writeUInt32LE(16036, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(16000, 40);
  return b;
}
