import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// Flashcards phase 5 (docs/specs/flashcards.md §10.3, §10.4): a deck studied
// without a connection – from the device's copy of the deck, the ratings
// waiting in IndexedDB ("2 Wertungen warten auf Verbindung") and sent once
// the connection is back – and the daily study reminder on #study.
// STUDY_SCREENSHOTS=<folder>: pictures of the new parts, light and dark.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.STUDY_SCREENSHOTS;

async function ownAccount(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `study:${uid}`, "Lena Lernt", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Lernen" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  return { boot, command, uid };
}
async function deck(command: (d: Record<string, unknown>) => Promise<any>, boot: any, page: Page, title: string) {
  const pageId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database", databaseKind: "empty" })).id as string;
  const db = (await (await page.request.get(`/api/pages/${pageId}`)).json()).database;
  await command({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Wort", type: "text" },
      { id: "answer", name: "Übersetzung", type: "text" },
    ],
    views: [
      { id: "study", name: "Lernen", type: "study", filters: [], sorts: [], default: true },
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  await command({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "answer" } } });
  for (const [word, answer] of [
    ["hola", "hallo"],
    ["perro", "Hund"],
    ["gato", "Katze"],
  ])
    await command({ action: "row.create", pageId, cells: { title: word, answer } });
  return pageId;
}
async function picture(page: Page, name: string, info: { project: { name: string } }) {
  if (!shots) return;
  const size = info.project.name === "mobile" ? "390" : "1440";
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `fc5-${name}-${size}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("a deck studied offline: ratings wait on the device and are sent when the connection is back", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await ownAccount(page);
  const pageId = await deck(command, boot, page, `Offline lernen ${info.project.name}`);
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByRole("button", { name: "Lernen starten" })).toBeEnabled();
  // The offline copy keeps the deck (what components/offline.ts stores for
  // decks studied in the last 14 days).
  await page.evaluate(async (id) => {
    const url = `/api/pages/${id}/study?offline=1`;
    const answer = await fetch(url, { cache: "no-store" });
    const cache = await caches.open("flowplan-data-v1");
    await cache.put(url, new Response(await answer.text(), { headers: { "content-type": "application/json" } }));
  }, pageId);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  await expect(focus.locator(".study-count-chip.new")).toHaveText("neu 3");
  for (let i = 0; i < 2; i++) {
    await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
    await expect(focus.getByRole("button", { name: /^Gut/ })).toBeVisible();
    await focus.getByRole("button", { name: /^Gut/ }).click();
  }
  await expect(focus.locator(".study-pending")).toHaveText("2 Wertungen warten auf Verbindung");
  await expect(focus.locator(".study-count-chip.new")).toHaveText("neu 1");
  await picture(page, "offline-focus", info);
  // Undo takes the waiting rating back on the device.
  await page.keyboard.press("z");
  await expect(focus.locator(".study-pending")).toHaveText("1 Wertung wartet auf Verbindung");
  await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
  await focus.getByRole("button", { name: /^Gut/ }).click();
  await expect(focus.locator(".study-pending")).toHaveText("2 Wertungen warten auf Verbindung");
  await focus.getByRole("button", { name: "Sitzung beenden" }).click();
  // The deck's overview counts them too, built on the device.
  await expect(page.locator(".study-overview .study-pending")).toHaveText("2 Wertungen warten auf Verbindung");
  await expect(page.locator(".study-count.new strong")).toHaveText("1");
  await picture(page, "offline-overview", info);

  // Back online: sent (study.reviews), the note goes, the server has them.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".study-overview .study-pending")).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}/study?limit=0`)).json()).done.new)
    .toBe(2);
  await expect(page.locator(".study-count.new strong")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("the daily study reminder is set on #study", async ({ page }, info) => {
  test.setTimeout(90_000);
  const { boot, command } = await ownAccount(page);
  await deck(command, boot, page, "Erinnerung");
  await page.goto("/#study");
  const section = page.locator(".study-reminder");
  const toggle = section.getByRole("switch", { name: "Täglich an fällige Karten erinnern" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await section.getByLabel("Uhrzeit der Lernerinnerung").fill("07:30");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await (await page.request.get(`/api/study/due?workspace=${boot.workspace.id}`)).json()).reminder)
    .toBe("07:30");
  await section.scrollIntoViewIfNeeded();
  await picture(page, "reminder", info);
  // A new time is saved when the field is left.
  await section.getByLabel("Uhrzeit der Lernerinnerung").fill("19:15");
  await section.getByLabel("Uhrzeit der Lernerinnerung").blur();
  await expect
    .poll(async () => (await (await page.request.get(`/api/study/due?workspace=${boot.workspace.id}`)).json()).reminder)
    .toBe("19:15");
  await page.reload();
  await expect(page.locator(".study-reminder").getByRole("switch", { name: "Täglich an fällige Karten erinnern" })).toHaveAttribute("aria-checked", "true");
  // The kind in the settings: push on, inbox off.
  await page.goto("/#settings/notifications");
  const kind = page.locator(".notif-kind", { hasText: "Lernerinnerungen" });
  await expect(kind.getByRole("switch", { name: "Lernerinnerungen als Push" })).toHaveAttribute("aria-checked", "true");
  await expect(kind.getByRole("switch", { name: "Lernerinnerungen im Posteingang" })).toHaveAttribute("aria-checked", "false");
  await expect(kind.getByRole("switch", { name: "Lernerinnerungen als Push" })).toBeEnabled();
});
