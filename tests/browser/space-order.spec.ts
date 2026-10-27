import { test, expect, type Page, type Browser } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// The order of spaces (issue #48): workspace owners drag a space by its
// header or use "Nach oben"/"Nach unten" in its "…" menu; Settings →
// Bereiche shows the same order with arrows; other members get the new
// order without reloading; a space folds and unfolds, remembered per device.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const db = () => {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  return d;
};

// A workspace with four spaces (one a private space of the editor, which
// the owner never sees), a page in each and a signed-in owner and editor.
function seed() {
  const run = randomBytes(3).toString("hex");
  const d = db();
  const person = (name: string) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `order:${uid}`, name, `${uid}@example.test`, Date.now());
    d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
    return { uid, token };
  };
  const owner = person(`Owner ${run}`),
    editor = person(`Editor ${run}`);
  const wid = randomUUID();
  d.prepare("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)").run(wid, `Order ${run}`, owner.uid);
  d.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)").run(wid, owner.uid, "owner");
  d.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)").run(wid, editor.uid, "editor");
  const spaces: Record<string, string> = {};
  for (const [name, owned, visibility] of [
    ["Alpha", owner.uid, "team"],
    ["Hidden", editor.uid, "private"],
    ["Beta", owner.uid, "team"],
    ["Gamma", owner.uid, "team"],
  ] as const) {
    const sid = randomUUID();
    spaces[name] = sid;
    d.prepare("INSERT INTO spaces(id,workspace_id,name,owner_id,visibility) VALUES(?,?,?,?,?)").run(sid, wid, name, owned, visibility);
    const pid = randomUUID();
    d.prepare("INSERT INTO pages(id,workspace_id,space_id,title,created_by) VALUES(?,?,?,?,?)").run(pid, wid, sid, `${name} page`, owned);
    d.prepare("INSERT INTO documents(page_id,html) VALUES(?,?)").run(pid, "<p></p>");
  }
  d.close();
  return { run, wid, owner, editor, spaces };
}
async function signIn(page: Page, token: string) {
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}
const names = (page: Page) => page.locator(".sidebar .nav-section .space-name").allTextContents();
async function openNavigation(page: Page, mobile: boolean) {
  if (mobile && !(await page.locator(".app-shell").getAttribute("class"))?.includes("nav-open"))
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
}
const storedOrder = (wid: string) => {
  const d = db();
  const list = d.prepare("SELECT name FROM spaces WHERE workspace_id=? ORDER BY position,rowid").all(wid).map((r) => String(r.name));
  d.close();
  return list;
};

const hiddenPosition = (sid: string) => {
  const d = db();
  const position = Number(d.prepare("SELECT position FROM spaces WHERE id=?").get(sid)!.position);
  d.close();
  return position;
};

