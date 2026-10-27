import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// Journals with years of days (#49): the page tree shows today, the last 7
// days and "Alle Tage …" (or folders per year and month), a day page has
// previous / next / today and a month picker, "Journal: Heute" opens today,
// and the review makes a month summary once.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayTitle = (date: string) =>
  new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
const monthName = (date: string) =>
  new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

// A person of their own (signed in through the session table) with one
// workspace: the shared development account would collect thousands of days.
async function setup(page: Page, info: TestInfo, days: number, html = (date: string) => `<p>Eintrag vom ${date}</p>`) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `journal-nav:${uid}`, "Jana Tag", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Journal" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Tagebuch ${info.project.name} ${Date.now()}`;
  const journalId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "journal" })
  ).id as string;
  // Years of days, written straight into the database (the API only makes today).
  const insertPage = db.prepare(
    "INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon,journal_date) VALUES(?,?,?,?,?,'document',?,?,'day',?)",
  );
  const insertDoc = db.prepare("INSERT INTO documents(page_id,html) VALUES(?,?)");
  const ids = new Map<string, string>();
  db.exec("BEGIN");
  for (let i = 1; i <= days; i++) {
    const date = localDay(-i);
    const id = randomUUID();
    insertPage.run(id, boot.workspace.id, boot.spaces[0].id, journalId, dayTitle(date), boot.user.id, -Number(date.replaceAll("-", "")), date);
    insertDoc.run(id, html(date));
    ids.set(date, id);
  }
  db.exec("COMMIT");
  db.close();
  const { dayId: todayId } = await command({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journalId, date: localDay() });
  return { boot, command, journalId, title, ids, todayId: todayId as string };
}
const mobile = (info: TestInfo) => info.project.name === "mobile";
async function openNavigation(page: Page, info: TestInfo) {
  if (mobile(info)) await page.getByRole("button", { name: "Navigation öffnen" }).click();
}

test("2,000 days: a short journal in the tree, day navigation, Journal: Heute", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { journalId, ids, todayId } = await setup(page, info, 2000);

  await page.goto(`/#page=${todayId}`);
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));
  await openNavigation(page, info);
  const group = page.locator(`#tree-group-${journalId}`);
  // Today, the 7 days before and "Alle Tage …" – nothing else is rendered.
  await expect(group.getByRole("treeitem")).toHaveCount(9);
  await expect(group.getByRole("treeitem").first()).toContainText("Heute");
  await expect(group.getByRole("treeitem").first()).toHaveAttribute("aria-selected", "true");
  await expect(group.getByRole("treeitem").nth(1)).toContainText(dayTitle(localDay(-1)));
  await expect(group.getByRole("treeitem").nth(7)).toContainText(dayTitle(localDay(-7)));
  await expect(group.getByRole("treeitem").last()).toContainText("Alle Tage");
  expect(await page.locator(".page-nav[data-page-id]").count()).toBeLessThan(200);

  // On a day: back to the previous entry, forward again.
  if (mobile(info)) await page.keyboard.press("Escape");
  const nav = page.getByRole("navigation", { name: "Tage im Journal" });
  await expect(nav.getByRole("button", { name: /Nächster Tag/ })).toBeDisabled();
  await nav.getByRole("button", { name: /Vorheriger Tag/ }).click();
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay(-1)));
  await nav.getByRole("button", { name: /Nächster Tag/ }).click();
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));

  // A day long ago: it shows up in the tree although older than 7 days.
  const old = localDay(-400);
  await page.goto(`/#page=${ids.get(old)}`);
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(old));
  await openNavigation(page, info);
  const oldRow = group.locator(`[data-page-id="${ids.get(old)}"]`);
  await expect(oldRow).toHaveAttribute("aria-selected", "true");
  await expect(group.getByRole("treeitem")).toHaveCount(10);
  if (mobile(info)) await page.keyboard.press("Escape");

  // The month picker: keyboard to the day before, Enter opens it.
  await nav.getByRole("button", { name: /Tag wählen/ }).click();
  const picker = page.getByRole("dialog", { name: "Tag im Journal wählen" });
  await expect(picker).toContainText(monthName(old));
  await expect(picker.locator(`[data-date="${old}"]`)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(picker.locator(`[data-date="${localDay(-401)}"]`)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay(-401)));
  await expect(picker).toHaveCount(0);
  // Escape closes it and gives the focus back.
  await nav.getByRole("button", { name: /Tag wählen/ }).click();
  await page.keyboard.press("Escape");
  await expect(nav.getByRole("button", { name: /Tag wählen/ })).toBeFocused();

  // "Heute" on the day, then the command palette and the shortcut.
  await nav.getByRole("button", { name: "Heute" }).click();
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));
  await page.goto(`/#page=${ids.get(localDay(-30))}`);
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay(-30)));
  if (!mobile(info)) {
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByLabel("Suchen oder Befehl");
    await input.fill("> journal: heute");
    await expect(page.locator(".command-actions")).toContainText("Journal: Heute");
    await input.press("Enter");
    await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));
    await page.goto(`/#page=${ids.get(localDay(-31))}`);
    await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay(-31)));
    await page.locator(".page-title").press("ControlOrMeta+Alt+y");
    await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));
  }

  // "Alle Tage …" opens the journal at its days.
  await openNavigation(page, info);
  await group.getByRole("treeitem").last().click();
  await expect(page.locator(".journal-days")).toBeFocused();
  expect(errors).toEqual([]);
});

