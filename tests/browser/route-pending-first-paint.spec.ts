import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// A reload (or a link) on another place than the start page – #page=…,
// #settings/…, #admin – never shows the start page the server rendered
// (the server never sees the address's fragment): a placeholder stands in
// until the app shows that place (lib/route-pending.ts). The start page
// itself keeps the server's first paint.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Seen = { home: string[]; placeholder: boolean; firstAttribute: string | null | undefined };

// Records, from the very first parsed element on, whether the start page
// was ever visible – at each change of the document and each frame – and
// whether the placeholder showed.
async function watchFirstPaint(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
    const seen = { home: [] as string[], placeholder: false, firstAttribute: undefined as string | null | undefined };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const visible = (el: Element | null) => !!el && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const check = (when: string) => {
      const home = document.querySelector(".home-screen");
      if (home && seen.firstAttribute === undefined) seen.firstAttribute = document.documentElement.getAttribute("data-route-pending");
      // The start page, or its name in the top bar.
      if (visible(home) || visible(document.querySelector(".home-grid")) || visible(document.querySelector(".breadcrumb-home"))) seen.home.push(when);
      if (visible(document.querySelector(".route-pending"))) seen.placeholder = true;
    };
    new MutationObserver(() => check("change")).observe(document, { childList: true, subtree: true, attributes: true });
    const frame = () => {
      check("frame");
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen }).__seen);

async function demo(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
}

async function signInAdmin(page: Page) {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `flash-admin:${uid}`, "Flash Admin", `${uid}@example.test`, Date.now());
  d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  d.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

// The place is shown, the wait has ended – and the start page never showed.
async function expectNoStartPage(page: Page, kind: string) {
  await expect(page.locator("html")).not.toHaveAttribute("data-route-pending");
  await expect(page.locator(".route-pending")).toHaveCount(0);
  await expect(page.locator(".home-screen")).toHaveCount(0);
  const result = await seen(page);
  expect(result.firstAttribute).toBe(kind);
  expect(result.home).toEqual([]);
}

test("a reload on a page, a settings section or the administration never shows the start page", async ({ page }) => {
  await demo(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Reload page ${Date.now()}`, kind: "document" },
    })
  ).json();
  await watchFirstPaint(page);

  await page.goto(`/#page=${created.id}`);
  await expect(page.locator(".ProseMirror").first()).toBeVisible({ timeout: 20_000 });
  await expectNoStartPage(page, "page");

  await page.goto("/#settings/appearance");
  await page.reload();
  await expect(page.getByRole("switch", { name: "Griffe immer anzeigen", exact: true })).toBeVisible({ timeout: 20_000 });
  await expectNoStartPage(page, "settings");

  // The same tab, a reload on the page again.
  await page.goto(`/#page=${created.id}`);
  await page.reload();
  await expect(page.locator(".ProseMirror").first()).toBeVisible({ timeout: 20_000 });
  await expectNoStartPage(page, "page");
});

test("a reload on the instance's settings never shows the start page", async ({ page }) => {
  await signInAdmin(page);
  await watchFirstPaint(page);
  await page.goto("/#settings/instance");
  await expect(page.locator(".sv-side a[data-area='admin'][data-section='push']")).toBeVisible({ timeout: 30_000 });
  await expectNoStartPage(page, "settings");
  await page.reload();
  await expect(page.locator(".sv-side a[data-area='admin'][data-section='push']")).toBeVisible({ timeout: 30_000 });
  await expectNoStartPage(page, "settings");
});

test("the start page keeps the server's first paint; a link that leads nowhere ends on it", async ({ page }) => {
  await demo(page);
  await watchFirstPaint(page);
  for (const address of ["/", "/#home"]) {
    await page.goto(address);
    // A fresh document (going from / to /#home only changes the fragment).
    await page.reload();
    await expect(page.locator(".home-grid")).toBeVisible();
    const result = await seen(page);
    // Unmarked, and visible as soon as the parser inserted it – before any
    // script of the app ran.
    expect(result.firstAttribute).toBeNull();
    expect(result.home[0]).toBe("change");
    expect(result.placeholder).toBe(false);
  }
  // An unknown page: the start page with the message, no placeholder left.
  await page.goto(`/#page=not-a-page`);
  await page.reload();
  await expect(page.locator(".home-grid")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-route-pending");
  await expect(page.locator(".route-pending")).toHaveCount(0);
});

test("without the app's scripts the start page shows after a few seconds instead of an empty pane", async ({ page }) => {
  await demo(page);
  // Every script of the app fails to load; the inline scripts in <head> run.
  await page.route(/\/_next\/static\/.*\.js(\?|$)/, (route) => route.abort());
  await page.goto("/#settings/appearance");
  await expect(page.locator("html")).toHaveAttribute("data-route-pending", "settings");
  await expect(page.locator(".route-pending-settings")).toBeVisible();
  await expect(page.locator(".home-screen")).toBeHidden();
  await expect(page.locator(".home-screen")).toBeVisible({ timeout: 12_000 });
  await expect(page.locator(".route-pending")).toBeHidden();
});