test("owners reorder spaces with the menu; the order holds in settings and for others", async ({ page, browser }, info) => {
  const mobile = info.project.name === "mobile";
  const f = seed();
  await signIn(page, f.owner.token);
  await page.goto("/#home");
  await openNavigation(page, mobile);
  const hiddenBefore = hiddenPosition(f.spaces.Hidden);
  // The owner does not see the editor's private space at all.
  await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma"]);

  // "…" → "Nach unten" on Alpha.
  await page.getByRole("button", { name: "Bereich Alpha verwalten", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Nach oben" })).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: "Nach unten" }).click();
  await expect.poll(() => names(page)).toEqual(["Beta", "Alpha", "Gamma"]);
  await expect(page.locator(".sidebar p[role='status']")).toHaveText("„Alpha“ steht jetzt an Position 2 von 3.");
  // The editor's private space kept its place (between Alpha and Beta before).
  await expect.poll(() => storedOrder(f.wid)).toEqual(["Beta", "Alpha", "Hidden", "Gamma"]);

  // Keyboard: the menu opens with Enter and "Nach oben" moves Gamma up.
  const gammaMenu = page.getByRole("button", { name: "Bereich Gamma verwalten", exact: true });
  await gammaMenu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Nach unten" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitem", { name: "Nach oben" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => names(page)).toEqual(["Beta", "Gamma", "Alpha"]);

  // Another member sees the new order without reloading (the app reloads
  // the workspace every few seconds); the editor also sees their private space.
  if (!mobile) {
    const other = await (browser as Browser).newContext({ baseURL: origin, locale: "de-DE", viewport: { width: 1440, height: 1000 } });
    const second = await other.newPage();
    await signIn(second, f.editor.token);
    await second.goto("/#home");
    await expect.poll(() => names(second)).toEqual(storedOrder(f.wid));
    expect(storedOrder(f.wid).filter((n) => n !== "Hidden")).toEqual(["Beta", "Gamma", "Alpha"]);
    // The editor has no move items.
    await second.getByRole("button", { name: "Bereich Hidden verwalten", exact: true }).click();
    await expect(second.getByRole("menuitem", { name: "Bereich bearbeiten …" })).toBeVisible();
    await expect(second.getByRole("menuitem", { name: "Nach oben" })).toHaveCount(0);
    await second.keyboard.press("Escape");
    await page.getByRole("button", { name: "Bereich Gamma verwalten", exact: true }).click();
    await page.getByRole("menuitem", { name: "Nach oben" }).click();
    await expect.poll(() => names(page)).toEqual(["Gamma", "Beta", "Alpha"]);
    await expect.poll(async () => (await names(second)).filter((n) => n !== "Hidden"), { timeout: 20_000 }).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(await names(second)).toEqual(storedOrder(f.wid));
    await other.close();
  } else {
    await page.getByRole("button", { name: "Bereich Gamma verwalten", exact: true }).click();
    await page.getByRole("menuitem", { name: "Nach oben" }).click();
    await expect.poll(() => names(page)).toEqual(["Gamma", "Beta", "Alpha"]);
  }

  // Settings → Bereiche: the same order, with arrows.
  await page.goto("/#settings/spaces");
  const items = page.locator(".ws-space-item strong");
  await expect.poll(() => items.allTextContents()).toEqual(storedOrder(f.wid));
  expect(storedOrder(f.wid).filter((n) => n !== "Hidden")).toEqual(["Gamma", "Beta", "Alpha"]);
  // Others' private spaces (managed by owners) cannot be moved from here.
  await expect(page.locator(".ws-space-item").filter({ hasText: "Hidden" }).getByRole("button", { name: /nach (oben|unten)/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Gamma nach oben", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Alpha nach oben", exact: true }).click();
  await expect.poll(async () => (await items.allTextContents()).filter((n) => n !== "Hidden")).toEqual(["Gamma", "Alpha", "Beta"]);
  expect(await items.allTextContents()).toEqual(storedOrder(f.wid));
  // The editor's private space never moved.
  expect(hiddenPosition(f.spaces.Hidden)).toBe(hiddenBefore);
  await expect(page.getByRole("button", { name: "Alpha nach unten", exact: true })).toBeEnabled();
});

test("owners drag a space by its header above or below another", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Dragging with the mouse; phones use the menu.");
  const f = seed();
  await signIn(page, f.owner.token);
  await page.goto("/#home");
  await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma"]);
  const header = (name: string) => page.locator(".sidebar .nav-section").filter({ has: page.locator(".space-name", { hasText: name }) }).locator(".nav-section-title");
  const section = (name: string) => page.locator(".sidebar .nav-section").filter({ has: page.locator(".space-name", { hasText: name }) });
  // Gamma onto the upper half of Alpha: before it. The drop line shows while dragging.
  const gamma = (await header("Gamma").boundingBox())!,
    alpha = (await section("Alpha").boundingBox())!;
  await page.mouse.move(gamma.x + 40, gamma.y + gamma.height / 2);
  await page.mouse.down();
  await page.mouse.move(alpha.x + 40, alpha.y + 6, { steps: 8 });
  await expect(section("Alpha")).toHaveClass(/space-drop-before/);
  await page.mouse.up();
  await expect.poll(() => names(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  await expect(page.locator(".space-drop-before, .space-drop-after")).toHaveCount(0);
  // Alpha onto the lower half of Beta: after it.
  const alphaHead = (await header("Alpha").boundingBox())!,
    beta = (await section("Beta").boundingBox())!;
  await page.mouse.move(alphaHead.x + 40, alphaHead.y + alphaHead.height / 2);
  await page.mouse.down();
  await page.mouse.move(beta.x + 40, beta.y + beta.height - 4, { steps: 8 });
  await expect(section("Beta")).toHaveClass(/space-drop-after/);
  await page.mouse.up();
  await expect.poll(() => names(page)).toEqual(["Gamma", "Beta", "Alpha"]);
  await expect.poll(async () => storedOrder(f.wid).filter((n) => n !== "Hidden")).toEqual(["Gamma", "Beta", "Alpha"]);
  // The order holds after a reload.
  await page.reload();
  await expect.poll(() => names(page)).toEqual(["Gamma", "Beta", "Alpha"]);
});

test("spaces fold and unfold, remembered per device; opening a page unfolds its space", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const f = seed();
  await signIn(page, f.owner.token);
  await page.goto("/#home");
  await openNavigation(page, mobile);
  const toggle = page.getByRole("button", { name: "Beta", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tree", { name: "Seiten in Beta" })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("tree", { name: "Seiten in Beta" })).toHaveCount(0);
  await page.reload();
  await openNavigation(page, mobile);
  await expect(page.getByRole("button", { name: "Beta", exact: true })).toHaveAttribute("aria-expanded", "false");
  // Opening a page of Beta (here by its address) unfolds Beta.
  const d = db();
  const pid = String(d.prepare("SELECT id FROM pages WHERE space_id=?").get(f.spaces.Beta)!.id);
  d.close();
  await page.goto(`/#page=${pid}`);
  await openNavigation(page, mobile);
  await expect(page.getByRole("button", { name: "Beta", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tree", { name: "Seiten in Beta" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("flowplan-collapsed-spaces"))).toBeNull();
});
