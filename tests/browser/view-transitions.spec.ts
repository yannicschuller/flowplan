import { test, expect, type Page } from "@playwright/test";

// View transitions of the shell (lib/view-transition.ts): opening a page
// cross-fades the main pane, the icon and title fly from the page tree, a
// board card grows into its record. Quick successive changes and taps
// never wait for an animation. document.startViewTransition is observed
// (not replaced) to see what was captured.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Seen = { kind?: string; main: string; old: string[]; fresh: string[] | null; done: boolean; skipped: boolean; start: number; end?: number };

async function setup(page: Page) {
  await page.addInitScript(() => {
    const seen: Seen[] = [];
    (window as unknown as { __vt: Seen[] }).__vt = seen;
    const original = Document.prototype.startViewTransition;
    if (!original) return;
    const named = () =>
      [...document.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.style?.viewTransitionName)
        .map((el) => `${el.style.viewTransitionName}:${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
    Document.prototype.startViewTransition = function (this: Document, arg?: unknown) {
      const main = document.querySelector(".split-primary > .main-scroll");
      const entry: Seen = {
        kind: document.documentElement.dataset.viewTransition,
        main: main ? getComputedStyle(main).viewTransitionName : "",
        old: named(),
        fresh: null,
        done: false,
        skipped: false,
        start: performance.now(),
      };
      seen.push(entry);
      const update = typeof arg === "function" ? arg : (arg as { update?: () => unknown })?.update;
      const wrapped = async () => {
        await update?.();
        entry.fresh = named();
      };
      const transition = original.call(this, typeof arg === "object" && arg ? { ...(arg as object), update: wrapped } : wrapped);
      transition.finished.finally(() => {
        entry.done = true;
        entry.end = performance.now();
      });
      const skip = transition.skipTransition.bind(transition);
      transition.skipTransition = () => {
        entry.skipped = true;
        skip();
      };
      return transition;
    } as typeof original;
  });
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
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __vt: Seen[] }).__vt);
const forget = (page: Page) => page.evaluate(() => ((window as unknown as { __vt: Seen[] }).__vt.length = 0));
const pageTitle = (page: Page) => page.locator(".split-primary input.page-title");

async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: /Willkommen bei Flowplan/ });
  if (await welcome.isVisible().catch(() => false)) await page.keyboard.press("Escape");
}
// The entry of a page in the tree (on phones in the navigation drawer).
async function treeEntry(page: Page, title: string, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  const entry = page.locator(".page-nav-title", { hasText: title }).first();
  await expect(entry).toBeVisible();
  return entry;
}
// Slows every view transition down, to act while one runs.
const slowDown = (page: Page) =>
  page.addStyleTag({
    content: "::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:4s!important}",
  });

test("opening a page from the tree: the pane cross-fades, icon and title fly to their place", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mobile = info.project.name === "mobile";
  const { newPage } = await setup(page);
  const stamp = Date.now();
  const first = await newPage(`Erste ${stamp}`),
    second = await newPage(`Zweite ${stamp}`);
  // Visited before: the second page opens from the kept copy, at once.
  await page.goto(`/#page=${second.id}`);
  await dismissWelcome(page);
  await expect(pageTitle(page)).toHaveValue(`Zweite ${stamp}`);
  await page.goto(`/#page=${first.id}`);
  await expect(pageTitle(page)).toHaveValue(`Erste ${stamp}`);
  // Past the window in which changes count as rapid.
  await page.waitForTimeout(500);
  await forget(page);

  await (await treeEntry(page, `Zweite ${stamp}`, mobile)).click();
  await expect(pageTitle(page)).toHaveValue(`Zweite ${stamp}`);
  await expect.poll(async () => (await seen(page)).length).toBe(1);
  const [transition] = await seen(page);
  expect(transition.kind).toBe("page");
  expect(transition.main).toBe("fp-main");
  // Old view: the tree entry's icon and title; new view: the page header's.
  expect(transition.old).toEqual(expect.arrayContaining([expect.stringMatching(/^fp-page-title:span\.page-nav-label/), expect.stringMatching(/^fp-page-icon:/)]));
  await expect.poll(async () => (await seen(page))[0].fresh).toEqual(
    expect.arrayContaining([expect.stringMatching(/^fp-page-title:input\.page-title/), expect.stringMatching(/^fp-page-icon:button\.large-page-icon/)]),
  );
  expect((await seen(page))[0].fresh!.some((name) => name.includes("page-nav-label"))).toBe(false);
  // Afterwards nothing stays named.
  await expect.poll(async () => (await seen(page))[0].done).toBe(true);
  expect(await page.evaluate(() => document.documentElement.dataset.viewTransition)).toBeUndefined();
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("*")].filter((el) => el.style?.viewTransitionName).length)).toBe(0);
  // Screens without a page take part too.
  await page.waitForTimeout(400);
  await forget(page);
  await page.evaluate(() => (location.hash = "inbox"));
  await expect.poll(async () => (await seen(page)).map((t) => t.kind)).toEqual(["page"]);
  expect(errors).toEqual([]);
});

