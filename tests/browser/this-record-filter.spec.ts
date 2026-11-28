import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// "Relation = this record" (#649): a linked view of Tasks in a project's
// content shows that project's tasks; "+ Neu" relates the new task to the
// project; a record template keeps the reference for every new project.
const THIS_RECORD = "@this-record";

test("linked views filtered by this record, + New and record templates", async ({ page }, info) => {
  test.setTimeout(180_000);
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
  const read = async (id: string) => (await page.request.get(`/api/pages/${id}`)).json();
  const tag = `${info.project.name}${Date.now()}`;
  const database = (title: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  const projects = await database(`Projects ${tag}`),
    tasks = await database(`Tasks ${tag}`);
  await command({
    action: "database.update",
    pageId: tasks.id,
    version: (await read(tasks.id)).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "project", name: "Project", type: "relation", relationPage: projects.id },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], hiddenFields: ["project"] }],
  });
  const row = async (pageId: string, cells: Record<string, unknown>, extra = {}) =>
    (await command({ action: "row.create", pageId, cells, ...extra })).id as string;
  const alpha = await row(projects.id, { title: "Alpha" }),
    beta = await row(projects.id, { title: "Beta" });
  await row(tasks.id, { title: "Alpha design", project: [alpha] });
  await row(tasks.id, { title: "Alpha review", project: [alpha] });
  await row(tasks.id, { title: "Beta launch", project: [beta] });
  await row(tasks.id, { title: "Loose task" });

  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true }).first();
  const insertTasks = async (related: boolean) => {
    const content = entry.getByLabel("Dokumentinhalt", { exact: true });
    await content.click();
    await entry.getByRole("button", { name: "Block hinzufügen", exact: true }).click();
    await page.locator(".slash-menu").getByRole("option", { name: /^Verknüpfte Datenbank/ }).first().click();
    const picker = page.getByRole("dialog", { name: "Datenbank verknüpfen", exact: true });
    if (related)
      await picker.getByRole("checkbox", { name: "Nur Einträge zeigen, die mit diesem Eintrag verknüpft sind" }).check();
    await picker.getByLabel("Datenquelle suchen", { exact: true }).fill(`Tasks ${tag}`);
    await picker.getByRole("button", { name: `Tasks ${tag}`, exact: true }).click();
    await expect(picker).not.toBeVisible();
  };
  const titles = (embed: ReturnType<Page["locator"]>) => embed.locator(".data-table tbody .title-cell");

  // Alpha: the filter set by hand – Project = this record.
  await page.goto(`/#page=${projects.id}&row=${alpha}`);
  await insertTasks(false);
  const embed = entry.locator(".linked-database");
  await expect(titles(embed)).toHaveCount(4, { timeout: 30_000 });
  await embed.getByRole("button", { name: /^Filtern/ }).click();
  await embed.getByRole("button", { name: "Erweitert …", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter bearbeiten", exact: true });
  await filter.getByRole("button", { name: "Bedingung hinzufügen", exact: true }).click();
  await filter.getByLabel("Filter-Eigenschaft", { exact: true }).selectOption("project");
  await expect(filter.getByLabel("Filterwert", { exact: true }).locator("option", { hasText: "Dieser Eintrag" })).toHaveCount(1);
  await filter.getByLabel("Filterwert", { exact: true }).selectOption(THIS_RECORD);
  await expect(filter.locator(".filter-preview")).toContainText("2 von 4");
  await filter.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(filter).not.toBeVisible();
  await expect(titles(embed)).toHaveText(["Alpha design", "Alpha review"]);
  mkdirSync("/tmp/claude-0/-home-user/f16eb679-8174-54bb-ad77-fd87de0398b3/scratchpad/649", { recursive: true });
  await page.screenshot({ path: `/tmp/claude-0/-home-user/f16eb679-8174-54bb-ad77-fd87de0398b3/scratchpad/649/${info.project.name}-filtered.png` });

  // + Neu: the new task belongs to Alpha, although "Project" is hidden in the view.
  await embed.getByRole("button", { name: "Neu", exact: true }).click();
  await expect
    .poll(async () =>
      (await read(tasks.id)).rows
        .filter((r: { cells: { project?: string[] } }) => r.cells.project?.includes(alpha))
        .map((r: { cells: { title: string } }) => r.cells.title)
        .sort(),
    )
    .toEqual(["Alpha design", "Alpha review", "Neuer Eintrag"]);
  // Back to Alpha (on wide screens Escape closes the new record and Alpha).
  await page.keyboard.press("Escape");
  await page.goto(`/#page=${projects.id}&row=${alpha}`);
  await page.reload();
  await expect(titles(embed)).toHaveCount(3, { timeout: 30_000 });
  // The record's content stores the token, not Alpha's id.
  await expect
    .poll(async () => (await read(projects.id)).rows.find((r: { id: string }) => r.id === alpha).content)
    .toContain(THIS_RECORD);

  // Beta: in one step from the picker.
  await page.goto(`/#page=${projects.id}&row=${beta}`);
  await insertTasks(true);
  await expect(titles(entry.locator(".linked-database"))).toHaveText(["Beta launch"], { timeout: 30_000 });

  // A record template from Alpha: every new project shows its own tasks.
  await expect
    .poll(async () => (await read(projects.id)).rows.find((r: { id: string }) => r.id === alpha).content)
    .toContain("data-linked-source");
  const template = (await command({ action: "row.template.save", pageId: projects.id, rowId: alpha, name: "Project" })).id;
  const gamma = await row(projects.id, { title: "Gamma" }, { templateId: template }),
    delta = await row(projects.id, { title: "Delta" }, { templateId: template });
  await row(tasks.id, { title: "Gamma kickoff", project: [gamma] });
  await row(tasks.id, { title: "Delta budget", project: [delta] });
  await row(tasks.id, { title: "Delta hiring", project: [delta] });
  for (const [record, expected] of [
    [gamma, ["Gamma kickoff"]],
    [delta, ["Delta budget", "Delta hiring"]],
  ] as const) {
    await page.goto(`/#page=${projects.id}&row=${record}`);
    await expect(titles(entry.locator(".linked-database"))).toHaveText([...expected], { timeout: 30_000 });
  }
  await page.screenshot({ path: `/tmp/claude-0/-home-user/f16eb679-8174-54bb-ad77-fd87de0398b3/scratchpad/649/${info.project.name}-template.png` });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: projects.id });
  await command({ action: "page.delete", pageId: tasks.id });
});
