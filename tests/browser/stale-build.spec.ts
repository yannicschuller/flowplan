import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// An outdated page whose files all load (#182): its scripts and styles came
// from a cache, a stored copy or a window that stayed open across an update,
// so nothing failed and the check of #61 (lib/stale-copy.ts) never ran –
// the app of the older build kept running against the newer server (the
// desktop app on Windows, Firefox until its cache was cleared). Here the
// first page of the app names an older build than the server runs: the
// app's first answer from the server names the live one, and the page
// loads the live build once – also when the outdated page keeps coming
// back (no loop, no message over a working app).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const OLDER = "older-build-182";

function signIn() {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `stale:${uid}`, "Stale Build", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600000);
  db.close();
  return token;
}

// The app's page as an older build would have it: its build in the meta
// tag and in the page's own check. `stale()` decides per load.
async function olderPages(context: BrowserContext, live: string, stale: (n: number) => boolean) {
  const loads: string[] = [];
  await context.route(
    (url) => url.origin === new URL(origin).origin && url.pathname === "/",
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      loads.push(route.request().url());
      const response = await route.fetch();
      let body = await response.text();
      if (stale(loads.length)) {
        const quoted = JSON.stringify(live);
        expect(body).toContain(`content=${quoted}`);
        body = body.replace(`name="flowplan-build" content=${quoted}`, `name="flowplan-build" content="${OLDER}"`).replace(`var BUILD=${quoted}`, `var BUILD="${OLDER}"`);
      }
      await route.fulfill({ response, body });
    },
  );
  return loads;
}

test.describe("#182 outdated page", () => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Once is enough."));

  test("a page of an older build loads the live build once instead of running on", async ({ browser, request }) => {
    const live = (await request.get(`${origin}/api/health`)).headers()["x-flowplan-build"];
    expect(live).toBeTruthy();
    const context = await browser.newContext({ locale: "de-DE" });
    await context.addCookies([{ name: "flowplan_session", value: signIn(), url: origin, httpOnly: true, sameSite: "Lax" }]);
    const loads = await olderPages(context, live, (n) => n === 1);
    const page = await context.newPage();
    await page.goto(`${origin}/#home`);
    await expect.poll(() => loads.length, { timeout: 20_000 }).toBe(2);
    await expect(page.locator('meta[name="flowplan-build"]')).toHaveAttribute("content", live);
    await expect(page.locator(".workspace-switch").first()).toBeAttached({ timeout: 20_000 });
    // The reload's mark goes again from the address; the place stays.
    await expect.poll(() => new URL(page.url()).searchParams.has("flowplan-fresh")).toBe(false);
    expect(new URL(page.url()).hash).toBe("#home");
    await page.waitForTimeout(3000);
    expect(loads.length).toBe(2);
    await context.close();
  });

  test("an older page that keeps coming back reloads only once and stays usable", async ({ browser, request }) => {
    const live = (await request.get(`${origin}/api/health`)).headers()["x-flowplan-build"];
    const context = await browser.newContext({ locale: "de-DE" });
    await context.addCookies([{ name: "flowplan_session", value: signIn(), url: origin, httpOnly: true, sameSite: "Lax" }]);
    const loads = await olderPages(context, live, () => true);
    const page = await context.newPage();
    await page.goto(`${origin}/#home`);
    await expect.poll(() => loads.length, { timeout: 20_000 }).toBe(2);
    await expect(page.locator(".workspace-switch").first()).toBeAttached({ timeout: 20_000 });
    // Errors the app catches ask the server again – still no second reload.
    await page.evaluate(() => window.dispatchEvent(new Event("flowplan:check-build")));
    await page.waitForTimeout(4000);
    expect(loads.length).toBe(2);
    await expect(page.locator("#flowplan-stale")).toHaveCount(0);
    await context.close();
  });
});
