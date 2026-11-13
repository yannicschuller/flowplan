import { test, expect, type Page } from "@playwright/test";

// The motion standard (#260, app/globals.css "Motion", lib/motion-pref.ts):
// menus and the text menu appear at their final place – opacity and a
// scale from 98 % at their anchor, never a translate – and "Animationen:
// Aus" (Settings → Appearance) lets nothing animate, like the system's
// "reduce motion"; "Reduziert" keeps short fades only.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Box = { x: number; y: number; width: number; height: number };
type Opened = { selector: string; first: Box; last: Box; properties: string[]; duration: number; names: string[] };

// Records, for every new element matching `selector`, its box at the first
// frame of its opening animation (currentTime 0) and at its end, and which
// properties the animation changes.
async function watchOpenings(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const w = window as unknown as { __opened: Opened[] };
    w.__opened = [];
    const seen = new WeakSet<Element>();
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const check = () => {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        requestAnimationFrame(() => {
          const animations = el.getAnimations().filter((a) => a instanceof CSSAnimation) as CSSAnimation[];
          const properties = new Set<string>();
          for (const a of animations)
            for (const frame of (a.effect as KeyframeEffect).getKeyframes())
              for (const key of Object.keys(frame)) if (!["offset", "computedOffset", "easing", "composite"].includes(key)) properties.add(key);
          for (const a of animations) {
            a.pause();
            a.currentTime = 0;
          }
          const first = box(el);
          for (const a of animations) a.finish();
          const last = box(el);
          const style = getComputedStyle(el);
          w.__opened.push({
            selector,
            first,
            last,
            properties: [...properties],
            duration: parseFloat(style.animationDuration) * (style.animationDuration.endsWith("ms") ? 1 : 1000),
            names: animations.map((a) => a.animationName),
          });
        });
      }
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  }, selector);
}
const openings = (page: Page) => page.evaluate(() => (window as unknown as { __opened: Opened[] }).__opened);

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const newPage = (title: string, kind = "document") =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind }) as Promise<{ id: string }>;
  return { command, newPage };
}
async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: /Willkommen bei Flowplan/ });
  if (await welcome.isVisible().catch(() => false)) await page.keyboard.press("Escape");
}
async function openWithText(page: Page, id: string) {
  await page.goto(`/#page=${id}`);
  await dismissWelcome(page);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Enter");
  await page.keyboard.type("Ein Satz mit einem Wort in der Mitte");
  return editor;
}
async function wordAt(page: Page, word: string) {
  return page.evaluate((word) => {
    const p = [...document.querySelectorAll(".split-primary .ProseMirror p")].find((p) => p.textContent?.includes(word))!;
    const text = p.firstChild!;
    const i = text.textContent!.indexOf(word);
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + word.length);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, word);
}
const reset = (page: Page) => page.request.post("/api/command", { headers: { origin }, data: { action: "profile.motion", motion: "normal" } });

test.afterEach(async ({ page }) => {
  await reset(page);
});

test("the text menu appears at its final place: it fades and scales, nothing travels", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "selecting with a mouse and right clicks");
  test.setTimeout(120_000);
  const { newPage } = await setup(page);
  await reset(page);
  const doc = await newPage(`Bewegung ${Date.now()}`);
  await openWithText(page, doc.id);
  await watchOpenings(page, ".text-menu");

  // Selecting a word: the menu above it, unfolding from its bottom centre.
  const at = await wordAt(page, "Wort");
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.locator(".text-menu.selection")).toBeVisible();
  await expect.poll(async () => (await openings(page)).length).toBe(1);
  const [selection] = await openings(page);
  expect(selection.names).toEqual(["menu-in"]);
  expect(selection.properties.sort()).toEqual(["opacity", "scale"]);
  expect(selection.duration).toBeGreaterThanOrEqual(100);
  expect(selection.duration).toBeLessThanOrEqual(120);
  // At the first frame it is where it ends: the same bottom centre, 98 %.
  const centre = (b: Box) => b.x + b.width / 2;
  expect(Math.abs(centre(selection.first) - centre(selection.last))).toBeLessThan(1.5);
  expect(Math.abs(selection.first.y + selection.first.height - (selection.last.y + selection.last.height))).toBeLessThan(1.5);
  expect(selection.first.width).toBeGreaterThan(selection.last.width * 0.97);

  // Right click: the menu at the pointer, unfolding from its top left.
  await page.keyboard.press("Escape");
  await expect(page.locator(".text-menu")).toHaveCount(0);
  const other = await wordAt(page, "Satz");
  await page.mouse.click(other.x, other.y, { button: "right" });
  await expect(page.locator(".text-menu.context")).toBeVisible();
  await expect.poll(async () => (await openings(page)).length).toBe(2);
  const context = (await openings(page))[1];
  expect(context.properties.sort()).toEqual(["opacity", "scale"]);
  expect(Math.abs(context.first.x - context.last.x)).toBeLessThan(1);
  expect(Math.abs(context.first.y - context.last.y)).toBeLessThan(1);
  expect(Math.abs(context.last.x - (other.x + 2))).toBeLessThan(12);
});

