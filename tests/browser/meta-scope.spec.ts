import { test, expect, type Page } from "@playwright/test";

// Tags, properties and templates of a space (#136): a tag created on a page
// belongs to its space, a move into another space asks what becomes of it,
// and a template of one space used in another resolves its tags there.
const shots = process.env.SCOPE_SCREENSHOTS;

async function setup(page: Page, label: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const stamp = `${label} ${Date.now()}`;
  const home = boot.spaces[0] as { id: string; name: string };
  const other = await command({ action: "space.create", name: `Entwicklung ${stamp}` });
  const tags = async () =>
    ((await (await page.request.get(`/api/tags?workspace=${boot.workspace.id}`)).json()) as { tags: { id: string; name: string; spaceId: string | null }[] }).tags;
  return { boot, command, stamp, home, other: { id: other.id as string, name: `Entwicklung ${stamp}` }, tags };
}

test("a tag created on a page belongs to the page's space unless chosen for the workspace", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const { command, stamp, home, tags } = await setup(page, "Tag");
  const doc = await command({ action: "page.create", spaceId: home.id, title: `Angebot ${stamp}`, kind: "document" });
  await page.goto(`/#page=${doc.id}`);
  const bar = page.getByRole("region", { name: "Tags und Eigenschaften" });
  await bar.getByRole("button", { name: "Tag", exact: true }).click();
  const name = `Vertrieb-${Date.now()}`;
  await page.getByRole("combobox", { name: "Tag hinzufügen" }).fill(name);
  // Both scopes are offered: this space first, then the whole workspace (owners).
  const listbox = page.getByRole("listbox", { name: "Tags" });
  await expect(listbox.getByRole("option")).toHaveText([`„${name}“ in diesem Bereich anlegen`, `„${name}“ im ganzen Arbeitsbereich anlegen`]);
  if (shots) await page.screenshot({ path: `${shots}/tag-picker-scopes.png`, clip: { x: 0, y: 0, width: 1440, height: 560 } });
  await page.keyboard.press("Enter");
  await expect(bar.locator(".page-tag", { hasText: name })).toBeVisible();
  const made = (await tags()).find((t) => t.name === name)!;
  expect(made.spaceId).toBe(home.id);
  // Settings list it with the space's badge.
  await page.goto("/#settings/tags");
  const row = page.locator(".tag-settings-row", { has: page.locator(`input[value="${name}"]`) });
  await expect(row.locator(".scope-badge")).toHaveText(home.name);
  if (shots) await row.screenshot({ path: `${shots}/settings-tag-badge.png` });
});

test("moving a page into another space asks what becomes of its space's tags", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const { command, stamp, home, other, tags } = await setup(page, "Move");
  const name = `Kunde-${Date.now()}`;
  const tag = await command({ action: "tag.save", name, spaceId: home.id });
  const doc = await command({ action: "page.create", spaceId: home.id, title: `Projekt ${stamp}`, kind: "document" });
  await command({ action: "page.properties", pageId: doc.id, addTags: [tag.id] });
  await page.goto(`/#page=${doc.id}`);
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Verschieben", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Seite verschieben" });
  await dialog.getByRole("combobox", { name: "Bereich", exact: true }).selectOption({ label: other.name });
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  // The step: the space's tag, copied by default.
  const step = page.getByRole("dialog", { name: "Tags und Eigenschaften mitnehmen" });
  await expect(step).toContainText(name);
  const choice = step.getByRole("combobox", { name: `Was mit „${name}“ geschieht` });
  await expect(choice).toHaveValue("copy");
  if (shots) await step.screenshot({ path: `${shots}/move-step.png` });
  await step.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(step).toHaveCount(0);
  const moved = await (await page.request.get(`/api/pages/${doc.id}`)).json();
  expect(moved.page.space_id).toBe(other.id);
  // The page carries a copy of the tag in its new space; the original stays.
  const after = await tags();
  const copy = after.find((t) => t.name === name && t.spaceId === other.id)!;
  expect(moved.properties.tags).toEqual([copy.id]);
  expect(after.some((t) => t.id === tag.id && t.spaceId === home.id)).toBe(true);
});

test("a template of one space used in another brings its tags along as chosen", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const { command, stamp, home, other, tags } = await setup(page, "Vorlage");
  const name = `Lead-${Date.now()}`;
  const source = await command({ action: "page.create", spaceId: home.id, title: `Angebotsvorlage ${stamp}`, kind: "document" });
  await command({ action: "page.properties", pageId: source.id, addTags: [name] });
  const template = await command({ action: "template.save", pageId: source.id, name: `Angebot ${stamp}` });
  await page.goto("/#home");
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  await create.getByRole("combobox", { name: "Bereich", exact: true }).selectOption({ label: other.name });
  await create.getByRole("radio", { name: /Aus Vorlage/ }).click();
  const gallery = page.getByRole("dialog", { name: "Vorlagen" });
  // Only the target space's and the workspace's templates at first.
  const row = gallery.locator(".saved-template-row", { hasText: `Angebot ${stamp}` });
  await expect(row).toHaveCount(0);
  await gallery.getByRole("combobox", { name: "Vorlagen welcher Bereiche" }).selectOption("all");
  await expect(row.locator(".scope-badge")).toHaveText(home.name);
  await row.getByRole("button", { name: "Verwenden" }).click();
  const step = page.getByRole("dialog", { name: "Tags und Eigenschaften der Vorlage" });
  await expect(step).toContainText(name);
  if (shots) await step.screenshot({ path: `${shots}/template-step.png` });
  await step.getByRole("button", { name: "Weiter" }).click();
  await expect(page.locator(".page-title")).toHaveValue(`Angebot ${stamp}`);
  const created = (await (await page.request.get("/api/bootstrap")).json()).pages.find(
    (p: { title: string; space_id: string }) => p.title === `Angebot ${stamp}` && p.space_id === other.id,
  );
  expect(created, "page created in the other space").toBeTruthy();
  const data = await (await page.request.get(`/api/pages/${created.id}`)).json();
  const copy = (await tags()).find((t) => t.name === name && t.spaceId === other.id)!;
  expect(data.properties.tags).toEqual([copy.id]);
  expect(template.id).toBeTruthy();
});
