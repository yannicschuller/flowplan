import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";

// Select and multi-select values found by typing (#423): the search opens
// with the cell, filters (case and accents aside), Enter takes the
// highlighted option; without a match "„…“ anlegen" adds the option to the
// property and sets it at once. A multi-select stays open for more;
// readers cannot change or create anything.
async function setup(page: Page, title: string, initial: Record<string, unknown> = {}) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
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
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt", "Café"] },
      { id: "labels", name: "Labels", type: "multiselect", options: ["Rot", "Blau"] },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Birnen", ...initial } });
  const data = async () => read(db.id);
  const cells = async () => ((await data()).rows as { id: string; cells: Record<string, unknown> }[]).find((r) => r.id === row.id)?.cells ?? {};
  const options = async (field: string) => ((await data()).database.fields as { id: string; options?: string[] }[]).find((f) => f.id === field)?.options;
  return { origin, boot, db, row, command, cells, options };
}

test("select cells: type to filter, Enter picks, a new option is created and set", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, cells, options } = await setup(page, `Auswahl ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${db.id}`);
  const row = page.locator(".data-table tbody tr[data-row-id]").first();
  await expect(row).toBeVisible();
  const status = row.locator("td").nth(2);
  const search = page.getByRole("combobox", { name: "Status: Option suchen oder anlegen" });
  const list = page.getByRole("listbox", { name: "Optionen von Status" });

  // Opening the cell focuses the search; every option is listed.
  await status.click();
  await expect(search).toBeFocused();
  await expect(list.getByRole("option")).toHaveText(["Offen", "In Arbeit", "Erledigt", "Café"]);
  // Typing filters; without an exact match it offers to create.
  await page.keyboard.type("ARB");
  await expect(list.getByRole("option")).toHaveText(["In Arbeit", "„ARB“ anlegen"]);
  await expect(search).toHaveAttribute("aria-activedescendant", await list.getByRole("option").first().getAttribute("id") as string);
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
  await expect.poll(async () => (await cells()).status).toBe("In Arbeit");
  await expect(status).toHaveText("In Arbeit");

  // Accents and case aside, an existing option is found and nothing is created.
  await status.click();
  await page.keyboard.type("cafe");
  await expect(list.getByRole("option")).toHaveText(["Café"]);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).status).toBe("Café");

  // Arrow keys move the highlight.
  await status.click();
  await page.keyboard.type("e");
  await expect(list.getByRole("option")).toHaveText(["Erledigt", "Offen", "In Arbeit", "Café", "„e“ anlegen"]);
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).status).toBe("Offen");

  // A new one: created in the property and set on the record in one go.
  await status.click();
  await page.keyboard.type("Wartet auf Kunde");
  await expect(list.getByRole("option")).toHaveText(["„Wartet auf Kunde“ anlegen"]);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).status).toBe("Wartet auf Kunde");
  expect(await options("status")).toEqual(["Offen", "In Arbeit", "Erledigt", "Café", "Wartet auf Kunde"]);
  await expect(status).toHaveText("Wartet auf Kunde");
  // The column's options have it (the property's settings).
  await page
    .locator(".data-table thead")
    .getByRole("button", { name: /^\W*Status$/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  await expect(settings.getByLabel("Optionen, durch Komma getrennt")).toHaveValue("Offen, In Arbeit, Erledigt, Café, Wartet auf Kunde");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // Escape closes without a change.
  await status.click();
  await page.keyboard.type("Off");
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await page.waitForTimeout(300);
  expect((await cells()).status).toBe("Wartet auf Kunde");
  expect(errors).toEqual([]);
});

