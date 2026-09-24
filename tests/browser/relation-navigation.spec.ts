import { test, expect } from "@playwright/test";

test("relation values link to related records and records list incoming links", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const db = async (title: string) =>
    (
      await command({
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title,
        kind: "database",
      })
    ).id as string;
  const projects = await db(`Projekte ${tag}`),
    tasks = await db(`Aufgaben ${tag}`);
  const read = async (id: string) =>
    (await page.request.get(`/api/pages/${id}`)).json();
  const schema = async (id: string, fields: unknown[]) =>
    command({
      action: "database.update",
      pageId: id,
      version: (await read(id)).database.version,
      fields,
      views: [
        { id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] },
      ],
    });
  await schema(projects, [{ id: "title", name: "Name", type: "text" }]);
  await schema(tasks, [
    { id: "title", name: "Name", type: "text" },
    {
      id: "project",
      name: "Projekt",
      type: "relation",
      relationPage: projects,
    },
  ]);
  const alpha = (
    await command({
      action: "row.create",
      pageId: projects,
      cells: { title: "Alpha" },
    })
  ).id;
  await command({
    action: "row.create",
    pageId: tasks,
    cells: { title: "Entwurf", project: [alpha] },
  });
  await page.goto(`/#page=${tasks}`);
  const link = page.locator(".data-table .relation-links a", {
    hasText: "Alpha",
  });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`page=${projects}.*row=${alpha}`));
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(
    entry.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const backlinks = entry.getByLabel("Verknüpft von");
  await expect(backlinks).toContainText("Entwurf");
  await expect(backlinks).toContainText(`Aufgaben ${tag} · Projekt`);
  await page.screenshot({
    path: `test-results/relation-navigation-verification/${testInfo.project.name}-backlinks.png`,
  });
  await backlinks.getByRole("link", { name: "Entwurf" }).click();
  await expect(page).toHaveURL(new RegExp(`page=${tasks}`));
  await expect(
    entry.getByRole("heading", { name: "Entwurf", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  for (const id of [tasks, projects])
    await command({ action: "page.delete", pageId: id });
});
