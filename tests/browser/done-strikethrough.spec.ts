import { test, expect, type Locator, type Page } from "@playwright/test";
import { withTaskFilters } from "./my-tasks-filters";

// "Erledigte Aufgaben durchstreichen" (#458, lib/done-strike-pref.ts): on by
// default. Off in Settings → Darstellung & Sprache → Editor, a class on
// <html> takes the line away from done tasks in documents and My tasks –
// they keep the ticked box and the faded colour; the document itself is
// unchanged. A test server may sign every test in as the same person, so
// the test puts the default back.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const r = await page.request.post("/api/command", { headers: { origin }, data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
const look = (el: Locator) => el.evaluate((node) => ({ line: getComputedStyle(node).textDecorationLine, color: getComputedStyle(node).color }));

test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.strikeDoneTasks", strikeDoneTasks: true } });
});

test("done tasks are struck through by default and only faded with the setting off", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  await command(page, { action: "profile.strikeDoneTasks", strikeDoneTasks: true });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const workspaceId = boot.workspace.id as string;
  await command(page, { action: "task.target", workspaceId, databaseId: null });
  // A done task of the own page (My tasks) and its document.
  const text = `Erledigt ${info.project.name} ${Date.now()}`;
  const added = await command(page, { action: "task.add", workspaceId, text, today: new Date().toISOString().slice(0, 10), locale: "de" });
  const listed = (await (await page.request.get(`/api/tasks?workspace=${workspaceId}`)).json()).tasks.find((t: { text: string }) => t.text === text);
  await command(page, { action: "task.update", pageId: added.pageId, index: listed.index, text, checked: true });

  // On (the default): struck through in the document and in My tasks.
  await page.goto(`/#page=${added.pageId}`);
  const inDoc = page.getByLabel("Dokumentinhalt", { exact: true }).locator('li[data-checked="true"] > div > p', { hasText: text });
  await expect(inDoc).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).not.toHaveClass(/done-tasks-plain/);
  const docOn = await look(inDoc);
  expect(docOn.line).toBe("line-through");

  // Off in the settings: saved for the person, the line gone right away.
  await page.goto("/#settings/appearance");
  const toggle = page.getByRole("switch", { name: "Erledigte Aufgaben durchstreichen" });
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("html")).toHaveClass(/done-tasks-plain/);
  await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).strikeDoneTasks).toBe(false);

  // After a reload: no line in the document, the faded colour stays.
  await page.goto(`/#page=${added.pageId}`);
  await page.reload();
  await expect(inDoc).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveClass(/done-tasks-plain/);
  const docOff = await look(inDoc);
  expect(docOff.line).toBe("none");
  expect(docOff.color).toBe(docOn.color);
  // The document is unchanged: the task is still done.
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).locator('li[data-checked="true"]', { hasText: text })).toHaveCount(1);

  // My tasks: the done task ticked, without the line.
  await page.goto("/#tasks");
  await withTaskFilters(page, (filters) => filters.getByLabel("Erledigte zeigen").check());
  const inList = page.locator(".my-tasks-group li.checked", { hasText: text });
  await expect(inList).toBeVisible({ timeout: 30_000 });
  await expect(inList.getByRole("checkbox")).toBeChecked();
  expect((await look(inList.locator(".my-task-text"))).line).toBe("none");

  // Back on: struck through again.
  await command(page, { action: "profile.strikeDoneTasks", strikeDoneTasks: true });
  await page.reload();
  await withTaskFilters(page, (filters) => filters.getByLabel("Erledigte zeigen").check());
  await expect(inList).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).not.toHaveClass(/done-tasks-plain/);
  await expect.poll(async () => (await look(inList.locator(".my-task-text"))).line).toBe("line-through");
  await withTaskFilters(page, (filters) => filters.getByLabel("Erledigte zeigen").uncheck());
  expect(errors).toEqual([]);
});
