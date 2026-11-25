import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// #535: the incidents under Einstellungen → Instanz → Sicherheit come in
// pages of 20 from the server ("Weitere laden", "20 von 47"), searchable
// (rule, detail, network, person) and filtered by status and severity –
// open ones first. A deep link opens an incident that is not on the first
// page.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.SHOTS_DIR || "test-results/security-incidents";

function seed() {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `incidents:${uid}`, "Ida Admin", `${uid}@example.test`, Date.now());
  d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600_000);
  // A word only these incidents have: other specs may open incidents too.
  const marker = `m${randomBytes(4).toString("hex")}`;
  const now = Date.now();
  const insert = d.prepare(
    "INSERT INTO security_incidents(id,rule,key,severity,actor_id,network,address_key,detail,first_at,last_at,count,resolved_at,resolved_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const ids: string[] = [];
  for (let i = 0; i < 45; i++) {
    const incident = randomUUID();
    ids.push(incident);
    insert.run(incident, "probing", `${marker}:${i}`, "warn", null, "203.0.113.0/24", "", `${marker} 60 verschiedene Anfragen mit 401/403/404, z. B. 404 /api/pages/${i}`, now - 3_600_000 - i * 60_000, now - 3_600_000 - i * 60_000, 1 + (i % 4), now - i * 60_000, uid);
  }
  insert.run(randomUUID(), "privilege_change", `${marker}:c`, "critical", uid, "", "", `${marker} scim.token.create`, now - 120_000, now - 120_000, 1, null, null);
  insert.run(randomUUID(), "brute_force_account", `${marker}:w`, "warn", null, "198.51.100.0/24", "", `${marker} ida@example.test: 10`, now - 60_000, now - 60_000, 3, null, null);
  d.close();
  return { token, marker, oldest: ids.at(-1)! };
}

async function signIn(page: Page, token: string) {
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
      localStorage.setItem("flowplan-offline-offer", "never");
    } catch {}
  });
}

test("incidents: search, filters, pages of 20 and a deep link past the first page", async ({ page }, testInfo) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const { token, marker, oldest } = seed();
  await signIn(page, token);
  await page.goto(`${origin}/#settings/instance/threats/incidents`);
  const section = page.locator("#incidents");
  const search = section.getByRole("searchbox", { name: "Vorfälle durchsuchen" });
  await expect(search).toBeVisible({ timeout: 20_000 });
  const count = section.getByRole("status").filter({ hasText: / von / });
  const open = section.getByRole("list", { name: "Offene Vorfälle" });
  const done = section.getByRole("list", { name: "Erledigte Vorfälle" });

  await search.fill(marker);
  await expect(count).toHaveText("20 von 47");
  // Open ones first: critical, then the warning; then the resolved ones.
  await expect(open.locator(".security-incident-title")).toHaveText(["Rechte oder Anmeldung der Instanz geändert", "Passwort-Raten bei einem Konto"]);
  await expect(done.locator("> li")).toHaveCount(18);
  await expect(section.getByRole("heading", { name: "Erledigt", exact: true })).toBeVisible();
  const status = section.getByRole("group", { name: "Status" });
  await expect(status.getByRole("button", { name: /^Offen/ })).toHaveText("Offen 2");
  await expect(status.getByRole("button", { name: /^Erledigt/ })).toHaveText("Erledigt 45");
  await page.screenshot({ path: join(shots, `${testInfo.project.name}-search.png`), fullPage: false });

  const more = section.getByRole("button", { name: "Weitere laden" });
  await more.click();
  await expect(count).toHaveText("40 von 47");
  await more.click();
  await expect(count).toHaveText("47 von 47");
  await expect(more).toHaveCount(0);
  await expect(done.locator("> li")).toHaveCount(45);

  // Only the open ones, then only critical.
  await status.getByRole("button", { name: /^Offen/ }).click();
  await expect(count).toHaveText("2 von 2");
  await expect(done).toHaveCount(0);
  await section.getByRole("combobox", { name: "Schwere" }).selectOption("critical");
  await expect(count).toHaveText("1 von 1");
  await expect(open.locator(".security-incident-title")).toHaveText(["Rechte oder Anmeldung der Instanz geändert"]);
  await section.getByRole("combobox", { name: "Schwere" }).selectOption("all");
  await status.getByRole("button", { name: /^Alle/ }).click();

  // A path inside the detail; an event name; the rule's title.
  await search.fill(`${marker} 60 verschiedene Anfragen mit 401/403/404, z. B. 404 /api/pages/44`);
  await expect(count).toHaveText("1 von 1");
  await search.fill(`${marker} scim.token`);
  await expect(count).toHaveText("1 von 1");
  await search.fill("ida@example.test: 10");
  await expect(open.locator(".security-incident-title")).toContainText(["Passwort-Raten bei einem Konto"]);

  // Nothing found: say so, and back to everything.
  await search.fill(`${marker}-nothing`);
  await expect(section.getByText("Keine passenden Vorfälle")).toBeVisible();
  if (testInfo.project.name === "desktop") await page.screenshot({ path: join(shots, "desktop-empty.png") });
  await section.getByRole("button", { name: "Suche und Filter zurücksetzen" }).click();
  await expect(search).toHaveValue("");
  await expect(count).toHaveText(/^20 von \d+$/);

  // The oldest incident is on the third page – its link opens it all the same.
  await page.goto(`${origin}/#settings/instance/threats/incident/${oldest}`);
  await expect(page.getByRole("heading", { name: "Abtasten von Adressen und IDs" })).toBeVisible();
  await expect(page.getByText(`${marker} 60 verschiedene Anfragen mit 401/403/404, z. B. 404 /api/pages/44`).first()).toBeVisible();
  await page.getByRole("link", { name: "Alle Vorfälle" }).click();
  await expect(search).toBeVisible();

  // Dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await search.fill(marker);
  await expect(count).toHaveText("20 von 47");
  await page.screenshot({ path: join(shots, `${testInfo.project.name}-dark.png`) });
});

test.use({ deviceScaleFactor: 2 });
test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
});
