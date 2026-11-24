import { test, expect, type Page } from "@playwright/test";

// #461: the content of a saved page template is edited in a draft page
// ("Inhalt bearbeiten", saved with "Vorlage speichern" or discarded) or
// replaced by another page's ("Aus Seite ersetzen …"). Pages made from the
// template before stay as they were.

async function openGallery(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Vorlagen" });
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.locator(".sidebar-tools").getByRole("button", { name: "Vorlagen" }).click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Eigene Vorlagen", exact: true }).click();
  return dialog;
}
// "Bearbeiten" on the template's row, then the edit dialog.
async function editTemplate(page: Page, name: string) {
  const gallery = await openGallery(page);
  await gallery.locator(".saved-template-row", { hasText: name }).getByRole("button", { name: `${name} bearbeiten` }).click();
  const edit = page.getByRole("dialog", { name: "Vorlage bearbeiten" });
  await expect(edit).toBeVisible();
  return edit;
}

test("the content of a saved page template is edited in a draft, replaced from a page, and a draft discarded", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { htmlState } = await import("../../lib/document-server");
  const withText = async (title: string, html: string) => {
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title });
    const generation = (await (await page.request.get(`/api/pages/${created.id}`)).json()).generation;
    await command({ action: "document.sync", pageId: created.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
    return created.id as string;
  };
  const htmlOf = async (id: string) => ((await (await page.request.get(`/api/pages/${id}`)).json()).html as string) || "";
  const fromTemplate = async (templateId: string, title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, templateId })).id as string;

  const stamp = Date.now();
  const name = `Protokoll ${stamp}`;
  const source = await withText(`Quelle ${stamp}`, "<p>Tagesordnung alt</p>");
  const template = await command({ action: "template.save", pageId: source, name });
  const earlier = await fromTemplate(template.id, `Frühere Seite ${stamp}`);

  // Edit content: the draft opens as a page with its bar.
  await page.goto("/#home");
  const edit = await editTemplate(page, name);
  await expect(edit).toContainText("Bereits erstellte Seiten werden nicht verändert.");
  await edit.getByRole("button", { name: "Inhalt bearbeiten" }).click();
  const bar = page.locator(".template-draft-bar");
  await expect(bar).toContainText(`Entwurf der Vorlage „${name}“ – nur du siehst ihn.`, { timeout: 30_000 });
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Tagesordnung alt");
  const draftId = new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)![1];
  // Not in the sidebar.
  await expect(page.locator(".sidebar")).not.toContainText(name);
  await editor.getByText("Tagesordnung alt").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" und neu");
  await bar.getByRole("button", { name: "Vorlage speichern" }).click();
  await expect(page.getByText("Vorlage gespeichert")).toBeVisible();
  await expect(bar).toBeHidden();
  // The draft is gone, the template has the new content, the earlier page
  // the old one.
  expect((await page.request.get(`/api/pages/${draftId}`)).status()).toBe(404);
  expect(await htmlOf(await fromTemplate(template.id, `Neu ${stamp}`))).toContain("Tagesordnung alt und neu");
  expect(await htmlOf(earlier)).not.toContain("und neu");

  // Replace from page …: another page's content, after confirming.
  const replacement = `Ersatz ${stamp}`;
  await withText(replacement, "<p>Ganz anderer Inhalt</p>");
  await page.reload();
  const again = await editTemplate(page, name);
  await again.getByRole("button", { name: "Aus Seite ersetzen …" }).click();
  const replace = page.getByRole("dialog", { name: "Inhalt aus Seite ersetzen" });
  await replace.getByLabel("Seite").selectOption({ label: replacement });
  await expect(replace).toContainText("Bereits erstellte Seiten werden nicht verändert.");
  await replace.getByRole("button", { name: "Inhalt ersetzen" }).click();
  await expect(replace).toBeHidden();
  expect(await htmlOf(await fromTemplate(template.id, `Neu 2 ${stamp}`))).toContain("Ganz anderer Inhalt");

  // A draft discarded: the template stays as it is.
  await page.keyboard.press("Escape");
  const third = await editTemplate(page, name);
  await third.getByRole("button", { name: "Inhalt bearbeiten" }).click();
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(editor).toContainText("Ganz anderer Inhalt");
  const discardedId = new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)![1];
  await bar.getByRole("button", { name: "Verwerfen" }).click();
  const confirm = page.getByRole("dialog", { name: "Entwurf verwerfen" });
  await confirm.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.getByText("Entwurf verworfen")).toBeVisible();
  expect((await page.request.get(`/api/pages/${discardedId}`)).status()).toBe(404);
  expect(await htmlOf(await fromTemplate(template.id, `Neu 3 ${stamp}`))).toContain("Ganz anderer Inhalt");
  expect(errors).toEqual([]);
});
