import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Rows that scroll sideways (tab strips, toolbars, chip rows) must not also
// scroll up and down: a box with overflow-x: auto gets overflow-y: auto too,
// and content a pixel taller than the box (underline, focus ring, padding)
// let iPhones drag the strip vertically and cut the labels in half (the
// section tabs of Administration → Benutzer). Generic: every element with
// a computed overflow-x of auto/scroll whose content is wider than the box,
// except the ones meant to scroll both ways (tables, code, canvases).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

type Finding = { strip: string; problem: string };

async function stripFindings(page: Page): Promise<{ checked: string[]; findings: Finding[] }> {
  return page.evaluate(() => {
    const name = (el: Element) => {
      const cls = [...el.classList].slice(0, 3).join(".");
      const role = el.getAttribute("role");
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${role ? `[role=${role}]` : ""}`;
    };
    // Meant to scroll both ways, or not a strip at all.
    const twoWay = (el: Element) =>
      el === document.scrollingElement ||
      el.matches("pre, textarea, .main-scroll, .sidebar-scroll, .board, .home-board, .calendar-scroll, .timeline-scroll, .notebook-scroll") ||
      !!el.querySelector("table, pre, canvas, .board, .calendar-grid");
    const checked: string[] = [];
    const findings: { strip: string; problem: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== "auto" && cs.overflowX !== "scroll") continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || cs.visibility === "hidden") continue;
      if (twoWay(el)) continue;
      const strip = name(el);
      checked.push(strip);
      const hidden = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (!hidden && el.scrollHeight > el.clientHeight + 1) findings.push({ strip, problem: `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}` });
      const before = el.scrollTop;
      el.scrollTop = 20;
      if (el.scrollTop !== 0) findings.push({ strip, problem: `scrollTop became ${el.scrollTop}` });
      el.scrollTop = before;
      // Items inside the padding box (scrolled sideways is fine, cut off at
      // the top or bottom is not).
      const top = rect.top + el.clientTop;
      const bottom = top + el.clientHeight;
      for (const item of el.querySelectorAll<HTMLElement>("a, button, [role=tab], [role=option], input, label, li")) {
        const r = item.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || getComputedStyle(item).visibility === "hidden") continue;
        if (r.top < top - 1 || r.bottom > bottom + 1) {
          findings.push({ strip, problem: `${name(item)} "${(item.textContent || item.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.top)}–${Math.round(r.bottom)} outside ${Math.round(top)}–${Math.round(bottom)}` });
          break;
        }
      }
    }
    return { checked, findings };
  });
}

async function expectNoVerticalScroll(page: Page, where: string, expected: string[] = []) {
  // Layout settles (fonts, the scroll-fade measuring).
  await page.waitForTimeout(400);
  const { checked, findings } = await stripFindings(page);
  for (const strip of expected) expect(checked, `${where}: ${strip} scrolls sideways`).toContainEqual(expect.stringContaining(strip));
  expect(findings, `${where}: ${checked.join(", ")}`).toEqual([]);
}

function adminSession() {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `strip-admin:${uid}`, "Strip Admin", `${uid}@example.test`, Date.now());
  d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  d.close();
  return token;
}

for (const scheme of ["light", "dark"] as const) {
  test(`sideways strips do not scroll vertically (${scheme})`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "The strips scroll on a phone.");
    test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.context().addCookies([{ name: "flowplan_session", value: adminSession(), url: origin, httpOnly: true, sameSite: "Lax" }]);
    const command = async (data: Record<string, unknown>) => {
      const response = await page.request.post("/api/command", { headers: { origin }, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    await command({ action: "profile.onboarded" });

    // Administration → Benutzer: the section tabs and the filter chips.
    await page.goto("/#admin/users");
    const rail = page.locator(".settings-detail[data-detail='users'] .settings-rail");
    await expect(rail.getByRole("link", { name: "Benutzer" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".admin-user-filters")).toBeVisible();
    await expectNoVerticalScroll(page, "admin/users", ["settings-rail"]);
    // The strip itself cannot move vertically; the labels stay whole.
    const box = (await rail.boundingBox())!;
    expect(await rail.evaluate((el) => getComputedStyle(el).overflowY)).toBe("hidden");
    await rail.evaluate((el) => el.scrollBy({ top: 30 }));
    expect(await rail.evaluate((el) => el.scrollTop)).toBe(0);
    const label = (await rail.getByRole("link", { name: "Benutzer" }).boundingBox())!;
    expect(label.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(label.y + label.height).toBeLessThanOrEqual(box.y + box.height + 1);
    await page.screenshot({ path: `test-results/strip-scroll/admin-users-${scheme}.png`, clip: { x: 0, y: Math.max(0, box.y - 40), width: 390, height: box.height + 120 } });
    // Still scrolls sideways to the last section.
    const last = rail.getByRole("link").last();
    await last.scrollIntoViewIfNeeded();
    expect(await rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await rail.evaluate((el) => el.scrollTop)).toBe(0);

    for (const hash of ["#admin", "#admin/signin", "#admin/workspaces", "#settings", "#settings/account", "#settings/appearance"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator(".settings-shell")).toBeVisible({ timeout: 30_000 });
      await expectNoVerticalScroll(page, hash);
    }

    // A database with several views: the view tabs. (The workspace exists
    // after the first visit.)
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Streifen ${Date.now()}`, kind: "database" });
    await page.goto(`/#page=${db.id}`);
    const tabs = page.locator(".database-tabs");
    await expect(tabs).toBeVisible({ timeout: 30_000 });
    await expectNoVerticalScroll(page, "database", ["database-tabs"]);

    // The editor with the formatting toolbar on a phone, and a tabs block
    // (#272) with more tabs than fit.
    const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Leiste ${Date.now()}`, kind: "document" });
    await page.goto(`/#page=${doc.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.type("/tabs");
    await page.getByRole("option", { name: /^Tabs/ }).first().click();
    const tablist = editor.getByRole("tablist", { name: "Tabs" });
    await expect(tablist.getByRole("tab")).toHaveCount(2);
    // A new tab opens with its name to type.
    for (let i = 3; i <= 7; i++) {
      await editor.getByRole("button", { name: "Tab hinzufügen" }).click();
      await editor.getByRole("textbox", { name: "Name des Tabs" }).fill(`Abschnitt ${i}`);
      await page.keyboard.press("Enter");
      await expect(tablist.getByRole("tab")).toHaveCount(i);
    }
    await editor.locator("p").last().click();
    await expect(tablist.getByRole("tab")).toHaveCount(7);
    await expect(page.getByRole("toolbar", { name: "Textformatierung" })).toBeVisible();
    await expectNoVerticalScroll(page, "editor", ["editor-toolbar", "tabs-list"]);
    expect(errors).toEqual([]);
  });
}
