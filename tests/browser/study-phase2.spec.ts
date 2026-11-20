import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// Flashcards phase 2 and 3a (docs/specs/flashcards.md): cards imported from
// pasted Quizlet text, cloze, typed and multiple choice cards in the focus
// mode, the screen #study with "Alle Stapel lernen", the start page's
// widget "Fällige Karten" and the line "… Karten gelernt" under a journal
// day.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function signedIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return { boot, command };
}
// A person of their own with a workspace of their own: #study and the
// widget count every deck of the workspace, which the shared demo account
// fills with the decks of other tests.
async function ownAccount(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `study:${uid}`, "Lena Lernt", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Lernen" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  return { boot, command };
}
// A deck with front and back and a study view; `settings` of the mapping.
async function deck(command: (d: Record<string, unknown>) => Promise<any>, boot: any, page: Page, title: string, settings: Record<string, unknown> = {}) {
  const pageId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database", databaseKind: "empty" })).id as string;
  const db = (await (await page.request.get(`/api/pages/${pageId}`)).json()).database;
  await command({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Wort", type: "text" },
      { id: "answer", name: "Übersetzung", type: "text" },
    ],
    views: [
      { id: "study", name: "Lernen", type: "study", filters: [], sorts: [], default: true },
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  await command({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "answer" }, ...settings } });
  return pageId;
}

test("cards imported from Quizlet text, with an error per line", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signedIn(page);
  const pageId = await deck(command, boot, page, `Import ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${pageId}`);
  await page.getByRole("button", { name: "Karten importieren" }).click();
  const wizard = page.getByRole("dialog", { name: "Karten importieren" });
  // Quizlet: tab between term and definition, semicolon between cards.
  await wizard.getByLabel("Text", { exact: true }).fill("hola\thallo;perro\tHund;gato\t;casa\tHaus;hola\thallo;");
  await expect(wizard.getByRole("combobox", { name: "Zwischen Karten" })).toHaveValue(";");
  await expect(wizard.getByRole("combobox", { name: "Ziel für Spalte 1" })).toHaveValue("title");
  await expect(wizard.getByRole("combobox", { name: "Ziel für Spalte 2" })).toHaveValue("answer");
  await expect(wizard.locator(".study-import-preview li")).toHaveCount(3);
  await expect(wizard.locator(".study-import-errors")).toContainText("Zeile 3: Rückseite fehlt.");
  await expect(wizard.locator(".study-import-errors")).toContainText("1 doppelte Zeilen übersprungen.");
  await page.screenshot({ path: `test-results/study-import-${info.project.name}.png` });
  await wizard.getByRole("button", { name: "3 Karten importieren" }).click();
  await expect(wizard).toBeHidden();
  await expect(page.locator(".study-notice")).toHaveText("3 Einträge importiert.");
  await expect(page.locator(".study-today .study-count.new strong")).toHaveText("3");
  // The export gives them back as CSV.
  const csv = await (await page.request.get(`/api/pages/${pageId}/study/export?zone=UTC`)).text();
  expect(csv).toContain("hola,hallo");
  expect(errors).toEqual([]);
});