test("grouped by year and month: folders, keys and the open day", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { journalId, ids, command } = await setup(page, info, 500);
  await page.goto(`/#page=${journalId}`);
  if (mobile(info)) await command({ action: "journal.settings", pageId: journalId, options: { sidebar: "grouped" } });
  else {
    // The setting in the journal's settings.
    await page.getByRole("button", { name: "Journal einrichten" }).click();
    await page.getByRole("tab", { name: "Tage", exact: true }).click();
    await page.getByRole("radio", { name: /Nach Jahr und Monat gruppiert/ }).check();
    await expect(page.getByRole("radio", { name: /Nach Jahr und Monat gruppiert/ })).toBeChecked();
    await page.keyboard.press("Escape");
  }
  await page.reload();
  await expect(page.locator(".journal-today")).toBeVisible();
  await openNavigation(page, info);
  const group = page.locator(`#tree-group-${journalId}`);
  const older = localDay(-8);
  const year = group.getByRole("treeitem", { name: new RegExp(`^${older.slice(0, 4)}, \\d+ Tage$`) });
  await expect(year).toHaveAttribute("aria-expanded", "false");
  // Folders are no pages: no page id, nothing to drop onto.
  expect(await year.getAttribute("data-page-id")).toBeNull();
  await year.click();
  await expect(year).toHaveAttribute("aria-expanded", "true");
  const month = group.getByRole("treeitem", { name: new RegExp(`^${monthName(older)}, \\d+ Tage?$`) });
  await expect(month).toHaveAttribute("aria-expanded", "false");
  // Keys: Right opens the month, Down goes to its newest day, Left back up.
  await month.focus();
  await page.keyboard.press("ArrowRight");
  await expect(month).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowDown");
  const first = group.locator(`[data-page-id="${ids.get(older)}"]`);
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(month).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(month).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(month).toHaveAttribute("aria-expanded", "true");
  await expect(month).toContainText(/\d+/);

  // An old day opened directly: its year and month unfold.
  const old = localDay(-450);
  await page.goto(`/#page=${ids.get(old)}`);
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(old));
  await openNavigation(page, info);
  await expect(group.getByRole("treeitem", { name: new RegExp(`^${old.slice(0, 4)}, \\d+ Tage$`) })).toHaveAttribute("aria-expanded", "true");
  await expect(group.getByRole("treeitem", { name: new RegExp(`^${monthName(old)}, `) })).toHaveAttribute("aria-expanded", "true");
  await expect(group.locator(`[data-page-id="${ids.get(old)}"]`)).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("the month review makes a summary page once", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Last month: a done and an open task on its last day.
  const now = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const back = Math.round((now.getTime() - lastMonthEnd.getTime()) / 864e5) + 12;
  const { journalId, ids } = await setup(page, info, back, (date) =>
    `<p>Notiz ${date}</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Erledigt ${date}</p></li><li data-type="taskItem" data-checked="false"><p>Offen ${date}</p></li></ul>`,
  );
  const lastDay = `${lastMonthEnd.getFullYear()}-${String(lastMonthEnd.getMonth() + 1).padStart(2, "0")}-${String(lastMonthEnd.getDate()).padStart(2, "0")}`;
  await page.goto(`/#page=${journalId}`);
  await page.getByRole("button", { name: "Rückblick" }).click();
  const review = page.getByRole("dialog", { name: "Rückblick" });
  await review.getByRole("button", { name: "Monat" }).click();
  await review.getByRole("button", { name: "Früher" }).click();
  await expect(review).toContainText(monthName(lastDay));
  await review.getByRole("button", { name: "Monatszusammenfassung erstellen" }).click();
  const summaryTitle = `Monatszusammenfassung ${monthName(lastDay)}`;
  await expect(page.locator(".page-title")).toHaveValue(summaryTitle);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Höhepunkte");
  await expect(editor).toContainText("Noch offen");
  await expect(editor).toContainText(`Erledigt ${lastDay}`);
  await expect(editor.locator(`a[href="/#page=${ids.get(lastDay)}"]`).first()).toBeVisible();
  // A normal page below the journal, after its days – not a day.
  await openNavigation(page, info);
  const row = page.locator(`#tree-group-${journalId} .page-nav[data-page-id]`, { hasText: summaryTitle });
  await expect(row).toHaveCount(1);
  if (mobile(info)) await page.keyboard.press("Escape");

  // Asked again: the existing page is offered.
  await page.goto(`/#page=${journalId}`);
  await page.getByRole("button", { name: "Rückblick" }).click();
  await review.getByRole("button", { name: "Monat" }).click();
  await review.getByRole("button", { name: "Früher" }).click();
  await expect(review).toContainText("gibt es schon eine Monatszusammenfassung");
  await expect(review.getByRole("button", { name: "Monatszusammenfassung erstellen" })).toHaveCount(0);
  await review.getByRole("button", { name: "Monatszusammenfassung öffnen" }).click();
  await expect(page.locator(".page-title")).toHaveValue(summaryTitle);
  expect(errors).toEqual([]);
});
