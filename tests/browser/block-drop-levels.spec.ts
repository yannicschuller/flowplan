import { test, expect, type Page } from "@playwright/test";

// Dropping by level (#239): moving right over a list item drops the block as
// its child, moving left drops it on the parent's level; the 4 px drop line
// is indented to that level. ⌥/Alt while dropping copies.
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
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, command, read };
}
const handle = (page: Page, text: string, kind = "[^·]+") => page.getByRole("button", { name: new RegExp(`^Blockaktionen: ${kind} · ${text}$`) });
// Grab a block's handle and move to (x, y), step by step; returns the drop line.
async function dragTo(page: Page, text: string, x: number, y: number, kind?: string) {
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  // A change arriving during a drag cancels it: the last drop is saved first.
  await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await editor.getByText(text, { exact: true }).first().hover();
  await expect(handle(page, text, kind)).toHaveClass(/hovered/);
  const grip = (await handle(page, text, kind).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 30, { steps: 4 });
  await page.mouse.move(x, y, { steps: 14 });
  const line = page.locator(".document-block-drop");
  await expect(line).toBeVisible();
  return line;
}

test("the drop line follows the pointer's level; ⌥ copies", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse: horizontal position and ⌥.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Ebenen ${Date.now()}`,
    "<p>Oben</p><ul><li><p>Eins</p></li><li><p>Zwei</p></li><li><p>Drei</p></li></ul><p>Absatz</p><details><summary>Klappe</summary><div><p>Drin</p></div></details><p>Ende</p>",
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  const einsText = editor.locator("li", { hasText: "Eins" }).locator(":scope > p");
  const eins = (await einsText.boundingBox())!;
  const list = (await editor.locator(":scope > ul").boundingBox())!;
  const gapY = eins.y + eins.height + 3;

  // "Drei" over the gap below "Eins", the pointer to the right: as a child of "Eins".
  let line = await dragTo(page, "Drei", eins.x + 90, gapY);
  const nestedLine = (await line.boundingBox())!;
  expect(nestedLine.x).toBeGreaterThan(eins.x - 4);
  expect(nestedLine.height).toBeGreaterThanOrEqual(3.5);
  await page.screenshot({ path: "test-results/block-drop-levels-nested.png" });
  // Back to the left: the list's own level, the line moves out.
  await page.mouse.move(list.x + 4, gapY, { steps: 6 });
  await expect.poll(async () => (await line.boundingBox())!.x).toBeLessThan(eins.x - 10);
  // And right again, then drop.
  await page.mouse.move(eins.x + 90, gapY, { steps: 6 });
  await expect.poll(async () => (await line.boundingBox())!.x).toBeGreaterThan(eins.x - 4);
  await page.mouse.up();
  await expect(editor.locator("li", { hasText: "Eins" }).locator("ul > li")).toHaveText(["Drei"]);
  await expect(editor.locator(":scope > ul > li")).toHaveCount(2);

  // The nested "Drei" out again: left of the list, below it – the parent level.
  await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 15_000 });
  const nestedDrei = editor.locator("li li", { hasText: "Drei" });
  await expect(nestedDrei).toBeVisible();
  const drei = (await nestedDrei.boundingBox())!;
  line = await dragTo(page, "Drei", list.x - 20, drei.y + drei.height + 3);
  await expect.poll(async () => (await line.boundingBox())!.x).toBeLessThan(drei.x - 10);
  await page.mouse.up();
  await expect(editor.locator(":scope > ul > li")).toHaveText(["Eins", "Drei", "Zwei"]);
  await expect(editor.locator("li ul")).toHaveCount(0);

  // A paragraph into a toggle: below its content, to the right.
  const drin = (await editor.getByText("Drin").boundingBox())!;
  await dragTo(page, "Absatz", drin.x + 80, drin.y + drin.height + 4);
  await page.mouse.up();
  await expect(editor.locator("details p")).toHaveText(["Drin", "Absatz"]);

  // ⌥ while dropping: a copy, the original stays; the cursor shows it.
  const oben = (await editor.getByText("Oben").boundingBox())!;
  const ende = (await editor.getByText("Ende").boundingBox())!;
  await dragTo(page, "Oben", oben.x + 80, ende.y + ende.height - 2);
  await page.keyboard.down("Alt");
  await page.mouse.move(oben.x + 82, ende.y + ende.height - 1);
  await expect(page.locator("html")).toHaveClass(/dragging-blocks-copy/);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(page.locator("html")).not.toHaveClass(/dragging-blocks-copy/);
  await expect(editor.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(["Oben", "Ende", "Oben"]);
  expect(errors).toEqual([]);
});
