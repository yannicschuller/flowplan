import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Text sizes on a phone in the hand (#639): the type scale of app/globals.css
// (--text-xs … --text-lg) moves up there, so nothing to read in the
// navigation drawer, the inbox and the settings is below 14 px, and the
// drawer's rows are 16 px like the sheets' rows and the fields. Windows with
// a mouse keep the desktop sizes.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const MIN = 14;
// Text that may stay smaller, each with its reason.
const ALLOWED: { selector: string; reason: string }[] = [
  { selector: ".notification-count, .nav-badge, .nav-count, .inbox-count, .inbox-stack, .inbox-face-badge, .mobile-tab-badge, .comments-count", reason: "count badges" },
  { selector: ".avatar, .workspace-letter", reason: "initials in a fixed circle or tile" },
  { selector: ".sv-preview-window.small, .sv-preview-window.small *", reason: "a page preview as a thumbnail: the shapes, not the words" },
  { selector: "svg text", reason: "a chart's axis labels" },
  { selector: "kbd, .keycap", reason: "keyboard hints" },
];

type Small = { text: string; where: string; size: number };

// The visible text below the size inside the scope.
async function smallText(page: Page, scope: string): Promise<Small[]> {
  return page.evaluate(
    ({ scope, allowed, min }) => {
      const out: Small[] = [];
      const name = (el: Element) => `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`;
      const shown = (el: Element) => {
        for (let p: Element | null = el; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05 || p.hasAttribute("hidden")) return false;
        }
        const r = el.getBoundingClientRect();
        // Not the clipped 1 px texts for screen readers.
        return r.width > 2 && r.height > 2;
      };
      for (const root of document.querySelectorAll(scope)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim();
          const el = node.parentElement;
          if (!text || !el || allowed.some((a) => el.matches(a)) || !shown(el)) continue;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (size < min) out.push({ text: text.slice(0, 30), where: `${name(el.parentElement!)} > ${name(el)}`, size });
        }
      }
      return out;
    },
    { scope, allowed: ALLOWED.map((a) => a.selector), min: MIN },
  );
}

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = (await (await page.request.get("/api/bootstrap")).json()) as { user: { id: string } };
  // The inbox with a comment, a warning and an older reminder.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"), "flowplan.sqlite"));
  const insert = db.prepare(
    "INSERT INTO notifications(id,user_id,body,kind,link,created_at,actor_id,subtype,severity,params,excerpt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
  insert.run(randomUUID(), boot.user.id, "Jonas kommentiert „Plan“", "comment", null, at(3), null, "comment", null, JSON.stringify({ actor: "Jonas Weber", page: "Plan" }), "Bitte bis Freitag prüfen");
  insert.run(randomUUID(), boot.user.id, "Sicherheitsvorfall: Abtasten von Adressen und IDs.", "incident", null, at(9), null, "incident", "warn", JSON.stringify({ rule: "probing", detail: "60 × 404" }), null);
  insert.run(randomUUID(), boot.user.id, "Erinnerung: Angebot schreiben", null, null, at(26 * 60), null, null, null, null, null);
  db.close();
}

const report = (screen: string, small: Small[]) => small.map((s) => `${screen}: ${s.size}px "${s.text}" (${s.where})`);
const fontSize = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize);

test("on a phone nothing to read is below 14 px and the drawer's rows are 16 px", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone's type scale.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(120_000);
  await setup(page);
  const found: string[] = [];

  await page.goto("/#home");
  await expect(page.locator(".home-grid")).toBeVisible();
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();
  await page.waitForTimeout(300);
  found.push(...report("sidebar", await smallText(page, ".sidebar")));
  // The primary rows as large as the sheets' rows; the workspace's name
  // above its subtitle, both readable.
  for (const selector of [".sidebar .main-nav > button", ".sidebar .add-space", ".sidebar .page-nav-title"]) expect(await fontSize(page, selector), selector).toBe("16px");
  expect(await fontSize(page, ".sidebar .workspace-switch > span:nth-child(2)")).toBe("15px");
  expect(await fontSize(page, ".sidebar .workspace-switch small")).toBe("14px");
  expect(await fontSize(page, ".sidebar .nav-section-title")).toBe("14px");

  await page.goto("/#inbox");
  await expect(page.locator(".inbox .notification-item").first()).toBeVisible();
  found.push(...report("inbox", await smallText(page, ".inbox")));
  // The line, its detail and the time keep their order.
  expect(await fontSize(page, ".inbox .inbox-line")).toBe("15px");
  expect(await fontSize(page, ".inbox .inbox-detail")).toBe("14px");

  await page.goto("/#settings");
  await expect(page.locator(".sv-start-setup a").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  found.push(...report("settings", await smallText(page, "main")));

  await page.goto("/#settings/account");
  await expect(page.locator(".settings-detail .setting-group").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  found.push(...report("settings section", await smallText(page, "main")));

  expect(found, found.join("\n")).toEqual([]);
});

test("windows with a mouse keep the desktop sizes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "A window with a mouse.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto("/#home");
  await expect(page.locator(".sidebar .main-nav > button").first()).toBeVisible();
  expect(await fontSize(page, ".sidebar .main-nav > button")).toBe("13px");
  expect(await fontSize(page, ".sidebar .workspace-switch > span:nth-child(2)")).toBe("13px");
  expect(await fontSize(page, ".sidebar .workspace-switch small")).toBe("11px");
  expect(await fontSize(page, ".sidebar .nav-section-title")).toBe("11px");

  await page.goto("/#settings/account");
  await expect(page.locator(".settings-detail .setting-group").first()).toBeVisible({ timeout: 30_000 });
  expect(await fontSize(page, ".setting-text > small")).toBe("12.5px");
  expect(await fontSize(page, ".setting-group > header p")).toBe("13px");

  // A narrow window with a mouse is not a phone in the hand either.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#home");
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();
  expect(await fontSize(page, ".sidebar .workspace-switch small")).toBe("11px");
});
