import { test, expect, type Locator, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";

// The order of the properties on the record page (#305): editors move them
// with the handle ("Nach oben", "An den Anfang", Alt + arrow keys) or drag
// them (desktop); the order is the database's, for everyone, and the
// table's columns stay as they were. Readers see it without handles.
test("record properties are reordered for everyone, apart from the table's columns", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Reihenfolge ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "note", name: "Notiz", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Angebot", status: "Offen", note: "Rückruf" } });
  const viewsBefore = JSON.stringify((await read()).database.views);

  // The names of the three properties, in the order shown (a date also
  // brings its repeat controls, left out here).
  const names = ["Status", "Notiz", "Fällig"];
  // Read from the page: while "Eigenschaft verschieben" is open, the record
  // dialog behind it is hidden from the accessibility tree.
  const labels = async (p: Page) =>
    (await p.locator(".row-properties .row-property > span:first-child").allTextContents()).map((s) => s.trim()).filter((s) => names.includes(s));
  const handle = (entry: Locator, name: string) => entry.getByRole("button", { name: `„${name}“ verschieben` });
  const open = async () => {
    await page.goto("about:blank");
    await page.goto(`/#page=${db.id}&row=${row.id}`);
    const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
    await expect(entry.locator(".row-properties")).toContainText("Fällig", { timeout: 30_000 });
    return entry;
  };
  let entry = await open();
  await expect.poll(() => labels(page)).toEqual(["Status", "Notiz", "Fällig"]);

  // The buttons: "Nach oben", then "An den Anfang".
  await handle(entry, "Fällig").click();
  const move = page.getByRole("dialog", { name: "Eigenschaft verschieben" });
  await expect(move).toContainText("„Fällig“ ist an Position 3 von 3.");
  await move.getByRole("button", { name: "Nach oben" }).click();
  await expect(move).toContainText("„Fällig“ ist an Position 2 von 3.");
  await expect.poll(() => labels(page)).toEqual(["Status", "Fällig", "Notiz"]);
  await move.getByRole("button", { name: "An den Anfang" }).click();
  await expect(move.getByRole("button", { name: "Nach oben" })).toBeDisabled();
  await expect.poll(() => labels(page)).toEqual(["Fällig", "Status", "Notiz"]);
  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
  await expect(entry).toBeVisible();

  // The keyboard: Alt + arrow up on the handle.
  await handle(entry, "Notiz").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => labels(page)).toEqual(["Fällig", "Notiz", "Status"]);
  await expect(handle(entry, "Notiz")).toBeFocused();

  // Dragging by the handle (desktop): Status above Fällig.
  if (!mobile) {
    await handle(entry, "Status").dragTo(entry.locator('.row-property-sortable[data-property="due"]'), { targetPosition: { x: 60, y: 4 } });
    await expect.poll(() => labels(page)).toEqual(["Status", "Fällig", "Notiz"]);
  }
  const expected = mobile ? ["Fällig", "Notiz", "Status"] : ["Status", "Fällig", "Notiz"];
  const ids = { Status: "status", Notiz: "note", Fällig: "due" } as Record<string, string>;
  await expect.poll(async () => (await read()).database.recordLayout.order).toEqual(expected.map((name) => ids[name]));

  // Kept after reloading; the table's columns and the views are untouched.
  entry = await open();
  await expect.poll(() => labels(page)).toEqual(expected);
  const data = await read();
  expect(JSON.stringify(data.database.views)).toBe(viewsBefore);
  expect(data.database.fields.map((f: { id: string }) => f.id)).toEqual(["title", "status", "note", "due"]);
  await page.goto("about:blank");
  await page.goto(`/#page=${db.id}`);
  const header = page.locator(".data-table thead");
  await expect(header).toContainText("Fällig");
  const columns = (await header.locator("th").allTextContents()).map((s) => s.trim()).filter((s) => ["Name", "Status", "Notiz", "Fällig"].includes(s));
  expect(columns).toEqual(["Name", "Status", "Notiz", "Fällig"]);

  // Another person, a reader: the same order, no handles, no change.
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
  const readerEntry = reader.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(readerEntry.locator(".row-properties")).toContainText("Fällig", { timeout: 30_000 });
  await expect.poll(() => labels(reader)).toEqual(expected);
  await expect(readerEntry.locator(".record-property-handle")).toHaveCount(0);
  const refused = await reader.request.post("/api/command", {
    headers: { origin },
    data: { action: "database.recordLayout", pageId: db.id, layout: { order: ["note"] } },
  });
  expect(refused.status()).toBe(403);
  expect((await read()).database.recordLayout.order).toEqual(expected.map((name) => ids[name]));
  await context.close();
  expect(errors).toEqual([]);
});
