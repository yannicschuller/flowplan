import { test, expect } from "@playwright/test";

// Databases as note collections (issues #26, #27, #28): the kind on
// creation, quick capture and sharing into a database, Markdown import.
test("databases for notes: kind on creation, capture, share and Markdown import", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const stamp = `${info.project.name} ${Date.now()}`;
  await page.goto("/#home");
  await page.evaluate(() => localStorage.removeItem("flowplan-database-kind"));

  // #26: "Documents" as kind, remembered for the next database.
  await page.goto("about:blank");
  await page.goto("/#new");
  const dialog = page.getByRole("dialog", { name: "Neue Seite" });
  await dialog.getByLabel("Name").fill(`Notizen ${stamp}`);
  await dialog.getByRole("button", { name: /Datenbank/ }).click();
  const kinds = dialog.getByRole("group", { name: "Art der Datenbank" });
  await expect(kinds.getByRole("radio", { name: /Aufgaben/ })).toBeChecked();
  await kinds.getByText("Dokumente", { exact: true }).click();
  await page.screenshot({ path: `test-results/database-kind-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page.locator(".page-title")).toHaveValue(`Notizen ${stamp}`);
  const database = new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get("page")!;
  const schema = await (await page.request.get(`/api/pages/${database}`)).json();
  expect(schema.database.fields.map((f: { type: string }) => f.type)).toEqual(["text", "multiselect", "created_at", "updated_at"]);
  await page.goto("about:blank");
  await page.goto("/#new");
  await dialog.getByRole("button", { name: /Datenbank/ }).click();
  await expect(kinds.getByRole("radio", { name: /Dokumente/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();

  // #27: quick capture into this database, remembered as default.
  await page.goto("about:blank");
  await page.goto("/#capture");
  const capture = page.getByRole("dialog", { name: "Erfassen" });
  await capture.getByLabel("Titel").fill(`Idee ${stamp}`);
  await capture.getByLabel("Text", { exact: true }).fill("Später sortieren");
  await capture.getByLabel("Datenbank").selectOption(database);
  await capture.getByLabel("Als Standard zum Erfassen verwenden").check();
  await page.screenshot({ path: `test-results/quick-capture-${info.project.name}.png` });
  await capture.getByRole("button", { name: "Erfassen" }).click();
  await expect(capture).toHaveCount(0);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${database}`)).json()).rows as { cells: { title: string } }[]).map((r) => r.cells.title))
    .toContain(`Idee ${stamp}`);
  const targets = await (await page.request.get(`/api/capture?workspace=${schema.page.workspace_id}`)).json();
  expect(targets.default).toBe(database);

  // Share / web clipper: the default database is preselected.
  await page.goto(`/share-target?title=${encodeURIComponent(`Artikel ${stamp}`)}&url=${encodeURIComponent("https://example.org/artikel")}`);
  await expect(page.getByRole("radio", { name: "Als Eintrag" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Datenbank")).toHaveValue(database);
  await page.screenshot({ path: `test-results/share-record-${info.project.name}.png` });
  await page.getByRole("button", { name: "Als Eintrag speichern" }).click();
  await expect(page).toHaveURL(new RegExp(`page=${database}&row=`));

  // #28: a Markdown file with frontmatter becomes a record.
  await page.goto("about:blank");
  await page.goto(`/#page=${database}`);
  await page.locator('input[type=file][accept*=".md"]').setInputFiles({
    name: "Heizung.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(`---\ntags: [heizung]\nbereich: Haus\n---\n# Heizung ${stamp}\n\nEntlüften im Herbst.\n`),
  });
  const importing = page.getByRole("dialog", { name: "Markdown importieren" });
  await expect(importing).toContainText("1 Datei wird zu einem Eintrag.");
  await expect(importing.getByLabel("Fehlende Eigenschaften anlegen")).toBeChecked();
  await expect(importing).toContainText("bereich");
  await page.screenshot({ path: `test-results/markdown-import-${info.project.name}.png` });
  await importing.getByRole("button", { name: "Importieren" }).click();
  await expect(importing).toHaveCount(0);
  await expect(page.getByText(`Heizung ${stamp}`).first()).toBeVisible();
  expect(errors).toEqual([]);
});

// Issue #29 and the follow-ups of #26–#28: a page becomes a record, records
// and databases are exported from their menus, the manifest follows the
// reader's language.
test("a page moves into a database; records and databases export from their menus", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
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
  const stamp = String(Date.now());
  const create = (title: string, kind: string, extra: Record<string, unknown> = {}) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind, ...extra });
  const database = (await create(`Wissen ${stamp}`, "database", { databaseKind: "documents" })).id;
  const guide = (await create(`Anleitung ${stamp}`, "document")).id;

  await page.goto(`/#page=${guide}`);
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.type("Schritt eins.");
  await expect.poll(async () => (await (await page.request.get(`/api/pages/${guide}`)).json()).html as string, { timeout: 15000 }).toContain("Schritt eins");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "In Datenbank verschieben …" }).click();
  const dialog = page.getByRole("dialog", { name: "In Datenbank verschieben" });
  await dialog.getByLabel("Datenbank").selectOption(database);
  await page.screenshot({ path: "test-results/page-to-record.png" });
  await dialog.getByRole("button", { name: "Verschieben" }).click();
  await expect(page).toHaveURL(new RegExp(`page=${database}&row=`));
  const record = page.getByRole("dialog", { name: "Eintrag" });
  await expect(record).toContainText("Schritt eins.");

  // The record's menu exports it as Markdown with frontmatter.
  await record.getByRole("button", { name: "Weitere Aktionen" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Als Markdown exportieren (.md)" }).click(),
  ]);
  const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  expect(text).toMatch(new RegExp(`^---\\ntitle: Anleitung ${stamp}\\n`));
  expect(text).toContain("Schritt eins.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The database toolbar has one export menu with CSV and Markdown.
  await page.getByRole("button", { name: "Exportieren", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "CSV (aktuelle Ansicht)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Markdown mit Dateien (.zip)" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The manifest in English for English readers.
  const english = await (await page.request.get("/manifest.webmanifest", { headers: { "Accept-Language": "en-US", cookie: "" } })).json();
  expect(english.shortcuts.map((s: { name: string }) => s.name)).toEqual(["Capture", "New page", "Search"]);
  expect(errors).toEqual([]);
});
