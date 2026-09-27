import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("journal: statistics, memories, trackers, template, review and PIN", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const localDay = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const journalId = (
    await command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `Tagebuch ${info.project.name} ${Date.now()}`,
      kind: "journal",
    })
  ).id;
  await command({
    action: "journal.settings",
    pageId: journalId,
    template: "<h3>Dankbar für</h3><p></p>",
    trackers: [
      { id: "mood", name: "Stimmung", kind: "mood" },
      { id: "sleep", name: "Schlaf", kind: "number", unit: "h" },
    ],
  });
  // Yesterday with an open task and tracker values; a day a week ago.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  for (const [offset, text] of [[-7, "Kick-off am Montag"], [-1, "Gestern war gut"]] as const) {
    const { dayId } = await command({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journalId, date: localDay(-1) });
    // Days further back cannot be rolled; move the day there.
    if (offset !== -1)
      db.prepare("UPDATE pages SET journal_date=?,position=? WHERE id=?").run(localDay(offset), -Number(localDay(offset).replaceAll("-", "")), dayId);
    const data = await (await page.request.get(`/api/pages/${dayId}`)).json();
    const { htmlState } = await import("../../lib/document-server");
    await command({
      action: "document.sync",
      workspaceId: boot.workspace.id,
      pageId: dayId,
      generation: data.generation,
      update: Buffer.from(
        htmlState(`<p>${text}</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Interviewtermine vereinbaren</p></li></ul>`),
      ).toString("base64"),
    });
    await command({ action: "journal.entry", pageId: dayId, entry: { values: { mood: 4, sleep: 7 } } });
  }
  await page.goto(`/#page=${journalId}`);
  await expect(page.locator(".journal-today")).toBeEnabled();
  // Streak of the last days, heatmap, one month ago and tracker trends.
  await expect(page.locator(".journal-stat").first()).toContainText("Tage in Folge");
  await expect(page.locator(".journal-heatmap button").first()).toBeVisible();
  await expect(page.locator(".journal-memory", { hasText: "Vor einer Woche" })).toContainText("Kick-off");
  await expect(page.locator(".journal-trend", { hasText: "Schlaf" })).toContainText("h");
  // Calendar layout with the days of the month.
  await page.getByRole("button", { name: "Kalender", exact: true }).click();
  await expect(page.locator(".journal-calendar-grid .has-entry").first()).toBeVisible();
  await page.getByRole("button", { name: "Liste", exact: true }).click();

  // Review of the week.
  await page.getByRole("button", { name: "Rückblick" }).click();
  const review = page.getByRole("dialog", { name: "Rückblick" });
  await expect(review.locator(".journal-review-numbers")).toContainText("Tage");
  await review.getByRole("button", { name: "Monat", exact: true }).click();
  await expect(review.locator(".journal-review-trackers")).toContainText("Stimmung");
  await review.getByRole("button", { name: "Schließen" }).click();

  // Today: the template is there, trackers can be set.
  await page.locator(".journal-today").click();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Dankbar für");
  await expect(editor).toContainText("Interviewtermine vereinbaren");
  const bar = page.locator(".journal-daybar");
  await bar.getByRole("button", { name: "Großartig" }).click();
  await expect(bar.getByRole("button", { name: "Großartig" })).toHaveAttribute("aria-pressed", "true");
  await bar.getByLabel("Ort").fill("Café am Markt");
  await bar.getByLabel("Ort").blur();
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator(".journal-daybar").getByRole("button", { name: "Großartig" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".journal-daybar").getByLabel("Ort")).toHaveValue("Café am Markt");

  // Settings: change the template, add a tracker, set a PIN.
  await page.goto(`/#page=${journalId}`);
  await page.getByRole("button", { name: "Journal einrichten" }).click();
  const settings = page.getByRole("dialog", { name: "Journal einrichten" });
  await settings.getByRole("button", { name: /Arbeitslog/ }).click();
  await expect(settings.locator(".journal-template-preview")).toContainText("Blockiert");
  await settings.getByRole("button", { name: "Sport" }).click();
  await settings.getByRole("button", { name: "Tracker speichern" }).click();
  await expect(page.locator(".toast, [role=status]").filter({ hasText: "Tracker gespeichert" }).first()).toBeVisible();
  await settings.getByLabel("Neue PIN").fill("2468");
  await settings.getByLabel("PIN wiederholen").fill("2468");
  await settings.getByRole("button", { name: "Sperren" }).click();
  await expect(settings.getByLabel("Bisherige PIN")).toBeVisible();
  await settings.getByRole("button", { name: "Schließen" }).click();
  // Lock now: the journal asks for the PIN.
  await page.getByRole("button", { name: "Journal jetzt sperren" }).click();
  await expect(page.getByRole("heading", { name: "Dieses Journal ist gesperrt" })).toBeVisible();
  await page.getByLabel("PIN").fill("1111");
  await page.getByRole("button", { name: "Entsperren" }).click();
  await expect(page.locator(".journal-lock-error")).toContainText("stimmt nicht");
  await page.getByLabel("PIN").fill("2468");
  await page.getByRole("button", { name: "Entsperren" }).click();
  await expect(page.locator(".journal-today")).toBeVisible();
  expect(errors, info.project.name).toEqual([]);
});
