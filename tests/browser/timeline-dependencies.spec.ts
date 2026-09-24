import { test, expect } from "@playwright/test";

test("timeline dependencies draw arrows, flag conflicts and move successors", async ({
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
    title: `Dependencies ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
      { id: "after", name: "Nach", type: "relation", relationPage: p.id },
    ],
    views: [
      {
        id: "timeline",
        name: "Timeline",
        type: "timeline",
        filters: [],
        sorts: [],
        dateField: "start",
        endDateField: "end",
      },
    ],
  });
  const now = new Date();
  const day = (n: number) =>
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
  const a = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Konzept", start: day(2), end: day(6) },
  });
  const b = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Umsetzung", start: day(4), end: day(8), after: [a.id] },
  });
  await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Test", start: day(14), end: day(16), after: [b.id] },
  });
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".timeline-view")).toBeVisible();
  await expect(page.locator(".timeline-dependencies")).toHaveCount(0);
  const select = page.getByLabel("Timeline: Abhängigkeiten", { exact: true });
  await select.selectOption({ label: "Nach" });
  await expect
    .poll(
      async () => (await read()).database.views[0].timeline?.dependencyField,
    )
    .toBe("after");
  const paths = page.locator(".timeline-dependencies > path");
  await expect(paths).toHaveCount(2);
  await expect(
    page.locator(".timeline-dependencies > path.conflict"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("img", {
      name: "Umsetzung beginnt vor dem Ende von Konzept",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/timeline-dependencies-verification/${testInfo.project.name}-conflict.png`,
  });
  await page
    .getByRole("button", {
      name: "Umsetzung hinter Vorgänger verschieben",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => {
      const row = (await read()).rows.find(
        (r: { id: string }) => r.id === b.id,
      );
      return [row.cells.start, row.cells.end];
    })
    .toEqual([day(7), day(11)]);
  await expect(
    page.locator(".timeline-dependencies > path.conflict"),
  ).toHaveCount(0);
  await expect(page.locator(".timeline-conflict")).toHaveCount(0);
  await page.reload();
  await expect(paths).toHaveCount(2);

  // Extending the first entry pushes the whole chain in one step.
  const first = (await read()).rows.find((r: { id: string }) => r.id === a.id);
  await command({
    action: "row.update",
    pageId: p.id,
    rowId: a.id,
    version: first.version,
    cells: { end: day(12) },
  });
  await page.reload();
  await page.getByRole("button", { name: "Alle Konflikte nachziehen" }).click();
  await expect
    .poll(async () =>
      (await read()).rows
        .filter((r: { id: string }) => r.id !== a.id)
        .map((r: { cells: { start: string } }) => r.cells.start)
        .sort(),
    )
    .toEqual([day(13), day(18)]);
  await expect(
    page.locator(".timeline-dependencies > path.conflict"),
  ).toHaveCount(0);
  // End-to-end links: successors must not end before their predecessor.
  const longer = (await read()).rows.find((r: { id: string }) => r.id === a.id);
  await command({
    action: "row.update",
    pageId: p.id,
    rowId: a.id,
    version: longer.version,
    cells: { end: day(25) },
  });
  await page.reload();
  await page
    .getByLabel("Timeline: Art der Abhängigkeit", { exact: true })
    .selectOption({ label: "Ende → Ende" });
  await expect
    .poll(
      async () => (await read()).database.views[0].timeline?.dependencyType,
    )
    .toBe("ff");
  await expect(
    page.getByRole("img", {
      name: "Umsetzung endet vor dem Ende von Konzept",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alle Konflikte nachziehen" }).click();
  await expect
    .poll(async () =>
      (await read()).rows
        .filter((r: { id: string }) => r.id !== a.id)
        .map((r: { cells: { end: string } }) => r.cells.end),
    )
    .toEqual([day(25), day(25)]);
  await expect(page.locator(".timeline-conflict")).toHaveCount(0);
  // A cycle is flagged and offers no automatic move.
  const rowA = (await read()).rows.find((r: { id: string }) => r.id === a.id);
  await command({
    action: "row.update",
    pageId: p.id,
    rowId: a.id,
    version: rowA.version,
    cells: { after: [b.id] },
  });
  await page.reload();
  await expect(
    page.getByRole("img", {
      name: "Konzept: zyklische Abhängigkeit",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Konzept hinter Vorgänger verschieben",
      exact: true,
    }),
  ).toHaveCount(0);
  await select.selectOption({ label: "Keine" });
  await expect
    .poll(
      async () => (await read()).database.views[0].timeline?.dependencyField,
    )
    .toBeUndefined();
  await expect(page.locator(".timeline-dependencies")).toHaveCount(0);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
