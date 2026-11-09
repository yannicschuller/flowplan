import { test, expect } from "@playwright/test";
import { openSidebarTool } from "./sidebar-tools";

// The trash (#123, #124): pages with an emoji, a library icon or none line up;
// a page is deleted permanently with its sub-pages after a confirmation that
// names them; "Papierkorb leeren" deletes the rest.
test("trash: aligned icons, delete permanently, empty trash", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const cmd = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    return { status: response.status(), body: await response.json() };
  };
  await cmd({ action: "profile.onboarded" });
  const tag = `${testInfo.project.name}${Date.now()}`;
  const create = async (title: string, icon?: string, parentId?: string) => {
    const { body } = await cmd({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, parentId });
    if (icon) await cmd({ action: "page.update", pageId: body.id, patch: { icon } });
    return body.id as string;
  };
  const rocket = await create(`Rakete ${tag}`, "🚀");
  await create(`Unterseite ${tag}`, undefined, rocket);
  const target = await create(`Ziel ${tag}`, "icon:Target:#d44c47");
  const plain = await create(`Schlicht ${tag}`);
  for (const id of [rocket, target, plain]) await cmd({ action: "page.delete", pageId: id });

  await page.goto("/#trash");
  await expect(page.getByRole("heading", { name: "Papierkorb", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Wird nach 30 Tagen endgültig gelöscht.")).toBeVisible();
  const row = (title: string) => page.locator(".trash-row", { hasText: title });
  await expect(row(`Rakete ${tag}`)).toContainText("noch 30 Tage");

  // #124: the titles start at the same left edge.
  const lefts = [];
  for (const title of [`Rakete ${tag}`, `Ziel ${tag}`, `Schlicht ${tag}`]) {
    await row(title).scrollIntoViewIfNeeded();
    lefts.push((await row(title).locator(".trash-title").boundingBox())!.x);
  }
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(1);

  // One page with its sub-page, after a confirmation naming both.
  await row(`Rakete ${tag}`).getByRole("button", { name: `„Rakete ${tag}“ endgültig löschen` }).click();
  const confirm = page.getByRole("dialog", { name: "Endgültig löschen" });
  await expect(confirm).toContainText(`„Rakete ${tag}“ und 1 Unterseite endgültig löschen?`);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/purge-dialog-${testInfo.project.name}.png` });
  await confirm.getByRole("button", { name: "Endgültig löschen" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(`Rakete ${tag}`)).toHaveCount(0);
  await expect(row(`Unterseite ${tag}`)).toHaveCount(0);
  expect((await cmd({ action: "page.restore", pageId: rocket })).status).toBe(404);
  await expect(row(`Ziel ${tag}`)).toBeVisible();

  // Everything else.
  await page.getByRole("button", { name: "Papierkorb leeren" }).click();
  const empty = page.getByRole("dialog", { name: "Papierkorb leeren" });
  await expect(empty).toContainText("Endgültig löschen:");
  await expect(empty).toContainText("Seiten");
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/empty-dialog-${testInfo.project.name}.png` });
  await empty.getByRole("button", { name: "Papierkorb leeren" }).click();
  await expect(page.getByText("Dein Papierkorb ist leer.")).toBeVisible();
  for (const id of [target, plain]) expect((await cmd({ action: "page.restore", pageId: id })).status).toBe(404);
  expect(errors).toEqual([]);
});

// The template trash (#123): one template deleted for good, then the rest.
test("template trash: delete permanently and empty", async ({ page }, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const cmd = async (data: Record<string, unknown>) =>
    (await page.request.post("/api/command", { headers: { origin }, data })).json();
  await cmd({ action: "profile.onboarded" });
  const tag = `${testInfo.project.name}${Date.now()}`;
  const source = (await cmd({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Quelle ${tag}` })).id;
  for (const name of [`Eins ${tag}`, `Zwei ${tag}`]) {
    const { id } = await cmd({ action: "template.save", pageId: source, name });
    await cmd({ action: "template.delete", workspaceId: boot.workspace.id, templateId: id, version: 1 });
  }
  await page.goto("/#home");
  if (testInfo.project.name === "mobile") await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
  await openSidebarTool(page, "Vorlagen");
  const gallery = page.getByRole("dialog", { name: "Vorlagen", exact: true });
  await gallery.getByRole("checkbox", { name: /Vorlagen-Papierkorb/ }).check();
  await expect(gallery.getByText("Vorlagen im Papierkorb werden nach 30 Tagen endgültig gelöscht.")).toBeVisible();
  await gallery.getByRole("button", { name: `Eins ${tag} endgültig löschen` }).click();
  const confirm = page.getByRole("dialog", { name: "Vorlage endgültig löschen" });
  await expect(confirm).toContainText(`Eins ${tag}`);
  await confirm.getByRole("button", { name: "Endgültig löschen" }).click();
  await expect(gallery.getByText(`Eins ${tag}`)).toHaveCount(0);
  await expect(gallery.getByText(`Zwei ${tag}`)).toBeVisible();
  await gallery.getByRole("button", { name: "Vorlagen-Papierkorb leeren" }).click();
  await page.getByRole("dialog", { name: "Vorlagen-Papierkorb leeren" }).getByRole("button", { name: "Vorlagen-Papierkorb leeren" }).click();
  await expect(gallery.getByText("Keine gelöschten Vorlagen.")).toBeVisible();
});