test("multi-select cells stay open: two options, one of them new", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, cells, options } = await setup(page, `Mehrfach ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${db.id}`);
  const row = page.locator(".data-table tbody tr[data-row-id]").first();
  await expect(row).toBeVisible();
  await row.locator("td").nth(3).click();
  const search = page.getByRole("combobox", { name: "Labels: Option suchen oder anlegen" });
  const list = page.getByRole("listbox", { name: "Optionen von Labels" });
  await expect(search).toBeFocused();
  await page.keyboard.type("grün");
  await expect(list.getByRole("option")).toHaveText(["„grün“ anlegen"]);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).labels).toEqual(["grün"]);
  expect(await options("labels")).toEqual(["Rot", "Blau", "grün"]);
  // Still open, empty again, the chosen one left out of the list.
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(list.getByRole("option")).toHaveText(["Rot", "Blau"]);
  await page.keyboard.type("BL");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).labels).toEqual(["grün", "Blau"]);
  await expect(row.getByRole("group", { name: "Labels", exact: true })).toContainText("grün");
  await expect(list.getByRole("option")).toHaveText(["Rot"]);
  // The one chosen already is no new option.
  await page.keyboard.type("Grün");
  await expect(list.getByRole("option")).toHaveCount(0);
  await expect(page.locator(".option-picker-empty")).toHaveText("Keine passende Option.");
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(row.locator("td").nth(3)).toHaveText("grünBlau");

  // In the record: the values as chips on a button that opens the same
  // search (#519); a chip goes with its ✕ there.
  await row.getByRole("button", { name: /^Eintrag öffnen/ }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry.getByRole("button", { name: "Labels: grün, Blau, ändern" }).click();
  await expect(page.getByRole("combobox", { name: "Labels: Option suchen oder anlegen" })).toBeFocused();
  await page.getByRole("group", { name: "Gewählt: Labels" }).getByRole("button", { name: "„grün“ entfernen" }).click();
  await expect.poll(async () => (await cells()).labels).toEqual(["Blau"]);
  // A tap or click on an option picks it.
  await page.getByRole("listbox", { name: "Optionen von Labels" }).getByRole("option", { name: "Rot" }).click();
  await expect.poll(async () => (await cells()).labels).toEqual(["Blau", "Rot"]);
  await page.keyboard.press("Escape");
  await expect(entry.getByRole("button", { name: "Labels: Blau, Rot, ändern" })).toBeFocused();
  // The single select in the record: the same search.
  await entry.getByRole("button", { name: /^Status: / }).click();
  await page.keyboard.type("erl");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).status).toBe("Erledigt");
  await expect(entry.getByRole("button", { name: "Status: Erledigt" })).toBeVisible();
  // Escape closes the search, the record stays open.
  await entry.getByRole("button", { name: "Status: Erledigt" }).click();
  await page.keyboard.press("Escape");
  await expect(entry.getByRole("button", { name: "Status: Erledigt" })).toBeFocused();
  await expect(entry).toBeVisible();
  expect(errors).toEqual([]);
});

