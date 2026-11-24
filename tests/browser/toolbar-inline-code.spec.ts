import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Inline-Code ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const html = "<p>Rufe npm install auf.</p><pre><code>echo hallo</code></pre>";
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { command, host };
}

// A selection as a mouse or the handles of a touch selection make it.
const select = (page: Page, selector: string, from: number, to: number) =>
  page.evaluate(
    ([selector, from, to]) => {
      const text = document.querySelector(selector)!.firstChild!;
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    [selector, from, to] as const,
  );

// #465: inline code in the formatting toolbar – on a phone the toolbar
// docked on the keyboard is the only way to it. Right after
// strikethrough; it marks the selection as code, shows as pressed there,
// and is off inside a code block.
test("inline code from the formatting toolbar", async ({ page }) => {
  test.setTimeout(120_000);
  const { command, host } = await setup(page);
  try {
    await page.goto(`/#page=${host.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    const paragraph = editor.locator("p", { hasText: "npm install" });
    await expect(paragraph).toBeVisible({ timeout: 30_000 });
    await paragraph.click();
    const bar = page.getByRole("toolbar", { name: "Textformatierung" });
    const button = bar.getByRole("button", { name: "Inline-Code", exact: true });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect(button).toHaveAttribute("aria-pressed", "false");

    // Right after "Durchgestrichen".
    const names = await bar.evaluate((el) => [...el.children].map((c) => c.getAttribute("aria-label") || c.getAttribute("title") || ""));
    expect(names[names.indexOf("Durchgestrichen") + 1]).toBe("Inline-Code");

    // "npm install" becomes code; the button shows it.
    await select(page, ".ProseMirror p", "Rufe ".length, "Rufe npm install".length);
    await button.click();
    await expect(paragraph.locator("code")).toHaveText("npm install");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveClass(/active/);
    // Saved with the page.
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${host.id}`)).json()).html as string, { timeout: 20_000 })
      .toContain("<code>npm install</code>");

    // Again: plain text once more.
    await select(page, ".ProseMirror p code", 0, "npm install".length);
    await button.click();
    await expect(paragraph.locator("code")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-pressed", "false");

    // In a code block it is off (a code block takes no marks).
    await editor.locator("pre").click();
    await expect(button).toBeDisabled();
  } finally {
    await command({ action: "page.delete", pageId: host.id }).catch(() => undefined);
  }
});
