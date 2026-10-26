import { test, expect, type Page } from "@playwright/test";

// Feeling instant: optimistic changes (shown before the server answers,
// rolled back with its message when it refuses), "Rückgängig" toasts, and
// pages that open from the tab's cache while the fresh copy loads.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.UX_FEEL_SHOTS;

async function setup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A production build has no demo sign-in: an account given to the test.
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  // No introduction in the way (a first account of an instance sees it).
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const doc = async (title: string, text: string) => {
    const p = await command({ action: "page.import", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, content: text, format: "text" });
    return p.id as string;
  };
  return { errors, boot, command, doc };
}
const tree = (page: Page, title: string) => page.locator(".page-nav").filter({ hasText: title }).first();

test("a task ticked off in Meine Aufgaben shows at once and comes back when the server refuses", async ({ page }, info) => {
  const { errors, boot, command } = await setup(page);
  const title = `Aufgaben sofort ${info.project.name} ${Date.now()}`;
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const taskText = `Rechnung ${info.project.name} ${Date.now()}`;
  await page.keyboard.type(`[] ${taskText}`);
  await page.getByRole("button", { name: "Fälligkeit setzen" }).click();
  await page.locator(".task-due-picker").fill("2020-01-01");
  await expect(editor.locator(".task-due-overdue")).toBeVisible();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/tasks?workspace=${boot.workspace.id}`)).json()), { timeout: 15_000 })
    .toContain(taskText);
  await page.goto("/#tasks");
  const item = page.locator(".my-tasks-group li", { hasText: taskText });
  const box = item.getByRole("checkbox");
  await expect(box).not.toBeChecked();
  // The server refuses: the task is unticked again and the reason shows.
  await page.route("**/api/command", async (route) => {
    if (route.request().postData()?.includes('"task.update"')) {
      await new Promise((r) => setTimeout(r, 700));
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Die Aufgabe wurde inzwischen geändert." }) });
    }
    await route.continue();
  });
  const started = Date.now();
  await box.click();
  await expect(box).toBeChecked({ timeout: 300 });
  const shownAfter = Date.now() - started;
  await expect(page.getByText("Die Aufgabe wurde inzwischen geändert.")).toBeVisible();
  await expect(box).not.toBeChecked();
  info.annotations.push({ type: "check-off shown after (ms)", description: String(shownAfter) });
  // Accepted (but slow): ticked at once, then gone from the open tasks.
  await page.unroute("**/api/command");
  await page.route("**/api/command", async (route) => {
    if (route.request().postData()?.includes('"task.update"')) await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await box.click();
  await expect(box).toBeChecked({ timeout: 300 });
  await expect(page.locator(".my-tasks-group li", { hasText: taskText })).toHaveCount(0, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("a page moved to the trash comes back with Rückgängig", async ({ page }, info) => {
  const { errors, doc } = await setup(page);
  const mobile = info.project.name === "mobile";
  const title = `Wegwerfseite ${info.project.name} ${Date.now()}`;
  const id = await doc(title, "Inhalt, der zurückkommt.");
  await page.goto(`/#page=${id}`);
  await expect(page.getByText("Inhalt, der zurückkommt.")).toBeVisible({ timeout: 20_000 });
  // Slow server: the page leaves the tree at once anyway.
  await page.route("**/api/command", async (route) => {
    if (route.request().postData()?.includes('"page.delete"')) await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "In den Papierkorb" }).click();
  if (!mobile) await expect(tree(page, title)).toHaveCount(0, { timeout: 400 });
  const toast = page.locator(".toast-undo");
  await expect(toast).toContainText(`„${title}“ in den Papierkorb gelegt`);
  const undo = toast.getByRole("button", { name: /Rückgängig/ });
  await expect(undo).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/ux-feel-undo-${info.project.name}.png` });
  await undo.click();
  await expect(page.locator(".toast").filter({ hasText: "Rückgängig gemacht" })).toBeVisible();
  // Back in the tree and open again.
  await expect(page.getByText("Inhalt, der zurückkommt.")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/pages/${id}`)).json()).page.deleted_at).toBeNull();
  if (!mobile) await expect(tree(page, title)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a deleted record comes back with Mod+Z", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "keyboard shortcut");
  const { errors, boot, command } = await setup(page);
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Liste ${Date.now()}`, kind: "database" });
  await command({ action: "row.create", pageId: p.id, cells: { title: "Bleibt erhalten" } });
  await page.goto(`/#page=${p.id}`);
  await page.getByText("Bleibt erhalten").click({ timeout: 20_000 });
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry.getByRole("button", { name: "Eintrag löschen" }).click();
  await expect(page.locator(".database").getByText("Bleibt erhalten")).toHaveCount(0, { timeout: 400 });
  await expect(page.locator(".toast-undo")).toContainText("„Bleibt erhalten“ in den Papierkorb gelegt");
  await page.locator("main").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".database").getByText("Bleibt erhalten")).toBeVisible();
  expect(errors).toEqual([]);
});

