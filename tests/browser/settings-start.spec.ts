import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// #532: one settings screen with one sidebar. The start page (#settings)
// shows the person's storage and AI as rings and "Dein Setup"; admins see
// "Instanz auf einen Blick" with live tiles that lead into the instance's
// sections (#settings/instance/<id>). The administration's old addresses
// (#admin/…) lead there without a history step of their own; for everyone
// else the instance's sections do not exist. On phones the start page
// stacks, the list of every section follows it and a section opens full
// screen with "← Einstellungen".
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signIn(page: Page, admin: boolean) {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `settings-start:${uid}`, admin ? "Ada Admin" : "Max Member", `${uid}@example.test`, Date.now());
  d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(admin ? ["flowplan-admins"] : []), Date.now() + 600_000);
  d.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
      localStorage.setItem("flowplan-offline-offer", "never");
    } catch {}
  });
}
// A fresh load of an address (a hash change alone would not reload).
async function open(page: Page, hash: string) {
  await page.goto("about:blank");
  await page.goto(`${origin}/${hash}`);
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Bereiche der Einstellungen" });

test.beforeEach(() => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
});

test("a member: the start page's tiles, no instance anywhere", async ({ page }) => {
  await signIn(page, false);
  await open(page, "#settings");
  await expect(page.getByRole("heading", { name: "Einstellungen", level: 1 })).toBeVisible({ timeout: 30_000 });
  // Storage as a ring with its words; the setup card leads into its sections.
  const usage = page.locator(".sv-start-usage");
  await expect(usage.getByRole("img", { name: /^Speicher: / })).toBeVisible();
  await expect(usage.getByRole("link", { name: /^Speicher/ })).toHaveAttribute("href", "#settings/usage/storage");
  const setup = page.locator(".sv-start-setup");
  await expect(setup.getByRole("link", { name: /^Erscheinungsbild/ })).toHaveAttribute("href", "#settings/appearance");
  await expect(setup.getByRole("link", { name: /^Benachrichtigungen/ })).toHaveAttribute("href", "#settings/notifications");
  await expect(setup.getByRole("link", { name: /^Dieses Gerät/ })).toHaveAttribute("href", "#settings/devices");
  await expect(page.getByRole("radiogroup", { name: "Einstellungsstufe" })).toBeVisible();
  // No instance: neither on the start page nor in the sidebar.
  await expect(page.getByRole("heading", { name: "Instanz auf einen Blick" })).toHaveCount(0);
  await expect(nav(page).locator("a[data-area='admin']")).toHaveCount(0);
  await expect(nav(page).getByRole("heading", { name: /Instanz/ })).toHaveCount(0);
  // The search does not find the instance's sections either.
  await page.getByRole("searchbox", { name: "Einstellung suchen" }).fill("Überwachung");
  await expect(page.locator(".settings-results .settings-tile[href^='#settings/instance']")).toHaveCount(0);
  // An instance address (new or old) shows the start page.
  for (const hash of ["#settings/instance/users", "#admin/users"]) {
    await open(page, hash);
    await expect(page.locator(".sv-start")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Benutzer", level: 1 })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings");
  }
});

