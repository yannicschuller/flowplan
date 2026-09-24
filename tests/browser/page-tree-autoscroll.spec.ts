import { test, expect } from "@playwright/test";

test("dragging a page by its handle scrolls the page list at the edges", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Handle drag is touch-only.");
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
  const tag = `scroll${Date.now()}`;
  const ids: string[] = [];
  for (let i = 0; i < 30; i++)
    ids.push(
      (
        await command({
          action: "page.create",
          workspaceId: boot.workspace.id,
          spaceId: boot.spaces[0].id,
          title: `Seite ${String(i).padStart(2, "0")} ${tag}`,
        })
      ).id,
    );
  await page.goto(`/#page=${ids[0]}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  const nav = page.locator(".sidebar");
  const handle = nav.getByRole("button", { name: `Seite 00 ${tag} ziehen` });
  await handle.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await handle.boundingBox())?.x)
    .toBeGreaterThanOrEqual(0);
  const scrollTop = () =>
    handle.evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const { overflowY } = getComputedStyle(n);
        if (/(auto|scroll)/.test(overflowY) && n.scrollHeight > n.clientHeight)
          return n.scrollTop;
      }
      return -1;
    });
  const start = await scrollTop();
  expect(start).toBeGreaterThanOrEqual(0);
  const from = (await handle.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const height = page.viewportSize()!.height;
  // Resting near the bottom edge keeps scrolling without further movement.
  await page.mouse.move(from.x + from.width / 2, height - 6, { steps: 6 });
  await expect.poll(scrollTop).toBeGreaterThan(start + 200);
  const last = nav.locator(`.page-nav[data-page-id="${ids[29]}"]`);
  // The list keeps scrolling until its end, where it stops.
  let previous = -1;
  await expect
    .poll(async () => {
      const now = await scrollTop(),
        settled = now === previous;
      previous = now;
      return settled;
    })
    .toBe(true);
  expect((await last.boundingBox())!.y).toBeLessThan(height - 100);
  const box = (await last.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await expect(last).toHaveClass(/drop-inside/);
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${ids[0]}`)).json()).page
          .parent_id,
    )
    .toBe(ids[29]);
  expect(errors).toEqual([]);
  // The moved page goes to the trash with its new parent.
  for (const id of ids.slice(1))
    await command({ action: "page.delete", pageId: id });
});
