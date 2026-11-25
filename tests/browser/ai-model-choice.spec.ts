import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { keepInstanceAi } from "./instance-ai";

keepInstanceAi();

// Choosing the AI model (#538, lib/ai/model-policy.ts): a workspace group
// gets "Bis Opus – frei wählbar" in the limits table; its member sees the
// model line of "KI fragen" as a picker (a radio group with a hint per
// model), picks Haiku – the next request reaches the mock provider with
// Haiku – and changes it back under Einstellungen → KI → Standardmodell.
// MODEL_CHOICE_SCREENSHOTS=<dir>: the picker in light and dark.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.MODEL_CHOICE_SCREENSHOTS || "";
if (shots) test.use({ deviceScaleFactor: 2 });
test.setTimeout(180_000);
const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-5";

type Mock = { base: string; models: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", models: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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

async function shoot(page: Page, name: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("a group with 'Bis Opus – frei wählbar': its member picks the model in the AI panel and in the settings", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  const phone = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mock = await startMock();
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  await command({
    action: "admin.ai",
    settings: {
      enabled: true,
      access: "everyone",
      provider: { kind: "openai", baseUrl: mock.base, model: HAIKU, embeddingModel: "" },
      prices: [
        { model: HAIKU, input: 1, output: 5 },
        { model: SONNET, input: 3, output: 15 },
        { model: OPUS, input: 5, output: 25 },
      ],
    },
  });
  await command({ action: "ai.settings", enabled: true, instanceModel: null });
  // A group of the workspace with the person in it.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const group = randomUUID(),
    groupName = `Pro ${Date.now()}`;
  db.prepare("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)").run(group, boot.workspace.id, groupName);
  db.prepare("INSERT INTO group_members(group_id,user_id) VALUES(?,?)").run(group, boot.user.id);
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Modellwahl ${Date.now()}`, kind: "document" });
  try {
    // Administration → KI → Kontingente: the group gets "Bis Opus – frei wählbar".
    await command({ action: "admin.aiRule", scope: "group", target: group, model: OPUS, choice: true });
    if (!phone) {
      await page.goto("/#settings/instance/ai");
      const limits = page.locator("section[aria-labelledby='quota-limits-title']");
      const cell = limits.getByRole("combobox", { name: new RegExp(`^Modell für .*${groupName}`) });
      await expect(cell).toHaveValue(`c:${OPUS}`, { timeout: 30_000 });
      await expect(cell.locator(`option[value="c:${OPUS}"]`)).toHaveText("Bis Opus – frei wählbar");
    }

    // The AI panel: the model line is a picker.
    await page.goto(`/#page=${doc.id}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    if (phone) await page.locator(".mobile-tab-bar").getByRole("button", { name: /Navigation öffnen|Menü/ }).click();
    await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
    const panel = page.getByRole("complementary", { name: "KI fragen" });
    await expect(panel).toBeVisible();
    if (phone) await panel.getByLabel("Deine Frage").blur();
    const pill = panel.getByRole("button", { name: "Modell: Opus 4.5 – ändern" });
    await pill.click();
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    const group1 = panel.getByRole("group", { name: "Modell wählen" });
    const radios = group1.getByRole("radio");
    await expect(radios).toHaveCount(3);
    await expect(group1.getByRole("radio", { name: /Opus 4\.5 · Standard\s*am stärksten/ })).toBeChecked();
    await expect(group1).toContainText("Sonnet 4.6");
    await expect(group1).toContainText("ausgewogen");
    await expect(group1).toContainText("schnell & günstig");
    await shoot(page, `${phone ? "phone" : "desktop"}-panel-picker`);
    // Keyboard: the radios are reachable and Escape closes the details.
    await group1.getByRole("radio", { name: /Haiku 4\.5/ }).check();
    await expect(panel.getByRole("button", { name: "Modell: Haiku 4.5 – ändern" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => (JSON.parse((db.prepare("SELECT config FROM ai_user_settings WHERE user_id=?").get(boot.user.id) as { config: string }).config) as { instanceModel?: string }).instanceModel).toBe(HAIKU);
    await page.keyboard.press("Escape");
    await expect(group1).toBeHidden();

    // The next question goes out with Haiku.
    const field = panel.getByLabel("Deine Frage");
    await field.fill("Was steht hier?");
    await panel.getByRole("button", { name: "Fragen", exact: true }).click();
    await expect(panel.locator(".ai-ask-answer").last()).toContainText(`Antwort von ${HAIKU}`, { timeout: 45_000 });
    expect(mock.models.at(-1)).toBe(HAIKU);

    // Einstellungen → KI → Standardmodell: back to Opus.
    await page.goto("/#settings/ai");
    const select = page.getByRole("combobox", { name: "Standardmodell" });
    await expect(select).toHaveValue(HAIKU, { timeout: 30_000 });
    await shoot(page, `${phone ? "phone" : "desktop"}-settings-default-model`);
    await select.selectOption(OPUS);
    await expect.poll(() => (JSON.parse((db.prepare("SELECT config FROM ai_user_settings WHERE user_id=?").get(boot.user.id) as { config: string }).config) as { instanceModel?: string }).instanceModel).toBe("");
    // A choice outside the set is refused by the server.
    const forged = await page.request.post("/api/command", { headers: { origin }, data: { action: "ai.settings", instanceModel: "gpt-9" } });
    expect(forged.status()).toBe(400);
    expect(errors).toEqual([]);
  } finally {
    await command({ action: "admin.aiRule", scope: "group", target: group, model: null, quota: null }).catch(() => {});
    await command({ action: "ai.settings", instanceModel: null }).catch(() => {});
    db.prepare("DELETE FROM group_members WHERE group_id=?").run(group);
    db.prepare("DELETE FROM groups WHERE id=?").run(group);
    db.close();
    await mock.close();
  }
});
