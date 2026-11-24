import { test, expect, type Browser } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// #386: an administrator switches workflows off for the whole instance
// (Administration → Instanz → Funktionen dieser Instanz): "Neue Seite" has
// no workflow, an existing workflow opens read-only with a notice, and the
// person's own switch shows it as switched off by the administration.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

function account(name: string, groups: string[] = []) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID();
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at,email_verified) VALUES(?,?,?,?,?,1)").run(uid, `modules-off:${uid}`, name, `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600_000);
  db.close();
  return { uid, token };
}
async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return context;
}

test("workflows switched off for the instance: no workflow in new page, an existing one read-only with a notice", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "desktop", "Instance settings are global.");
  test.setTimeout(300_000);
  const admin = account("Instanz Admin", ["flowplan-admins"]);
  const context = await signedIn(browser, admin.token);
  const page = await context.newPage();
  const command = (data: Record<string, unknown>) => page.request.post(`${origin}/api/command`, { headers: { origin }, data });
  try {
    // The first visit makes the account's workspace; a workflow while on.
    await page.goto(`${origin}/`);
    await expect(page.getByRole("button", { name: /Neue Seite/ }).first()).toBeVisible({ timeout: 30_000 });
    const boot = await (await page.request.get(`${origin}/api/bootstrap`)).json();
    const made = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Abläufe", kind: "workflow" });
    expect(made.ok(), await made.text()).toBe(true);
    const workflow = (await made.json()) as { id: string };

    // Switched off in the administration (with a confirmation).
    // Loaded afresh at that address: a change of only the hash while the
    // first page still hydrates is undone by Next.js, which writes the
    // address it was loaded with ("/") into the history when it starts.
    await page.goto("about:blank");
    await page.goto(`${origin}/#admin/general`);
    const card = page.locator("#modules-off");
    await expect(card).toBeVisible({ timeout: 30_000 });
    page.once("dialog", (d) => void d.accept());
    await card.getByRole("switch", { name: "Workflows" }).click();
    await expect.poll(async () => (await (await page.request.get(`${origin}/api/admin`)).json()).settings.modulesOff).toEqual(["workflows"]);
    await expect(card.getByRole("switch", { name: "Workflows" })).not.toBeChecked();
    // The default for new accounts shows it as switched off, disabled.
    await expect(page.locator("#modules-default").getByRole("switch", { name: "Workflows" })).toBeDisabled();

    // "Neue Seite": no workflow (from the start page; "/" would return to
    // the administration last open).
    await page.goto(`${origin}/#home`);
    await page.reload();
    await page.getByRole("button", { name: /Neue Seite/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Neue Seite", exact: true });
    await expect(dialog.getByRole("radio", { name: "Dokument" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Workflow" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    // The server refuses it as well.
    const refused = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Neu", kind: "workflow" });
    expect(refused.status()).toBe(403);

    // The existing workflow: in the tree, opens with the notice.
    await page.goto(`${origin}/#page=${workflow.id}`);
    await expect(page.getByRole("note").filter({ hasText: "Auf dieser Instanz ausgeschaltet" })).toBeVisible({ timeout: 30_000 });

    // The person's own switch: off and disabled, with the reason.
    await page.goto(`${origin}/#settings/appearance`);
    const own = page.locator("#modules");
    await expect(own).toBeVisible({ timeout: 30_000 });
    await expect(own.getByRole("switch", { name: "Workflows" })).toBeDisabled();
    await expect(own.getByText("Von der Administration für diese Instanz ausgeschaltet.")).toBeVisible();
  } finally {
    await command({ action: "admin.settings", settings: { modulesOff: [] } });
    await context.close();
  }
});
