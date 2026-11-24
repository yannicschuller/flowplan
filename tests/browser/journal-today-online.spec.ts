import { test, expect, type Page } from "@playwright/test";

// Issue #456: a journal's "Heute" said "Du bist offline – schreib trotzdem …"
// while the connection worked. The journal page asks for today's page when
// it opens (journal.roll); any failure of that one request – a dropped
// connection while a self-hosted server restarts, a proxy hiccup, even a
// refusal – counted as "offline", and the notice stayed until the next
// "online" event, which never comes while the browser is online. Now only
// a failure while offline or one that did not reach the server shows the
// notice, and online the journal asks again by itself.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const offlineText = "Du bist offline";

async function freshJournal(page: Page, name: string, create?: "write") {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const journalId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${name} ${Date.now()}`, kind: "journal" })
  ).id as string;
  await command({ action: "journal.settings", pageId: journalId, template: "<h3>Vorlage</h3><p></p>" });
  if (create) await command({ action: "journal.settings", pageId: journalId, options: { create } });
  const days = async () =>
    ((await (await page.request.get("/api/bootstrap")).json()).pages as { id: string; parent_id: string; journal_date?: string; deleted_at?: string }[]).filter(
      (p) => p.parent_id === journalId && p.journal_date === localDay() && !p.deleted_at,
    );
  return { journalId, days };
}
// The journal page's own request for today's page (with `pageId`).
const isPageRoll = (body: string | null, journalId: string) =>
  !!body && body.includes('"journal.roll"') && body.includes(journalId);

test("online, a fresh journal's today is a draft without any offline notice; typing creates the day (#456)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { journalId, days } = await freshJournal(page, "Online-Journal", "write");
  await page.goto(`/#page=${journalId}`);
  const today = page.locator(".journal-today");
  await expect(today).toContainText("Noch nichts geschrieben");
  await expect(today).not.toContainText(offlineText);
  await expect(today).toBeEnabled();
  await today.click();
  await expect(page.locator(".journal-draft-hint")).toContainText("Noch nicht gespeichert");
  await expect(page.locator(".journal-draft-hint")).not.toContainText(offlineText);
  expect(await days()).toEqual([]);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator("h3", { hasText: "Vorlage" })).toBeVisible();
  await editor.locator("p").last().click();
  await page.keyboard.type("Online geschrieben.");
  await expect.poll(async () => (await days()).length, { timeout: 20_000 }).toBe(1);
  expect(errors).toEqual([]);
});

test("a failed request for today's page while online does not leave the offline notice; it asks again (#456)", async ({ page }) => {
  // "Beim ersten Schreiben": nothing else creates today's page meanwhile.
  const { journalId } = await freshJournal(page, "Wackel-Journal", "write");
  // The first request for today's page gets no answer (the server restarted,
  // a proxy dropped it) – the browser stays online.
  let dropped = 0;
  await page.route("**/api/command", async (route) => {
    if (!dropped && isPageRoll(route.request().postData(), journalId)) {
      dropped++;
      return route.abort("connectionreset");
    }
    return route.fallback();
  });
  await page.goto(`/#page=${journalId}`);
  const today = page.locator(".journal-today");
  // Asked again by itself: today's page is there, the notice is gone.
  await expect(today).toContainText("Noch nichts geschrieben", { timeout: 20_000 });
  await expect(today).not.toContainText(offlineText);
  expect(dropped).toBe(1);
});

test("a refused request for today's page is no offline notice (#456)", async ({ page }) => {
  const { journalId } = await freshJournal(page, "Abgelehnt-Journal", "write");
  await page.route("**/api/command", async (route) => {
    if (isPageRoll(route.request().postData(), journalId))
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Das Datum passt nicht zur Serverzeit." }) });
    return route.fallback();
  });
  await page.goto(`/#page=${journalId}`);
  await expect(page.locator(".toast-error, [role=alert]").filter({ hasText: "Das Datum passt nicht zur Serverzeit." }).first()).toBeVisible();
  await expect(page.locator(".journal-today")).not.toContainText(offlineText);
});

test("offline, today's entry still says so and can be written; back online it is a draft again (#456, #333)", async ({ page, context }) => {
  const { journalId } = await freshJournal(page, "Offline-Journal", "write");
  // The connection goes while the journal page asks for today's page.
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  let holding = true;
  await page.route("**/api/command", async (route) => {
    if (!holding || !isPageRoll(route.request().postData(), journalId)) return route.fallback();
    holding = false;
    await held;
    return route.abort("internetdisconnected");
  });
  await page.goto(`/#page=${journalId}`);
  const today = page.locator(".journal-today");
  await expect(today).toContainText("wird angelegt", { timeout: 30_000 });
  await context.setOffline(true);
  release();
  await expect(today).toContainText(offlineText);
  await expect(today).toBeEnabled();
  await today.click();
  await expect(page.locator(".journal-draft-hint")).toContainText(offlineText);
  // Back on the journal page while still offline: it cannot be loaded (a
  // journal is never kept on the device) …
  const journalFailed = page.waitForEvent("requestfailed", (r) => r.url().includes(`/api/pages/${journalId}`));
  await page.goBack();
  await journalFailed;
  // … and once online it loads by itself: today is the server's draft again.
  await context.setOffline(false);
  await expect(today).toContainText("Noch nichts geschrieben", { timeout: 20_000 });
  await expect(today).not.toContainText(offlineText);
});
