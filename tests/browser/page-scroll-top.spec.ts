import { test, expect, type Page } from "@playwright/test";

// Another page starts at its top (#224): the pane the pages scroll in
// (.main-scroll) kept the position of the page before whenever the new
// page's kept copy came in at full height at once (here: a database opened
// again), so it showed up scrolled down. A link to a block still scrolls to
// that block, and the same page (an edit) does not jump.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const scrollTop = (page: Page) => page.locator(".main-scroll").first().evaluate((el) => el.scrollTop);
const title = (page: Page) => page.locator(".page-title");

test("a page opened from the sidebar, the address or back starts at its top; a block link scrolls to the block", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The sidebar tree is behind the menu on phones; the pane is the same.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const { htmlState } = await import("../../lib/document-server");
  const stamp = Date.now();
  const long = async (name: string) => {
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `${name} ${stamp}` });
    const generation = (await (await page.request.get(`/api/pages/${created.id}`)).json()).generation;
    const paragraphs = Array.from({ length: 80 }, (_, i) => `<p data-block-id="${name}-${i}">${name} Absatz ${i}</p>`).join("");
    await command({ action: "document.sync", pageId: created.id, generation, update: Buffer.from(htmlState(paragraphs)).toString("base64") });
    return created.id as string;
  };
  const a = await long("Lang");
  const b = await long("Weit");
  const table = async (name: string) => {
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `${name} ${stamp}` });
    for (let i = 0; i < 60; i++) await command({ action: "row.create", pageId: created.id, cells: { title: `${name} Zeile ${i}` } });
    return created.id as string;
  };
  const d1 = await table("Tabelle");
  const d2 = await table("Liste");
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });

  await page.goto(`/#page=${a}`);
  await expect(editor.getByText("Lang Absatz 79", { exact: true })).toBeAttached({ timeout: 20_000 });
  await expect(page.locator("article[data-revalidating]")).toHaveCount(0);
  await page.locator(".main-scroll").first().evaluate((el) => (el.scrollTop = 1500));
  await expect.poll(() => scrollTop(page)).toBe(1500);
  // An edit to the same page does not move it.
  await editor.getByText("Lang Absatz 40", { exact: true }).click();
  const editing = await scrollTop(page);
  expect(editing).toBeGreaterThan(1000);
  await page.keyboard.type(" bearbeitet");
  await page.waitForTimeout(600);
  expect(Math.abs((await scrollTop(page)) - editing)).toBeLessThan(50);

  // From the sidebar: page B at its top.
  await page.locator(`.page-nav[data-page-id="${b}"]`).first().click();
  await expect(title(page)).toHaveValue(`Weit ${stamp}`);
  await expect(editor.getByText("Weit Absatz 79", { exact: true })).toBeAttached();
  await expect.poll(() => scrollTop(page)).toBe(0);

  // Back to A: where it was left in that step (#262), not where B was.
  await page.locator(".main-scroll").first().evaluate((el) => (el.scrollTop = 900));
  await page.goBack();
  await expect(title(page)).toHaveValue(`Lang ${stamp}`);
  await expect.poll(async () => Math.abs((await scrollTop(page)) - editing)).toBeLessThan(50);

  // Databases opened again show their kept copy at full height at once:
  // the case that kept the position before.
  for (const id of [d1, d2]) {
    await page.evaluate((hash) => (location.hash = hash), `page=${id}`);
    await expect(page.locator(".main-scroll").first().getByText(/Zeile 59$/).first()).toBeAttached({ timeout: 20_000 });
  }
  for (const [from, to, name] of [
    [d2, d1, "Tabelle"],
    [d1, d2, "Liste"],
  ]) {
    await page.evaluate((hash) => (location.hash = hash), `page=${from}`);
    await expect(page.locator(".main-scroll").first().getByText(/Zeile 59$/).first()).toBeAttached();
    await page.locator(".main-scroll").first().evaluate((el) => (el.scrollTop = 1500));
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
    await page.evaluate((hash) => (location.hash = hash), `page=${to}`);
    await expect(page.locator(".main-scroll").first().getByText(`${name} Zeile 59`).first()).toBeAttached();
    await page.waitForTimeout(500);
    expect(await scrollTop(page)).toBe(0);
  }

  // A block link from a page scrolled down: the block, not the top.
  await page.locator(".main-scroll").first().evaluate((el) => (el.scrollTop = 1200));
  await page.evaluate((hash) => (location.hash = hash), `page=${b}&block=Weit-60`);
  await expect(title(page)).toHaveValue(`Weit ${stamp}`);
  const target = editor.locator('[data-block-id="Weit-60"]');
  await expect(target).toBeInViewport({ timeout: 10_000 });
  expect(await scrollTop(page)).toBeGreaterThan(500);

  await page.goto("/#home");
  for (const id of [a, b, d1, d2]) await command({ action: "page.delete", pageId: id });
});
