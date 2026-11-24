// #530: the link dialog edits the link's text together with its address.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function selectWord(page: Page, paragraph: Locator, word: string) {
  const at = await paragraph.evaluate((p, word) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.textContent!.indexOf(word);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + word.length);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error(`no ${word}`);
  }, word);
  await page.mouse.dblclick(at.x, at.y);
}

test("the link dialog sets and changes the text with the address, in one undo step", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "selecting with a mouse");
  const dir = process.env.FLOWPLAN_DATA_DIR;
  test.skip(!dir || dir === "./data", "Braucht einen eigenen Datenordner.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Linktext ${Date.now()}` });
  const html = `<p>Hallo Welt und <a href="https://example.com/">Altlink</a> Ende</p>`;
  const { htmlState } = await import("../../lib/document-server");
  const db = new DatabaseSync(join(dir!, "flowplan.sqlite"));
  db.prepare("UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?").run(htmlState(html), html, crypto.randomUUID(), doc.id);
  db.close();
  await page.goto(`/#page=${doc.id}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(content).toContainText("Altlink");
  const paragraph = content.locator("p").first();
  const linkButton = page.getByRole("toolbar", { name: "Textformatierung" }).getByTitle("Link", { exact: true });

  // A selection: its text is prefilled; text and address change together.
  await selectWord(page, paragraph, "Welt");
  await linkButton.click();
  let dialog = page.getByRole("dialog", { name: "Link einfügen" });
  const text = dialog.getByLabel("Text", { exact: true });
  const address = dialog.getByLabel("Adresse", { exact: true });
  await expect(text).toHaveValue("Welt");
  await expect(address).toHaveValue("");
  await text.fill("schöne Welt");
  await address.fill("https://a.example/");
  await address.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(content.locator('a[href="https://a.example/"]')).toHaveText("schöne Welt");
  await expect(paragraph).toHaveText("Hallo schöne Welt und Altlink Ende");

  // The cursor inside an existing link: the whole link's text and address.
  await selectWord(page, paragraph, "Ende");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await linkButton.click();
  dialog = page.getByRole("dialog", { name: "Link bearbeiten" });
  await expect(dialog.getByLabel("Text", { exact: true })).toHaveValue("Altlink");
  await expect(dialog.getByLabel("Adresse", { exact: true })).toHaveValue("https://example.com/");
  await dialog.getByLabel("Text", { exact: true }).fill("Neuer Link");
  await dialog.getByLabel("Text", { exact: true }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(content.locator('a[href="https://example.com/"]')).toHaveText("Neuer Link");
  await expect(paragraph).toHaveText("Hallo schöne Welt und Neuer Link Ende");

  // Escape changes nothing.
  await selectWord(page, paragraph, "Hallo");
  await linkButton.click();
  dialog = page.getByRole("dialog", { name: "Link einfügen" });
  await dialog.getByLabel("Text", { exact: true }).fill("Weg");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(paragraph).toHaveText("Hallo schöne Welt und Neuer Link Ende");

  // One undo step brings the old text back, with its address.
  await selectWord(page, paragraph, "Hallo");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content.locator('a[href="https://example.com/"]')).toHaveText("Altlink");
  await expect(paragraph).toHaveText("Hallo schöne Welt und Altlink Ende");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: doc.id });
});
