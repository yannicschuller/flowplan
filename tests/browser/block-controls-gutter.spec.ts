import { test, expect, type Locator, type Page } from "@playwright/test";

// "+" and ⠿ beside every editor with block handles, not only the page's
// (#278): in a record (centred, side panel, page of its own), in the split
// view and on a share page edited by a guest, both controls sit in the
// editor's gutter – inside every box that clips them (dialog, scroll area,
// the bordered editor box of the share page) – and take the click.
// BLOCK_GUTTER_SHOTS=<dir> keeps a screenshot of each place and theme there.
const SHOTS = process.env.BLOCK_GUTTER_SHOTS;
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
test.use({ locale: "en-US", extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = (title: string, kind: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind, title });
  return { command, create };
}

// Where the control is cut off or covered; [] when it is whole and on top.
function problems(control: Locator, box?: string) {
  return control.evaluate((el, boxSelector) => {
    const found: string[] = [];
    const r = el.getBoundingClientRect();
    const inside = (name: string, left: number, top: number, right: number, bottom: number) => {
      if (r.left < left - 0.5 || r.top < top - 0.5 || r.right > right + 0.5 || r.bottom > bottom + 0.5)
        found.push(`${name}: control ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)} outside ${Math.round(left)},${Math.round(top)}–${Math.round(right)},${Math.round(bottom)}`);
    };
    if (r.width < 20 || r.height < 20) found.push(`too small: ${r.width}×${r.height}`);
    inside("window", 0, 0, innerWidth, innerHeight);
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      const clips = s.overflowX !== "visible" || s.overflowY !== "visible" || /paint|strict|content/.test(s.contain) || s.clipPath !== "none";
      if (!clips) continue;
      const b = a.getBoundingClientRect();
      const left = b.left + a.clientLeft,
        top = b.top + a.clientTop;
      inside(`${a.tagName.toLowerCase()}.${[...a.classList].join(".")}`, left, top, left + a.clientWidth, top + a.clientHeight);
    }
    // The visible box around the editor (its border).
    if (boxSelector) {
      const frame = el.closest(boxSelector) || document.querySelector(boxSelector);
      if (!frame) found.push(`no ${boxSelector}`);
      else {
        const b = frame.getBoundingClientRect();
        inside(boxSelector, b.left + frame.clientLeft, b.top + frame.clientTop, b.right - frame.clientLeft, b.bottom - frame.clientTop);
      }
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) found.push(`covered by ${hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "nothing"}`);
    return found;
  }, box ?? null);
}

