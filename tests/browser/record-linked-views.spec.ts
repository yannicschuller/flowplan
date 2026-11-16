import { test, expect } from "@playwright/test";

test("record documents embed linked database views", async ({
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
  const database = (title: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title,
      kind: "database",
    });
  const projects = await database(`Projekte ${tag}`),
    tasks = await database(`Aufgaben ${tag}`);
  for (const title of ["Entwurf", "Review"])
    await command({ action: "row.create", pageId: tasks.id, cells: { title } });
  const record = await command({
    action: "row.create",
    pageId: projects.id,
    cells: { title: "Relaunch" },
  });
  await page.goto(`/#page=${projects.id}&row=${record.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const content = entry.getByLabel("Dokumentinhalt", { exact: true });
  await content.click();
  await entry
    .getByRole("button", { name: "Block hinzufügen", exact: true })
    .click();
  await page.locator(".slash-menu").getByRole("option", { name: /^Verknüpfte Datenbank/ }).first().click();
  const picker = page.getByRole("dialog", {
    name: "Datenbank verknüpfen",
    exact: true,
  });
  await picker
    .getByLabel("Datenquelle suchen", { exact: true })
    .fill(`Aufgaben ${tag}`);
  await picker
    .getByRole("button", { name: `Aufgaben ${tag}`, exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  const embedded = entry.locator(".linked-database");
  await expect(embedded).toContainText(`Aufgaben ${tag}`);
  await expect(embedded.locator(".data-table tbody tr")).toHaveCount(2, { timeout: 30_000 }); // The linked view loads its own code first.
  const read = async (id: string) =>
    (await page.request.get(`/api/pages/${id}`)).json();
  await expect
    .poll(
      async () =>
        (await read(projects.id)).rows.find(
          (r: { id: string }) => r.id === record.id,
        ).content,
    )
    .toContain(`data-linked-source="${tasks.id}"`);
  // Reopening the record loads the embedded view again. First the app boots
  // and the record's editor appears – as on the first visit (the click on
  // the content above waits for it the same way, without an expect
  // timeout): against `next dev` that alone takes about 4–6 s, the CPU busy
  // with React's development checks over the whole workspace (StrictMode
  // renders twice, every JSX element records its owner stack). Only the
  // embed's own loading is what the check below times.
  await page.reload();
  await content.waitFor();
  await expect(
    entry.locator(".linked-database .data-table tbody tr"),
  ).toHaveCount(2);
  await page.screenshot({
    path: `test-results/record-linked-verification/${testInfo.project.name}.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: projects.id });
  await command({ action: "page.delete", pageId: tasks.id });
});
