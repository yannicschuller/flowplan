import { test, expect, type Page } from "@playwright/test";

// Toggle blocks open and close in edit mode (#137): the arrow (mouse, touch,
// Enter on it) and ⌘⌥↵ / Ctrl+Alt+Enter; the content stays, the title is
// edited in place, and what is stored is unchanged by opening or closing.
async function fixture(page: Page, title: string) {
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
    update: Buffer.from(
      htmlState("<p>Intro</p><details><summary>Mehr</summary><div><p>Geheim</p><p>Zweite Zeile</p></div></details><p>Ende</p>"),
    ).toString("base64"),
  });
  return { host, command, read };
}

test("toggles collapse and expand in edit mode, keep their content and their title stays editable", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Toggle ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const details = editor.locator("details");
  const isOpen = () => details.evaluate((d) => (d as HTMLDetailsElement).open);
  const arrow = details.locator(".toggle-arrow");
  await expect(editor.getByText("Geheim", { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await isOpen()).toBe(true);
  await expect(arrow).toHaveAttribute("aria-expanded", "true");

  // The arrow closes and opens again (a tap on phones).
  if (info.project.name === "mobile") await arrow.tap();
  else await arrow.click();
  await expect.poll(isOpen).toBe(false);
  await expect(arrow).toHaveAttribute("aria-expanded", "false");
  await expect(editor.getByText("Geheim", { exact: true })).toBeHidden();
  // A moment later it is still closed (nothing draws it open again).
  await page.waitForTimeout(400);
  expect(await isOpen()).toBe(false);
  if (info.project.name === "mobile") await arrow.tap();
  else await arrow.click();
  await expect.poll(isOpen).toBe(true);
  await expect(editor.getByText("Geheim", { exact: true })).toBeVisible();

  // The title is edited in place: a click places the caret, typing works,
  // the toggle stays as it is.
  const title = details.locator(".toggle-title");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Infos");
  await expect(title).toHaveText("Mehr Infos");
  expect(await isOpen()).toBe(true);
  await expect.poll(async () => (await f.read()).html as string, { timeout: 15_000 }).toContain("<summary>Mehr Infos</summary>");

  if (info.project.name === "desktop") {
    // Keyboard: ⌘⌥↵ inside closes, the caret goes to the title; the same
    // keys there open it; ↵ in the title goes into the content.
    await editor.getByText("Zweite Zeile", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Alt+Enter");
    await expect.poll(isOpen).toBe(false);
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("toggle-title"))).toBe(true);
    await page.keyboard.press("ControlOrMeta+Alt+Enter");
    await expect.poll(isOpen).toBe(true);
    await page.keyboard.press("ControlOrMeta+Alt+Enter");
    await expect.poll(isOpen).toBe(false);
    await page.keyboard.press("Enter");
    await expect.poll(isOpen).toBe(true);
    await page.keyboard.type("Neu: ");
    await expect(details.locator("p").first()).toHaveText("Neu: Geheim");
    // ↑ at the very start of the content goes to the title.
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("toggle-title"))).toBe(true);
    // Enter on the focused arrow.
    await arrow.focus();
    await page.keyboard.press("Enter");
    await expect.poll(isOpen).toBe(false);
    await page.keyboard.press("Enter");
    await expect.poll(isOpen).toBe(true);
    // Closing while the caret is inside moves it out: typing never lands
    // in hidden content.
    await editor.getByText("Zweite Zeile", { exact: true }).click();
    await arrow.click();
    await expect.poll(isOpen).toBe(false);
    await page.keyboard.type("X");
    await expect(details.locator("p").nth(1)).toHaveText("Zweite Zeile");
    await expect(editor.locator(":scope > p", { hasText: "Intro" })).toHaveText("IntroX");
  }

  // Closed or open is not stored: the stored HTML stays a plain open toggle
  // with all its content.
  await expect
    .poll(async () => (await f.read()).html as string, { timeout: 15_000 })
    .toMatch(/<details[^>]* open="true"[^>]*><summary>Mehr Infos<\/summary><div><p[^>]*>(Neu: )?Geheim<\/p><p[^>]*>Zweite Zeile<\/p><\/div><\/details>/);
  // Reading mode: the whole title line opens and closes, nothing is edited.
  if (info.project.name === "desktop") {
    await page.getByRole("button", { name: "Lesemodus", exact: true }).click();
    await expect(editor).toHaveAttribute("contenteditable", "false");
    if (!(await isOpen())) await title.click();
    await expect.poll(isOpen).toBe(true);
    await title.click();
    await expect.poll(isOpen).toBe(false);
    await title.click();
    await expect.poll(isOpen).toBe(true);
    await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  }
  expect(errors).toEqual([]);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
