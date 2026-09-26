import { test, expect } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "Maus-Ziehen");

test("board cards lift, open a gap in the target column and settle into it", async ({
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
    column(name).locator(".record-card-wrap .record-card strong");
  await expect(titles("Fertig")).toHaveText(["Drei", "Vier"]);
  const source = column("Offen").locator(".record-card", { hasText: "Eins" });
  const target = column("Fertig").locator(".record-card", { hasText: "Vier" });
  const vier = column("Fertig").locator(".record-card-wrap", { hasText: "Vier" });
  await source.hover();
  await page.mouse.down();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6, { steps: 12 });
  // While dragging, a tilted copy follows the pointer, the original stays as
  // a faded placeholder and the target column opens a gap; the DOM order
  // does not change, so nothing jumps under the pointer.
  await expect(page.locator(".board-drag-preview")).toHaveCount(1);
  await expect(
    column("Offen").locator('.record-card-wrap[data-drag="source"]'),
  ).toHaveText(/Eins/);
  await expect(vier).toHaveClass(/order-drop-before/);
  await expect
    .poll(() => vier.evaluate((el) => (el as HTMLElement).style.translate))
    .toMatch(/^0px \d+/);
  await expect(titles("Fertig")).toHaveText(["Drei", "Vier"]);
  await expect(titles("Offen")).toHaveText(["Eins", "Zwei"]);
  if (process.env.BOARD_SHOTS)
    await page.screenshot({ path: `${process.env.BOARD_SHOTS}/drag.png` });
  // Follow "Eins" every frame from the drop on: first the copy, then the
  // real card. It must glide, never jump.
  await page.evaluate(() => {
    const w = window as unknown as { path: number[] };
    w.path = [];
    const until = performance.now() + 1500;
    const tick = () => {
      const preview = document.querySelector(".board-drag-preview");
      const card = [
        ...document.querySelectorAll<HTMLElement>(
          '.board-column[data-group-key] .record-card-wrap:not([data-drag="source"])',
        ),
      ].find((el) => el.textContent?.includes("Eins"));
      const el = preview || card;
      if (el) w.path.push(el.getBoundingClientRect().top);
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.up();
  // The copy settles into the gap, then the card takes its place.
  await expect(titles("Fertig")).toHaveText(["Drei", "Eins", "Vier"]);
  await expect(page.locator(".board-drag-preview")).toHaveCount(0);
  await expect(page.locator('[data-drag="source"]')).toHaveCount(0);
  await expect
    .poll(() => vier.evaluate((el) => (el as HTMLElement).style.translate))
    .toBe("");
  if (process.env.BOARD_SHOTS)
    await page.screenshot({ path: `${process.env.BOARD_SHOTS}/dropped.png` });
  await page.waitForTimeout(1600);
  const path = await page.evaluate(
    () => (window as unknown as { path: number[] }).path,
  );
  const steps = path.slice(1).map((y, i) => Math.abs(y - path[i]));
  expect(Math.max(...steps)).toBeLessThan(30);
  // Reordering inside a column: the placeholder travels, the others yield.
  const drei = column("Fertig").locator(".record-card", { hasText: "Drei" });
  const vierCard = column("Fertig").locator(".record-card", { hasText: "Vier" });
  await drei.hover();
  await page.mouse.down();
  const end = (await vierCard.boundingBox())!;
  await page.mouse.move(end.x + end.width / 2, end.y + end.height - 4, {
    steps: 12,
  });
  await expect(titles("Fertig")).toHaveText(["Drei", "Eins", "Vier"]);
  await page.mouse.up();
  await expect(titles("Fertig")).toHaveText(["Eins", "Vier", "Drei"]);
  await expect(page.locator(".board-drag-preview")).toHaveCount(0);
  // Clicking a card after a drag still opens it.
  await column("Offen").locator(".record-card", { hasText: "Zwei" }).click();
  await expect(page.locator(".row-page, .record-page, [role=dialog]").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (await read()).rows.find(
          (r: { cells: { title: string } }) => r.cells.title === "Eins",
        ).cells.status,
    )
    .toBe("Fertig");
  await page.reload();
  await expect(titles("Fertig")).toHaveText(["Eins", "Vier", "Drei"]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
