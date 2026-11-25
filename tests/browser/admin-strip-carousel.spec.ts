import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// The charts of the administration's live strip (components/settings/admin/
// strip-charts.tsx): a carousel with only the charts whose feature is on,
// switched with ‹ › (desktop), swipes (phone), the arrow keys and the dots,
// the chosen chart remembered on the device. Creates an admin session
// directly in the test server's database – never without an explicit data
// directory.
test("the live strip's charts are a carousel of what is switched on", async ({ browser }, testInfo) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  // Five page loads; a development server compiles the administration on the first.
  test.setTimeout(150_000);
  const mobile = testInfo.project.name === "mobile";
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `strip-admin:${uid}`, "Strip Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600_000);
  const setMetrics = (enabled: boolean) =>
    db.prepare("INSERT INTO instance_settings(key,value) VALUES('metrics',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ enabled }));
  const before = db.prepare("SELECT config FROM ai_instance WHERE id=1").get() as { config: string } | undefined;
  setMetrics(true);
  db.prepare("DELETE FROM ai_instance WHERE id=1").run();
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } }),
    locale: "de-DE",
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  const carousel = page.getByRole("region", { name: "Diagramme" });
  const dots = carousel.getByRole("group", { name: "Diagramm wählen" }).getByRole("button");
  const heading = carousel.getByRole("heading", { level: 2 });
  const open = async (p: Page) => {
    // A new load each time (going to the same address with a hash would not reload).
    await p.goto("about:blank");
    await p.goto(`${origin}/#settings/instance`);
    // (The dev server may compile the page on first use.)
    await expect(carousel).toBeVisible({ timeout: 30_000 });
  };
  try {
    await open(page);
    // Statistics on, AI not set up: requests, people & load, server, errors.
    await expect(dots).toHaveCount(4);
    await expect(heading).toHaveText("Anfragen pro Minute");
    await expect(dots.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(carousel.getByRole("group", { name: "Diagramm 1 von 4: Anfragen pro Minute" })).toBeVisible();
    if (mobile) {
      // No arrows on a phone: a quick swipe to the left shows the next chart.
      await expect(carousel.getByRole("button", { name: "Nächstes Diagramm" })).toBeHidden();
      const slide = carousel.getByRole("group", { name: /^Diagramm 1 von 4/ });
      const box = (await slide.boundingBox())!;
      const y = box.y + box.height / 2;
      await slide.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, clientX: box.x + box.width - 30, clientY: y });
      await slide.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, clientX: box.x + 40, clientY: y + 4 });
      await expect(heading).toHaveText("Aktive Personen und Serverlast");
      // … and back to the right.
      const next = carousel.getByRole("group", { name: /^Diagramm 2 von 4/ });
      await next.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, clientX: box.x + 40, clientY: y });
      await next.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, clientX: box.x + box.width - 30, clientY: y });
      await expect(heading).toHaveText("Anfragen pro Minute");
      // A tap on a dot.
      await dots.nth(2).tap();
    } else {
      await carousel.getByRole("button", { name: "Nächstes Diagramm" }).click();
      await expect(heading).toHaveText("Aktive Personen und Serverlast");
      await carousel.getByRole("button", { name: "Voriges Diagramm" }).click();
      await expect(heading).toHaveText("Anfragen pro Minute");
      // Arrow keys while the carousel has focus; from the first to the last.
      await dots.nth(0).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(heading).toHaveText("Fehler und langsame Endpunkte");
      await page.keyboard.press("ArrowRight");
      await expect(heading).toHaveText("Anfragen pro Minute");
      await dots.nth(2).click();
    }
    await expect(heading).toHaveText("Server: CPU, RAM, Speicherplatz");
    await expect(dots.nth(2)).toHaveAttribute("aria-current", "true");
    await expect(carousel).toContainText("CPU");
    await page.screenshot({ path: `test-results/admin-strip/${testInfo.project.name}-server.png` });
    // Remembered on this device.
    await open(page);
    await expect(heading).toHaveText("Server: CPU, RAM, Speicherplatz");

    // AI set up: its chart joins.
    db.prepare("INSERT INTO ai_instance(id,config) VALUES(1,?)").run(JSON.stringify({ enabled: true, provider: { kind: "ollama", baseUrl: "http://127.0.0.1:9", model: "test-model", embeddingModel: "" } }));
    await open(page);
    await expect(dots).toHaveCount(5);
    await dots.nth(2).click();
    await expect(heading).toHaveText("KI-Nutzung");
    await expect(carousel).toContainText("Tokens");

    // Statistics off: the charts made from them go; the server's stay.
    setMetrics(false);
    await open(page);
    await expect(dots).toHaveCount(2);
    await expect(heading).toHaveText("Aktive Personen und Serverlast");
    await expect(carousel).toContainText("Aktive Personen nur mit eingeschalteter Statistik");
  } finally {
    setMetrics(true);
    db.prepare("DELETE FROM ai_instance WHERE id=1").run();
    if (before) db.prepare("INSERT INTO ai_instance(id,config) VALUES(1,?)").run(before.config);
    db.close();
    await context.close();
  }
});
