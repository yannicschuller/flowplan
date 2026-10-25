import { test, expect, type Page, type Route } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Administration → Push-Benachrichtigungen: the tile on the landing page,
// the health tile of the monitoring and the detail page with the relay,
// its reachability, the signing keys, deliveries, Expo and Web Push. The
// relay's health is mocked (the answers of /api/admin/push and the push
// part of /api/admin/summary and /api/admin/monitoring); the checks
// themselves are covered by tests/push-status.test.ts against local servers.
async function signInAdmin(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `push-admin:${uid}`, "Push Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

const now = Date.now();
const HOUR = 3_600_000;
const hourly = Array.from({ length: 24 }, (_, i) => ({ at: now - (23 - i) * HOUR, ok: [0, 2, 1, 4, 3, 6, 2, 0, 5, 7, 4, 3, 8, 6, 2, 1, 3, 4, 9, 5, 2, 3, 6, 4][i], failed: i === 20 ? 1 : 0 }));
const counts = (ok: number, error = 0, gone = 0) => ({ ok, gone, forbidden: 0, invalid: 0, rate_limited: 0, error });
const reachable = { ok: true, ms: 85, httpStatus: 200, error: null, version: "1.4.2", at: now - 20_000 };
const status = (health: Record<string, unknown>) => ({
  at: now,
  tone: health.ok ? "warn" : "error",
  relay: {
    enabled: true,
    reason: null,
    url: "https://push.flowplan.org",
    official: true,
    custom: false,
    instance: "https://flowplan.example.test",
    wellKnown: true,
    wellKnownUrl: "https://flowplan.example.test/.well-known/flowplan-push",
    health,
    self: { ok: false, ms: null, httpStatus: null, error: "dns", version: null, at: now - 20_000 },
    keys: [
      { id: "Qm9vdHN0cmFwS2V5MDAx", signing: true, createdAt: now - 40 * 86_400_000, activeFrom: now - 40 * 86_400_000, retireAt: now + 7 * 86_400_000 },
      { id: "TmV4dEtleUZvclJlbGF5", signing: false, createdAt: now - 600_000, activeFrom: now + 55 * 60_000, retireAt: null },
    ],
  },
  mobile: { enabled: true, content: "default" },
  web: { vapid: "file", subject: false },
  devices: { apps: 3, relay: 2, relayOnly: 1, expo: 2, web: 4 },
  queue: { pending: 1, givenUp: 0 },
  deliveries: {
    collecting: true,
    hours: 24,
    totals: { relay: counts(84, 1, 1), expo: counts(6), web: counts(10, 0, 2) },
    hourly,
    lastOk: { relay: now - 5 * 60_000, expo: now - 3 * HOUR, web: now - 20 * 60_000 },
    lastError: { channel: "relay", result: "error", code: "unreachable", at: now - 4 * HOUR },
  },
});
const summary = (health: { ok: boolean; ms: number | null; error: string | null; httpStatus: number | null }) => ({
  tone: health.ok ? "ok" : "error",
  enabled: true,
  reason: null,
  url: "https://push.flowplan.org",
  official: true,
  health,
  self: { ok: true, error: null },
  mobile: true,
  delivered24h: 100,
  failed24h: 1,
  hourly: hourly.map((h) => h.ok),
});

// The real answer with the push part replaced.
async function patch(route: Route, edit: (body: Record<string, unknown>) => void) {
  const response = await route.fetch();
  const body = await response.json();
  edit(body);
  await route.fulfill({ response, json: body });
}

test("admins see the push relay's state: tile, monitoring and detail page", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signInAdmin(page);
  await page.route("**/api/admin/summary", (route) => patch(route, (b) => (b.push = summary({ ok: true, ms: 85, error: null, httpStatus: 200 }))));
  await page.route("**/api/admin/monitoring*", (route) =>
    new URL(route.request().url()).searchParams.get("view") === "live" || route.request().method() !== "GET"
      ? route.fallback()
      : patch(route, (b) => ((b.health as Record<string, unknown>).push = summary({ ok: false, ms: null, error: "timeout", httpStatus: null }))),
  );
  let checks = 0;
  await page.route("**/api/admin/push", async (route) => {
    if (route.request().method() === "POST") {
      checks++;
      expect(route.request().postDataJSON()).toEqual({ action: "check" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill({ json: status({ ok: false, ms: null, httpStatus: null, error: "timeout", version: null, at: Date.now() }) });
    }
    return route.fulfill({ json: status(reachable) });
  });
  const shots = process.env.PUSH_STATUS_SCREENSHOTS;
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: `${shots}/relay-status-${name}-${info.project.name}.png`, animations: "disabled" });
  };

  // The landing page: a tile with a green badge and the deliveries.
  await page.goto("/#admin");
  const tile = page.locator('.settings-tile[data-section="push"]');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("Push-Benachrichtigungen");
  await expect(tile.locator(".status-badge.ok")).toHaveText("Erreichbar (85 ms)");
  await expect(tile).toContainText("push.flowplan.org");
  await tile.scrollIntoViewIfNeeded();
  await shot("tile");

  // The detail page.
  await tile.click();
  await expect(page).toHaveURL(/#admin\/push$/);
  const health = page.getByTestId("push-relay-health");
  await expect(health).toHaveText("Erreichbar (85 ms)");
  const relay = page.locator("#relay");
  await expect(relay).toContainText("https://push.flowplan.org");
  await expect(relay).toContainText("Offizielles Relay");
  await expect(relay).toContainText("Version 1.4.2");
  await expect(relay).toContainText("https://flowplan.example.test");
  // Not reachable from inside: a warning with the explanation, no error.
  await expect(page.getByTestId("push-well-known")).toContainText("Veröffentlicht · von hier nicht erreichbar");
  await expect(page.getByTestId("push-well-known").locator(".status-badge")).toHaveClass(/warn/);
  await expect(relay).toContainText("Hinter NAT");
  await expect(page.locator("#keys")).toContainText("Qm9vdHN0cmFwS2V5MDAx");
  await expect(page.locator("#keys")).toContainText("Wechsel läuft: TmV4dEtleUZvclJlbGF5 signiert ab");
  const deliveries = page.locator("#deliveries");
  await expect(deliveries).toContainText("Relay (Apps)");
  await expect(deliveries).toContainText("84");
  await expect(deliveries).toContainText("Fehler · unreachable");
  await expect(deliveries).toContainText("3 App-Installationen: 2 über das Relay (1 nur Relay), 2 mit Expo-Token. 4 Browser mit Web Push.");
  await expect(page.locator("#channels")).toContainText("Nur verschlüsselt");
  await expect(page.locator("#channels")).toContainText("Von Flowplan erzeugt");
  await expect(page.locator('a[href="#settings/notifications/push-test"]').first()).toBeVisible();
  await expect(page.locator('a[href^="https://docs.flowplan.org/de/configuration#push-relay"]').first()).toBeVisible();
  // No "Aktualisieren" next to the title: the page has its own check.
  await expect(page.getByRole("button", { name: "Aktualisieren" })).toHaveCount(0);
  await shot("detail");
  if (shots) await page.screenshot({ path: `${shots}/relay-status-detail-full-${info.project.name}.png`, fullPage: true, animations: "disabled" });

  // Check again: the answer of the forced check.
  await page.getByRole("button", { name: "Erreichbarkeit prüfen" }).click();
  await expect(page.getByRole("button", { name: "Wird geprüft …" })).toHaveAttribute("aria-busy", "true");
  await expect(health).toHaveText("Nicht erreichbar: Zeitüberschreitung (5 s)");
  await expect(health.locator(".status-badge")).toHaveClass(/error/);
  expect(checks).toBe(1);
  await expect(page.locator(".admin-status")).toContainText("Relay nicht erreichbar");

  // Rotating the key asks first; cancelling sends nothing.
  let rotations = 0;
  await page.route("**/api/admin/operations", (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.action === "pushRelay.rotate") rotations++;
    return route.fallback();
  });
  await page.getByRole("button", { name: "Schlüssel wechseln …" }).click();
  const dialog = page.getByRole("dialog", { name: "Signaturschlüssel wechseln?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("signiert nach gut einer Stunde");
  await shot("rotate");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toHaveCount(0);
  expect(rotations).toBe(0);

  // Nothing wider than the screen on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // The monitoring's health tiles show the relay too.
  await page.goto("/#admin/monitoring");
  const monitoringTile = page.locator(".mon-health-tile", { hasText: "Push-Relay" });
  await expect(monitoringTile).toBeVisible();
  await expect(monitoringTile).toHaveClass(/error/);
  await expect(monitoringTile).toContainText("push.flowplan.org · Nicht erreichbar: Zeitüberschreitung (5 s)");
  await monitoringTile.scrollIntoViewIfNeeded();
  await shot("monitoring");
  expect(errors).toEqual([]);
});

test("the real endpoint answers for administrators and refuses everyone else", async ({ page, request }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  expect((await request.get("/api/admin/push")).status()).toBe(401);
  await signInAdmin(page);
  const response = await page.request.get("/api/admin/push");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(typeof body.relay.enabled).toBe("boolean");
  expect(JSON.stringify(body)).not.toMatch(/private/i);
});
