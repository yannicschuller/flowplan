import { test, expect } from "@playwright/test";

test("board columns keep an own card order for multi-select rows", async ({
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Card order ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] },
    ],
    views: [
      {
        id: "board",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "tags",
      },
    ],
  });
  for (const title of ["Alpha", "Beta"])
    await command({
      action: "row.create",
      pageId: p.id,
      cells: { title, tags: ["A", "B"] },
    });
  await page.goto(`/#page=${p.id}`);
  const column = (label: string) =>
    page.getByRole("region", { name: `Gruppe ${label}`, exact: true });
  const titles = (label: string) =>
    column(label)
      .locator(".record-card")
      .evaluateAll((cards) =>
        cards.map(
          (c) =>
            c.querySelector("strong, h3, .card-title")?.textContent ||
            c.textContent,
        ),
      );
  await expect(column("A").locator(".record-card")).toHaveCount(2);
  const handle = column("A").getByRole("button", {
    name: "Eintrag verschieben: Beta",
    exact: true,
  });
  if (testInfo.project.name === "desktop") await handle.press("Alt+ArrowUp");
  else {
    await handle.tap();
    const dialog = page.getByRole("dialog", {
      name: "Eintrag verschieben",
      exact: true,
    });
    await dialog.getByRole("button", { name: "Nach oben", exact: true }).tap();
    await expect(dialog).not.toBeVisible();
  }
  await expect
    .poll(async () => (await titles("A")).map((t) => t!.includes("Beta")))
    .toEqual([true, false]);
  await page.reload();
  await expect
    .poll(async () => (await titles("A")).map((t) => t!.includes("Beta")))
    .toEqual([true, false]);
  // The other column is untouched.
  await expect
    .poll(async () => (await titles("B")).map((t) => t!.includes("Alpha")))
    .toEqual([true, false]);
  expect(errors).toEqual([]);
});