// #426: the chosen values stand above the search as chips; Backspace in
// the empty search removes the last one, the arrow keys reach the chips,
// Delete removes the focused one.
test("chosen values above the search: Backspace, Delete and the chips' ✕", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, cells } = await setup(page, `Abwählen ${info.project.name} ${Date.now()}`, { status: "Offen", labels: ["Rot", "Blau"] });
  await page.goto(`/#page=${db.id}`);
  const row = page.locator(".data-table tbody tr[data-row-id]").first();
  await expect(row).toBeVisible();

  // Multi-select: the chips above the search, each with its ✕.
  await row.locator("td").nth(3).click();
  const search = page.getByRole("combobox", { name: "Labels: Option suchen oder anlegen" });
  await expect(search).toBeFocused();
  const chosen = page.getByRole("group", { name: "Gewählt: Labels" });
  await expect(chosen.getByRole("button", { name: "„Rot“ entfernen" })).toBeVisible();
  await expect(chosen.getByRole("button", { name: "„Blau“ entfernen" })).toBeVisible();
  // Backspace in the empty search: the last one goes, the search stays.
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await cells()).labels).toEqual(["Rot"]);
  await expect(search).toBeFocused();
  await expect(chosen.getByRole("button")).toHaveCount(1);
  // Typed text is deleted first, values only from an empty field.
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await expect(search).toHaveValue("");
  expect((await cells()).labels).toEqual(["Rot"]);
  // Back to two; ArrowLeft reaches the chips, Delete removes the focused one.
  await page.keyboard.type("blau");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).labels).toEqual(["Rot", "Blau"]);
  await page.keyboard.press("ArrowLeft");
  await expect(chosen.getByRole("button", { name: "„Blau“ entfernen" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(chosen.getByRole("button", { name: "„Rot“ entfernen" })).toBeFocused();
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await cells()).labels).toEqual(["Blau"]);
  await expect(chosen.getByRole("button", { name: "„Blau“ entfernen" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(search).toBeFocused();
  // The chip's ✕ by click or tap.
  await chosen.getByRole("button", { name: "„Blau“ entfernen" }).click();
  await expect.poll(async () => (await cells()).labels).toEqual([]);
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();

  // Select: its value as a chip; Backspace in the empty search clears it.
  await row.locator("td").nth(2).click();
  await expect(page.getByRole("group", { name: "Gewählt: Status" }).getByRole("button", { name: "„Offen“ entfernen" })).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await cells()).status).toBe("");
  await expect(page.getByRole("combobox", { name: /^Status: Option suchen/ })).toBeHidden();
  await expect(row.locator("td").nth(2)).toHaveText("");

  // In the record: pick, then the chip's ✕ in the open search.
  await row.getByRole("button", { name: /^Eintrag öffnen/ }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry.getByRole("button", { name: "Status: leer" }).click();
  await page.keyboard.type("Erl");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await cells()).status).toBe("Erledigt");
  await entry.getByRole("button", { name: "Status: Erledigt" }).click();
  await page.getByRole("group", { name: "Gewählt: Status" }).getByRole("button", { name: "„Erledigt“ entfernen" }).click();
  await expect.poll(async () => (await cells()).status).toBe("");
  expect(errors).toEqual([]);
});

test("readers see the values but cannot change them or create options", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  const { origin, boot, db, row, options } = await setup(page, `Lesend ${info.project.name} ${Date.now()}`, { status: "Offen", labels: ["Rot"] });
  const store = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  store.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  store.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, uid, "Lea Lesend", `${uid}@test.invalid`, Date.now());
  store.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "viewer");
  store
    .prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)")
    .run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600000);
  store.close();
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: mobile,
    hasTouch: mobile,
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    storageState: { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin }]);
  const reader = await context.newPage();
  reader.on("pageerror", (e) => errors.push(e.message));
  await reader.goto(`${origin}/#page=${db.id}&row=${row.id}`);
  const entry = reader.getByRole("dialog", { name: "Eintrag", exact: true });
  // Readers see the values as chips, without a button to change them (#519).
  const properties = entry.locator(".row-properties");
  await expect(properties).toContainText("Offen", { timeout: 30_000 });
  await expect(properties).toContainText("Rot");
  await expect(properties.getByRole("button", { name: /ändern$/ })).toHaveCount(0);
  await expect(reader.getByRole("combobox", { name: /Option suchen/ })).toHaveCount(0);
  // The server refuses a new option from a reader.
  const d = (await (await reader.request.get(`/api/pages/${db.id}`)).json()).database;
  const refused = await reader.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "database.update",
      pageId: db.id,
      version: d.version,
      fields: d.fields.map((f: { id: string; options?: string[] }) => (f.id === "status" ? { ...f, options: [...(f.options || []), "Neu"] } : f)),
      views: d.views,
    },
  });
  expect(refused.status()).toBe(403);
  expect(await options("status")).toEqual(["Offen", "In Arbeit", "Erledigt", "Café"]);
  await context.close();
  expect(errors).toEqual([]);
});
