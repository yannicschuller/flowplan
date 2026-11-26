import { test, expect, type Page } from "@playwright/test";

// Ticking a task off does not put the caret into the text: on iPhone and
// iPad that brought up the keyboard just for a tick. Only the task changes;
// an editor that had the focus keeps it.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function fixture(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return host;
}
const editorHasFocus = (page: Page) => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));

test("ticking a task leaves the focus where it was", async ({ page }, info) => {
  test.setTimeout(120_000);
  const host = await fixture(
    page,
    `Abhaken ${info.project.name} ${Date.now()}`,
    '<p>Einleitung</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Erste Aufgabe</p></li><li data-type="taskItem" data-checked="false"><p>Zweite Aufgabe</p></li></ul>',
  );
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Zweite Aufgabe", { exact: true })).toBeVisible({ timeout: 30_000 });
  const item = (text: string) => editor.locator("li[data-checked]", { hasText: text });
  const box = (text: string) => item(text).locator("label").first();
  const tap = async (text: string) => {
    if (info.project.name === "mobile") await box(text).tap();
    else await box(text).click();
  };

  // Not writing: a tap ticks the task and the editor stays without focus
  // (no keyboard on a phone).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await editorHasFocus(page)).toBe(false);
  await tap("Erste Aufgabe");
  await expect(item("Erste Aufgabe")).toHaveAttribute("data-checked", "true");
  expect(await editorHasFocus(page)).toBe(false);
  // And back again.
  await tap("Erste Aufgabe");
  await expect(item("Erste Aufgabe")).toHaveAttribute("data-checked", "false");
  expect(await editorHasFocus(page)).toBe(false);

  // Writing: the caret stays in the text being written.
  await editor.getByText("Einleitung", { exact: true }).click();
  await expect.poll(() => editorHasFocus(page)).toBe(true);
  await tap("Zweite Aufgabe");
  await expect(item("Zweite Aufgabe")).toHaveAttribute("data-checked", "true");
  expect(await editorHasFocus(page)).toBe(true);
  await page.keyboard.type(" weiter");
  await expect(editor.getByText("Einleitung weiter", { exact: true })).toBeVisible();
});
