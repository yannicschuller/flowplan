import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { keepInstanceAi } from "./instance-ai";

keepInstanceAi();

// Settings → Speicher & KI: a member whose storage comes from a directory
// group sees the tile with storage and AI on the landing page, opens the
// page with the explanation and the instance's "Mehr Speicher oder KI?",
// gets the notice at 80 % once (closed, it stays closed), and the old
// addresses (Deine Grenzen, KI-Kontingent) lead to the page. No AI request
// is made – the usage is written into the counts.
// USAGE_SHOTS=<dir>: screenshots of the landing page and the page, light and dark.
test("Speicher & KI: tile, page, notice at 80 % and the old addresses", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const phone = info.project.name === "mobile";
  const device = phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {};
  const stamp = Date.now();
  const group = `Plus ${stamp}`;
  const name = `Ida ${stamp}`;
  const uid = randomUUID();
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `usage:${uid}`, name, `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600000);
  // The directory pushed the group with Ida (lib/scim.ts); it gives 10 MB.
  const scimGroup = randomUUID();
  db.prepare("INSERT INTO scim_groups(id,display_name,version,created_at,updated_at) VALUES(?,?,1,?,?)").run(scimGroup, group, Date.now(), Date.now());
  db.prepare("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)").run(scimGroup, uid);
  db.prepare("INSERT INTO group_limits(target,limits,updated_at) VALUES(?,?,?)").run(`dir:${group}`, JSON.stringify({ storageMb: 10 }), Date.now());

  // The administrator: AI with a monthly quota and the link for more.
  const admin = await browser.newContext({ locale: "de-DE" });
  const command = async (page: Page, data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const adminPage = await admin.newPage();
  await adminPage.request.post(`${origin}/api/auth/demo`, { headers: { origin } });
  const before = (await (await adminPage.request.get(`${origin}/api/bootstrap`)).json()) as { user: { isAdmin?: boolean } };
  expect(before.user.isAdmin).toBe(true);
  const moreUrl = "https://billing.example.test/plans";
  const stored = db.prepare("SELECT value FROM instance_settings WHERE key='moreLimitsUrl'").get() as { value: string } | undefined;
  const previousMore = stored ? (JSON.parse(stored.value) as string) : "";
  await command(adminPage, { action: "admin.settings", settings: { moreLimitsUrl: moreUrl } });
  await command(adminPage, { action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "usage-model", embeddingModel: "" } } });
  await command(adminPage, { action: "admin.aiQuotas", settings: { unit: "tokens", timeZone: "UTC", weekStart: "monday", warnAt: 80, workflowsCountInstance: true }, rules: [{ scope: "default", limits: { month: 1000 } }] });

  const context = await browser.newContext({ ...device, locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const shots = process.env.USAGE_SHOTS;
  const shoot = async (label: string) => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, `${phone ? "phone" : "desktop"}-${scheme}-${label}.png`), fullPage: !phone });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  // A new address with only another hash: loaded afresh, as from a link.
  const go = async (hash: string) => {
    await page.goto(`${origin}/${hash}`);
    await page.reload();
  };
  try {
    // The first visit creates Ida's workspace; then 8.5 of 10 MB in it.
    await page.goto(`${origin}/#home`);
    await expect(page.locator(".sidebar, .workspace-switch").first()).toBeAttached({ timeout: 20_000 });
    await command(page, { action: "ai.settings", enabled: true });
    const ws = (db.prepare("SELECT workspace_id FROM members WHERE user_id=? AND role='owner'").get(uid) as { workspace_id: string }).workspace_id;
    const pageId = randomUUID();
    db.prepare("INSERT INTO pages(id,workspace_id,title) VALUES(?,?,'Dateien')").run(pageId, ws);
    db.prepare("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,'video.mp4','video/mp4',?,?)").run(randomUUID(), pageId, Math.round(8.5 * 1024 * 1024), uid);
    db.prepare("INSERT INTO ai_quota_usage(day,user_id,model,kind,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?,?,?)").run(new Date().toISOString().slice(0, 10), uid, "usage-model", "person", 2, 240, 100);

    // The landing page: the tile first in "Persönlich", with both figures.
    await go("#settings");
    const personal = page.locator(".settings-tile-group", { has: page.getByRole("heading", { name: "Persönlich" }) });
    const tile = personal.locator(".settings-tile").first();
    await expect(tile).toHaveAttribute("data-section", "usage", { timeout: 30_000 });
    await expect(tile).toContainText("Speicher & KI");
    await expect(tile).toContainText(group);
    await expect(tile).toContainText("8,5 von 10 MB");
    await expect(tile).toContainText("340 von 1.000 Tokens diesen Monat");
    await expect(tile.locator("progress")).toHaveCount(2);

    // The notice at 80 %: once, with both links.
    const notice = page.locator(".limits-notice[data-kind='storage']");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Dein Speicher ist fast voll (8,5 von 10 MB).");
    await expect(notice.getByRole("link", { name: "Mehr Speicher oder KI?" })).toHaveAttribute("href", moreUrl);
    await expect(page.locator(".limits-notice[data-kind='ai']")).toHaveCount(0);
    await shoot("settings");

    // The page: storage with where it comes from, the AI quota, the link.
    await tile.click();
    await expect(page.getByRole("heading", { name: "Speicher & KI", level: 1 })).toBeVisible({ timeout: 20_000 });
    const storage = page.locator("#storage");
    await expect(storage).toContainText("8,5 von 10 MB");
    await expect(storage).toContainText(`aus Gruppe ${group}`);
    await expect(storage.locator("#upload")).toContainText("10 MB");
    await expect(storage.locator("#workspaces")).toContainText("1 · unbegrenzt");
    const ai = page.locator("#ai");
    await expect(ai).toContainText("Diesen Monat");
    await expect(ai).toContainText("660 von 1.000 übrig");
    await expect(ai).toContainText("Danach ist KI aus");
    await expect(ai.locator("#models")).toContainText("usage-model");
    await expect(page.locator("#more").getByRole("link", { name: "Mehr Speicher oder KI?" })).toHaveAttribute("href", moreUrl);
    await shoot("usage");

    // Closed, the notice stays closed – after a reload too.
    await notice.getByRole("button", { name: "Hinweis schließen" }).click();
    await expect(notice).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Speicher & KI", level: 1 })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    await expect(page.locator(".limits-notice")).toHaveCount(0);

    // Konto & Sicherheit and KI only point here.
    await go("#settings/account");
    await expect(page.getByRole("heading", { name: "Konto & Sicherheit", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".setting-group", { hasText: "Deine Grenzen" })).toHaveCount(0);
    await page.locator(".usage-moved").getByRole("link", { name: "Speicher & KI" }).click();
    await expect(page.getByRole("heading", { name: "Speicher & KI", level: 1 })).toBeVisible();
    await go("#settings/ai");
    await expect(page.locator(".usage-moved")).toContainText("KI-Kontingent: 340 von 1.000 Tokens diesen Monat", { timeout: 20_000 });
    await expect(page.locator("section[aria-labelledby='quota-title']")).toHaveCount(0);

    // Old addresses lead to the page.
    await go("#settings/account/limits");
    await expect(page.getByRole("heading", { name: "Speicher & KI", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/usage/storage");
    await go("#settings/ai/quota");
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/usage/ai");
    await expect(page.getByRole("heading", { name: "Speicher & KI", level: 1 })).toBeVisible();

    // The search finds it by "Kontingent" and "upload".
    await go("#settings");
    const search = page.getByRole("searchbox", { name: "Einstellung suchen" });
    await search.fill("Kontingent");
    await expect(page.locator(".settings-results .settings-tile[data-section='usage']").first()).toBeVisible();
    await search.fill("upload");
    await expect(page.locator(".settings-results .settings-tile[data-section='usage']").first()).toBeVisible();

    // Below 80 % and up again: the notice comes back.
    db.prepare("UPDATE files SET size=? WHERE created_by=?").run(1024 * 1024, uid);
    await page.reload();
    await expect(page.locator(".settings-tile[data-section='usage']")).toContainText("1 von 10 MB", { timeout: 20_000 });
    await expect(page.locator(".limits-notice")).toHaveCount(0);
    db.prepare("UPDATE files SET size=? WHERE created_by=?").run(10 * 1024 * 1024, uid);
    await page.reload();
    await expect(page.locator(".limits-notice[data-kind='storage']")).toContainText("Dein Speicher ist voll (10 von 10 MB).", { timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally {
    await command(adminPage, { action: "admin.aiQuotas", rules: [] }).catch(() => {});
    await command(adminPage, { action: "admin.settings", settings: { moreLimitsUrl: previousMore } }).catch(() => {});
    db.prepare("DELETE FROM ai_quota_usage WHERE user_id=?").run(uid);
    db.prepare("DELETE FROM group_limits WHERE target=?").run(`dir:${group}`);
    db.prepare("DELETE FROM scim_groups WHERE id=?").run(scimGroup);
    await context.close();
    await admin.close();
    db.close();
  }
});
