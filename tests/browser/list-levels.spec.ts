import { test, expect, type Locator } from "@playwright/test";

// Nested lists (#234): numbered lists count 1. → a. → i. and bullets
// • → ◦ → ▪ per level, again from the fourth; the level counts list items
// of any kind (a numbered list below a bullet or a task on level 2 counts
// a.). The same in the editor and on the published page; items stand a
// little further apart than the lines of one item.
const HTML =
  "<ol><li><p>Eins</p><ol><li><p>Zwei</p><ol><li><p>Drei</p><ol><li><p>Vier</p><ol><li><p>Fünf</p></li></ol></li></ol></li></ol></li></ol></li></ol>" +
  "<ul><li><p>B1</p><ul><li><p>B2</p><ul><li><p>B3</p><ul><li><p>B4</p></li></ul></li></ul></li></ul><ol><li><p>N2</p></li></ol></li></ul>" +
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Aufgabe</p><ol><li><p>T2</p></li></ol></li></ul>';

const markerOf = (root: Locator, text: string) =>
  root
    .locator("li", { has: root.page().getByText(text, { exact: true }) })
    .last()
    .evaluate((li) => getComputedStyle(li.parentElement!).listStyleType);

async function expectLevels(root: Locator) {
  const expected: [string, string][] = [
    ["Eins", "decimal"],
    ["Zwei", "lower-alpha"],
    ["Drei", "lower-roman"],
    ["Vier", "decimal"],
    ["Fünf", "lower-alpha"],
    ["B1", "disc"],
    ["B2", "circle"],
    ["B3", "square"],
    ["B4", "disc"],
    ["N2", "lower-alpha"],
    ["T2", "lower-alpha"],
  ];
  for (const [text, marker] of expected) await expect.poll(() => markerOf(root, text), { message: text }).toBe(marker);
  // Task lists keep showing no markers.
  expect(await root.locator('ul[data-type="taskList"]').first().evaluate((ul) => getComputedStyle(ul).listStyleType)).toBe("none");
  // Items have room of their own beyond the line height.
  const item = root.locator("li", { has: root.page().getByText("Eins", { exact: true }) }).first();
  const spacing = await item.evaluate((li) => {
    const style = getComputedStyle(li);
    return { top: parseFloat(style.paddingTop), lineHeight: parseFloat(getComputedStyle(li.querySelector("p")!).lineHeight) / parseFloat(style.fontSize) };
  });
  expect(spacing.top).toBeGreaterThanOrEqual(2);
  expect(spacing.lineHeight).toBeLessThan(1.7);
}

test("nested lists show 1. a. i. and • ◦ ▪ per level in the editor and on the published page", async ({ page, browser }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `Listen ${info.project.name} ${Date.now()}` });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(HTML)).toString("base64") });

  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Fünf", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expectLevels(editor);

  await command({ action: "page.publish", pageId: host.id, enabled: true });
  const token = (await read()).page.public_token;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${origin}/share/${token}`);
  const published = visitor.locator(".document-editor").first();
  await expect(published.getByText("Fünf", { exact: true })).toBeVisible();
  await expectLevels(published);
  await visitorContext.close();

  expect(errors).toEqual([]);
  await page.goto("/#home");
  await command({ action: "page.delete", pageId: host.id });
});
