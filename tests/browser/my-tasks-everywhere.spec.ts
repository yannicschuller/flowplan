// My tasks → "Alle Arbeitsbereiche" and the board (#564,
// components/my-tasks.tsx, components/my-tasks-board.tsx).
import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  return { command, boot };
}
// A page with one task given to the demo person (so it stays without a date too).
const taskPage = (boot: { user: { id: string; name: string } }, text: string, due: string | null) =>
  `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"${due ? ` data-due="${due}"` : ""}><p>${text} <span data-mention="${boot.user.id}" class="mention">@${boot.user.name}</span></p></li></ul>`;
const localToday = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

test("Alle Arbeitsbereiche: one list with the workspace of each task, filtered, opened in its workspace", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, boot } = await signIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const name = `Büro ${stamp}`;
  const other = await command({ action: "workspace.create", name });
  const otherBoot = await (await page.request.get(`/api/bootstrap?workspace=${other.id}`)).json();
  const current = (await (await page.request.get("/api/bootstrap")).json()).workspace;
  test.skip(current.id === other.id, "The new workspace became the current one.");
  const there = `Pläne einreichen ${stamp}`;
  const here = `Angebot prüfen ${stamp}`;
  await command({ action: "page.import", workspaceId: other.id, spaceId: otherBoot.spaces[0].id, title: `Bauantrag ${stamp}`, content: taskPage(boot, there, "2020-01-01"), format: "html" });
  await command({ action: "page.import", workspaceId: current.id, spaceId: boot.spaces[0].id, title: `Angebot ${stamp}`, content: taskPage(boot, here, "2020-01-02"), format: "html" });

  await page.goto("/#tasks");
  // This workspace: the other one's task in its own section.
  await expect(page.locator(".my-tasks-others")).toContainText(there);
  await page.locator(".my-tasks-workspace-scope label", { hasText: "Alle Arbeitsbereiche" }).click();
  const thereItem = page.locator(".my-tasks-group li", { hasText: there });
  const hereItem = page.locator(".my-tasks-group li", { hasText: here });
  await expect(thereItem).toBeVisible();
  await expect(hereItem).toBeVisible();
  // Both in "Überfällig", each with its workspace; no second section.
  await expect(page.locator(".my-tasks-group.overdue")).toContainText(there);
  await expect(thereItem.locator(".my-task-workspace > span:last-child")).toHaveText(name);
  await expect(hereItem.locator(".my-task-workspace > span:last-child")).toHaveText(current.name);
  await expect(page.locator(".my-tasks-others")).toHaveCount(0);
  // The workspace filter: only the other workspace, then all again.
  const chips = page.getByRole("group", { name: "Arbeitsbereiche filtern" });
  await chips.getByRole("button", { name }).click();
  await expect(chips.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  await expect(hereItem).toHaveCount(0);
  await expect(thereItem).toBeVisible();
  await chips.getByRole("button", { name: "Alle", exact: true }).click();
  await expect(hereItem).toBeVisible();
  // Kept on this device.
  await page.reload();
  await expect(page.locator('.my-tasks-workspace-scope label[data-active="true"]')).toHaveText("Alle Arbeitsbereiche");
  await expect(thereItem.locator(".my-task-workspace > span:last-child")).toHaveText(name);
  // Ticking off and the date work across workspaces as in the normal list.
  await thereItem.getByRole("button", { name: /^Fälligkeit von .* entfernen$/ }).click();
  await expect(page.locator(".my-tasks-group", { hasText: "Ohne Datum" }).locator("li", { hasText: there })).toBeVisible();
  // A click opens the task's page in its workspace.
  await thereItem.getByRole("button", { name: `Bauantrag ${stamp}` }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText(there);
  await expect.poll(async () => (await page.evaluate(() => location.hash)).startsWith("#page=")).toBe(true);
  expect(errors).toEqual([]);
});

test("Board: a card dragged or moved with “Verschieben nach …” gets the column's date", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, boot } = await signIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const text = `Fassade planen ${stamp}`;
  await command({ action: "page.import", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Fassade ${stamp}`, content: taskPage(boot, text, "2020-01-01"), format: "html" });
  const dueOnServer = async () =>
    ((await (await page.request.get(`/api/tasks?workspace=${boot.workspace.id}`)).json()).tasks as { text: string; due: string | null }[]).find((t) => t.text.startsWith(text))?.due;

  await page.goto("/#tasks");
  await page.locator(".my-tasks-layout label", { hasText: "Board" }).click();
  const column = (name: string) => page.locator(`.my-tasks-column[data-column="${name}"]`);
  const card = (name: string) => column(name).locator(".my-task-card", { hasText: text });
  await expect(card("Überfällig")).toBeVisible();
  await expect(card("Überfällig").locator(".my-task-card-source")).toContainText(`Fassade ${stamp}`);
  const today = await localToday(page);
  if (info.project.name === "desktop") {
    // Dragged to "Heute": due today.
    await card("Überfällig").dragTo(column("Heute"));
    await expect(card("Heute")).toBeVisible();
    await expect.poll(dueOnServer).toBe(today);
  } else {
    // Phones: the menu only.
    await card("Überfällig").getByRole("button", { name: /verschieben nach/ }).click();
    await page.getByRole("menuitem", { name: "Heute" }).click();
    await expect(card("Heute")).toBeVisible();
    await expect.poll(dueOnServer).toBe(today);
  }
  // "Verschieben nach …" → Später is today + 8: from the keyboard on
  // desktops, a tap on phones.
  const move = card("Heute").getByRole("button", { name: /verschieben nach/ });
  if (info.project.name === "desktop") {
    await move.focus();
    await page.keyboard.press("Enter");
  } else await move.click();
  await expect(page.getByRole("menu", { name: "Verschieben nach" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Später (in 8 Tagen)" }).click();
  await expect(card("Später")).toBeVisible();
  const later = new Date(`${today}T00:00:00Z`);
  later.setUTCDate(later.getUTCDate() + 8);
  await expect.poll(dueOnServer).toBe(later.toISOString().slice(0, 10));
  // "Ohne Datum" removes the date; "Überfällig" takes no cards.
  await card("Später").getByRole("button", { name: /verschieben nach/ }).click();
  await expect(page.getByRole("menuitem", { name: /Überfällig/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Ohne Datum (Datum entfernen)" }).click();
  await expect(card("Ohne Datum")).toBeVisible();
  await expect.poll(dueOnServer).toBe(null);
  // The board stays chosen on this device; ticking a card off works there too.
  await page.reload();
  await expect(card("Ohne Datum")).toBeVisible();
  await card("Ohne Datum").getByRole("checkbox").click();
  await expect(page.locator(".my-task-card", { hasText: text })).toHaveCount(0);
  expect(errors).toEqual([]);
});