const LATENCY = 1500;
// Milliseconds from the click on a page in the tree until its text shows,
// measured in the browser (MutationObserver).
const timeToText = (page: Page, pageId: string, text: string) =>
  page.evaluate(
    ([pageId, text]) =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        const done = () => {
          if (!document.querySelector('[aria-label="Dokumentinhalt"]')?.textContent?.includes(text)) return false;
          observer.disconnect();
          resolve(Math.round(performance.now() - start));
          return true;
        };
        const observer = new MutationObserver(done);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        document.querySelector<HTMLElement>(`.page-nav[data-page-id="${pageId}"] .page-nav-title`)!.click();
      }),
    [pageId, text],
  );

test("a page opened again shows its kept copy at once, then the fresh one", async ({ page }, info) => {
  const { errors, doc, command } = await setup(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const a = await doc(`Erste ${stamp}`, `Alter Stand ${stamp}`);
  const b = await doc(`Zweite ${stamp}`, `Die andere Seite ${stamp}`);
  const c = await doc(`Dritte ${stamp}`, `Noch nie geöffnet ${stamp}`);
  // Every page load takes 1.5 s on this "slow connection".
  await page.route(/\/api\/pages\/[0-9a-f-]{36}$/, async (route) => {
    await new Promise((r) => setTimeout(r, LATENCY));
    await route.continue();
  });
  await page.goto("/#home");
  await expect(page.locator(`.page-nav[data-page-id="${a}"]`)).toBeAttached({ timeout: 20_000 });
  // First visit (also loads the editor's code): the placeholder in the shape of a page.
  const first = timeToText(page, a, `Alter Stand ${stamp}`);
  await expect(page.locator(".page-skeleton")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/ux-feel-skeleton-${info.project.name}.png` });
  await first;
  await timeToText(page, b, `Die andere Seite ${stamp}`);
  // Before: a page that is not kept waits for the server.
  const cold = await timeToText(page, c, `Noch nie geöffnet ${stamp}`);
  // Meanwhile the first page changes on the server (its icon).
  await command({ action: "page.update", pageId: a, patch: { icon: "🚀" } });
  // After: the page opened before shows at once from the cache – while
  // the fresh copy is still on its way …
  const warm = await timeToText(page, a, `Alter Stand ${stamp}`);
  await expect(page.locator("article.page-content[data-revalidating]")).toHaveCount(1, { timeout: 100 });
  await expect(page.locator(".large-page-icon .page-emoji")).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/ux-feel-revisit-${info.project.name}.png` });
  // … then the fresh state arrives by itself.
  await expect(page.locator(".large-page-icon")).toContainText("🚀", { timeout: 15_000 });
  await expect(page.locator("article.page-content[data-revalidating]")).toHaveCount(0);
  info.annotations.push({ type: "time to content (ms)", description: `not kept ${cold}, kept ${warm}` });
  console.log(`[ux-feel ${info.project.name}] time to content with ${LATENCY} ms latency: not kept ${cold} ms, revisit from cache ${warm} ms`);
  expect(cold).toBeGreaterThan(LATENCY);
  expect(warm).toBeLessThan(LATENCY);
  expect(errors).toEqual([]);
});

test("signing out leaves nothing in the tab's cache", async ({ page }) => {
  const { doc } = await setup(page);
  const id = await doc(`Privat ${Date.now()}`, "Geheimer Inhalt");
  await page.goto(`/#page=${id}`);
  await expect(page.getByText("Geheimer Inhalt")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("flowplan:swr:")).length))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("flowplan:signed-out", { cancelable: true })));
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("flowplan:swr:")).length)).toBe(0);
});
