import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// "Für Bug-Report kopieren" (#630): Settings → Über Flowplan shows the
// installation details in one line and copies them; members get version
// and build with their device, administrators also the instance details
// (lib/diagnostics.ts) – there and under Instanz → Name & Version.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// A person of their own: the specs' demo sign-in administers the instance.
async function signIn(page: Page, groups: string[]) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `diagnostics:${uid}`, groups.length ? "Diagnose Admin" : "Diagnose Mitglied", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test("a member copies version, build and their browser – no instance details", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "The clipboard check runs on the desktop project.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, []);
  await page.goto("/#settings/about");
  const box = page.getByTestId("diagnostics-text");
  await expect(box).toHaveText(/^Flowplan .+ · Frontend: Chrome \d+, (Linux|macOS|Windows)$/);
  const shown = (await box.textContent())!;
  expect(shown).not.toMatch(/Node\.js|SQLite|PostgreSQL|local disk|single instance/);
  expect(shown).not.toContain(new URL(origin).host);
  const button = page.getByRole("button", { name: "Für Bug-Report kopieren" });
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "In die Zwischenablage kopiert." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kopiert" })).toBeVisible();
  expect(await clipboard(page)).toBe(shown);
});

test("an administrator gets the instance details on the About page and under Name & Version", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "The clipboard check runs on the desktop project.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, ["flowplan-admins"]);
  await page.goto("/#settings/about");
  const box = page.getByTestId("diagnostics-text");
  await expect(box).toHaveText(/^Flowplan .+\(.*Node\.js v[\d.]+, .+, SQLite, local disk, single instance\) · Frontend: Chrome \d+, /);
  await page.getByRole("button", { name: "Für Bug-Report kopieren" }).click();
  expect(await clipboard(page)).toBe(await box.textContent());
  await page.goto("/#settings/instance/general");
  await expect(page.getByTestId("diagnostics-text")).toHaveText(/Node\.js v[\d.]+, .+, SQLite, local disk, single instance\) · Frontend: /);
});
