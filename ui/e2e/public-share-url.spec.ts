import { expect, test } from "@playwright/test";
import { alphaId, installFileApi } from "./file-api.fixture";

for (const publicUrl of ["https://drive.example.com/share/fixture-token", "/share/fixture-token"]) {
  test(`copy public share from localhost: ${publicUrl}`, async ({ page }) => {
    await installFileApi(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as typeof window & { copiedText?: string }).copiedText = value;
          },
        },
      });
    });
    let created = false;
    let creations = 0;
    const shared = {
      id: "55555555-5555-4555-8555-555555555555",
      fileId: alphaId,
      token: "fixture-token",
      publicUrl,
      passwordProtected: false,
      permission: "read",
      downloadCount: 0,
      createdAt: "2026-10-12T12:00:00Z",
    };
    await page.route(new RegExp(`/api/v1/files/${alphaId}/shares`), async (route) => {
      if (route.request().method() === "POST") {
        created = true;
        creations++;
        return route.fulfill({ status: 201, json: shared });
      }
      return route.fulfill({ json: { items: created ? [shared] : [] } });
    });
    await page.goto("/files");
    await page.getByRole("row", { name: /alpha\.txt/ }).click();
    await page.getByRole("button", { name: "Compartir elemento seleccionado" }).click();
    await page.getByRole("button", { name: "Crear enlace público", exact: true }).click();
    const expectedUrl = new URL(publicUrl, new URL(page.url()).origin).toString();
    await expect
      .poll(() =>
        page.evaluate(() => (window as typeof window & { copiedText?: string }).copiedText),
      )
      .toBe(expectedUrl);
    await expect(page.getByRole("dialog").locator("input[readonly]")).toHaveValue(expectedUrl);
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await page.reload();
    await page.getByRole("row", { name: /alpha\.txt/ }).click();
    await page.getByRole("button", { name: "Compartir elemento seleccionado" }).click();
    await expect(
      page.getByRole("button", { name: "Crear enlace público", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Copiar enlace", exact: true }).click();
    await expect(page.getByRole("dialog").locator("input[readonly]")).toHaveValue(expectedUrl);
    expect(creations).toBe(1);
  });
}