test("an admin: instance at a glance, its tiles lead into the sections, #admin redirects", async ({ page }, info) => {
  await signIn(page, true);
  await open(page, "#settings");
  const instance = page.getByRole("region", { name: "Instanz auf einen Blick" });
  await expect(instance).toBeVisible({ timeout: 30_000 });
  // The state and the live panels on top (live-panels.tsx).
  await expect(instance.getByRole("region", { name: "Zustand der Instanz" })).toBeVisible();
  const tiles = instance.locator(".sv-start-tile");
  await expect(tiles).toHaveCount(6, { timeout: 30_000 });
  const hrefs = {
    accounts: "#settings/instance/users",
    storage: "#settings/instance/storage",
    monitoring: "#settings/instance/monitoring",
    signins: "#settings/instance/threats/addresses",
    features: "#settings/instance/general/modules-off",
    version: "#settings/instance/general/version",
  };
  for (const [id, href] of Object.entries(hrefs)) await expect(instance.locator(`.sv-start-tile[data-tile="${id}"]`)).toHaveAttribute("href", href);
  // Live numbers with their words: the stacked bar names both parts.
  await expect(instance.locator('[data-tile="storage"]').getByRole("img", { name: /^Datenbank .+, Dateien .+/ })).toBeVisible();
  await expect(instance.locator('[data-tile="features"]')).toContainText(/\d+ von \d+ an/);
  await expect(instance.locator('[data-tile="version"]')).toContainText(/v\d+\.\d+\.\d+/);
  // The sidebar: "Instanz" with its groups, only here.
  await expect(nav(page).getByRole("heading", { name: /^Instanz/ })).toBeVisible();
  for (const group of ["Personen", "Daten", "Dienste", "Sicherheit", "Betrieb"]) await expect(nav(page).getByRole("heading", { name: group, exact: true })).toBeAttached();
  // A tile opens its section; the sidebar marks it (desktop).
  await instance.locator('[data-tile="monitoring"]').click();
  await expect(page.getByRole("heading", { name: "Überwachung", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#settings\/instance\/monitoring$/);
  if (info.project.name === "desktop") await expect(nav(page).locator("a[aria-current='page']")).toHaveAttribute("data-section", "monitoring");

  // The same id in both areas stays apart (KI).
  await open(page, "#settings/instance/ai");
  await expect(page.getByRole("heading", { name: "KI", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".settings-breadcrumb")).toContainText("Instanz › Dienste");

  // Old addresses: replaced in place, no step of their own.
  await open(page, "#home");
  await expect(page.locator(".home-grid, .home-screen").first()).toBeVisible({ timeout: 30_000 });
  // (A hash changed while the page still hydrates is undone by Next.js.)
  await page.waitForTimeout(2_000);
  const steps = await page.evaluate(() => history.length);
  await page.evaluate(() => (location.hash = "admin/users"));
  await expect(page.getByRole("heading", { name: "Benutzer", level: 1 })).toBeVisible({ timeout: 30_000 });
  // One step (the link itself), replaced – none for the redirect.
  expect(await page.evaluate(() => history.length)).toBe(steps + 1);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/instance/users");
  // Back leads to the place before (phones: no tabs keeping their own
  // places in the way).
  if (info.project.name === "mobile") {
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#home");
  }
  await open(page, "#admin");
  await expect(instance).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/instance");
  await open(page, "#admin/operations");
  await expect(page.getByRole("heading", { name: "Überwachung", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/instance/monitoring");

  // The command palette's entry for the instance.
  if (info.project.name === "desktop") {
    await open(page, "#home");
    await expect(page.locator(".home-grid, .home-screen").first()).toBeVisible({ timeout: 30_000 });
    const input = page.getByLabel("Suchen oder Befehl");
    await expect(async () => {
      if (!(await input.isVisible())) await page.keyboard.press("ControlOrMeta+k");
      await expect(input).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await input.fill("> Einstellungen: Instanz");
    await expect(page.locator(".command-actions")).toContainText("Einstellungen: Instanz");
    await input.press("Enter");
    await expect(instance).toBeVisible({ timeout: 30_000 });
    // No Administration entry in the sidebar any more.
    await expect(page.locator(".sidebar").getByRole("button", { name: "Administration" })).toHaveCount(0);
  }
});

test("phones: the start page stacks, the list follows, a section opens full screen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone layout.");
  await signIn(page, true);
  await open(page, "#settings");
  const rings = page.locator(".sv-start-usage");
  const instance = page.getByRole("region", { name: "Instanz auf einen Blick" });
  await expect(instance.locator(".sv-start-tile").first()).toBeVisible({ timeout: 30_000 });
  // Rings first, then the instance, then the list of every section.
  const y = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!.y;
  expect(await y(rings)).toBeLessThan(await y(instance));
  const list = nav(page);
  expect(await y(instance)).toBeLessThan(await y(list));
  // Two tiles a row, nothing wider than the screen.
  const [a, b] = [await instance.locator(".sv-start-tile").nth(0).boundingBox(), await instance.locator(".sv-start-tile").nth(1).boundingBox()];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // "Alle Bereiche" leads to the list: grouped, with one line of facts.
  await page.getByRole("button", { name: "Alle Bereiche" }).tap();
  await expect(list.getByRole("heading", { name: "Persönlich" })).toBeInViewport();
  const appearance = list.locator("a[data-section='appearance']");
  await expect(appearance.locator("small")).toBeVisible();
  await expect(appearance.locator("small")).not.toHaveText("");
  // A section full screen, back to the start page.
  await appearance.tap();
  await expect(page.getByRole("heading", { name: "Darstellung & Sprache", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(list).toBeHidden();
  const back = page.getByRole("button", { name: "Einstellungen" });
  await expect(back).toBeVisible();
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await back.tap();
  await expect(page.locator(".sv-start")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings");
});

// The live panels on top of "Instanz auf einen Blick" (components/settings/
// admin/live-panels.tsx): all at once in a grid, only those whose data or
// feature is there, each linked to its section; phones show four and "Alle
// Diagramme" (remembered on the device).
function database() {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const setMetrics = (enabled: boolean) => d.prepare("INSERT INTO instance_settings(key,value) VALUES('metrics',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ enabled }));
  const ai = d.prepare("SELECT config FROM ai_instance WHERE id=1").get() as { config: string } | undefined;
  const setAi = (on: boolean) => {
    d.prepare("DELETE FROM ai_instance WHERE id=1").run();
    if (on) d.prepare("INSERT INTO ai_instance(id,config) VALUES(1,?)").run(JSON.stringify({ enabled: true, provider: { kind: "ollama", baseUrl: "http://127.0.0.1:9", model: "test-model", embeddingModel: "" } }));
  };
  const restore = () => {
    setMetrics(true);
    d.prepare("DELETE FROM ai_instance WHERE id=1").run();
    if (ai) d.prepare("INSERT INTO ai_instance(id,config) VALUES(1,?)").run(ai.config);
    d.close();
  };
  return { d, setMetrics, setAi, restore };
}
const LINKS: Record<string, string> = {
  people: "#settings/instance/monitoring/people",
  requests: "#settings/instance/monitoring/traffic",
  ai: "#settings/instance/ai/ai-statistics",
  storage: "#settings/instance/storage",
  errors: "#settings/instance/monitoring/errors",
  server: "#settings/instance/monitoring/server",
  accounts: "#settings/instance/users",
  signins: "#settings/instance/monitoring/signins",
  backups: "#settings/instance/storage/backup",
  background: "#settings/instance/monitoring/queues",
};
// Into the middle of the screen: at the bottom edge the phone's tab bar would cover it.
const centre = async (l: ReturnType<Page["locator"]>) => await l.evaluate((e) => e.scrollIntoView({ block: "center" }));
const ids = (page: Page) => page.locator(".sv-glance-panel").evaluateAll((els) => els.map((e) => e.getAttribute("data-panel")));

test("an admin: live panels on top of the tiles, only what is on, each linked", async ({ page }, info) => {
  test.setTimeout(150_000);
  const mobile = info.project.name === "mobile";
  const db = database();
  try {
    db.setMetrics(true);
    db.setAi(false);
    await signIn(page, true);
    await open(page, "#settings/instance");
    const instance = page.getByRole("region", { name: "Instanz auf einen Blick" });
    const panels = instance.locator(".sv-glance-panel");
    await expect(panels.first()).toBeVisible({ timeout: 30_000 });
    // Statistics on, AI not set up: the most important first.
    await expect.poll(() => ids(page)).toEqual(["people", "requests", "storage", "errors", "server", "accounts", "signins", "backups", "background"]);
    for (const id of await ids(page)) await expect(instance.locator(`[data-panel="${id}"] h3 a`)).toHaveAttribute("href", LINKS[id!]);
    // Each a group named by its title, with a number and a chart that has words.
    // (The chart's own legend is a group with the same name: the panel by its id.)
    const people = instance.locator('[data-panel="people"]');
    await expect(people).toHaveRole("group");
    await expect(people).toHaveAccessibleName(/^Aktive Personen/);
    await expect(people).toContainText("gerade aktiv");
    await expect(instance.locator('[data-panel="requests"]').getByRole("img").first()).toHaveAccessibleName(/Anfragen pro Minute/);
    // Above the tiles, on phones too.
    const tiles = instance.locator(".sv-start-tiles");
    await expect(tiles).toBeVisible({ timeout: 30_000 });
    expect((await panels.first().boundingBox())!.y).toBeLessThan((await tiles.boundingBox())!.y);
    // No carousel any more, and nothing shown twice: no second live strip under the tiles.
    await expect(page.getByRole("button", { name: "Nächstes Diagramm" })).toHaveCount(0);
    await expect(instance.locator(".kpi-grid")).toHaveCount(0);
    if (mobile) {
      // Four at first, the rest on request – remembered on this device.
      await expect(panels.nth(3)).toBeVisible();
      await expect(panels.nth(4)).toBeHidden();
      const more = instance.getByRole("button", { name: "Alle 9 Diagramme" });
      expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await centre(more);
      await more.tap();
      await expect(panels.nth(8)).toBeVisible();
      await expect(instance.getByRole("button", { name: "Weniger Diagramme" })).toHaveAttribute("aria-expanded", "true");
      await open(page, "#settings/instance");
      await expect(panels.nth(8)).toBeVisible({ timeout: 30_000 });
      const fewer = instance.getByRole("button", { name: "Weniger Diagramme" });
      await centre(fewer);
      await fewer.tap();
      await expect(panels.nth(4)).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } else {
      // Desktop: all at once, three a row.
      await expect(panels.nth(8)).toBeVisible();
      await expect(instance.getByRole("group", { name: "Neue Konten" }).getByRole("img")).toHaveAccessibleName(/Neue Konten je Tag/);
      await expect(instance.getByRole("button", { name: /Alle \d+ Diagramme/ })).toBeHidden();
      const [a, b, c] = await Promise.all([0, 1, 2].map(async (i) => (await panels.nth(i).boundingBox())!.y));
      expect(Math.abs(a - b) + Math.abs(b - c)).toBeLessThan(2);
    }
    // A panel's title opens its section.
    const accounts = instance.locator('[data-panel="accounts"] h3 a');
    if (mobile) {
      await centre(instance.getByRole("button", { name: "Alle 9 Diagramme" }));
      await instance.getByRole("button", { name: "Alle 9 Diagramme" }).tap();
      await centre(accounts);
    }
    await accounts.click();
    await expect(page.getByRole("heading", { name: "Benutzer", level: 1 })).toBeVisible({ timeout: 30_000 });

    // AI set up: its panel follows the requests.
    db.setAi(true);
    await open(page, "#settings/instance");
    await expect.poll(() => ids(page), { timeout: 30_000 }).toEqual(["people", "requests", "ai", "storage", "errors", "server", "accounts", "signins", "backups", "background"]);
    await expect(instance.getByRole("group", { name: "KI-Nutzung" })).toContainText("Tokens in 14 Tagen");

    // Statistics off: the panels made from them go, people say why.
    db.setMetrics(false);
    await open(page, "#settings/instance");
    await expect.poll(() => ids(page), { timeout: 30_000 }).toEqual(["people", "storage", "server", "accounts", "signins", "backups", "background"]);
    await expect(people).toContainText("Aktive Personen nur mit eingeschalteter Statistik");
    await expect(instance.getByRole("group", { name: "Anmeldungen", exact: true })).toContainText("fehlgeschlagen in 24 Std.");
  } finally {
    db.restore();
  }
});

// Screenshots for review (SETTINGS_SHOTS=<folder>): the admin's start page
// light and dark, the phone, and every panel – with some history written
// into the test database first (sign-ins, accounts, AI use, backup runs).
test("screenshots of the live panels", async ({ browser }, info) => {
  const dir = process.env.SETTINGS_SHOTS;
  test.skip(!dir || info.project.name !== "desktop", "SETTINGS_SHOTS=<folder>, once.");
  test.setTimeout(180_000);
  mkdirSync(dir!, { recursive: true });
  const db = database();
  const now = Date.now(),
    HOUR = 3_600_000,
    DAY = 86_400_000;
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  try {
    for (let h = 0; h < 24; h++) {
      for (let i = 0; i < ((h * 7) % 5) + 1; i++) db.d.prepare("INSERT INTO ops_events(kind,at) VALUES('login_success',?)").run(now - h * HOUR - i * 1000);
      if (h % 4 === 1) db.d.prepare("INSERT INTO ops_events(kind,at) VALUES('login_failure',?)").run(now - h * HOUR - 500);
    }
    for (let i = 1; i <= 12; i++)
      if (i % 3 !== 0) db.d.prepare("INSERT INTO users(id,subject,name,email,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), `shots:${randomUUID()}`, "Shot", `${randomUUID()}@example.test`, new Date(now - i * 2 * DAY).toISOString().replace("T", " ").slice(0, 19));
    for (let i = 0; i < 14; i++)
      db.d
        .prepare("INSERT OR IGNORE INTO metrics_ai_usage(day,model,source,workspace_id,user_id,feature,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(day(now - i * DAY), "shots", "instance", "", `shots-${i % 3}`, ["write", "summarize", "ask"][i % 3], 3 + (i % 4), 1200 + ((i * 937) % 2400), 300 + ((i * 211) % 700));
    const runs = Array.from({ length: 10 }, (_, i) => ({ at: now - (10 - i) * DAY, target: "local", name: `flowplan-${i}.sqlite`, bytes: 4_000_000 + i * 120_000, error: i === 6 ? "x" : null }));
    db.d.prepare("INSERT INTO instance_state(key,value) VALUES('scheduledBackupRuns',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(runs));
    db.setAi(true);
    // The server caches the facts a minute per statistics switch: off and on renews them.
    db.setMetrics(false);
    for (const [name, options] of [
      // Tall windows: the start page's main column scrolls on its own, an element shot would cut it.
      ["desktop-light", { viewport: { width: 1440, height: 2600 }, colorScheme: "light" }],
      ["desktop-dark", { viewport: { width: 1440, height: 2600 }, colorScheme: "dark" }],
      ["phone-light", { viewport: { width: 390, height: 3400 }, isMobile: true, hasTouch: true, colorScheme: "light" }],
      ["phone-dark", { viewport: { width: 390, height: 3400 }, isMobile: true, hasTouch: true, colorScheme: "dark" }],
    ] as const) {
      const context = await browser.newContext({ ...options, deviceScaleFactor: 2, locale: "de-DE" });
      const page = await context.newPage();
      await signIn(page, true);
      await open(page, "#settings/instance");
      await expect(page.locator(".sv-glance-panel").first()).toBeVisible({ timeout: 30_000 });
      if (name === "desktop-light") {
        db.setMetrics(true);
        await open(page, "#settings/instance");
        await expect(page.locator('.sv-glance-panel[data-panel="errors"]')).toBeVisible({ timeout: 30_000 });
      }
      await expect(page.locator('.sv-glance-panel[data-panel="ai"]')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(600);
      await page.locator(".sv-start-instance").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir!, `start-${name}.png`) });
      if (name === "phone-light") {
        await page.getByRole("button", { name: /^Alle \d+ Diagramme$/ }).tap();
        await expect(page.locator('.sv-glance-panel[data-panel="background"]')).toBeVisible();
        await page.screenshot({ path: join(dir!, `start-${name}-all.png`) });
        await page.getByRole("button", { name: "Weniger Diagramme" }).tap();
      }
      if (name === "desktop-light" || name === "desktop-dark")
        for (const id of await ids(page)) await page.locator(`.sv-glance-panel[data-panel="${id}"]`).screenshot({ path: join(dir!, `panel-${id}-${name.replace("desktop-", "")}.png`) });
      await context.close();
    }
  } finally {
    db.d.prepare("DELETE FROM ops_events WHERE at>=? AND kind IN ('login_success','login_failure')").run(now - 25 * HOUR);
    db.d.prepare("DELETE FROM users WHERE subject LIKE 'shots:%'").run();
    db.d.prepare("DELETE FROM metrics_ai_usage WHERE model='shots'").run();
    db.d.prepare("DELETE FROM instance_state WHERE key='scheduledBackupRuns'").run();
    db.restore();
  }
});