test("menus and dialogs share one timing; none of them slides", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "phones show dialogs as bottom sheets, which slide up from the edge");
  test.setTimeout(120_000);
  const { newPage } = await setup(page);
  await reset(page);
  const doc = await newPage(`Menüs ${Date.now()}`);
  await page.goto(`/#page=${doc.id}`);
  await dismissWelcome(page);
  await expect(page.locator(".split-primary textarea.page-title")).toBeVisible({ timeout: 30_000 });
  await watchOpenings(page, ".dropdown, .modal");
  await page.getByRole("button", { name: "Seitenaktionen" }).first().click();
  await expect(page.locator(".dropdown").first()).toBeVisible();
  await expect.poll(async () => (await openings(page)).length).toBeGreaterThanOrEqual(1);
  const [menu] = await openings(page);
  expect(menu.names).toEqual(["menu-in"]);
  expect(menu.properties.sort()).toEqual(["opacity", "scale"]);
  expect(menu.duration).toBe(100);
  await page.keyboard.press("Escape");
  // A dialog: opacity and scale, 150 ms, no spring.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".modal").first()).toBeVisible();
  await expect.poll(async () => (await openings(page)).some((o) => o.names.includes("modal-in"))).toBe(true);
  const dialog = (await openings(page)).find((o) => o.names.includes("modal-in"))!;
  expect(dialog.properties.sort()).toEqual(["opacity", "scale"]);
  expect(dialog.duration).toBe(150);
  expect(await page.locator(".modal").first().evaluate((el) => getComputedStyle(el).animationTimingFunction)).toBe("cubic-bezier(0.2, 0, 0, 1)");
});

test("“Animationen: Aus” lets nothing animate; “Reduziert” only fades", async ({ page }, info) => {
  test.setTimeout(120_000);
  const { command, newPage } = await setup(page);
  const [one, two] = await Promise.all([newPage(`Ruhe ${Date.now()}`), newPage(`Stille ${Date.now()}`)]);
  await command({ action: "profile.motion", motion: "off" });
  // The server renders the attribute, so the first paint has it.
  expect(await (await page.request.get("/")).text()).toContain('data-motion="off"');
  await page.addInitScript(() => {
    const w = window as unknown as { __vt: number };
    w.__vt = 0;
    const original = Document.prototype.startViewTransition;
    if (original)
      Document.prototype.startViewTransition = function (this: Document, ...args: Parameters<typeof original>) {
        w.__vt++;
        return original.apply(this, args);
      } as typeof original;
  });
  await page.goto(`/#page=${one.id}`);
  await dismissWelcome(page);
  await expect(page.locator(".split-primary textarea.page-title")).toHaveValue(/Ruhe/, { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await page.waitForTimeout(500);
  // Another page: no view transition.
  await page.evaluate((id) => (location.hash = `page=${id}`), two.id);
  await expect(page.locator(".split-primary textarea.page-title")).toHaveValue(/Stille/);
  expect(await page.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBe(0);
  // A menu opens and closes; its animation and transitions end at once.
  await page.getByRole("button", { name: "Seitenaktionen" }).first().click();
  const menu = page.locator(".dropdown").first();
  await expect(menu).toBeVisible();
  const style = await menu.evaluate((el) => {
    const s = getComputedStyle(el);
    return { animation: parseFloat(s.animationDuration), transition: parseFloat(s.transitionDuration) };
  });
  expect(style.animation).toBeLessThanOrEqual(0.00001);
  expect(style.transition).toBeLessThanOrEqual(0.00001);
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.getComputedTiming().duration as number) > 1).length)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // The side panel still opens (comments).
  if (info.project.name === "desktop") {
    await page.getByRole("button", { name: "Kommentare", exact: true }).click();
    await expect(page.locator(".comments-panel")).toBeVisible();
    expect(await page.locator(".comments-panel").evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThanOrEqual(0.00001);
  }

  // "Reduziert": short fades, no scale.
  await command({ action: "profile.motion", motion: "reduced" });
  await page.reload();
  await dismissWelcome(page);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page.getByRole("button", { name: "Seitenaktionen" }).first().click();
  await expect(menu).toBeVisible();
  const reduced = await menu.evaluate((el) => {
    const s = getComputedStyle(el);
    return { scale: s.getPropertyValue("--motion-scale").trim(), duration: s.animationDuration, name: s.animationName };
  });
  expect(reduced).toEqual({ scale: "1", duration: "0.07s", name: "menu-in" });
});

test("the setting is under Darstellung and applies at once", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await reset(page);
  await page.goto("/#settings/appearance");
  await dismissWelcome(page);
  const group = page.getByRole("radiogroup", { name: "Animationen" });
  await expect(group).toBeVisible({ timeout: 30_000 });
  await group.getByText("Aus", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).motion).toBe("off");
  await group.getByText("Normal", { exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-motion", /./);
  await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).motion).toBe("normal");
});
