import { test, expect, type Page } from "@playwright/test";

// Editing and deleting page and record comments (#450), as text comments:
// pencil and bin on one's own comment, the edit in place with the
// formatted composer (files removable), "· bearbeitet" afterwards, and a
// confirmation before deleting. Guests' comments have neither.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const LOAD = 30_000;

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "profile.commentMargin", commentMargin: false });
  return { boot, command };
}
async function upload(page: Page, pageId: string, name: string, rowId?: string) {
  const response = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId,
      ...(rowId ? { rowId } : {}),
      purpose: "comment",
      file: { name, mimeType: "text/plain", buffer: Buffer.from(`Inhalt ${name}`) },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string };
}
async function openComments(page: Page) {
  if (test.info().project.name === "mobile") {
    await page.getByRole("button", { name: /Seitenmenü|Weitere Aktionen|Mehr/ }).first().click();
    await page.getByRole("menuitem", { name: "Kommentare", exact: true }).click();
  } else await page.getByTitle("Kommentare", { exact: true }).click();
  return page.locator(".comments-panel");
}
const doc = (text: string, attachments: { id: string }[] = []) => ({
  type: "doc",
  ...(attachments.length ? { attrs: { attachments: attachments.map((f) => ({ src: `/api/files/${f.id}` })) } } : {}),
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

test("a page comment: edit in place with its files, marked edited, then deleted after confirming", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The comments panel's phone layout has its own specs.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bearbeiten ${testInfo.project.name} ${Date.now()}` });
  const keep = await upload(page, p.id, "behalten.txt"),
    drop = await upload(page, p.id, "weg.txt");
  await command({ action: "comment.create", pageId: p.id, body: "", content: doc("Erste Fassung", [keep, drop]) });
  await command({ action: "comment.create", pageId: p.id, body: "Bleibt stehen" });
  // A guest's comment (a share link) cannot be edited or deleted.
  const link = await command({ action: "share.create", pageId: p.id, role: "commenter", name: "Feedback" });
  const shared = await page.request.post(`/api/share/${link.token}`, {
    headers: { origin },
    data: { action: "comment", pageId: p.id, name: "Gast", body: "Von außen" },
  });
  expect(shared.ok(), await shared.text()).toBe(true);
  await page.goto(`/#page=${p.id}`);
  const panel = await openComments(page);
  const comment = panel.locator(".comment").filter({ hasText: "Erste Fassung" });
  await expect(comment).toBeVisible({ timeout: LOAD });
  await expect(comment.locator(":scope > div > small")).not.toContainText("bearbeitet");
  const guest = panel.locator(".comment").filter({ hasText: "Von außen" });
  await expect(guest).toBeVisible();
  await expect(guest.getByRole("button", { name: "Kommentar bearbeiten" })).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Kommentar löschen" })).toHaveCount(0);

  // Edit: the composer opens with the text and both files.
  await comment.getByRole("button", { name: "Kommentar bearbeiten" }).click();
  const field = comment.getByRole("textbox", { name: "Kommentartext bearbeiten" });
  await expect(field).toBeFocused({ timeout: LOAD });
  await expect(field).toHaveText("Erste Fassung");
  await expect(comment.getByText("weg.txt")).toBeVisible();
  await comment.getByRole("button", { name: "Anhang entfernen: weg.txt" }).click();
  await expect(comment.getByText("weg.txt")).toHaveCount(0);
  // Back into the text, at its end.
  await field.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(", überarbeitet");
  await page.screenshot({ path: `test-results/comment-edit/${testInfo.project.name}-editing.png` });
  await comment.getByRole("button", { name: "Änderung speichern" }).click();
  const edited = panel.locator(".comment").filter({ hasText: "Erste Fassung, überarbeitet" });
  await expect(edited.getByRole("textbox")).toHaveCount(0, { timeout: LOAD });
  await expect(edited.locator(":scope > div > small")).toContainText("bearbeitet");
  await expect(edited.getByRole("link", { name: /behalten\.txt/ })).toBeVisible();
  await expect(edited.getByText("weg.txt")).toHaveCount(0);
  await page.screenshot({ path: `test-results/comment-edit/${testInfo.project.name}-edited.png` });
  // Stored: body and content alike, the dropped file in the trash.
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  const stored = data.comments.find((c: { body: string }) => c.body.startsWith("Erste Fassung"));
  expect(stored.body).toBe("Erste Fassung, überarbeitet");
  expect(stored.version).toBe(2);
  expect(stored.content.attrs.attachments.map((a: { name: string }) => a.name)).toEqual(["behalten.txt"]);
  expect((await page.request.get(`/api/files/${drop.id}`)).ok()).toBe(false);
  expect((await page.request.get(`/api/files/${keep.id}`)).ok()).toBe(true);

  // Cancelling an edit keeps the comment as it was.
  await edited.getByRole("button", { name: "Kommentar bearbeiten" }).click();
  await expect(edited.getByRole("textbox", { name: "Kommentartext bearbeiten" })).toBeFocused({ timeout: LOAD });
  await page.keyboard.type(" – verworfen");
  await edited.getByRole("button", { name: "Bearbeitung abbrechen" }).click();
  await expect(edited.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByText("verworfen")).toHaveCount(0);

  // Delete: asks first; closing the dialog keeps it.
  await edited.getByRole("button", { name: "Kommentar löschen" }).click();
  const dialog = page.getByRole("dialog", { name: "Kommentar löschen" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(edited).toBeVisible();
  await edited.getByRole("button", { name: "Kommentar löschen" }).click();
  await dialog.getByRole("button", { name: "Kommentar endgültig löschen" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.locator(".comment").filter({ hasText: "Erste Fassung" })).toHaveCount(0, { timeout: LOAD });
  await expect(panel.locator(".comment").filter({ hasText: "Bleibt stehen" })).toBeVisible();
  // Gone on the server too, its last file in the trash; a reload agrees.
  expect((await page.request.get(`/api/files/${keep.id}`)).ok()).toBe(false);
  await page.reload();
  const again = await openComments(page);
  await expect(again.locator(".comment").filter({ hasText: "Bleibt stehen" })).toBeVisible({ timeout: LOAD });
  await expect(again.getByText("Erste Fassung")).toHaveCount(0);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});

test("a record comment: edited and deleted in the record", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Aufgaben ${testInfo.project.name} ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Angebot schreiben" } });
  await command({ action: "comment.create", pageId: db.id, rowId: row.id, body: "Bis Montag" });
  await page.goto(`/#page=${db.id}&row=${row.id}&full=1`);
  const record = page.locator(".record-page");
  const comment = record.locator(".comment").filter({ hasText: "Bis Montag" });
  await expect(comment).toBeVisible({ timeout: LOAD });
  await comment.getByRole("button", { name: "Kommentar bearbeiten" }).click();
  const field = comment.getByRole("textbox", { name: "Kommentartext bearbeiten" });
  await expect(field).toBeFocused({ timeout: LOAD });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" oder Dienstag");
  await comment.getByRole("button", { name: "Änderung speichern" }).click();
  const edited = record.locator(".comment").filter({ hasText: "Bis Montag oder Dienstag" });
  await expect(edited.getByRole("textbox")).toHaveCount(0, { timeout: LOAD });
  await expect(edited.locator(":scope > div > small")).toHaveText("bearbeitet");
  await page.screenshot({ path: `test-results/comment-edit/${testInfo.project.name}-record.png` });
  await edited.getByRole("button", { name: "Kommentar löschen" }).click();
  await page.getByRole("dialog", { name: "Kommentar löschen" }).getByRole("button", { name: "Kommentar endgültig löschen" }).click();
  await expect(record.locator(".comment").filter({ hasText: "Bis Montag" })).toHaveCount(0, { timeout: LOAD });
  const data = await (await page.request.get(`/api/pages/${db.id}`)).json();
  expect(data.comments.filter((c: { row_id: string }) => c.row_id === row.id)).toEqual([]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: db.id });
});
