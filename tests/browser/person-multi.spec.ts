import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Person properties with several people (#535): with "Mehrere Personen" the
// cell takes members as chips with ✕, found by typing (Enter, Backspace,
// Escape); the table shows each person, the board puts the record under
// each of its people; switching the setting off asks first, naming how
// many records have more than one person, and keeps the first.
// SHOTS_DIR: screenshots of the picker and the board go there.
const shots = process.env.SHOTS_DIR;

async function setup(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  // Two more members to choose from.
  const store = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  // The same people for every test of the workspace (the demo's).
  const member = (name: string) => {
    const known = store
      .prepare("SELECT u.id FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=? AND u.name=?")
      .get(boot.workspace.id, name) as { id: string } | undefined;
    if (known) return known.id;
    const uid = randomUUID();
    store.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, uid, name, `${uid}@test.invalid`, Date.now());
    store.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
    return uid;
  };
  const ben = member("Ben Brandt"),
    cleo = member("Cléo Martin");
  store.close();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async (id: string) => (await page.request.get(`/api/pages/${id}`)).json();
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read(db.id)).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "team", name: "Team", type: "person", multiPerson: true },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      { id: "board", name: "Board", type: "board", groupBy: "team", filters: [], sorts: [] },
    ],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Startseite überarbeiten", status: "Offen" } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Logo", team: [ben], status: "Offen" } });
  const cells = async () => ((await read(db.id)).rows as { id: string; cells: Record<string, unknown> }[]).find((r) => r.id === row.id)?.cells ?? {};
  return { db, ben, cleo, me: boot.user.id as string, cells, read };
}

test.use({ deviceScaleFactor: 2 });

test("several people: chips with a search, both columns on the board, off keeps the first", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "desktop", "The table and the board on a desktop; the phone has its own test.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (shots) mkdirSync(shots, { recursive: true });
  const { db, ben, cleo, cells, read } = await setup(page, `Personen ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${db.id}`);
  const row = page.locator(".data-table tbody tr[data-row-id]", { hasText: "Startseite" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const team = row.locator("td").nth(2);
  const search = page.getByRole("combobox", { name: "Team: Person suchen" });
  const list = page.getByRole("listbox", { name: "Mitglieder für Team" });

  // The cell opens the search; members are found by name, accents aside.
  await team.click();
  await expect(search).toBeFocused();
  await expect(list).toHaveAttribute("aria-multiselectable", "true");
  await page.keyboard.type("cleo");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toHaveAccessibleName("Cléo Martin");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).team).toEqual([cleo]);
  // It stays open for more; the chosen one is a chip and no longer offered.
  await expect(search).toBeFocused();
  await page.keyboard.type("b");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toHaveAccessibleName("Ben Brandt");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).team).toEqual([cleo, ben]);
  const chosen = page.getByRole("group", { name: "Gewählt: Team" });
  await expect(chosen.getByRole("button", { name: "„Cléo Martin“ entfernen" })).toBeVisible();
  await expect(chosen.getByRole("button", { name: "„Ben Brandt“ entfernen" })).toBeVisible();
  if (shots) await page.screenshot({ path: join(shots, "picker-light.png") });
  // Backspace in the empty search removes the last one, ✕ another.
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await cells()).team).toEqual([cleo]);
  await page.keyboard.type("ben");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).team).toEqual([cleo, ben]);
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  // The table shows both, each with the avatar.
  await expect(team.locator(".person-cell")).toHaveCount(2);
  await expect(team.locator(".person-cell").first()).toContainText("Cléo Martin");
  await expect(team.locator(".person-cell").last()).toContainText("Ben Brandt");
  if (shots) await page.screenshot({ path: join(shots, "table-light.png") });

  // The board: the record under each of its people.
  await page.getByRole("group", { name: "Ansichten" }).getByRole("button", { name: "Board" }).click();
  const column = (name: string) => page.locator(".board-column", { has: page.getByRole("button", { name: `Gruppe ${name} einklappen` }) });
  await expect(column("Ben Brandt").locator(".record-card")).toHaveCount(2, { timeout: 15_000 });
  await expect(column("Cléo Martin").locator(".record-card", { hasText: "Startseite" })).toHaveCount(1);
  await expect(column("Ben Brandt").locator(".record-card", { hasText: "Startseite" })).toHaveCount(1);
  if (shots) {
    await page.screenshot({ path: join(shots, "board-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, "board-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
  }

  // Off: asked first with the count, then each record keeps its first person.
  await page.getByRole("group", { name: "Ansichten" }).getByRole("button", { name: "Tabelle" }).click();
  await page.locator(".data-table thead").getByRole("button", { name: /^\W*Team$/ }).click();
  const settings = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  const toggle = settings.getByRole("checkbox", { name: "Mehrere Personen" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  const asked: string[] = [];
  page.once("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await settings.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => asked).toEqual(["„Mehrere Personen“ ausschalten? 1 Eintrag hat mehr als eine Person – er behält nur die erste."]);
  await expect.poll(async () => (await cells()).team).toBe(cleo);
  const logo = ((await read(db.id)).rows as { cells: Record<string, unknown> }[]).find((r) => r.cells.title === "Logo")!;
  expect(logo.cells.team).toBe(ben);
  await expect(settings).toBeHidden();
  // One person again: the plain list of members.
  await expect(team.locator(".person-cell")).toHaveCount(1);
  await expect(team).toContainText("Cléo Martin");
  expect(errors).toEqual([]);
});

test("the picker on a phone, in the dark", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "mobile", "A phone's own context, once.");
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, ben, cleo, cells } = await setup(page, `Personen Telefon ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${db.id}`);
  // The record opens; its Team value opens the picker.
  await page.getByText("Startseite überarbeiten").first().click();
  const value = page.getByRole("button", { name: /^Team/ }).first();
  await expect(value).toBeVisible({ timeout: 30_000 });
  await value.click();
  const add = page.getByRole("button", { name: "Person zu „Team“ hinzufügen" });
  const search = page.getByRole("combobox", { name: "Team: Person suchen" });
  if (await add.isVisible()) await add.click();
  await expect(search).toBeVisible();
  await search.fill("Ben");
  await page.getByRole("option", { name: "Ben Brandt" }).click();
  await search.fill("Cl");
  await page.getByRole("option", { name: "Cléo Martin" }).click();
  await expect.poll(async () => (await cells()).team).toEqual([ben, cleo]);
  if (shots) await page.screenshot({ path: join(shots, "picker-phone-dark.png") });
  expect(errors).toEqual([]);
  await context.close();
});
