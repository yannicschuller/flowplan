import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// An entry for an earlier day (#288): in the day picker a past day without
// a page is a button that creates it – without the open tasks of the day
// before – and opens it; days after today stay locked.
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

test("a past day without an entry is created from the day picker, a future one is locked", async ({ page }) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A person of their own, signed in through the session table.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `journal-past:${uid}`, "Jana Früher", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Journal" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const journalId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Tagebuch ${Date.now()}`, kind: "journal" })
  ).id as string;
  // Yesterday with an open task, written straight into the database.
  const yesterday = localDay(-1);
  db.prepare(
    "INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon,journal_date) VALUES(?,?,?,?,?,'document',?,?,'day',?)",
  ).run(randomUUID(), boot.workspace.id, boot.spaces[0].id, journalId, dayTitle(yesterday), boot.user.id, -Number(yesterday.replaceAll("-", "")), yesterday);
  const yesterdayId = (db.prepare("SELECT id FROM pages WHERE parent_id=? AND journal_date=?").get(journalId, yesterday) as { id: string }).id;
  db.prepare("INSERT INTO documents(page_id,html) VALUES(?,?)").run(
    yesterdayId,
    '<p>Gestern</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Noch offen</p></li></ul>',
  );
  db.close();
  const { dayId: todayId } = await command({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journalId, date: localDay() });

  await page.goto(`/#page=${todayId}`);
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));
  const nav = page.getByRole("navigation", { name: "Tage im Journal" });
  const picker = page.getByRole("dialog", { name: "Tag im Journal wählen" });

  // Tomorrow: locked, Enter does nothing.
  await nav.getByRole("button", { name: /Tag wählen/ }).click();
  await page.keyboard.press("ArrowRight");
  const tomorrow = picker.locator(`[data-date="${localDay(1)}"]`);
  await expect(tomorrow).toBeFocused();
  await expect(tomorrow).toHaveAttribute("aria-disabled", "true");
  await expect(tomorrow).toHaveAccessibleName(/kein Eintrag/);
  await page.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));

  // Three days ago: a button that creates the entry.
  const past = localDay(-3);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  const cell = picker.locator(`[data-date="${past}"]`);
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAccessibleName(`Eintrag für ${dayTitle(past)} anlegen`);
  await expect(cell).not.toHaveAttribute("aria-disabled", "true");
  await cell.click();
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(past));
  await expect(picker).toHaveCount(0);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).not.toContainText("Noch offen");

  // Chosen again: the same page opens.
  await page.goto(`/#page=${todayId}`);
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(localDay()));
  await nav.getByRole("button", { name: /Tag wählen/ }).click();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await expect(picker.locator(`[data-date="${past}"]`)).toHaveAccessibleName(dayTitle(past));
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-title")).toHaveValue(dayTitle(past));
  expect(errors).toEqual([]);
});