test("cloze, typed and multiple choice cards in the focus mode", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signedIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  // Cloze: a basic record with {{c1::…}} gives one card per number.
  const cloze = await deck(command, boot, page, `Lücken ${stamp}`);
  await command({ action: "row.create", pageId: cloze, cells: { title: "{{c1::Madrid}} ist die Hauptstadt von {{c2::Spanien}}", answer: "" } });
  await page.goto(`/#page=${cloze}`);
  await expect(page.locator(".study-deck")).toContainText("2 Karten");
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  await expect(focus.locator(".study-front .cloze-gap")).toHaveText("[…]");
  await expect(focus.locator(".study-front")).toContainText("ist die Hauptstadt von Spanien");
  await expect(focus.locator(".study-front")).not.toContainText("Madrid");
  await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
  await expect(focus.locator(".cloze-answer")).toHaveText("Madrid");
  await page.screenshot({ path: `test-results/study-cloze-${info.project.name}.png` });
  await focus.getByRole("button", { name: /^Leicht, / }).click();
  await page.keyboard.press("Escape");

  // Typed: the comparison suggests a rating, Enter takes it.
  const typed = await deck(command, boot, page, `Tippen ${stamp}`, { type: { fixed: "typed" } });
  await command({ action: "row.create", pageId: typed, cells: { title: "la estación", answer: "der Bahnhof" } });
  await page.goto(`/#page=${typed}`);
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const field = focus.getByLabel("Deine Antwort");
  await expect(field).toBeFocused();
  await field.fill("der banhof");
  await field.press("Enter");
  await expect(focus.locator(".study-typed-result")).toContainText("Fast richtig: 1 Zeichen anders");
  await expect(focus.locator(".study-diff ins")).toHaveText("h");
  // The expected answer once: the back that only repeats it is left out (#346).
  await expect(focus.locator(".study-typed-expected")).toContainText("der Bahnhof");
  await expect(focus.locator(".study-back")).not.toContainText("der Bahnhof");
  await expect(focus.getByRole("button", { name: /^Schwer, .*\(Vorschlag\)$/ })).toBeVisible();
  await page.screenshot({ path: `test-results/study-typed-${info.project.name}.png` });
  // The person may rate otherwise: Easy instead of the suggestion.
  await focus.getByRole("button", { name: /^Leicht, / }).click();
  await expect(focus.getByRole("heading", { name: /geschafft/i })).toBeVisible();
  await page.keyboard.press("Escape");

  // Multiple choice: options from the other cards, a wrong pick suggests Again.
  const choice = await deck(command, boot, page, `Auswahl ${stamp}`, { type: { fixed: "choice" }, newPerDay: 1 });
  for (const [title, answer] of [["Hauptstadt von Spanien?", "Madrid"], ["Hauptstadt von Italien?", "Rom"], ["Hauptstadt von Polen?", "Warschau"], ["Hauptstadt von Portugal?", "Lissabon"]])
    await command({ action: "row.create", pageId: choice, cells: { title, answer } });
  await page.goto(`/#page=${choice}`);
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const options = focus.locator(".study-choice");
  await expect(options).toHaveCount(4);
  await expect(focus.locator(".study-front")).toContainText("Hauptstadt von Spanien?");
  const wrong = options.filter({ hasNotText: "Madrid" }).first();
  if (info.project.name === "mobile") await wrong.click();
  else await page.keyboard.press((await wrong.locator("kbd").textContent())!.toLowerCase());
  await expect(focus.locator(".study-choice.wrong")).toHaveCount(1);
  await expect(focus.locator(".study-choice.right")).toContainText("Madrid");
  // Right and wrong not by colour alone; the answer not again below.
  await expect(focus.locator(".study-choice.right .study-choice-mark")).toHaveText("richtig");
  await expect(focus.locator(".study-choice.wrong .study-choice-mark")).toHaveText("deine Wahl, falsch");
  await expect(focus.locator(".study-back")).not.toContainText("Madrid");
  await expect(focus.getByRole("button", { name: /^Nochmal, .*\(Vorschlag\)$/ })).toBeVisible();
  await page.screenshot({ path: `test-results/study-choice-${info.project.name}.png` });
  await page.keyboard.press("Enter");
  // Again: the card comes back after its learning step – the wait screen.
  await expect(focus.getByRole("heading", { name: /^Nächste Karte in \d+ Min$/ }).or(focus.locator(".study-choice").first())).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("#study lists the due decks, the widget counts them, the journal shows what was studied", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await ownAccount(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const a = await deck(command, boot, page, `Alpha ${stamp}`, { newPerDay: 2 });
  for (const [title, answer] of [["uno", "eins"], ["dos", "zwei"], ["tres", "drei"]]) await command({ action: "row.create", pageId: a, cells: { title, answer } });
  const b = await deck(command, boot, page, `Beta ${stamp}`);
  await command({ action: "row.create", pageId: b, cells: { title: "rojo", answer: "rot" } });

  await page.goto("/#study");
  const screen = page.locator(".study-screen");
  await expect(screen.getByRole("heading", { name: "Lernen", level: 1 })).toBeVisible();
  const alpha = screen.locator(".study-deck-list li", { hasText: `Alpha ${stamp}` });
  await expect(alpha.locator(".study-deck-count.new")).toHaveText("2 neu");
  await page.screenshot({ path: `test-results/study-screen-${info.project.name}.png` });
  // Study all due: Alpha first (more due), then on to Beta.
  await screen.getByRole("button", { name: "Alle Stapel lernen" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  for (let i = 0; i < 2; i++) {
    await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
    await focus.getByRole("button", { name: /^Leicht, / }).click();
  }
  await focus.getByRole("button", { name: `Weiter mit Beta ${stamp}` }).click();
  await expect(focus).toContainText("rojo");
  await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
  await focus.getByRole("button", { name: /^Leicht, / }).click();
  await focus.getByRole("button", { name: "Zurück zum Stapel" }).click();
  await expect(alpha.locator(".study-deck-count.new")).toHaveText("0 neu");
  // The sidebar and the command palette lead here too.
  await page.goto("/#home");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Suchen oder Befehl").fill(">Lernen");
  await expect(page.getByRole("option", { name: /Lernen: fällige Karten/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // The widget: the same counts, "Lernen" opens #study.
  const layout = {
    version: 1,
    widgets: [{ id: "cards", kind: "study", size: "m", config: {} }],
    appearance: { header: { type: "none", value: "", position: 50 }, density: "comfortable", background: "none", icon: "", width: "normal" },
  };
  await command({ action: "home.save", workspaceId: boot.workspace.id, layout });
  // Saved through the API, not the editor: the open start page learns it
  // on its next load.
  await page.goto("/#home");
  await page.reload();
  const widget = page.locator('[data-widget-id="cards"]');
  await expect(widget.getByRole("heading", { name: "Fällige Karten" })).toBeVisible();
  await expect(widget.locator(".home-study-decks")).toContainText(`Alpha ${stamp}`);
  await expect(widget.locator(".home-study-streak")).toContainText("Serie 1");
  await page.screenshot({ path: `test-results/study-widget-${info.project.name}.png` });
  await widget.getByRole("link", { name: /Lernen|Für heute geschafft/ }).click();
  await expect(page).toHaveURL(/#study$/);

  // The journal: "3 Karten gelernt" (Alpha 2, Beta 1) on today's page.
  const journal = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Journal ${stamp}`, kind: "journal" })).id as string;
  const { dayId } = await command({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journal, date: localDay() });
  await page.goto(`/#page=${dayId}`);
  const completed = page.locator(".journal-completed");
  await expect(completed.locator('li[data-kind="study"]', { hasText: `Alpha ${stamp}` })).toContainText("2 Karten gelernt");
  await expect(completed.locator('li[data-kind="study"]', { hasText: `Beta ${stamp}` })).toContainText("1 Karte gelernt");
  expect(errors).toEqual([]);
});
