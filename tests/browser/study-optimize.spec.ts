import { test, expect, type Page } from "@playwright/test";
import { syntheticReviews } from "../helpers/fsrs-synthetic";

// Flashcards phase 8 (docs/specs/flashcards.md §23): "Parameter optimieren"
// from "Meine Einstellungen" – below 1000 ratings a clear message; with a
// log the fit runs in a Web Worker, shows log loss and RMSE before and
// after and a recommended retention; applying stores the weights (the
// scheduler uses them), the statistics name them, and a reset brings the
// defaults back. Desktop and phone.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signedIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return { boot, command };
}

test("FSRS parameters are optimised from the own log, applied, shown and reset", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signedIn(page);
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Optimieren ${info.project.name} ${Date.now()}`, kind: "database", databaseKind: "empty" });
  const pageId = created.id as string;
  const db = (await (await page.request.get(`/api/pages/${pageId}`)).json()).database;
  await command({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Wort", type: "text" },
      { id: "answer", name: "Übersetzung", type: "text" },
    ],
    views: [{ id: "study", name: "Lernen", type: "study", filters: [], sorts: [], default: true }],
  });
  await command({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "answer" } } });
  await command({ action: "rows.import", pageId, rows: Array.from({ length: 150 }, (_, i) => ({ title: `Wort ${i + 1}`, answer: `Antwort ${i + 1}` })) });

  // No log yet: the message, nothing to start.
  await page.goto(`/#page=${pageId}`);
  await page.getByRole("button", { name: "Meine Einstellungen" }).click();
  const prefs = page.getByRole("dialog", { name: "Meine Einstellungen" });
  await expect(prefs.locator(".study-model")).toContainText("Standardparameter von FSRS-6.");
  await prefs.getByRole("button", { name: "Parameter optimieren …" }).click();
  const dialog = page.getByRole("dialog", { name: "Parameter optimieren" });
  await expect(dialog).toContainText("Zum Optimieren braucht es mindestens 1.000 Wertungen – hier sind es 0.");
  await expect(dialog.getByRole("button", { name: "Optimieren", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A year and a half of ratings (sent like ratings made offline).
  const rows = (await (await page.request.get(`/api/pages/${pageId}`)).json()).rows as { id: string; cells: { title: string } }[];
  const ids = [...rows].sort((a, b) => Number(a.cells.title.split(" ")[1]) - Number(b.cells.title.split(" ")[1])).map((r) => r.id);
  const reviews = syntheticReviews(pageId, ids);
  expect(reviews.length).toBeGreaterThanOrEqual(1000);
  for (let i = 0; i < reviews.length; i += 500) await command({ action: "study.reviews", reviews: reviews.slice(i, i + 500) });

  await page.reload();
  await page.getByRole("button", { name: "Meine Einstellungen" }).click();
  await expect(prefs.locator(".study-model-note")).toContainText("genug, um die Parameter an dein Gedächtnis anzupassen");
  await prefs.getByRole("button", { name: "Parameter optimieren …" }).click();
  await expect(dialog.locator(".study-optimize-status")).toContainText(`${reviews.length.toLocaleString("de-DE")} Wertungen.`);
  await dialog.getByRole("button", { name: "Optimieren", exact: true }).click();
  const result = dialog.getByRole("region", { name: "Ergebnis" });
  await expect(result).toBeVisible({ timeout: 60_000 });
  // The result in plain words; the measures behind it in a disclosure.
  await expect(result).toContainText("Die neuen Parameter passen besser zu dir.");
  await expect(result).toContainText(/Empfohlene Behaltensrate: \d\d %/);
  await expect(result.getByRole("rowheader", { name: "Log-Loss" })).toBeHidden();
  await result.getByText("Details zur Berechnung").click();
  await expect(result.getByRole("columnheader", { name: "Optimiert" })).toBeVisible();
  await expect(result.getByRole("rowheader", { name: "Log-Loss" })).toBeVisible();
  await expect(result.getByRole("rowheader", { name: "RMSE (Klassen)" })).toBeVisible();
  await dialog.getByRole("button", { name: "Parameter übernehmen", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".study-notice")).toHaveText("Deine optimierten Parameter gelten ab jetzt.");

  // The scheduler uses them; the settings and the statistics say so.
  const queue = await command({ action: "study.queue", pageId, limit: 0 });
  expect(queue.params.weights).toHaveLength(21);
  expect(queue.model.source).toBe("deck");
  await page.getByRole("button", { name: "Meine Einstellungen" }).click();
  await expect(prefs.locator(".study-model")).toContainText("Deine optimierten Parameter für diesen Stapel, vom");
  await expect(prefs.locator(".study-model-note")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(prefs).toBeHidden();
  await page.locator(".study-deck").getByRole("button", { name: "Statistik" }).click();
  await expect(page.locator(".study-stats-model")).toContainText(/Gedächtnismodell: FSRS-6 mit deinen Parametern für diesen Stapel, optimiert am .+ aus [\d.]+ Wertungen\. RMSE/);

  // The recommended retention, applied from the dialog.
  await page.getByRole("button", { name: "Meine Einstellungen" }).click();
  await prefs.getByRole("button", { name: "Parameter optimieren …" }).click();
  await dialog.getByRole("button", { name: "Optimieren", exact: true }).click();
  await expect(result).toBeVisible({ timeout: 60_000 });
  // Optimised again from the same log: no better than what is in use.
  await result.getByText("Details zur Berechnung").click();
  await expect(result.getByRole("columnheader", { name: "Bisher" })).toBeVisible();
  const use = dialog.getByRole("button", { name: /^Behaltensrate auf \d\d % setzen$/ });
  if (await use.count()) {
    const percent = Number((await use.textContent())!.match(/\d\d/)![0]);
    await use.click();
    await expect(page.locator(".study-notice")).toHaveText(`Behaltensrate ${percent} % übernommen.`);
    expect((await command({ action: "study.queue", pageId, limit: 0 })).params.retention).toBeCloseTo(percent / 100, 5);
  } else await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Reset: FSRS-6's defaults again.
  await page.getByRole("button", { name: "Meine Einstellungen" }).click();
  await prefs.getByRole("button", { name: "Parameter optimieren …" }).click();
  await dialog.getByRole("button", { name: "Auf Vorgabe zurücksetzen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".study-notice")).toHaveText("Wieder die Standardparameter von FSRS-6.");
  expect((await command({ action: "study.queue", pageId, limit: 0 })).model.source).toBe("default");
  expect(errors).toEqual([]);
});
