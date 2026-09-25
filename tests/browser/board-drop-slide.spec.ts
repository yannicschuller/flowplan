import { test, expect } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "Maus-Ziehen");

test("board drags show the insertion line and the card slides into place", async ({
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
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Live-Board ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Offen", "Fertig"],
      },
    ],
    views: [
      {
        id: "b",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "status",
      },
    ],
  });
  for (const [title, status] of [
    ["Eins", "Offen"],
    ["Zwei", "Offen"],
    ["Drei", "Fertig"],
    ["Vier", "Fertig"],
  ])
    await command({
      action: "row.create",
      pageId: p.id,
      cells: { title, status },
    });
  await page.goto(`/#page=${p.id}`);
  const column = (name: string) =>
    page.getByRole("region", { name: `Gruppe ${name}`, exact: true });
  const titles = (name: string) =>
    column(name).locator(
      ".record-card-wrap:not(.drag-source) .record-card strong",
    );
  await expect(titles("Fertig")).toHaveText(["Drei", "Vier"]);
  const source = column("Offen").locator(".record-card", { hasText: "Eins" });
  const target = column("Fertig").locator(".record-card", { hasText: "Vier" });
  await source.hover();
  await page.mouse.down();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6, { steps: 12 });
  // While dragging only the insertion line shows; nothing jumps around.
  await expect(
    column("Fertig").locator(".record-card-wrap", { hasText: "Vier" }),
  ).toHaveClass(/order-drop-before/);
  await expect(titles("Fertig")).toHaveText(["Drei", "Vier"]);
  await expect(titles("Offen")).toHaveText(["Eins", "Zwei"]);
  await page.mouse.up();
  // After dropping, the card slides into its new place.
  await expect(
    column("Fertig").locator(".record-card-wrap.row-sliding"),
  ).toHaveCount(1);
  await expect(titles("Fertig")).toHaveText(["Drei", "Eins", "Vier"]);
  await expect
    .poll(
      async () =>
        (await read()).rows.find(
          (r: { cells: { title: string } }) => r.cells.title === "Eins",
        ).cells.status,
    )
    .toBe("Fertig");
  await page.reload();
  await expect(titles("Fertig")).toHaveText(["Drei", "Eins", "Vier"]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
