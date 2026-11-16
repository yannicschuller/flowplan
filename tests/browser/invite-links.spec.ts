import { test, expect, type Browser } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Invitation links for several people (#320): the owner creates a link in
// Settings → Mitglieder, a second browser signs up through it while sign-ups
// are closed and joins the workspace; the owner sees the use, revokes the
// link, and a third browser is refused.
test("an invite link lets a new person sign up and join until it is revoked", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Instance settings are global; once is enough.");
  test.setTimeout(180_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  // Sign-ups closed: only the link lets the new person in.
  db.prepare("INSERT INTO instance_settings(key,value) VALUES('allowSignup','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `il:${uid}`, "Olga Owner", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600000);
  const open = async (b: Browser, session?: string) => {
    const context = await b.newContext({ locale: "de-DE", storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] } });
    if (session) await context.addCookies([{ name: "flowplan_session", value: session, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    return { context, page, errors };
  };
  const o = await open(browser, token);
  const n = await open(browser);
  const late = await open(browser);
  try {
    await o.page.goto(`${origin}/#home`);
    await expect(o.page.locator(".workspace-switch").first()).toBeAttached({ timeout: 30_000 });
    const boot = await (await o.page.request.get("/api/bootstrap")).json();
    const wid = boot.workspace.id as string;
    const name = `Linkteam ${Date.now()}`;
    expect((await o.page.request.post("/api/command", { headers: { origin }, data: { action: "workspace.update", workspaceId: wid, name } })).ok()).toBe(true);

    // Owner: create a link for viewers, at most two joins.
    await o.page.goto(`${origin}/#settings/members`);
    await o.page.reload();
    await o.page.getByRole("button", { name: "Einladungslink erstellen" }).click();
    const sheet = o.page.getByRole("dialog", { name: "Einladungslink erstellen" });
    await sheet.getByRole("combobox", { name: "Rolle" }).selectOption("viewer");
    await sheet.getByRole("combobox", { name: "Gültig für" }).selectOption("24h");
    await sheet.getByLabel("Höchstens so viele Beitritte").fill("2");
    await sheet.getByRole("button", { name: "Link erstellen" }).click();
    const urlField = sheet.locator("#invite-link-url");
    await expect(urlField).toHaveValue(/\/\?join=[A-Za-z0-9_-]{43}$/, { timeout: 15_000 });
    const link = await urlField.inputValue();
    await sheet.getByRole("button", { name: "Fertig" }).click();
    const item = o.page.locator("[data-invite-link]");
    await expect(item).toHaveCount(1);
    await expect(item.locator("[data-invite-link-uses]")).toContainText("0 von 2 Beitritten");

    // A new person opens the link, signs up and lands in the workspace.
    await n.page.goto(link);
    await expect(n.page.locator("[data-join-notice]")).toContainText(`Du bist zu „${name}“ eingeladen`, { timeout: 30_000 });
    await n.page.getByRole("button", { name: "Konto erstellen" }).click();
    const email = `joiner-${Date.now()}@example.test`;
    await n.page.getByLabel("Name").fill("Jana Joiner");
    await n.page.getByLabel("E-Mail-Adresse").fill(email);
    await n.page.locator("input[name=password]").fill("ein-langes-passwort");
    await n.page.getByRole("button", { name: "Konto erstellen" }).click();
    const intro = n.page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
    await expect(intro.or(n.page.locator(".workspace-switch").first())).toBeVisible({ timeout: 90_000 });
    if (await intro.isVisible()) await intro.getByRole("button", { name: "Überspringen" }).click();
    const joined = await (await n.page.request.get("/api/bootstrap")).json();
    expect(joined.workspaces.map((w: { id: string }) => w.id)).toContain(wid);
    const joiner = db.prepare("SELECT id FROM users WHERE email=?").get(email) as { id: string };
    expect(db.prepare("SELECT role FROM members WHERE workspace_id=? AND user_id=?").get(wid, joiner.id)).toEqual({ role: "viewer" });
    // The address bar no longer carries the link.
    await expect.poll(() => new URL(n.page.url()).searchParams.get("join")).toBeNull();

    // Owner: one join counted; revoke.
    await o.page.reload();
    await expect(item.locator("[data-invite-link-uses]")).toContainText("1 von 2 Beitritten", { timeout: 30_000 });
    o.page.once("dialog", (d) => void d.accept());
    await item.getByRole("button", { name: "Zurückziehen" }).click();
    await expect(item).toHaveCount(0, { timeout: 15_000 });

    // Revoked: the link no longer opens sign-up.
    await late.page.goto(link);
    await expect(late.page.locator("[data-join-error]")).toContainText("Dieser Einladungslink wurde zurückgezogen.", { timeout: 30_000 });
    await expect(late.page.getByRole("button", { name: "Konto erstellen" })).toHaveCount(0);
    expect((db.prepare("SELECT uses FROM invite_links WHERE workspace_id=?").get(wid) as { uses: number }).uses).toBe(1);
    expect([...o.errors, ...n.errors, ...late.errors]).toEqual([]);
  } finally {
    await o.context.close();
    await n.context.close();
    await late.context.close();
    db.close();
  }
});
