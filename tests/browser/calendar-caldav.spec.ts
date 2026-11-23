import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { CalDavMock } from "../caldav-server-mock";

// Connect a CalDAV account in the settings (server address, username, app
// password) against the local mock (#460), then sync a database view with
// its calendar through "Kalender-Sync". The test server allows 127.0.0.1
// (FLOWPLAN_CALDAV_ALLOW_PRIVATE in scripts/e2e-server.mjs).
test("connecting a CalDAV calendar in the settings and syncing a view with it", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // Demo accounts do not connect calendars: a real account with a session.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `caldav:${uid}`, "Kalender Person", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600_000);
  db.close();
  // Throwaway credentials of this run.
  const username = `anna${randomBytes(3).toString("hex")}`,
    password = randomBytes(18).toString("base64url");
  const mock = new CalDavMock(username, password);
  await mock.start();
  const context = await browser.newContext({ locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/#home`);
    await expect(page.locator(".workspace-switch").first()).toBeAttached({ timeout: 20_000 });
    await page.goto(`${origin}/#settings/connections`);
    await page.getByRole("button", { name: "Mit CalDAV verbinden" }).click();
    const form = page.getByRole("form", { name: "CalDAV-Kalender verbinden" });
    await form.getByLabel("Server-Adresse").fill(mock.origin);
    await form.getByLabel("Benutzername").fill(username);
    // A wrong password: the server's refusal is shown, nothing is connected.
    await form.getByLabel("App-Passwort").fill("falsch");
    await form.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page.getByText(/Benutzername oder App-Passwort abgelehnt/).first()).toBeVisible();
    await form.getByLabel("App-Passwort").fill(password);
    await form.getByRole("button", { name: "Verbinden", exact: true }).click();
    const account = `${username}@${new URL(mock.origin).host}`;
    await expect(page.getByRole("status").filter({ hasText: `${account} verbunden (1 Kalender)` })).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(page.getByText(`CalDAV · ${account}`)).toBeVisible();

    // A database with a calendar view, synced with the account's calendar.
    const api = context.request;
    const boot = await (await api.get(`${origin}/api/bootstrap`)).json();
    const command = async (data: Record<string, unknown>) => {
      const response = await api.post(`${origin}/api/command`, { headers: { origin }, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Termine CalDAV", kind: "database" });
    const first = await (await api.get(`${origin}/api/pages/${created.id}`)).json();
    await command({
      action: "database.update",
      pageId: created.id,
      version: first.database.version,
      fields: [
        { id: "title", name: "Name", type: "text" },
        { id: "when", name: "Wann", type: "date" },
      ],
      views: [{ id: "cal", name: "Kalender", type: "calendar", dateField: "when", calendar: { mode: "month", timeZone: "Europe/Berlin" }, filters: [], sorts: [] }],
    });
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await command({ action: "row.create", pageId: created.id, cells: { title: "Review", when: day } });
    await page.goto(`${origin}/#page=${created.id}`);
    await page.locator(".calendar-nav").waitFor();
    await page.getByRole("button", { name: "Kalender-Sync" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Konto")).toContainText(`CalDAV · ${account}`);
    await expect(dialog.getByLabel("Kalender", { exact: true })).toContainText("Arbeit");
    await dialog.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Verbunden und synchronisiert.");
    // The record is an event in the CalDAV calendar now.
    const events = [...mock.calendars.get("work")!.events.values()];
    expect(events).toHaveLength(1);
    expect(events[0].ics).toContain("SUMMARY:Review");
    expect(events[0].ics).toContain(`DTSTART;VALUE=DATE:${day.replace(/-/g, "")}`);
    expect(mock.requests.find((r) => r.method === "PUT")?.ifNoneMatch).toBe("*");
    await expect(dialog).toContainText("1 Termine");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await mock.stop();
  }
});
