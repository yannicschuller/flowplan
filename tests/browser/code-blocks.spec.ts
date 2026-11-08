import { test, expect, type Locator, type Page } from "@playwright/test";
// The language picker (components/code-language-picker.tsx): a button with
// the full name, a search in a list below it.
const languageButton = (scope: Locator) => scope.getByRole("button", { name: /^Code-Sprache: / });
async function pickLanguage(scope: Locator, query: string) {
  await languageButton(scope).click();
  const search = scope.page().getByRole("combobox", { name: "Sprache suchen", exact: true });
  await search.fill(query);
  await search.press("Enter");
}
async function fixture(page: Page, title: string, kind = "document") {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  // A new account would see the introduction first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    kind,
    title,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${host.id}`)).json();
  return { host, read, command, origin };
}
test("code blocks select languages, preserve literal input, indent, wrap and copy on desktop and mobile", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Code editor ${info.project.name} ${Date.now()}`,
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: f.origin,
  });
  await page.goto(`/#page=${f.host.id}`);
  await page
    .getByRole("button", { name: "Block hinzufügen", exact: true })
    .click();
  await page.locator(".slash-menu").getByRole("option", { name: /^Code / }).first().click();
  const block = page.locator(".code-block-view"),
    code = block.locator("pre code");
  await expect(block).toBeVisible();
  const source =
    'const message = "<script>alert(1)</script>";\nconsole.log(message);';
  await code.click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), source);
  await page.keyboard.press("ControlOrMeta+V");
  await expect(code).toHaveText(source);
  // Pasted code in a plain block: a suggestion, applied only on a click.
  const suggestion = block.getByRole("button", { name: "Sieht aus wie JavaScript – übernehmen?", exact: true });
  await expect(suggestion).toBeVisible();
  await expect(languageButton(block)).toHaveAccessibleName("Code-Sprache: Klartext");
  await suggestion.click();
  await expect(suggestion).toHaveCount(0);
  await expect(code.locator(".tok-keyword").first()).toHaveText("const");
  await code.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" // /path @user");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("return 42;");
  await expect(code).toContainText("  return 42;");
  await block
    .getByRole("button", { name: "Zeilenumbruch", exact: true })
    .click();
  await expect(block.locator("pre")).toHaveAttribute("data-code-wrap", "true");
  await expect(code).toHaveCSS("white-space", "pre-wrap");
  const text = await code.textContent();
  await block.getByRole("button", { name: "Kopieren", exact: true }).click();
  await expect(block.getByRole("status")).toHaveText("Code kopiert");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await expect
    .poll(async () => (await f.read()).html)
    .toContain("language-javascript");
  await expect.poll(async () => (await f.read()).html).toContain("/path @user");
  expect((await f.read()).html).not.toContain("tok-");
  expect((await f.read()).html).not.toContain("<script>");
  await page.reload();
  await expect(code).toHaveText(text!);
  await expect(languageButton(block)).toHaveAccessibleName("Code-Sprache: JavaScript");
  await expect(block.locator("pre")).toHaveAttribute("data-code-wrap", "true");
  await pickLanguage(block, "plaintext");
  await expect(code.locator('[class*="tok-"]')).toHaveCount(0);
  await pickLanguage(block, "typescript");
  await expect(code.locator(".tok-keyword").first()).toBeVisible();
  await page.screenshot({
    path: `test-results/${info.project.name}-code-editor.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({
    path: `test-results/${info.project.name}-code-dark.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
  await f.command({
    action: "page.update",
    pageId: f.host.id,
    patch: { locked: true },
  });
  await page.reload();
  await expect(languageButton(block)).toBeDisabled();
  await expect(
    block.getByRole("button", { name: "Zeilenumbruch", exact: true }),
  ).toBeDisabled();
  await expect(
    block.getByRole("button", { name: "Kopieren", exact: true }),
  ).toBeEnabled();
  await expect(code).toHaveText(text!);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
test("record code appears highlighted in feeds and public pages and remains editable through guest links", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(
    page,
    `Code records ${info.project.name} ${Date.now()}`,
    "database",
  );
  const d = await f.read();
  await f.command({
    action: "database.update",
    pageId: f.host.id,
    version: d.database.version,
    fields: d.database.fields,
    views: [{ id: "feed", name: "Feed", type: "feed", filters: [], sorts: [] }],
  });
  const row = await f.command({
    action: "row.create",
    pageId: f.host.id,
    cells: { title: "Code example" },
  });
  const readRow = async () =>
    (await page.request.get(`/api/pages/${f.host.id}/rows/${row.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await f.command({
    action: "row.document.sync",
    pageId: f.host.id,
    rowId: row.id,
    generation: (await readRow()).generation,
    update: Buffer.from(
      htmlState(
        '<pre data-code-wrap="true"><code class="language-python">def greet(name):\n    return "Hello " + name\n</code></pre>',
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  const feed = page.getByRole("region", {
    name: "Datenbank-Feed",
    exact: true,
  });
  await expect(feed.locator(".tok-keyword").first()).toHaveText("def");
  await expect(feed.locator(".code-block-view")).toHaveCount(1);
  await feed.getByRole("button", { name: "Code example", exact: true }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(languageButton(entry)).toHaveAccessibleName("Code-Sprache: Python");
  await pickLanguage(entry, "ruby");
  // The new language applies (and re-highlights) before the code is replaced.
  await expect(languageButton(entry)).toHaveAccessibleName("Code-Sprache: Ruby");
  await entry.locator("pre code").fill("");
  await expect(entry.locator("pre code")).toHaveText("");
  await entry.locator("pre code").click();
  await page.keyboard.insertText("def greet(name)");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText('  "Hello #{name}"');
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("end");
  await expect(entry.locator(".tok-keyword").last()).toHaveText("end");
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect
    .poll(async () => (await readRow()).html)
    .toContain("language-ruby");
  await expect(feed.locator(".tok-keyword").last()).toHaveText("end", {
    timeout: 12000,
  });
  const link = await f.command({
    action: "share.create",
    pageId: f.host.id,
    role: "editor",
    name: "Code guest",
  });
  const visitor = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
  });
  try {
    const guest = await visitor.newPage();
    await guest.goto(
      `${f.origin}/share/${link.token}/${f.host.id}?row=${row.id}`,
    );
    // Public rows use their explicit record URL parameter.
    await expect(guest.locator(".tok-keyword").first()).toHaveText("def");
    await expect(guest.locator(".code-block-view")).toHaveCount(1);
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    const editor = guest.getByLabel("Geteilten Inhalt bearbeiten", {
      exact: true,
    });
    await pickLanguage(editor, "javascript");
    await editor.locator("pre code").fill("");
    await editor.locator("pre code").click();
    await guest.keyboard.insertText(
      'const value = "<img src=x onerror=alert(1)>";',
    );
    await expect(editor.locator(".tok-keyword").first()).toHaveText("const");
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(
      guest.getByText("Änderungen gespeichert", { exact: true }),
    ).toBeVisible();
    await expect(guest.locator(".tok-keyword").first()).toHaveText("const");
    await expect(guest.locator(".code-block-view img")).toHaveCount(0);
    expect((await readRow()).html).not.toContain("tok-");
    expect((await readRow()).html).toContain('data-code-wrap="true"');
  } finally {
    await visitor.close();
  }
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
