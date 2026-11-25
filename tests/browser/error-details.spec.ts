import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Administration → Überwachung → Fehler im Detail (lib/error-details.ts):
// a 5xx of the specs' failing endpoint (lib/e2e-failure.ts, only in this
// build) shows up as a group with its route, error name and scrubbed
// message; opened, with the stack frames and the request id the answer
// carried (X-Request-Id and the JSON body). Screenshots light and dark.
async function signInAdmin(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `errors-admin:${uid}`, "Errors Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return origin;
}

test("a 5xx shows up in the error details with its stack frames and request id", async ({ page }, testInfo) => {
  const origin = await signInAdmin(page);
  // A caught 500 (a route handler's catch) and one Next.js answered itself.
  const caught = await page.request.get(`${origin}/api/e2e/fail?kind=caught`);
  expect(caught.status()).toBe(500);
  const id = caught.headers()["x-request-id"];
  expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
  expect((await caught.json()).requestId).toBe(id);
  const uncaught = await page.request.get(`${origin}/api/e2e/fail?kind=uncaught`);
  expect(uncaught.status()).toBe(500);
  const uncaughtId = uncaught.headers()["x-request-id"];
  expect(uncaughtId).toMatch(/^[A-Za-z0-9]{12}$/);

  await page.goto(`${origin}/#settings/instance/monitoring/errors`);
  const card = page.locator("#errors");
  await expect(card.getByRole("heading", { name: "Fehler im Detail" })).toBeVisible();
  const group = card.locator(".mon-errgroup").filter({ hasText: "E2eTestFailure" }).first();
  await expect(group).toBeVisible();
  // "e2e" holds a digit: the route pattern makes it an id (routeKey).
  await expect(group.locator(".mon-error-where")).toHaveText("GET /api/:id/fail");
  // Scrubbed: neither the e-mail nor the token of the message.
  await expect(group.locator(".mon-error-what")).toContainText("E2E test failure for [e-mail] with token=[…]");
  await expect(card).not.toContainText("e2e-person@example.com");
  await expect(card).not.toContainText("e2eSecretValue123");

  await group.locator("summary").click();
  const stack = group.locator(".mon-error-stack");
  await expect(stack).toBeVisible();
  await expect(stack).toContainText(/at .+:\d+:\d+\)/);
  await expect(group.getByRole("table", { name: "Vorkommen" }).or(group.locator(".responsive-table"))).toContainText(id);
  await expect(group).toContainText(uncaughtId);
  await expect(group.getByRole("button", { name: "Kopieren für ein Issue" })).toBeVisible();

  // Phone width: the frames scroll inside their box, the card stays within the page.
  const boxes = await page.evaluate(() => {
    const card = document.getElementById("errors")!.getBoundingClientRect();
    const pre = document.querySelector("#errors .mon-error-stack")!.getBoundingClientRect();
    return { card: [card.left, card.right], pre: [pre.left, pre.right], width: document.documentElement.clientWidth };
  });
  expect(boxes.pre[1]).toBeLessThanOrEqual(boxes.card[1] + 0.5);
  expect(boxes.card[1]).toBeLessThanOrEqual(boxes.width + 0.5);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `test-results/error-details/${testInfo.project.name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await card.screenshot({ path: `test-results/error-details/${testInfo.project.name}-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.emulateMedia({ colorScheme: "light" });

  // Clear: the empty state.
  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Zurücksetzen" }).click();
  await expect(card.getByText("Keine Fehler in den letzten 14 Tagen.")).toBeVisible();
  await card.screenshot({ path: `test-results/error-details/${testInfo.project.name}-empty.png` });
});