test("quick successive changes and taps never wait for an animation", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { newPage } = await setup(page);
  const stamp = Date.now();
  const pages = await Promise.all(["Eins", "Zwei", "Drei"].map((name) => newPage(`${name} ${stamp}`)));
  await page.goto(`/#page=${pages[0].id}`);
  await dismissWelcome(page);
  await expect(pageTitle(page)).toHaveValue(`Eins ${stamp}`);
  await slowDown(page);
  // (The opening's own transition may still run.)
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.viewTransition)).toBeUndefined();
  await page.waitForTimeout(500);
  await forget(page);

  // A second page while the first one's transition runs: it comes at once,
  // without a transition, and ends the running one.
  await page.evaluate((id) => (location.hash = `page=${id}`), pages[1].id);
  await expect.poll(async () => (await seen(page)).length).toBe(1);
  await page.evaluate((id) => (location.hash = `page=${id}`), pages[2].id);
  await expect(pageTitle(page)).toHaveValue(`Drei ${stamp}`);
  await expect.poll(async () => (await seen(page))[0].done).toBe(true);
  const [first] = await seen(page);
  expect(first.skipped).toBe(true);
  expect(first.end! - first.start).toBeLessThan(2500);
  expect((await seen(page)).length).toBe(1);

  // A tap during a transition ends it at once; the page is usable.
  await page.waitForTimeout(500);
  await forget(page);
  await page.evaluate((id) => (location.hash = `page=${id}`), pages[0].id);
  await expect.poll(async () => (await seen(page)).length).toBe(1);
  if (mobile) await page.touchscreen.tap(195, 420);
  else await page.mouse.click(900, 600);
  await expect.poll(async () => (await seen(page))[0].done).toBe(true);
  const [ended] = await seen(page);
  expect(ended.skipped).toBe(true);
  // Far before the (slowed) animation would have ended.
  expect(ended.end! - ended.start).toBeLessThan(2500);
  await expect(pageTitle(page)).toHaveValue(`Eins ${stamp}`);
  await expect(pageTitle(page)).toBeEditable();

  // A button pressed while a transition runs does its job.
  await page.waitForTimeout(500);
  await forget(page);
  await page.evaluate((id) => (location.hash = `page=${id}`), pages[1].id);
  await expect.poll(async () => (await seen(page)).length).toBe(1);
  if (mobile) {
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).tap();
    await expect(page.locator(".app-shell.nav-open")).toBeVisible();
  } else {
    await page.locator(".sidebar-hide").click();
    await expect(page.locator(".app-shell.desktop-collapsed")).toBeVisible();
  }
  await expect(pageTitle(page)).toHaveValue(`Zwei ${stamp}`);
});

test("with reduced motion pages change without a transition", async ({ page }) => {
  const { newPage } = await setup(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stamp = Date.now();
  const [one, two] = await Promise.all([newPage(`Ruhig ${stamp}`), newPage(`Still ${stamp}`)]);
  await page.goto(`/#page=${one.id}`);
  await dismissWelcome(page);
  await expect(pageTitle(page)).toHaveValue(`Ruhig ${stamp}`);
  await page.waitForTimeout(500);
  await page.evaluate((id) => (location.hash = `page=${id}`), two.id);
  await expect(pageTitle(page)).toHaveValue(`Still ${stamp}`);
  expect(await seen(page)).toEqual([]);
});

test("a board card grows into its record and back", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mobile = info.project.name === "mobile";
  const { command, newPage } = await setup(page);
  const db = await newPage(`Board ${Date.now()}`, "database");
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "state", name: "Status", type: "select", options: ["Offen", "Fertig"] },
    ],
    views: [{ id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "state" }],
  });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Karte", state: "Offen" } });
  await page.goto(`/#page=${db.id}`);
  await dismissWelcome(page);
  const card = page.locator(".record-card", { hasText: "Karte" });
  await expect(card).toBeVisible();
  await page.waitForTimeout(500);
  await forget(page);
  await card.click();
  const dialog = page.getByRole("dialog", { name: "Eintrag" });
  await expect(dialog).toBeVisible();
  if (mobile) {
    // Phones keep their bottom sheet (its own rise, swiped to close).
    await expect(dialog).toHaveClass(/modal-sheet/);
    expect((await seen(page)).filter((t) => t.kind === "record")).toEqual([]);
    return;
  }
  await expect.poll(async () => (await seen(page)).map((t) => t.kind)).toEqual(["record"]);
  const [open] = await seen(page);
  expect(open.old).toEqual([expect.stringMatching(/^fp-record:button\.record-card/)]);
  await expect.poll(async () => (await seen(page))[0].fresh).toEqual([expect.stringMatching(/^fp-record:div\.modal/)]);
  await expect.poll(async () => (await seen(page))[0].done).toBe(true);
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await seen(page)).map((t) => t.kind)).toEqual(["record", "record"]);
  await expect.poll(async () => (await seen(page))[1].fresh).toEqual([expect.stringMatching(/^fp-record:button\.record-card/)]);
  // The keyboard is back on the card.
  await expect(card).toBeFocused();
  expect(errors).toEqual([]);
});
