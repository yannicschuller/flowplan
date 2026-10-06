import { test, expect } from "@playwright/test";

// Set up CalDAV in the calendar dialog; a CalDAV client sees and edits events.
test("two-way calendar sync over CalDAV", async ({ page }, info) => {
  test.setTimeout(150_000);
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Termine ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "when", name: "Wann", type: "date" },
    ],
    views: [{ id: "cal", name: "Kalender", type: "calendar", dateField: "when", calendar: { mode: "month", timeZone: "Europe/Berlin" }, filters: [], sorts: [] }],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Review", when: new Date().toISOString().slice(0, 10) } });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: "Abonnieren" }).click();
  await page.getByRole("button", { name: "Zugang einrichten" }).click();
  const dialog = page.getByRole("dialog");
  const password = await dialog.getByLabel(/Passwort/).inputValue();
  const calendar = await dialog.getByLabel(/Kalender-Adresse/).inputValue();
  const auth = `Basic ${Buffer.from(`me:${password}`).toString("base64")}`;
  const path = new URL(calendar).pathname;
  // Discovery as Apple does it, with the trailing slash.
  const root = await page.request.fetch("/.well-known/caldav", { method: "PROPFIND", headers: { authorization: auth }, maxRedirects: 0 });
  expect(root.status()).toBe(301);
  const list = await page.request.fetch(path, { method: "PROPFIND", headers: { authorization: auth, depth: "1" } });
  expect(list.status()).toBe(207);
  expect(await list.text()).toContain(`${row.id}.ics`);
  const ics = await (await page.request.get(`${path}${row.id}.ics`, { headers: { authorization: auth } })).text();
  const put = await page.request.fetch(`${path}${row.id}.ics`, { method: "PUT", headers: { authorization: auth, "content-type": "text/calendar" }, data: ics.replace("SUMMARY:Review", "SUMMARY:Review (verschoben)") });
  expect(put.status()).toBe(204);
  const after = await (await page.request.get(`/api/pages/${db.id}`)).json();
  expect(after.rows.find((r: { id: string }) => r.id === row.id).cells.title).toBe("Review (verschoben)");
  // Pages still lose a trailing slash.
  const login = await page.request.get("/login/", { maxRedirects: 0 });
  expect(login.status()).toBe(308);
  expect(errors).toEqual([]);
});
