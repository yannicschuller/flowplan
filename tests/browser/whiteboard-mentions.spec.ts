import { test, expect } from "@playwright/test";
import * as Y from "yjs";

// #567: "@" in the text of a sticky note opens the mention dialog of
// documents; the page picked goes into the text as a link, the note shows
// it as a link that opens the page, and the page lists the board under
// "Verlinkt von". SHOT_DIR=<folder>: screenshots of the dialog and the link
// (light and dark) for the review.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("@ in a sticky note links a page, which lists the board", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const tag = `${info.project.name}${Date.now()}`;
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  const target = await create(`Projektplan ${tag}`);
  const board = await create(`Board ${tag}`, "whiteboard");
  // A note on the board, in the middle of the view.
  const data = await (await page.request.get(`/api/pages/${board}`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  const before = Y.encodeStateVector(doc);
  const note = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ type: "sticky", x: -130, y: -90, w: 260, h: 180, z: 1, text: "Siehe", fill: "#fff6b6" })) note.set(k, v);
  doc.getMap("items").set("note", note);
  await command({ action: "whiteboard.sync", pageId: board, generation: data.whiteboard.generation, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") });

  await page.goto(`/#page=${board}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const sticky = wb.locator(".wb-sticky", { hasText: "Siehe" });
  await expect(sticky).toBeVisible();
  // Selected, Enter edits it; "@" after a space opens the dialog.
  await sticky.click();
  await page.keyboard.press("Enter");
  const field = wb.locator("textarea.wb-editor");
  await expect(field).toBeFocused();
  await page.keyboard.type(" ");
  await page.keyboard.press("@");
  const dialog = page.getByRole("dialog", { name: "Seite, Eintrag oder Person erwähnen" });
  const search = dialog.getByRole("combobox", { name: "Seiten, Einträge und Personen suchen" });
  await expect(search).toBeFocused();
  await page.keyboard.type(`Projektplan ${tag}`);
  await expect(dialog.getByRole("option", { selected: true })).toHaveText(`Projektplan ${tag}`);
  const shots = process.env.SHOT_DIR;
  if (shots) await page.screenshot({ path: `${shots}/567-picker-${info.project.name}.png` });
  // Escape types the "@" and the search, as in documents.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(`Siehe @Projektplan ${tag}`);
  // Again, and Enter picks the highlighted page.
  for (let i = 0; i < `@Projektplan ${tag}`.length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("@");
  await page.keyboard.type(`Projektplan ${tag}`);
  await expect(dialog.getByRole("option", { selected: true })).toHaveText(`Projektplan ${tag}`);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  // The caret is back in the note, after the link.
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(`Siehe [Projektplan ${tag}](/#page=${target}) `);
  await page.keyboard.type("lesen");
  await page.keyboard.press("Escape");
  await expect(field).toBeHidden();

  // The note shows the link.
  const link = sticky.getByRole("link", { name: `Projektplan ${tag}` });
  await expect(link).toHaveAttribute("href", `/#page=${target}`);
  await expect(sticky).toContainText("lesen");
  // Stored with the board's summary (what the backlinks read).
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${board}`)).json()).html as string).includes(`#page=${target}`), { timeout: 15000 })
    .toBe(true);
  if (shots) {
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${shots}/567-link-light-${info.project.name}.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/567-link-dark-${info.project.name}.png` });
    await page.emulateMedia({ colorScheme: "light" });
  }

  // A click opens the page, which lists the board under "Verlinkt von".
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#page=${target}$`));
  const heading = page.getByRole("heading", { name: "Verlinkt von" });
  await expect(heading).toBeVisible();
  await expect(heading.locator("..").getByRole("button", { name: `Board ${tag}`, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
