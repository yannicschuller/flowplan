import { test, expect, type Page } from "@playwright/test";

// Tab nests into toggles (#246, as in Notion): Tab in a toggle's title
// moves the toggle into the one before it and keeps the caret in the title
// (never out of the document); Tab on a block after a toggle moves it in,
// so closing the toggle hides it; Shift+Tab takes it out again; one undo
// step each. Toggle content is indented by the Tab step, and hovering the
// arrow or the toggle's handle tints the whole toggle.
const RESULTS = process.env.TOGGLE_NESTING_SHOTS || "test-results";

async function fixture(page: Page, title: string, html: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await read()).generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
  return { host };
}
const focusedTitle = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el?.classList.contains("toggle-title") ? el.textContent : null;
  });

test("Tab nests toggles and blocks into toggles, Shift+Tab takes them out (#246)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard (a hardware keyboard on touch devices): desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Verschachteln ${Date.now()}`,
    "<details><summary>Eins</summary><div><p>Inhalt eins</p></div></details>" +
      "<details><summary>Zwei</summary><div><p>Inhalt zwei</p></div></details>" +
      "<p>Danach</p><p>Ende</p>",
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p", { hasText: "Danach" })).toBeVisible({ timeout: 20_000 });
  const top = editor.locator(":scope > details.toggle-block");
  await expect(top).toHaveCount(2);

  // Tab in the first title: nothing to nest into, the caret stays there.
  await top.first().locator(".toggle-title").click();
  await page.keyboard.press("Tab");
  expect(await focusedTitle(page)).toBe("Eins");
  await expect(top).toHaveCount(2);

  // Tab in the second title: into the first toggle, the caret still in it.
  await top.nth(1).locator(".toggle-title").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  await expect(top).toHaveCount(1);
  const inner = top.first().locator(":scope > div > details.toggle-block");
  await expect(inner.locator(".toggle-title")).toHaveText("Zwei");
  await expect.poll(() => focusedTitle(page)).toBe("Zwei");
  // Where the caret was: typing goes after the first letter.
  await page.keyboard.type("x");
  await expect(inner.locator(".toggle-title")).toHaveText("Zxwei");
  await page.keyboard.press("Backspace");
  await expect(inner.locator(".toggle-title")).toHaveText("Zwei");
  // Nested by one indent step: the inner toggle starts where a Tab indent does.
  const step = await top.first().evaluate((el) => parseFloat(getComputedStyle(el.querySelector(":scope > div")!).paddingInlineStart));
  expect(step).toBeCloseTo(15 * 1.75, 0);
  // The title lines up with the content.
  const [titleLeft, contentLeft] = await top.first().evaluate((el) => [
    el.querySelector(":scope > summary .toggle-title")!.getBoundingClientRect().left,
    el.querySelector(":scope > div > p")!.getBoundingClientRect().left,
  ]);
  expect(Math.abs(titleLeft - contentLeft)).toBeLessThan(2);

  // Shift+Tab: out again, right after the outer toggle.
  await page.keyboard.press("Shift+Tab");
  await expect(top).toHaveCount(2);
  await expect(top.nth(1).locator(".toggle-title")).toHaveText("Zwei");
  await expect.poll(() => focusedTitle(page)).toBe("Zwei");
  // In once more; one undo step takes it back out.
  await page.keyboard.press("Tab");
  await expect(top).toHaveCount(1);
  await expect.poll(() => focusedTitle(page)).toBe("Zwei");
  // (Esc first: in the title ⌘Z is the title's own text undo.)
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(top).toHaveCount(2);
  // And in again for the rest of the test.
  await top.nth(1).locator(".toggle-title").click();
  await page.keyboard.press("Tab");
  await expect(top).toHaveCount(1);
  await expect.poll(() => focusedTitle(page)).toBe("Zwei");

  // Tab on the paragraph after the toggle: into it as its last block.
  const danach = editor.locator("p", { hasText: "Danach" });
  await danach.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(editor.locator(":scope > p", { hasText: "Danach" })).toHaveCount(0);
  await expect(top.first().locator(":scope > div > p", { hasText: "Danach" })).toHaveCount(1);
  await expect(danach).not.toHaveAttribute("data-indent", /.+/);
  // The caret stayed at the end of its text.
  await page.keyboard.type("!");
  await expect(danach).toHaveText("Danach!");
  await page.screenshot({ path: `${RESULTS}/nested-toggles-light.png` });
  // Closing the toggle hides it – it is inside.
  await top.first().locator(":scope > summary .toggle-arrow").click();
  await expect(top.first()).not.toHaveAttribute("open", "");
  await expect(danach).toBeHidden();
  await expect(editor.locator(":scope > p", { hasText: "Ende" })).toBeVisible();
  // Tab on "Ende" into the closed toggle opens it (as in Notion).
  await editor.locator(":scope > p", { hasText: "Ende" }).click();
  await page.keyboard.press("Tab");
  await expect(top.first()).toHaveAttribute("open", "");
  await expect(top.first().locator(":scope > div > p", { hasText: "Ende" })).toBeVisible();
  // One undo step: back out.
  await page.waitForTimeout(600);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator(":scope > p", { hasText: "Ende" })).toHaveCount(1);
  await expect(danach).toBeVisible();

  // Shift+Tab on "Danach!": out to right after the toggle, visible when it closes.
  await danach.click();
  await page.keyboard.press("Shift+Tab");
  await expect(editor.locator(":scope > p", { hasText: "Danach!" })).toHaveCount(1);
  await top.first().locator(":scope > summary .toggle-arrow").click();
  await expect(top.first()).not.toHaveAttribute("open", "");
  await expect(editor.locator(":scope > p", { hasText: "Danach!" })).toBeVisible();
  // A paragraph with nothing to nest into keeps the visual indent.
  await editor.locator(":scope > p", { hasText: "Ende" }).click();
  await page.keyboard.press("Tab");
  await expect(editor.locator(":scope > p", { hasText: "Ende" })).toHaveAttribute("data-indent", "1");
  await page.keyboard.press("Shift+Tab");
  await expect(editor.locator(":scope > p", { hasText: "Ende" })).not.toHaveAttribute("data-indent", /.+/);
  expect(errors).toEqual([]);
});

