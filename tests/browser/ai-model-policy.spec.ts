import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { keepInstanceAi } from "./instance-ai";

keepInstanceAi();

// The AI model per person (lib/ai/model-policy.ts): the instance runs on
// Haiku by default; an administrator gives one person Opus in that person's
// details (Administration → Benutzer → KI). That person's request reaches
// the provider with Opus, everyone else's with Haiku – against a mock
// OpenAI-compatible provider that records the model of every request. The
// person sees the model in Settings → KI, marked as set by the
// administration. AI_RULE_SCREENSHOTS=<dir>: screenshots of the section
// (light and dark).

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.AI_RULE_SCREENSHOTS || "";
const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-5";

type Mock = { base: string; models: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", models: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: HAIKU }, { id: "claude-sonnet-4-5" }, { id: OPUS }] }));
        return;
      }
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      mock.models.push(body.model);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Antwort von ${body.model}` } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

// The section settled for a screenshot: loaded, nothing saving.
async function shoot(page: Page, name: string, phone: boolean) {
  if (!shots) return;
  const section = page.getByRole("region", { name: /^KI für / });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await section.screenshot({ path: `${shots}/${phone ? "phone" : "desktop"}-${scheme}-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("an administrator gives one person Opus while the instance runs on Haiku", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(180_000);
  const phone = info.project.name === "mobile";
  const mock = await startMock();
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const name = `Opus ${Date.now()}`;
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `model:${uid}`, name, `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600000);

  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>, request = page.request) => {
    const r = await request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  await command({
    action: "admin.ai",
    settings: {
      enabled: true,
      access: "everyone",
      guests: true,
      provider: { kind: "openai", baseUrl: mock.base, model: HAIKU, embeddingModel: "" },
      prices: [
        { model: HAIKU, input: 1, output: 5 },
        { model: OPUS, input: 5, output: 25 },
      ],
    },
  });
  await command({ action: "ai.settings", enabled: true });
  const context = await browser.newContext({ ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}), locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const person = await context.newPage();
  try {
    // The person's workspace exists after the first visit.
    await person.goto(`${origin}/#home`);
    await expect(person.locator(".sidebar, .workspace-switch").first()).toBeAttached({ timeout: 30_000 });
    await command({ action: "ai.settings", enabled: true }, person.request);

    // Administration → Benutzer → the person → KI → Modell: Opus.
    await page.goto("/#admin/users");
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(name);
    await page.locator(".user-row", { hasText: name }).getByRole("button", { name, exact: true }).click();
    const sheet = page.getByRole("dialog", { name, exact: true });
    const section = sheet.getByRole("region", { name: `KI für ${name}` });
    const model = section.getByRole("combobox", { name: "Modell" });
    await expect(model).toBeVisible({ timeout: 30_000 });
    // What the default resolves to is in the label.
    await expect(model.locator("option").first()).toHaveText(`Standard der Instanz (${HAIKU})`);
    await expect(section).toContainText(`Verwendet: ${HAIKU} (Standard der Instanz)`);
    await shoot(page, "default", phone);
    await model.selectOption(`m:${OPUS}`);
    await expect(section).toContainText(`Verwendet: ${OPUS} (eigene Einstellung)`);
    expect(db.prepare("SELECT model,kind FROM ai_model_rules WHERE scope='user' AND target=?").get(uid)).toEqual({ model: OPUS, kind: "openai" });
    // Own limits in the same section: the rule of the quota table.
    await section.getByRole("combobox", { name: "Kontingent" }).selectOption("own");
    const day = section.getByRole("spinbutton", { name: `${name}: Tag` });
    await day.fill("50000");
    await day.press("Enter");
    await expect.poll(() => (db.prepare("SELECT limits FROM ai_quota_rules WHERE scope='user' AND target=?").get(uid) as { limits: string } | undefined)?.limits).toBe(JSON.stringify({ day: 50000 }));
    await expect(section).toContainText("0 von 50.000 · 50.000 übrig");
    await shoot(page, "opus", phone);

    // The person's request goes out with Opus, the administrator's with Haiku.
    const ask = async (request: typeof page.request) => {
      const boot = await (await request.get("/api/bootstrap")).json();
      const r = await request.post("/api/ai/run", { headers: { origin }, data: { feature: "write", workspaceId: boot.workspace.id, messages: [{ role: "user", content: "Hallo" }], maxTokens: 20 } });
      expect(r.ok(), await r.text()).toBe(true);
      return await r.text();
    };
    expect(await ask(person.request)).toContain(`Antwort von ${OPUS}`);
    expect(mock.models.at(-1)).toBe(OPUS);
    expect(await ask(page.request)).toContain(`Antwort von ${HAIKU}`);
    expect(mock.models.at(-1)).toBe(HAIKU);

    // The person sees the model in their own AI settings – read-only.
    await person.goto(`${origin}/#settings/ai`);
    const row = person.locator(".setting-row", { hasText: "Von der Administration festgelegt." });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(OPUS);

    // The limits table of Administration → KI → Kontingente shows the model too.
    await page.goto("/#admin/ai");
    const limits = page.locator("section[aria-labelledby='quota-limits-title']");
    await expect(limits.getByRole("combobox", { name: new RegExp(`^Modell für ${name}`) })).toHaveValue(`m:${OPUS}`, { timeout: 30_000 });
  } finally {
    await command({ action: "admin.aiRule", scope: "user", target: uid, model: null, quota: null }).catch(() => {});
    await context.close();
    db.close();
    await mock.close();
  }
});
