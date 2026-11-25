import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Administration → Überwachung → Neustarts (components/settings/admin/
// monitoring-restarts.tsx): the restart history the server keeps in
// restart_events (lib/restarts/history.ts). The specs' server does not
// restart, so the rows are put into its database here: a crash with its
// error and log lines – one of them looks like HTML and must stay text –
// and a clean restart. Checked: the list with reason badges and memory,
// the lines loaded only when a row is opened, the .txt download, and that
// it fits a phone; 20 a page with "Weitere laden" and "Nur unerwartete".
// Screenshots light and dark.
function database() {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}
async function signInAdmin(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = database();
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `restarts-admin:${uid}`, "Restarts Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return origin;
}

const GB = 1024 ** 3;
const heartbeat = (over: Record<string, unknown>) =>
  JSON.stringify({ v: 1, key: "flowplan-1", run: "a1b2c3", instance: "flowplan-1", host: "flowplan-1", pid: 1, version: "0.9.9", rss: 0.6 * GB, heapUsed: 0.3 * GB, heapTotal: 0.4 * GB, heapLimit: 2 * GB, external: 0, memLimit: GB, memCurrent: 0.97 * GB, memWorkingSet: 0.95 * GB, oomKills: 0, ...over });
const HTML_LINE = '2026-11-18T13:59:58.000Z [err] <img src=x onerror="window.injected=1"> <b>not bold</b>';

test("the restart history: list, a crash's log lines as text, download, phone width", async ({ page }, testInfo) => {
  const origin = await signInAdmin(page);
  const now = Date.now();
  const crashId = randomUUID(),
    cleanId = randomUUID();
  const lines = [
    "2026-11-18T13:59:40.000Z [out] Flowplan 0.9.9 (abc1234) started",
    "2026-11-18T13:59:50.000Z [litestream] level=INFO msg=\"replica sync\" key=[redacted]",
    HTML_LINE,
    ...Array.from({ length: 60 }, (_, i) => `2026-11-18T13:59:59.${String(i).padStart(3, "0")}Z [err]     at frame${i} (lib/x.ts:${i}:1)`),
  ];
  const db = database();
  db.exec("DELETE FROM restart_events");
  const insert = db.prepare(
    "INSERT INTO restart_events(id,at,ended_at,instance,host,previous_start,uptime_ms,reason,signal,exit_code,version,heartbeat,error,line_count,log_lines,incident) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(crashId, now - 10 * 60_000, now - 10 * 60_000 - 3000, "flowplan-1", "flowplan-1", now - 5 * 3600_000, 5 * 3600_000 - 600_000, "crash", null, 1, "0.9.9", heartbeat({ startedAt: now - 5 * 3600_000, at: now - 600_000 }), "TypeError: Cannot read properties of undefined (reading 'id')\n    at handler (lib/api.ts:10:5)", lines.length, JSON.stringify(lines), `restart:${crashId}`);
  insert.run(cleanId, now - 26 * 3600_000, now - 26 * 3600_000, "flowplan-1", "flowplan-1", now - 50 * 3600_000, 24 * 3600_000, "clean", "SIGTERM", 143, "0.9.8", heartbeat({ memWorkingSet: 0.4 * GB, rss: 0.35 * GB }), null, 0, null, null);
  db.close();

  const restartRequests: string[] = [];
  page.on("request", (r) => {
    if (/view=restart/.test(r.url())) restartRequests.push(new URL(r.url()).search);
  });
  await page.goto(`${origin}/#settings/instance/monitoring`);
  // Its code loads only when the card comes into view.
  await page.locator("#restarts").first().scrollIntoViewIfNeeded();
  const card = page.getByTestId("restarts-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Neustarts" })).toBeVisible();
  const rows = card.getByTestId("restart-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Absturz");
  await expect(rows.nth(0)).toContainText("TypeError: Cannot read properties of undefined");
  await expect(rows.nth(0)).toContainText("Speicher zuletzt");
  await expect(rows.nth(0)).toContainText("(95 %)");
  await expect(rows.nth(1)).toContainText("Sauber beendet");
  await expect(rows.nth(1)).toContainText("SIGTERM");
  // The lines are loaded only when a row is opened.
  expect(restartRequests.every((q) => !q.includes("view=restart&"))).toBe(true);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `test-results/restarts/${testInfo.project.name}-list.png` });

  await rows.nth(0).locator("summary").click();
  const log = rows.nth(0).getByTestId("restart-log");
  await expect(log).toBeVisible();
  expect(restartRequests.some((q) => q.includes(`view=restart&id=${crashId}`))).toBe(true);
  await expect(rows.nth(0)).toContainText(`Letzte ${lines.length} Zeilen des Logs`);
  // Text, never HTML: the line shows as typed, nothing of it is rendered.
  await expect(log).toContainText('<img src=x onerror="window.injected=1"> <b>not bold</b>');
  await expect(log.locator("img, b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { injected?: number }).injected)).toBeUndefined();
  // A box of its own that scrolls.
  const box = await log.evaluate((el) => ({ scroll: el.scrollHeight > el.clientHeight, font: getComputedStyle(el).fontFamily, overflow: getComputedStyle(el).overflowY }));
  expect(box.scroll).toBe(true);
  expect(box.overflow).toBe("auto");
  expect(box.font).toMatch(/mono/i);

  const [download] = await Promise.all([page.waitForEvent("download"), rows.nth(0).getByRole("button", { name: "Als .txt herunterladen" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^flowplan-restart-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.txt$/);
  const text = readFileSync((await download.path())!, "utf8");
  expect(text).toContain("Grund: Absturz");
  expect(text).toContain("TypeError: Cannot read properties of undefined");
  expect(text).toContain(HTML_LINE);
  expect(text.trim().split("\n").at(-1)).toBe(lines.at(-1));

  // A clean one has no lines, only what it was.
  await rows.nth(1).locator("summary").click();
  await expect(rows.nth(1)).toContainText("Sauber beendet (SIGTERM): Update, Neustart oder docker stop.");
  await expect(rows.nth(1).getByTestId("restart-log")).toHaveCount(0);

  // Phone width: the card and the log stay within the page.
  const fits = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="restarts-card"]')!.getBoundingClientRect();
    const log = document.querySelector('[data-testid="restart-log"]')!.getBoundingClientRect();
    return { right: Math.max(card.right, log.right), width: document.documentElement.clientWidth };
  });
  expect(fits.right).toBeLessThanOrEqual(fits.width + 0.5);
  await rows.nth(0).screenshot({ path: `test-results/restarts/${testInfo.project.name}-crash-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await rows.nth(0).screenshot({ path: `test-results/restarts/${testInfo.project.name}-crash-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.emulateMedia({ colorScheme: "light" });

  const cleanup = database();
  cleanup.prepare("DELETE FROM restart_events WHERE id IN (?,?)").run(crashId, cleanId);
  cleanup.close();
});

test("no restarts yet: an empty state", async ({ page }) => {
  const origin = await signInAdmin(page);
  const db = database();
  db.exec("DELETE FROM restart_events");
  db.close();
  await page.goto(`${origin}/#settings/instance/monitoring`);
  await expect(page.locator(".mon-health").first()).toBeVisible();
  await page.locator("#restarts").first().scrollIntoViewIfNeeded();
  const card = page.getByTestId("restarts-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Keine Neustarts in den letzten 30 Tagen.");
  await expect(card.getByTestId("restart-row")).toHaveCount(0);
});

// Many restarts: newest first, 20 a page, "Weitere laden", the filter
// "Nur unerwartete" with its count, the count announced politely.
test("a long history: pages of 20, 'Weitere laden', 'Nur unerwartete'", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  const origin = await signInAdmin(page);
  const now = Date.now();
  const db = database();
  db.exec("DELETE FROM restart_events");
  const insert = db.prepare("INSERT INTO restart_events(id,at,ended_at,instance,host,previous_start,uptime_ms,reason,signal,exit_code,version,heartbeat,error,line_count,log_lines,incident) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // 45 restarts, one every 6 hours: every third unexpected (15).
  for (let i = 0; i < 45; i++) {
    const unexpected = i % 3 === 0;
    const reason = !unexpected ? "clean" : i % 2 ? "oom" : "crash";
    insert.run(`page-${i}`, now - i * 6 * 3600_000 - 60_000, now - i * 6 * 3600_000 - 61_000, "flowplan-1", "flowplan-1", now - (i + 1) * 6 * 3600_000, 6 * 3600_000 - 60_000, reason, unexpected ? null : "SIGTERM", unexpected ? 1 : 143, "0.11.6", heartbeat({ memWorkingSet: (unexpected ? 0.9 : 0.4) * GB }), unexpected ? `Error: run ${i} failed` : null, unexpected ? 1 : 0, unexpected ? JSON.stringify([`2026-11-18T13:59:59.000Z [err] run ${i}`]) : null, null);
  }
  db.close();
  await page.goto(`${origin}/#settings/instance/monitoring`);
  await page.locator("#restarts").first().scrollIntoViewIfNeeded();
  const card = page.getByTestId("restarts-card");
  const rows = card.getByTestId("restart-row");
  const count = card.getByTestId("restarts-count");
  await expect(rows).toHaveCount(20);
  await expect(count).toHaveText("20 von 45");
  await expect(count).toHaveAttribute("aria-live", "polite");
  await expect(card.getByTestId("restarts-all")).toHaveText("Alle 45");
  await expect(card.getByTestId("restarts-all")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("restarts-unexpected")).toHaveText("Nur unerwartete 15");
  await expect(rows.nth(0)).toContainText("Error: run 0 failed");
  const more = card.getByRole("button", { name: "Weitere laden" });
  await more.click();
  await expect(rows).toHaveCount(40);
  await expect(count).toHaveText("40 von 45");
  await more.click();
  await expect(rows).toHaveCount(45);
  await expect(count).toHaveText("45 von 45");
  await expect(more).toHaveCount(0);
  // Newest first across the pages.
  await expect(rows.nth(44)).toContainText("Sauber beendet");
  // The reload keeps what is shown.
  await card.getByRole("button", { name: "Neu laden" }).click();
  await expect(count).toHaveText("45 von 45");
  await expect(rows).toHaveCount(45);

  await card.getByTestId("restarts-unexpected").click();
  await expect(card.getByTestId("restarts-unexpected")).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText("15 von 15");
  await expect(rows).toHaveCount(15);
  for (const text of await rows.allTextContents()) expect(text).not.toContain("Sauber beendet");
  // The log of an unexpected one still opens.
  await rows.nth(1).locator("summary").click();
  await expect(rows.nth(1).getByTestId("restart-log")).toContainText("run 3");
  await rows.nth(1).locator("summary").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth) + 1);

  // Screenshots for review (SETTINGS_SHOTS=<folder>, desktop project only):
  // the first page, light and dark, and the phone, at twice the pixels.
  const dir = process.env.SETTINGS_SHOTS;
  if (dir && testInfo.project.name === "desktop")
    for (const [name, options] of [
      ["desktop-light", { viewport: { width: 1280, height: 2400 }, colorScheme: "light" }],
      ["desktop-dark", { viewport: { width: 1280, height: 2400 }, colorScheme: "dark" }],
      ["phone-light", { viewport: { width: 390, height: 3200 }, isMobile: true, hasTouch: true, colorScheme: "light" }],
    ] as const) {
      const context = await browser.newContext({ ...options, deviceScaleFactor: 2, locale: "de-DE" });
      const shot = await context.newPage();
      await signInAdmin(shot);
      await shot.goto(`${origin}/#settings/instance/monitoring`);
      // The placeholder is replaced by the card once its code has loaded.
      const c = shot.getByTestId("restarts-card");
      await expect(async () => {
        await shot.locator("#restarts").first().scrollIntoViewIfNeeded({ timeout: 2000 });
        await expect(c).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 30_000 });
      await expect(c.getByTestId("restarts-count")).toHaveText("20 von 45", { timeout: 30_000 });
      await c.getByTestId("restart-row").first().locator("summary").click();
      await expect(c.getByTestId("restart-log")).toBeVisible();
      await c.screenshot({ path: join(dir, `restarts-${name}.png`) });
      await context.close();
    }

  const cleanup = database();
  cleanup.exec("DELETE FROM restart_events WHERE id LIKE 'page-%'");
  cleanup.close();
});
