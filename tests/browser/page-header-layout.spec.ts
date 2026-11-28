import { test, expect, type Browser, type Page } from "@playwright/test";

// The head and the margins of a document page on touch screens.
// - #643: in the iPad app the title shrank to 16 px with the sidebar hidden –
//   the app's web view adds `textarea{font-size:max(16px,1em)!important}`
//   (flowplan-app, src/bridge-script.ts) and only some of the page's sizes
//   for the title had !important. The title has one size whether the
//   sidebar is shown or not, and a long title wraps instead of being cut off.
// - #645: on a phone the text has the same margin left and right; the
//   caret block's handle fits into the left one.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const LONG_TITLE = "APC Back-UPS ES 550G with LiFePO4 and Synology";
// What the iPhone/iPad app puts into every page (src/bridge-script.ts).
const APP_STYLE = "input:not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea{font-size:max(16px,1em)!important}";

async function asApp(page: Page) {
  await page.addInitScript((css) => {
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = { platform: "ios", version: "1.1.9", refresh() {}, haptic() {} };
    const style = document.createElement("style");
    style.textContent = css;
    const add = () => (document.head || document.documentElement).append(style);
    if (document.documentElement) add();
    else addEventListener("DOMContentLoaded", add);
  }, APP_STYLE);
}

async function openPage(page: Page, place: "above" | "inline", title = LONG_TITLE) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "profile.pageIcon", pageIcon: place });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  await command({ action: "page.update", pageId: created.id, patch: { icon: "🔋" } });
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: created.id,
    generation: (await (await page.request.get(`/api/pages/${created.id}`)).json()).generation,
    update: Buffer.from(
      htmlState("<h2>Global context and hardware</h2><p>I replaced the original lead-acid battery in an APC UPS with a LiFePO4 battery.</p><ul><li><p>UPS</p></li></ul><blockquote><p>Quote</p></blockquote>"),
    ).toString("base64"),
  });
  await page.goto(`/#page=${created.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).locator(":scope > p", { hasText: "replaced" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".split-primary .block-editor-surface.with-block-handles")).toBeVisible();
  return { id: created.id as string, command };
}

// The title's size, whether its text fits into the field, and the field
// within the page's column.
function titleState(page: Page) {
  return page.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>(".split-primary textarea.page-title")!;
    const column = document.querySelector(".split-primary .page-content")!.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    return {
      fontSize: parseFloat(getComputedStyle(field).fontSize),
      overflow: field.scrollWidth - field.clientWidth,
      lines: Math.round(box.height / parseFloat(getComputedStyle(field).lineHeight)),
      inside: box.right <= column.right + 0.5 && box.left >= column.left - 0.5,
    };
  });
}

async function ipad(browser: Browser, inApp: boolean) {
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
  });
  const page = await context.newPage();
  if (inApp) await asApp(page);
  return { context, page };
}

for (const inApp of [true, false])
  test(`iPad ${inApp ? "app" : "Safari"}: the title keeps its size with the sidebar shown or hidden and wraps (#643)`, async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "Opens an iPad of its own.");
    test.setTimeout(120_000);
    const { context, page } = await ipad(browser, inApp);
    const f = await openPage(page, "inline");
    const shell = page.locator(".app-shell");
    await expect(shell).not.toHaveClass(/desktop-collapsed/);
    const shown = await titleState(page);
    await page.keyboard.press("Control+Alt+B");
    await expect(shell).toHaveClass(/desktop-collapsed/);
    await expect.poll(async () => (await titleState(page)).lines).toBeGreaterThanOrEqual(1);
    const hidden = await titleState(page);
    expect(shown.fontSize).toBe(31);
    expect(hidden.fontSize).toBe(shown.fontSize);
    for (const state of [shown, hidden]) {
      // Not cut off: wrapped onto further lines within the column.
      expect(state.overflow).toBeLessThanOrEqual(0);
      expect(state.inside).toBe(true);
    }
    expect(shown.lines).toBeGreaterThanOrEqual(2);
    // The icon next to the title is one of its lines high.
    const icon = (await page.locator(".split-primary .document-header .large-page-icon").boundingBox())!;
    expect(icon.height).toBeGreaterThan(hidden.fontSize);
    expect(icon.height).toBeLessThan(hidden.fontSize * 1.5);
    await page.keyboard.press("Control+Alt+B");
    await f.command({ action: "page.delete", pageId: f.id });
    await f.command({ action: "profile.pageIcon", pageIcon: "above" });
    await context.close();
  });

test("desktop: a long title wraps within the column (#643)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The phone has its own test.");
  const f = await openPage(page, "above", `${LONG_TITLE} – ${"Notstromversorgung ".repeat(4)}`);
  const state = await titleState(page);
  expect(state.fontSize).toBe(38);
  expect(state.overflow).toBeLessThanOrEqual(0);
  expect(state.inside).toBe(true);
  expect(state.lines).toBeGreaterThanOrEqual(2);
  await f.command({ action: "page.delete", pageId: f.id });
});

for (const place of ["above", "inline"] as const)
  test(`phone (${place}): the same margin left and right, the handle in it (#645)`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Phones only.");
    test.setTimeout(120_000);
    await asApp(page);
    const f = await openPage(page, place);
    const title = await titleState(page);
    expect(title.fontSize).toBe(31);
    expect(title.overflow).toBeLessThanOrEqual(0);
    expect(title.inside).toBe(true);
    const insets = await page.evaluate(() => {
      const columnEl = document.querySelector(".split-primary .page-content")!;
      const column = columnEl.getBoundingClientRect();
      const inset = (selector: string) => {
        const r = document.querySelector(`.split-primary .page-content ${selector}`)!.getBoundingClientRect();
        return { left: Math.round(r.left - column.left), right: Math.round(column.right - r.right) };
      };
      return {
        width: column.width,
        overflow: document.documentElement.scrollWidth - innerWidth,
        text: inset(".ProseMirror > p"),
        heading: inset(".ProseMirror > h2"),
        header: inset(".document-header"),
        properties: inset(".page-properties"),
      };
    });
    expect(insets.width).toBe(390);
    expect(insets.overflow).toBeLessThanOrEqual(0);
    expect(Math.abs(insets.text.left - insets.text.right)).toBeLessThanOrEqual(3);
    expect(insets.text.left).toBeGreaterThanOrEqual(24);
    expect(insets.text.left).toBeLessThanOrEqual(30);
    // The head starts where the text starts.
    for (const part of [insets.heading, insets.header, insets.properties]) expect(part.left).toBe(insets.text.left);
    // The caret block's handle: on the screen, left of the text.
    await page.getByLabel("Dokumentinhalt", { exact: true }).locator(":scope > p", { hasText: "replaced" }).tap();
    const handle = page.locator(".split-primary .document-block-handle.active");
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(insets.text.left);
    await page.goto("/#home");
    await f.command({ action: "page.delete", pageId: f.id });
    await f.command({ action: "profile.pageIcon", pageIcon: "above" });
  });
