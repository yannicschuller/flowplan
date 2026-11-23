import { test, expect, type Page } from "@playwright/test";

// Attachments, page mentions and links in page comments and in replies to
// text comments (#450): files by the paperclip, image previews open in the
// image viewer, other files are chips, "@" finds pages as well as people,
// and a page mention is a link that opens the page.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const LOAD = 30_000;
// A 2×2 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.commentMargin", commentMargin: false });
  const target = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Zielseite ${title}` });
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title });
  return { command, target, p };
}
async function openComments(page: Page) {
  const mobile = test.info().project.name === "mobile";
  if (mobile) {
    await page.getByRole("button", { name: /Seitenmenü|Weitere Aktionen|Mehr/ }).first().click();
    await page.getByRole("menuitem", { name: "Kommentare", exact: true }).click();
  } else await page.getByRole("button", { name: "Kommentare", exact: true }).click();
  return page.locator(".comments-panel");
}

test("a page comment with an image, a file, a page mention and a link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The comments panel's phone layout has its own specs.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = `Anhänge ${testInfo.project.name} ${Date.now()}`;
  const { command, target, p } = await setup(page, title);
  await page.goto(`/#page=${p.id}`);
  const panel = await openComments(page);
  const field = panel.getByRole("textbox", { name: "Kommentar", exact: true });
  await expect(field).toBeVisible({ timeout: LOAD });
  // Two files at once, by the paperclip's file field.
  await panel.locator('input[type="file"]').setInputFiles([
    { name: "foto.png", mimeType: "image/png", buffer: PNG },
    { name: "notizen.txt", mimeType: "text/plain", buffer: Buffer.from("Hallo") },
  ]);
  const draftFiles = panel.locator(".comment-composer .comment-files");
  await expect(draftFiles.getByRole("button", { name: "Bild öffnen: foto.png" })).toBeVisible({ timeout: LOAD });
  await expect(draftFiles.getByText("notizen.txt")).toBeVisible();
  await field.click();
  await page.keyboard.type("Siehe ");
  // "@" offers pages too.
  await page.keyboard.type("@Zielseite");
  const option = panel.getByRole("option", { name: new RegExp(`Zielseite ${title}`) });
  await expect(option).toBeVisible({ timeout: LOAD });
  await option.click();
  await page.keyboard.type("und https://example.org/info ");
  await panel.getByRole("button", { name: "Kommentieren", exact: true }).click();
  await expect(field).toHaveText("");

  const comment = panel.locator(".comment").filter({ hasText: "Siehe" });
  await expect(comment).toBeVisible({ timeout: LOAD });
  // The link is a link; the file a download chip.
  await expect(comment.getByRole("link", { name: "https://example.org/info" })).toHaveAttribute("href", "https://example.org/info");
  const chip = comment.getByRole("link", { name: /notizen\.txt/ });
  await expect(chip).toHaveAttribute("href", /^\/api\/files\//);
  // The image opens in the viewer.
  await comment.getByRole("button", { name: "Bild öffnen: foto.png" }).click();
  const viewer = page.getByRole("dialog", { name: "foto.png" });
  await expect(viewer).toBeVisible();
  await page.screenshot({ path: `test-results/comment-attachments/${testInfo.project.name}-viewer.png` });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await page.screenshot({ path: `test-results/comment-attachments/${testInfo.project.name}-comment.png` });
  // Stored on the server with the files' own names.
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  const stored = data.comments.find((c: { body: string }) => c.body.startsWith("Siehe"));
  expect(stored.content.attrs.attachments.map((a: { name: string }) => a.name)).toEqual(["foto.png", "notizen.txt"]);
  // The page mention opens the page.
  const mention = comment.getByRole("link", { name: new RegExp(`Zielseite ${title}`) });
  await expect(mention).toHaveAttribute("href", `/#page=${target.id}`);
  await mention.click();
  await expect(page).toHaveURL(new RegExp(`page=${target.id}`));
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
  await command({ action: "page.delete", pageId: target.id });
});

test("a reply to a text comment with an image", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Text comments on phones have their own specs.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = `Antwort ${testInfo.project.name} ${Date.now()}`;
  const { command, target, p } = await setup(page, title);
  await page.goto(`/#page=${p.id}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await content.click();
  await page.keyboard.type("Diese Zahl prüfen");
  await page.keyboard.press("ControlOrMeta+a");
  const toggle = page.getByRole("button", { name: /^Textkommentare \(/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByRole("button", { name: "Neuer Textkommentar", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Kommentar zur Textstelle" });
  await draft.click();
  await page.keyboard.type("Stimmt das?");
  await page.getByRole("button", { name: "Kommentar senden" }).click();
  const region = page.getByRole("region", { name: "Textkommentare" });
  const reply = region.getByRole("textbox", { name: "Antwort", exact: true });
  await expect(reply).toBeVisible({ timeout: LOAD });
  const form = region.locator("form", { has: page.getByRole("textbox", { name: "Antwort", exact: true }) });
  await form.locator('input[type="file"]').setInputFiles([{ name: "beleg.png", mimeType: "image/png", buffer: PNG }]);
  await expect(form.getByRole("button", { name: "Bild öffnen: beleg.png" })).toBeVisible({ timeout: LOAD });
  // An image alone is a reply.
  await region.getByRole("button", { name: "Antwort senden" }).click();
  const sent = region.locator(".inline-comment-message").filter({ has: page.getByRole("button", { name: "Bild öffnen: beleg.png" }) });
  await expect(sent).toBeVisible({ timeout: LOAD });
  await sent.getByRole("button", { name: "Bild öffnen: beleg.png" }).click();
  await expect(page.getByRole("dialog", { name: "beleg.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
  await command({ action: "page.delete", pageId: target.id });
});
