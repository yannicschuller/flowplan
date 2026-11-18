import { test, expect, type Page } from "@playwright/test";

// Switching database views cross-fades (#338, components/database-view.tsx,
// app/globals.css). While a view transition runs the browser hit-tests
// past every element taking part in it: when the new view took part, a
// click or tap in the first 100–200 ms after the switch went to the
// .database around it and was lost. The new view stays out of the
// transition (only the old one fades out over it), so a click right after
// the switch reaches the new table – on the desktop with the mouse, on the
// phone with a tap. With reduced motion the views swap without a fade.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function fixture(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Ansicht wechseln ${Date.now()}` });
  await command({
    action: "database.update",
    pageId: db.id,
    version: 1,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "done", name: "Erledigt", type: "checkbox" },
    ],
    views: [
      { id: "list", name: "Liste", type: "list", filters: [], sorts: [] },
      // Narrow columns: "Erledigt" is on screen beside the pinned title on the phone too.
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], fieldOrder: ["title", "done"], columnWidths: { title: 140, done: 100 } },
    ],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Einkaufen", done: false } });
  const done = async () => ((await (await page.request.get(`/api/pages/${db.id}`)).json()).rows.find((r: { id: string }) => r.id === row.id).cells.done as boolean) ?? false;
  return { db, row, done, command };
}

for (const motion of ["full", "reduced"] as const)
  test(`a click right after switching views reaches the new view (${motion} motion)`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (motion === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    const mobile = info.project.name === "mobile";
    const { db, row, done, command } = await fixture(page);
    try {
      await page.goto(`/#page=${db.id}`);
      const tabs = page.locator(".database-tabs");
      await expect(tabs.getByRole("button", { name: "Liste", exact: true })).toHaveAttribute("aria-current", "true", { timeout: 30_000 });
      await expect(page.getByText("Einkaufen").first()).toBeVisible();
      const tab = (await tabs.getByRole("button", { name: "Tabelle", exact: true }).boundingBox())!;
      const press = (x: number, y: number) => (mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));

      // Switch, wait only until the new table's "Erledigt" cell is laid out
      // (polled every frame), and click its middle at once (a click there
      // ticks it). No actionability checks: they would wait for the point
      // to take hits. The page notes when the cell appeared and when the
      // press arrived.
      await page.evaluate(() => {
        const w = window as Window & { pressedAt?: number };
        addEventListener("pointerdown", () => void (w.pressedAt = performance.now()), true);
      });
      await press(tab.x + tab.width / 2, tab.y + tab.height / 2);
      const found = await page.waitForFunction(
        (id) => {
          const box = document.querySelector(`tr[data-row-id="${id}"] > td:nth-child(3)`)?.getBoundingClientRect();
          // Whether the cross-fade runs: its animations are on the ::view-transition pseudo-elements.
          const fading = document.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition"));
          return box && box.width > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2, at: performance.now(), fading } : null;
        },
        row.id,
        { polling: "raf" },
      );
      const cell = (await found.jsonValue())!;
      await press(cell.x, cell.y);
      const delay = await page.evaluate((since) => (window as Window & { pressedAt?: number }).pressedAt! - since, cell.at);
      info.annotations.push({ type: "click delay", description: `${Math.round(delay)} ms after the new table appeared` });
      // Within the cross-fade (100–200 ms); later the spec would prove nothing.
      expect(delay).toBeLessThan(50);
      expect(cell.fading).toBe(motion === "full");

      await expect(page.locator(`tr[data-row-id="${row.id}"] > td:nth-child(3) .check-display.checked`)).toBeVisible();
      await expect.poll(done).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await command({ action: "page.delete", pageId: db.id }).catch(() => {});
    }
  });