// Hovers the first block of the editor and checks "+" and ⠿.
async function check(page: Page, editor: Locator, place: string, theme: string, frame?: string) {
  const first = editor.locator(":scope > *").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400); // opening animations
  await editor.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 6);
  const surface = editor.locator("xpath=ancestor::*[contains(@class,'block-editor-surface')][1]");
  const plus = surface.locator(".document-block-add");
  const grip = surface.locator(".document-block-handle.hovered");
  await expect(plus).toBeVisible();
  await expect(grip).toHaveCount(1);
  await expect.poll(() => grip.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  await expect.poll(() => plus.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  if (SHOTS) {
    const clip = await editor.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.left - 120), y: Math.max(0, r.top - 120), width: Math.min(innerWidth, r.width + 240), height: 260 };
    });
    await page.screenshot({ path: `${SHOTS}/${place}-${theme}.png`, clip: { ...clip, width: Math.min(clip.width, 1440 - clip.x) } });
  }
  expect(await problems(plus, frame), `${place}: "+"`).toEqual([]);
  expect(await problems(grip, frame), `${place}: handle`).toEqual([]);
  // The text starts right of both.
  const text = await first.evaluate((el) => el.getBoundingClientRect().left);
  const g = (await grip.boundingBox())!,
    p = (await plus.boundingBox())!;
  expect(p.x + p.width).toBeLessThanOrEqual(g.x + 1);
  expect(text - (g.x + g.width)).toBeGreaterThanOrEqual(8);
  // "+" takes the click: the document changes (a block below, or "/" in an
  // empty block).
  const before = await editor.innerHTML();
  await plus.click();
  await expect.poll(() => editor.innerHTML()).not.toBe(before);
  await page.keyboard.press("Escape");
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme}`, () => {
    test.use({ colorScheme: theme });

    test(`records show "+" and the handle inside their box (${theme})`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "Mouse only: touch screens have no “+”.");
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const { command, create } = await setup(page);
      const db = await create(`Gutter ${theme} ${Date.now()}`, "database");
      const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Empty record" } });
      for (const mode of ["center", "side", "full"]) {
        const current = await (await page.request.get(`/api/pages/${db.id}`)).json();
        await command({
          action: "database.update",
          pageId: db.id,
          version: current.database.version,
          fields: [{ id: "title", name: "Name", type: "text" }],
          views: [{ id: "table", name: "Table", type: "table", filters: [], sorts: [], recordOpen: mode }],
        });
        await page.goto("about:blank");
        await page.goto(`/#page=${db.id}&row=${row.id}`);
        const editor = page.locator(".row-document .ProseMirror");
        await check(page, editor, `record-${mode}`, theme);
      }
      expect(errors).toEqual([]);
    });

    test(`the split view shows "+" and the handle in both panes (${theme})`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "Mouse only; no split view on narrow screens.");
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const { command, create } = await setup(page);
      const { htmlState } = await import("../../lib/document-server");
      const pages = [];
      for (const name of ["Left", "Right"]) {
        const p = await create(`${name} ${theme} ${Date.now()}`, "document");
        const read = await (await page.request.get(`/api/pages/${p.id}`)).json();
        await command({ action: "document.sync", pageId: p.id, generation: read.generation, update: Buffer.from(htmlState(`<p>${name} text</p><p>More</p>`)).toString("base64") });
        pages.push(p);
      }
      await page.goto(`/?split=${pages[1].id}#page=${pages[0].id}`);
      await expect(page.locator(".split-pane .ProseMirror")).toBeVisible({ timeout: 20_000 });
      await check(page, page.locator(".split-primary .ProseMirror").first(), "split-primary", theme);
      await check(page, page.locator(".split-pane .ProseMirror"), "split-pane", theme);
      expect(errors).toEqual([]);
    });

    test(`a guest editing a shared page or record sees "+" and the handle inside the editor box (${theme})`, async ({ page, browser }, info) => {
      test.skip(info.project.name !== "desktop", "Mouse only: touch screens have no “+”.");
      test.setTimeout(120_000);
      const errors: string[] = [];
      const { command, create } = await setup(page);
      const { htmlState } = await import("../../lib/document-server");
      const doc = await create(`Shared ${theme} ${Date.now()}`, "document");
      const read = await (await page.request.get(`/api/pages/${doc.id}`)).json();
      await command({ action: "document.sync", pageId: doc.id, generation: read.generation, update: Buffer.from(htmlState("<p>Shared text</p><p>More</p>")).toString("base64") });
      const docLink = await command({ action: "share.create", pageId: doc.id, role: "editor", name: "Guests" });
      const db = await create(`Shared records ${theme} ${Date.now()}`, "database");
      const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Guest record" } });
      const dbLink = await command({ action: "share.create", pageId: db.id, role: "editor", name: "Guests" });
      const visitor = await browser.newContext({ viewport: page.viewportSize()!, colorScheme: theme, locale: "en-US", extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });
      try {
        const guest = await visitor.newPage();
        guest.on("pageerror", (e) => errors.push(e.message));
        for (const [place, url] of [
          ["share-page", `${origin}/share/${docLink.token}`],
          ["share-record", `${origin}/share/${dbLink.token}/${db.id}?row=${row.id}`],
        ]) {
          await guest.goto(url);
          await guest.locator(".shared-interactions").getByRole("button", { name: /^(Edit content|Inhalt bearbeiten)$/ }).click();
          const editor = guest.locator(".shared-rich-editor .ProseMirror");
          await check(guest, editor, place, theme, ".shared-rich-editor");
        }
      } finally {
        await visitor.close();
      }
      expect(errors).toEqual([]);
    });
  });
}
