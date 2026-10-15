import { expect, test } from "@playwright/test";
import { installFileApi } from "./file-api.fixture";

test.beforeEach(async ({ page }) => {
  await installFileApi(page);
  await page.addInitScript(() => localStorage.setItem("teldrive-tour-v1:1", "seen"));
  await page.route("**/api/v1/mobile/config", (route) =>
    route.fulfill({ json: { googleEnabled: true, adsConfigUrl: "" } }),
  );
});

test("admin cannot see owner settings or open their routes; privacy is not a web setting", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        userId: 2,
        displayName: "Admin",
        role: "admin",
        capabilities: ["files", "system.manageJobs"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  let sensitiveRequests = 0;
  page.on("request", (request) => {
    if (/\/api\/v1\/admin\//.test(request.url())) sensitiveRequests++;
  });
  await page.goto("/settings");
  for (const path of ["users", "server", "configuration", "privacy"]) {
    await expect(page.locator(`a[href='/settings/${path}']`)).toHaveCount(0);
    await page.goto(`/settings/${path}`, { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/settings\/?$/);
    await expect(page.getByRole("heading", { name: "Cuenta", exact: true })).toBeVisible();
  }
  expect(sensitiveRequests).toBe(0);
  await page.goto("/settings/privacy?client=mobile", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(
    page.getByRole("link", { name: "Privacidad y publicidad", exact: true }),
  ).toHaveCount(0);
});

test("owner imports and validates TOML before saving and sees a pending restart", async ({
  page,
}) => {
  let current = {
    enabled: true,
    toml: '[node]\npublic-url="https://cloud.example"\nsupabase-key="__TELDRIVE_KEEP_SECRET__"',
    revision: "before",
    restartRequired: false,
    restartAvailable: true,
    backups: [],
  };
  const actions: string[] = [];
  await page.route("**/api/v1/admin/configuration**", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "GET") return route.fulfill({ json: current });
    const body = route.request().postDataJSON();
    actions.push(name);
    expect(route.request().headers()["x-teldrive-config"]).toBe("1");
    expect(body.revision).toBe("before");
    if (name === "validate")
      return route.fulfill({
        json: {
          changed: ["SUPABASE_URL"],
          ignored: ["logging.log-level"],
          databaseChanged: true,
          connectionTested: false,
        },
      });
    expect(body.confirmDatabaseChange).toBe(true);
    expect(body.discardUnsupported).toBe(true);
    current = { ...current, revision: "after", restartRequired: true };
    return route.fulfill({ json: current });
  });
  await page.goto("/settings/configuration");
  await expect(
    page.getByRole("heading", { name: "Configuración del servidor", exact: true, level: 1 }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Guardar para el próximo reinicio", exact: true });
  await expect(save).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "migration.toml", mimeType: "text/plain",
    buffer: Buffer.from('[node]\nsupabase-url="https://other.example"\n[logging]\nlog-level="info"'),
  });
  await expect(page.getByRole("textbox", { name: "Configuración TOML" })).toHaveValue(/other\.example/);
  await page.getByRole("button", { name: "Validar TOML", exact: true }).click();
  await expect(page.getByText(/Validación correcta/)).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: /Confirmo que preparé/ }).check();
  await page.getByRole("checkbox", { name: /Omitir estas opciones/ }).check();
  await save.click();
  await expect(page.getByText(/Hay cambios guardados pendientes/)).toBeVisible();
  expect(actions).toEqual(["validate", "save"]);
});

test("native app retains privacy preferences and bot administration", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [
          { name: "SecureStorage", methods: [{ name: "internalGetItem", rtype: "promise" }] },
          {
            name: "App",
            methods: [
              { name: "addListener", rtype: "callback" },
              { name: "removeListener", rtype: "promise" },
            ],
          },
        ],
        nativeCallback: () => "test-listener",
        nativePromise: async () => ({ data: "" }),
      },
    });
  });
  await page.goto("/settings/privacy");
  await expect(
    page.getByRole("heading", { name: "Privacidad y publicidad", exact: true }),
  ).toBeVisible();
  await page.goto("/settings");
  await expect(
    page.getByRole("link", { name: "Privacidad y publicidad", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Bots", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Usuarios y permisos", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Límites del servidor", exact: true })).toHaveCount(
    0,
  );
});
