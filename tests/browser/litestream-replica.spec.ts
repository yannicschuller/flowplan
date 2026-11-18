import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Administration → Überwachung: the warning about a stuck Litestream
// replica (components/settings/admin/monitoring-litestream.tsx). The specs'
// server runs without S3 and Litestream, so the dashboard's answer gets the
// state of lib/litestream-health.ts put in, and the buttons' requests are
// answered here – a real restart would end the server. Checked: the
// warning, "Replik jetzt neu aufbauen" (confirmed, then "wird beim nächsten
// Neustart repariert" with "Jetzt neu starten"), the restart request, and
// that it fits a phone. Screenshots light and dark.
async function signInAdmin(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `litestream-admin:${uid}`, "Litestream Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return origin;
}

test("a stuck replica: warning, rebuild on the next start, restart now", async ({ page }, testInfo) => {
  const origin = await signInAdmin(page);
  const now = Date.now();
  const incident = { since: now - 3 * 3600_000, checkedAt: now, oldestAt: now - 26 * 3600_000, files: 1000, truncated: true, repair: "off", backup: null as null | { at: number; name: string; error: string | null } };
  const state = { active: true, since: now - 5 * 3600_000, autoheal: false, marker: null as null | string, incident, lastCheck: { at: now, error: null } };
  const posted: string[] = [];
  await page.route(/\/api\/admin\/monitoring(\?|$)/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const action = (request.postDataJSON() as { action: string }).action;
      posted.push(action);
      if (action === "litestream.rebuild") {
        state.marker = "remote";
        incident.repair = "scheduled";
        incident.backup = { at: Date.now(), name: "flowplan-2026-11-18T12-00-00.sqlite.enc", error: null };
      }
      return route.fulfill({ json: { litestream: state, restarting: action === "litestream.restart" } });
    }
    // The dashboard polls and drops a request under way when it loads
    // again (or the test ends): that one is gone.
    try {
      const response = await route.fetch();
      const body = await response.json();
      if (body?.system) body.system.litestream = state;
      await route.fulfill({ response, json: body });
    } catch {}
  });

  await page.goto(`${origin}/#admin/monitoring`);
  const warning = page.getByTestId("litestream-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("role", "alert");
  await expect(warning).toContainText("Die Litestream-Replik im Bucket hängt");
  await expect(warning).toContainText("1.000+ Änderungsdateien");
  await expect(warning).toContainText("Die automatische Reparatur ist aus (FLOWPLAN_LITESTREAM_AUTOHEAL=off).");
  await expect(warning.getByRole("link", { name: "Litestream-Zustand reparieren" })).toHaveAttribute("href", "https://docs.flowplan.org/de/restore#litestream-zustand-reparieren");
  await warning.scrollIntoViewIfNeeded();
  await warning.screenshot({ path: `test-results/litestream-replica/${testInfo.project.name}-stuck.png` });

  // Rebuild: confirmed first, then repaired on the next start.
  let question = "";
  page.once("dialog", (dialog) => {
    question = dialog.message();
    void dialog.accept();
  });
  await warning.getByRole("button", { name: "Replik jetzt neu aufbauen" }).click();
  await expect(warning).toContainText("wird beim nächsten Neustart repariert");
  expect(question).toContain("löscht Flowplan den Ordner db/");
  expect(posted).toEqual(["litestream.rebuild"]);
  await expect(warning).toContainText("Vorher gesichert: flowplan-2026-11-18T12-00-00.sqlite.enc");
  const restart = warning.getByRole("button", { name: "Jetzt neu starten" });
  await expect(restart).toBeVisible();
  await expect(warning.getByRole("button", { name: "Reparatur abbrechen" })).toBeVisible();

  // Phone width: the note and its buttons stay within the page.
  const boxes = await page.evaluate(() => {
    const note = document.querySelector('[data-testid="litestream-warning"]')!.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('[data-testid="litestream-warning"] button')].map((b) => b.getBoundingClientRect().right);
    return { right: Math.max(note.right, ...buttons), width: document.documentElement.clientWidth };
  });
  expect(boxes.right).toBeLessThanOrEqual(boxes.width + 0.5);
  await warning.screenshot({ path: `test-results/litestream-replica/${testInfo.project.name}-scheduled-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await warning.screenshot({ path: `test-results/litestream-replica/${testInfo.project.name}-scheduled-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.emulateMedia({ colorScheme: "light" });

  // Restart: confirmed, then the note says it restarts.
  page.once("dialog", (dialog) => {
    question = dialog.message();
    void dialog.accept();
  });
  await restart.click();
  await expect(page.getByText("Flowplan startet neu und repariert dabei die Litestream-Replik.")).toBeVisible();
  expect(question).toContain("Neustart-Richtlinie");
  expect(posted).toEqual(["litestream.rebuild", "litestream.restart"]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("no stuck replica, nothing scheduled: no warning", async ({ page }) => {
  const origin = await signInAdmin(page);
  await page.goto(`${origin}/#admin/monitoring`);
  await expect(page.locator(".mon-toolbar")).toBeVisible();
  await expect(page.locator("#health, .mon-health").first()).toBeVisible();
  await expect(page.getByTestId("litestream-warning")).toHaveCount(0);
});
