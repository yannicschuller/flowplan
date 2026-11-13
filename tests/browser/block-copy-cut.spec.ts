import { test, expect, type Page } from "@playwright/test";

// "Kopieren" and "Ausschneiden" in the block menu (#263), for one block and
// for chosen blocks, with their shortcuts and in the menu's search; the
// clipboard holds what ⌘C would: blocks that paste back as blocks (also in
// another page) and plain text for other apps. On touch screens the bar of
// the selection mode copies, its ⋯ menu copies and cuts.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", { headers: { origin }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function document(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command(page, { action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return host;
}
const HTML = "<h2>Titel</h2><p>Alpha</p><ul><li><p>Eins</p></li><li><p>Zwei</p></li></ul><p>Bravo</p><p>Ende</p>";
const clipboard = (page: Page) =>
  page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const html = item.types.includes("text/html") ? await (await item.getType("text/html")).text() : "";
    const text = item.types.includes("text/plain") ? await (await item.getType("text/plain")).text() : "";
    return { html, text };
  });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

test("copy and cut from the block menu, pasted as blocks into another page (#263)", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard; touch below.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const source = await document(page, `Kopieren ${Date.now()}`, HTML);
  const target = await document(page, `Ziel ${Date.now()}`, "<p>Oben</p><p>Unten</p>");
  await page.goto(`/#page=${source.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });

  // One block: the entries with their shortcuts.
  await editor.getByText("Alpha").hover();
  await page.getByRole("button", { name: "Blockaktionen: Absatz · Alpha", exact: true }).click();
  const copy = page.getByRole("menuitem", { name: "Kopieren", exact: true });
  const cut = page.getByRole("menuitem", { name: "Ausschneiden", exact: true });
  await expect(copy).toBeVisible();
  await expect(copy.locator(".block-menu-shortcut")).toHaveText(/C/);
  await expect(cut.locator(".block-menu-shortcut")).toHaveText(/X/);
  await copy.click();
  await expect(toast(page, "1 Block kopiert")).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  let data = await clipboard(page);
  expect(data.text.trim()).toBe("Alpha");
  expect(data.html).toContain("data-pm-slice");

  // Several chosen blocks (heading to list): the menu of the chosen ones.
  await editor.getByText("Titel").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".document-block-marked")).toHaveCount(3);
  await page.keyboard.press("/");
  await expect(page.getByRole("menu", { name: "3 Blöcke" })).toBeVisible();
  // Found by the search, in German and English.
  await page.keyboard.type("copy");
  await expect(page.getByRole("menuitem", { name: "Kopieren", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(toast(page, "3 Blöcke kopiert")).toBeVisible();
  data = await clipboard(page);
  expect(data.text).toContain("Titel");
  expect(data.text).toContain("Zwei");
  // The choice stays (as after ⌘C).
  await expect(page.locator(".document-block-marked")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Pasted into another page: the same blocks, a heading and a list.
  await page.goto(`/#page=${target.id}`);
  const other = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(other.getByText("Unten")).toBeVisible({ timeout: 20_000 });
  await other.getByText("Oben").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(other.locator(":scope > h2")).toHaveText("Titel");
  await expect(other.locator(":scope > ul > li")).toHaveText(["Eins", "Zwei"]);
  await expect(other.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(["Oben", "Alpha", "Unten"]);

  // Cut: the blocks leave the page and are on the clipboard.
  await page.goto(`/#page=${source.id}`);
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Bravo").hover();
  await page.getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true }).click();
  await page.getByRole("searchbox", { name: "Aktionen und Blocktypen suchen" }).fill("ausschneiden");
  await page.getByRole("menuitem", { name: "Ausschneiden", exact: true }).click();
  await expect(toast(page, "1 Block ausgeschnitten")).toBeVisible();
  await expect(editor.getByText("Bravo")).toHaveCount(0);
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  expect((await clipboard(page)).text.trim()).toBe("Bravo");
  // ⌘V puts it back (the caret is where it was).
  await editor.getByText("Ende").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(editor.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(["Alpha", "Bravo", "Ende"]);
  expect(errors).toEqual([]);
});

test("touch: the selection bar copies, its ⋯ menu copies and cuts (#263)", async ({ page, context }, info) => {
  test.skip(info.project.name !== "mobile", "Touch only.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const source = await document(page, `Kopieren touch ${Date.now()}`, HTML);
  await page.goto(`/#page=${source.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Titel").tap();
  await page.getByRole("button", { name: "Blockaktionen: Überschrift · Titel", exact: true }).tap();
  // The sheet has both entries too.
  await expect(page.getByRole("menuitem", { name: "Kopieren", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Ausschneiden", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mehrere auswählen", exact: true }).tap();
  await page.getByRole("checkbox", { name: "Absatz · Alpha" }).tap();
  const bar = page.getByRole("toolbar", { name: "Ausgewählte Blöcke" });
  await expect(bar).toContainText("2 Blöcke");
  await bar.getByRole("button", { name: "Kopieren" }).tap();
  await expect(toast(page, "2 Blöcke kopiert")).toBeVisible();
  expect((await clipboard(page)).text).toContain("Alpha");
  // ⋯ → Ausschneiden: both go.
  await bar.getByRole("button", { name: "Weitere Aktionen" }).tap();
  await page.getByRole("menuitem", { name: "Ausschneiden", exact: true }).tap();
  await expect(toast(page, "2 Blöcke ausgeschnitten")).toBeVisible();
  await expect(editor.getByText("Titel")).toHaveCount(0);
  await expect(editor.getByText("Alpha")).toHaveCount(0);
  await expect(editor.getByText("Bravo")).toBeVisible();
});