test("hovering a toggle's arrow or its handle tints the whole toggle, light and dark (#246)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Hover: desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Umfang ${Date.now()}`,
    "<p>Davor</p><details><summary>Außen</summary><div><p>Erster Absatz</p>" +
      "<details><summary>Innen</summary><div><p>Tief drin</p></div></details><p>Letzter Absatz</p></div></details><p>Danach</p>",
  );
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/#page=${f.host.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor.locator(":scope > p", { hasText: "Danach" })).toBeVisible({ timeout: 20_000 });
    const outer = editor.locator(":scope > details.toggle-block");
    const background = () => outer.evaluate((el) => getComputedStyle(el).backgroundColor);
    const plain = await background();
    // The arrow.
    await outer.locator(":scope > summary .toggle-arrow").hover();
    await expect.poll(background).not.toBe(plain);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${RESULTS}/toggle-hover-arrow-${scheme}.png` });
    // Only the toggle whose arrow it is: the inner one is not tinted on its own.
    const innerBg = await outer.locator("details.toggle-block").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(innerBg).toBe(plain);
    // The block handle.
    await editor.locator(":scope > p", { hasText: "Davor" }).hover();
    await expect.poll(background).toBe(plain);
    await outer.locator(":scope > summary .toggle-title").hover();
    const handle = page.locator(".document-block-handle.hovered");
    await expect(handle).toBeVisible();
    await handle.hover();
    await expect(outer).toHaveClass(/toggle-scope/);
    await expect.poll(background).not.toBe(plain);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${RESULTS}/toggle-hover-handle-${scheme}.png` });
    await editor.locator(":scope > p", { hasText: "Danach" }).hover();
    await expect(outer).not.toHaveClass(/toggle-scope/);
  }
  expect(errors).toEqual([]);
});
