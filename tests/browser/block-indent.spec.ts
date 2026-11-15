import { test, expect, type Page } from "@playwright/test";

// Indent and outdent without a keyboard (#302): "Einrücken" / "Ausrücken"
// in the block handle menu and as buttons of the formatting toolbar (hidden
// until added), for several chosen blocks at once in one undo step – what
// Tab / Shift+Tab do in the text.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: Page, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  // The default toolbar (another spec may have left a layout).
  await command({ action: "profile.toolbarLayout", toolbarLayout: null });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `Einrücken ${Date.now()}` });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  // The development badge of Next.js sits on the toolbar's first buttons
  // on phones.
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    };
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  await page.goto(`/#page=${host.id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 30_000 });
  return { editor, command };
}
const HTML = "<ul><li><p>Eins</p><ul><li><p>Zwei</p></li></ul></li><li><p>Drei</p></li><li><p>Vier</p></li></ul><p>Ende</p>";
// How deep a list item's text is: the number of list items around it.
const depth = (page: Page, text: string) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).evaluate((root, text) => {
    const p = [...root.querySelectorAll("li > p")].find((el) => el.textContent === text);
    let n = 0;
    for (let el = p?.parentElement; el && el !== root; el = el.parentElement) if (el.tagName === "LI") n++;
    return n;
  }, text);
async function openHandleMenu(page: Page, text: string, mobile: boolean) {
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const handle = page.getByRole("button", { name: new RegExp(`^Blockaktionen: .* · ${text}`) });
  if (mobile) {
    await editor.getByText(text, { exact: true }).tap();
    await handle.tap();
  } else {
    await editor.getByText(text, { exact: true }).hover();
    await handle.click();
  }
}
const tapOrClick = (mobile: boolean) => (locator: import("@playwright/test").Locator) => (mobile ? locator.tap() : locator.click());

test("the handle menu outdents and indents a nested list item (#302)", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const press = tapOrClick(mobile);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page, HTML);
  expect(await depth(page, "Zwei")).toBe(2);

  await openHandleMenu(page, "Zwei", mobile);
  const outdent = page.getByRole("menuitem", { name: "Ausrücken", exact: true });
  const indent = page.getByRole("menuitem", { name: "Einrücken", exact: true });
  await expect(outdent).toBeEnabled();
  if (!mobile) {
    await expect(indent.locator(".block-menu-shortcut")).toHaveText(/Tab/);
    await expect(outdent).toHaveAttribute("aria-keyshortcuts", "Shift+Tab");
  }
  await expect(indent).toBeDisabled();
  await press(outdent);
  await expect.poll(() => depth(page, "Zwei")).toBe(1);

  await openHandleMenu(page, "Zwei", mobile);
  await press(page.getByRole("menuitem", { name: "Einrücken", exact: true }));
  await expect.poll(() => depth(page, "Zwei")).toBe(2);

  // The first item cannot go deeper; a top-level item outdents out of its
  // list, as Shift+Tab does.
  await openHandleMenu(page, "Eins", mobile);
  await expect(page.getByRole("menuitem", { name: "Einrücken", exact: true })).toBeDisabled();
  await press(page.getByRole("menuitem", { name: "Ausrücken", exact: true }));
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p").first()).toHaveText("Eins");
  expect(errors).toEqual([]);
});

test("toolbar buttons once added: indent and outdent at the caret, disabled where nothing moves (#302)", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const press = tapOrClick(mobile);
  const L = await import("../../lib/toolbar-layout");
  // Not in the default toolbar.
  const { editor, command } = await setup(page, HTML);
  await press(editor.getByText("Zwei", { exact: true }));
  const bar = page.getByRole("toolbar", { name: "Textformatierung" });
  await expect(bar.getByRole("button", { name: "Rückgängig" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Einrücken" })).toHaveCount(0);

  // Added (as "Formatierungsleiste anpassen" saves it).
  await command({ action: "profile.toolbarLayout", toolbarLayout: { order: L.DEFAULT_TOOLBAR_ORDER, hidden: ["bulletList", "orderedList"] } });
  await page.reload();
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 30_000 });
  await press(editor.getByText("Zwei", { exact: true }));
  const indent = bar.getByRole("button", { name: "Einrücken", exact: true });
  const outdent = bar.getByRole("button", { name: "Ausrücken", exact: true });
  await expect(outdent).toBeEnabled();
  await expect(indent).toBeDisabled();
  await press(outdent);
  await expect.poll(() => depth(page, "Zwei")).toBe(1);
  await expect(indent).toBeEnabled();
  await press(indent);
  await expect.poll(() => depth(page, "Zwei")).toBe(2);

  // A paragraph takes a visual indent; nothing to outdent before.
  await press(editor.getByText("Ende", { exact: true }));
  await expect(outdent).toBeDisabled();
  await press(indent);
  await expect(editor.locator(':scope > p[data-indent="1"]')).toHaveText("Ende");
  await expect(outdent).toBeEnabled();
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.toolbarLayout", toolbarLayout: null } });
});

test("several chosen list items indent at once and come back with one undo (#302)", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { editor } = await setup(page, HTML);
  if (mobile) {
    // The touch selection mode: circles, its bar's ⋯ menu.
    await openHandleMenu(page, "Drei", true);
    await page.getByRole("menuitem", { name: "Mehrere auswählen", exact: true }).tap();
    await page.getByRole("checkbox", { name: /· Vier$/ }).tap();
    const bar = page.getByRole("toolbar", { name: "Ausgewählte Blöcke" });
    await expect(bar).toContainText("2 Blöcke");
    await bar.getByRole("button", { name: "Weitere Aktionen" }).tap();
    await page.getByRole("menuitem", { name: "Einrücken", exact: true }).tap();
    await expect(bar).toContainText("2 Blöcke");
    await bar.getByRole("button", { name: "Fertig" }).tap();
  } else {
    // Chosen with the keyboard, the menu of the chosen blocks.
    await editor.getByText("Drei", { exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator(".document-block-marked")).toHaveCount(2);
    await page.keyboard.press("/");
    await expect(page.getByRole("menu", { name: "2 Blöcke" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Einrücken", exact: true }).click();
    // Still chosen, where they went.
    await expect(page.locator(".document-block-marked")).toHaveCount(2);
  }
  await expect.poll(() => depth(page, "Drei")).toBe(2);
  expect(await depth(page, "Vier")).toBe(2);
  expect(await depth(page, "Zwei")).toBe(2);

  // One undo step brings both back.
  if (mobile) await editor.getByText("Ende", { exact: true }).tap();
  const undo = page.getByRole("toolbar", { name: "Textformatierung" }).getByRole("button", { name: "Rückgängig" });
  await (mobile ? undo.tap() : undo.click());
  await expect.poll(() => depth(page, "Drei")).toBe(1);
  expect(await depth(page, "Vier")).toBe(1);
  expect(await depth(page, "Zwei")).toBe(2);
});
