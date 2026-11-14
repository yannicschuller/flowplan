import { test, expect, type Browser } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Emergency access (#281): the holder names a trusted contact in the settings,
// the contact accepts and requests, and after the waiting period reads the
// holder's private pages in the viewer – read and export only.
test("a trusted contact requests emergency access and reads the holder's pages", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(180_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const make = (name: string) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex"),
      email = `${uid}@example.test`;
    db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `em:${uid}`, name, email, Date.now());
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600000);
    return { uid, token, email };
  };
  const open = async (b: Browser, token: string) => {
    const context = await b.newContext({ locale: "de-DE" });
    await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    return { context, page, errors };
  };
  const holder = make(`Halterin ${Date.now()}`);
  const contact = make(`Vertraut ${Date.now()}`);
  const h = await open(browser, holder.token);
  const c = await open(browser, contact.token);
  try {
    // First visit: the holder's workspace and private space exist.
    await h.page.goto(`${origin}/#home`);
    await expect(h.page.locator(".workspace-switch").first()).toBeAttached({ timeout: 30_000 });
    const boot = await (await h.page.request.get("/api/bootstrap")).json();
    const command = async (data: Record<string, unknown>) => {
      const r = await h.page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
      expect(r.ok(), await r.text()).toBe(true);
      return r.json();
    };
    const space = await command({ action: "space.create", name: "Privat", private: true });
    const pageTitle = `Testament ${Date.now()}`;
    await command({ action: "page.create", spaceId: space.id, title: pageTitle, kind: "document" });
    // Holder: add the contact.
    await h.page.goto(`${origin}/#settings/account/emergency`);
    await expect(h.page.getByText("Deine Vertrauenspersonen")).toBeVisible({ timeout: 30_000 });
    await h.page.getByRole("textbox", { name: "E-Mail-Adresse" }).fill(contact.email);
    await h.page.getByRole("combobox", { name: "Wartezeit" }).selectOption("1");
    await h.page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
    await expect(h.page.getByText("Noch nicht bestätigt")).toBeVisible({ timeout: 15_000 });

    // Contact: accept, then request.
    await c.page.goto(`${origin}/#settings/account/emergency`);
    await expect(c.page.getByText("Ich bin Vertrauensperson für …")).toBeVisible({ timeout: 30_000 });
    await c.page.getByRole("button", { name: "Annehmen" }).click();
    await c.page.getByRole("button", { name: "Notfallzugriff anfragen" }).click();
    await c.page.getByRole("dialog").getByRole("button", { name: "Anfragen", exact: true }).click();
    await expect(c.page.getByRole("button", { name: "Anfrage zurückziehen" })).toBeVisible({ timeout: 15_000 });

    // Holder sees the request with a deny button.
    await h.page.reload();
    await expect(h.page.getByRole("button", { name: "Ablehnen" })).toBeVisible({ timeout: 30_000 });

    // The waiting period runs out.
    db.prepare("UPDATE emergency_contacts SET grant_at=? WHERE holder_id=? AND contact_id=?").run(Date.now() - 1000, holder.uid, contact.uid);
    await c.page.reload();
    const openContent = c.page.getByRole("button", { name: "Inhalte öffnen" });
    await expect(openContent).toBeVisible({ timeout: 30_000 });
    await openContent.click();
    await expect(c.page.locator(".emergency-tree")).toBeVisible({ timeout: 30_000 });
    await c.page.locator(".emergency-tree").getByText(pageTitle).click();
    await expect(c.page.getByRole("button", { name: "Als Markdown herunterladen" })).toBeVisible({ timeout: 15_000 });
    await expect(c.page.locator(".emergency-tree").getByText("Team")).toHaveCount(0);
    await c.page.screenshot({ path: test.info().outputPath("viewer.png") });
    expect(db.prepare("SELECT status FROM emergency_contacts WHERE holder_id=? AND contact_id=?").get(holder.uid, contact.uid)).toEqual({ status: "granted" });

    // Holder ends the access.
    await h.page.reload();
    await expect(h.page.getByText("Hat Lesezugriff")).toBeVisible({ timeout: 30_000 });
    await h.page.screenshot({ path: test.info().outputPath("holder.png") });
    await h.page.getByRole("button", { name: "Zugriff beenden" }).click();
    await expect(h.page.getByText("Hat Lesezugriff")).toHaveCount(0, { timeout: 15_000 });
    expect(h.errors).toEqual([]);
    expect(c.errors).toEqual([]);
  } finally {
    await h.context.close();
    await c.context.close();
    db.close();
  }
});
