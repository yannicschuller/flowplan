import { test, expect, type Page } from "@playwright/test";

// Switching pages (#604): the editor of the page left behind is not drawn
// anew while it is still in the page. Tiptap resets the node views of an
// editor it unmounts, and ProseMirror then rebuilt the whole old text in
// place – hundreds of insertions and a style and layout pass over a page
// about to disappear. Counted, not timed: insertions into the old text
// while it is still part of the document.
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
  const { htmlState } = await import("../../lib/document-server");
  const create = async (title: string, html: string) => {
    const { id } = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
    const { generation } = await (await page.request.get(`/api/pages/${id}`)).json();
    await command({ action: "document.sync", pageId: id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
    return id as string;
  };
  return { command, create };
}

test("leaving a page does not redraw its text in place", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, create } = await setup(page);
  const stamp = Date.now();
  const paragraphs = Array.from({ length: 120 }, (_, i) => `<p>Absatz ${i}</p>`).join("");
  const first = await create(`Wechsel A ${stamp}`, paragraphs + "<p>Ende A</p>");
  const second = await create(`Wechsel B ${stamp}`, paragraphs + "<p>Ende B</p>");
  await page.goto(`/#page=${first}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende A", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Every insertion into the old text from now on, and whether the text
  // was still in the document then.
  await editor.evaluate((dom) => {
    const seen = ((window as unknown as { __inserted: { attached: number; detached: number } }).__inserted = { attached: 0, detached: 0 });
    for (const method of ["insertBefore", "appendChild"] as const) {
      const original = dom[method] as (...args: unknown[]) => unknown;
      (dom as unknown as Record<string, unknown>)[method] = function (this: Node, ...args: unknown[]) {
        if (this.isConnected) seen.attached++;
        else seen.detached++;
        return original.apply(this, args);
      };
    }
  });
  // On a phone the sidebar is a drawer: the page opens by its address there.
  if (info.project.name === "desktop") await page.locator(".sidebar").getByText(`Wechsel B ${stamp}`, { exact: true }).click();
  else await page.evaluate((id) => (location.hash = `#page=${id}`), second);
  await expect(editor.getByText("Ende B", { exact: true })).toBeVisible({ timeout: 30_000 });
  const inserted = await page.evaluate(() => (window as unknown as { __inserted: { attached: number; detached: number } }).__inserted);
  // A few for the caret or a widget leaving are fine; a redraw is one per block.
  expect(inserted.attached, JSON.stringify(inserted)).toBeLessThan(20);
  expect(errors).toEqual([]);
  await page.goto("/#home");
  for (const id of [first, second]) await command({ action: "page.delete", pageId: id });
});
