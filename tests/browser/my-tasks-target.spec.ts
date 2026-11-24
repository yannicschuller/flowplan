import { test, expect, type Page } from "@playwright/test";

// Where "Aufgabe hinzufügen" of My tasks writes (#457,
// lib/my-task-target.ts): the chip at the end of the field switches from
// the own page "Aufgaben" to a task database; a task then becomes a record
// there and shows in the list. A database in the trash sends tasks back to
// the own page, and a line below the field says so. A test server may sign
// every test in as the same person, so the test puts the default back.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const r = await page.request.post("/api/command", { headers: { origin }, data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}

test("Aufgabe hinzufügen writes into the chosen task database, and back to the own page when it is gone", async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const workspaceId = boot.workspace.id as string;
  await command(page, { action: "task.target", workspaceId, databaseId: null });
  const name = `Projekt ${info.project.name} ${Date.now()}`;
  const db = await command(page, { action: "page.create", workspaceId, spaceId: boot.spaces[0].id, title: name, kind: "database", databaseKind: "tasks" });
  try {
    await page.goto("/#tasks");
    const field = page.getByRole("textbox", { name: "Aufgabe hinzufügen" });
    await expect(field).toBeVisible({ timeout: 30_000 });
    // The chip names the own page; its panel offers the task database.
    const chip = page.getByRole("button", { name: "Ziel: Aufgaben" });
    await chip.click();
    const panel = page.getByRole("dialog", { name: "Neue Aufgaben landen in" });
    await expect(panel.getByRole("radio", { name: /Meine Seite „Aufgaben“/ })).toBeChecked();
    await panel.locator("label", { hasText: name }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Ziel: ${name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `„${name}“ öffnen` })).toBeVisible();

    // A task becomes a record of it, with me as the person and tomorrow's date.
    const text = `Angebot ${Date.now()}`;
    await field.fill(`${text} morgen`);
    await expect(page.locator(".my-tasks-add-hint")).toContainText(`als Eintrag in „${name}“`);
    await field.press("Enter");
    await expect(field).toHaveValue("");
    const record = page.locator(".my-tasks-group li.my-record", { hasText: text });
    await expect(record).toBeVisible({ timeout: 15_000 });
    await expect(record).toContainText(name);
    const rows = await (await page.request.get(`/api/pages/${db.id}`)).json();
    const row = (rows.rows as { cells: Record<string, unknown> }[]).find((r) => r.cells.title === text);
    expect(row?.cells.assignee).toBe(boot.user.id);
    expect(["Nicht begonnen", "Not started"]).toContain(row?.cells.status);

    // In the trash: the line below the field says so, tasks go to the own page.
    await command(page, { action: "page.delete", pageId: db.id });
    await page.reload();
    await expect(page.locator(".my-tasks-target-problem")).toContainText("gibt es nicht mehr", { timeout: 30_000 });
    const own = `Notiz ${Date.now()}`;
    await field.fill(own);
    await field.press("Enter");
    await expect(page.locator(".my-tasks-notice")).toContainText("neue Aufgaben landen auf deiner Seite „Aufgaben“");
    await expect(page.locator(".my-tasks-group li", { hasText: own })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".my-tasks-group li", { hasText: own }).locator(".my-task-page")).toContainText("Aufgaben");

    // Back to the own page in the panel.
    await page.getByRole("button", { name: /^Ziel: / }).click();
    await page.getByRole("dialog", { name: "Neue Aufgaben landen in" }).getByText("Meine Seite „Aufgaben“").click();
    await expect(page.getByRole("button", { name: "Ziel: Aufgaben" })).toBeVisible();
    await expect(page.locator(".my-tasks-target-problem")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.request.post("/api/command", { headers: { origin }, data: { action: "task.target", workspaceId, databaseId: null } });
  }
});
