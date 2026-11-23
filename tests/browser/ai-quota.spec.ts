import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { keepInstanceAi } from "./instance-ai";

keepInstanceAi();

// AI quotas (#382): an administrator sets the default per person under
// Administration → KI → Kontingente, the person sees what is left under
// Settings → Speicher & KI, and the "KI fragen" panel shows the note once little is
// left. No AI request is made – the usage is written into the counts.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const db = () => {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  return d;
};

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  // Expert: every setting shows.
  await command({ action: "profile.settingsLevel", level: "expert" });
  // A provider that is never asked (no request is made in this spec).
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "quota-model", embeddingModel: "" } } });
  await command({ action: "ai.settings", enabled: true });
  await command({ action: "admin.aiQuotas", settings: { unit: "tokens", timeZone: "UTC", weekStart: "monday", warnAt: 80, workflowsCountInstance: true }, rules: [] });
  // The usage starts at nothing: the AI specs before this one on the same
  // server (ai-ask-*, ai-page-*, … against their mock provider) counted
  // tokens for the same demo account today.
  const d = db();
  d.prepare("DELETE FROM ai_quota_usage WHERE user_id=?").run(boot.user.id);
  d.prepare("DELETE FROM ai_quota_after_usage WHERE user_id=?").run(boot.user.id);
  d.close();
  return { command, userId: boot.user.id as string };
}

test("quotas: the administrator sets the default, the person sees what is left", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tables of the administration: the desktop run.");
  test.setTimeout(120_000);
  const { command, userId } = await setup(page);
  try {
    await page.goto("/#admin/ai");
    const limits = page.locator("section[aria-labelledby='quota-limits-title']");
    await expect(limits).toBeVisible({ timeout: 30_000 });
    const day = limits.getByRole("spinbutton", { name: "Standard je Person: Tag" });
    await day.fill("10000");
    await day.press("Enter");
    await expect
      .poll(async () => ((await (await page.request.get("/api/ai/admin/quotas")).json()).rules as { scope: string; limits: Record<string, number> }[]).find((r) => r.scope === "default")?.limits.day)
      .toBe(10_000);

    // 8,500 tokens used today: 1,500 of 10,000 left – past the 80 % note.
    const d = db();
    d.prepare("INSERT INTO ai_quota_usage(day,user_id,model,kind,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?,?,?)").run(new Date().toISOString().slice(0, 10), userId, "quota-model", "person", 3, 6000, 2500);
    d.close();
    await page.goto("/#settings/usage");
    const quota = page.locator("section[aria-labelledby='ai-title']");
    await expect(quota).toBeVisible({ timeout: 30_000 });
    await expect(quota).toContainText("Heute");
    await expect(quota).toContainText("1.500 von 10.000 übrig");
    await expect(quota.locator("progress")).toHaveAttribute("value", "8500");

    // The usage per person in the administration.
    await page.goto("/#admin/ai");
    const usage = page.locator("section[aria-labelledby='quota-usage-title']");
    await expect(usage).toBeVisible({ timeout: 30_000 });
    await usage.getByRole("combobox", { name: "Zeitraum" }).selectOption("day");
    await expect(usage.getByRole("table", { name: "Nach Person" })).toContainText("8.500");
  } finally {
    await command({ action: "admin.aiQuotas", rules: [] });
    const d = db();
    d.prepare("DELETE FROM ai_quota_usage WHERE user_id=?").run(userId);
    d.close();
  }
});

// "Danach: weiter mit …" with a limit of its own (schema 122): the
// administrator sets "höchstens" next to the model, the person sees what is
// left of the continuation once the quota is used up.
test("quotas: the continuation after the quota has a limit, the person sees what is left of it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tables of the administration: the desktop run.");
  test.setTimeout(120_000);
  const { command, userId } = await setup(page);
  try {
    await command({ action: "admin.aiQuotas", rules: [{ scope: "default", target: "", exempt: false, limits: { month: 1000 } }] });
    await page.goto("/#admin/ai");
    const limits = page.locator("section[aria-labelledby='quota-limits-title']");
    await expect(limits).toBeVisible({ timeout: 30_000 });
    await limits.getByRole("combobox", { name: "Standard je Person: nach Erreichen des Kontingents" }).selectOption("quota-model");
    const most = limits.getByRole("spinbutton", { name: "Standard je Person: weiter mit quota-model: höchstens (leer = unbegrenzt, Tokens)" });
    await expect(most).toBeVisible();
    await expect(limits.getByRole("combobox", { name: "Standard je Person: weiter mit quota-model: Zeitraum" })).toHaveValue("month");
    await most.fill("20000");
    await most.press("Enter");
    await expect
      .poll(async () => ((await (await page.request.get("/api/ai/admin/quotas")).json()).rules as { scope: string; after?: string; afterLimits?: Record<string, number> }[]).find((r) => r.scope === "default")?.afterLimits?.month)
      .toBe(20_000);

    // The quota is used up (1,500 of 1,000); 5,000 went on with the model.
    const d = db();
    const day = new Date().toISOString().slice(0, 10);
    d.prepare("INSERT INTO ai_quota_usage(day,user_id,model,kind,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?,?,?)").run(day, userId, "quota-model", "person", 3, 6000, 500);
    d.prepare("INSERT INTO ai_quota_after_usage(day,user_id,model,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?,?)").run(day, userId, "quota-model", 2, 4000, 1000);
    d.close();
    const status = (await (await page.request.get("/api/ai/quota")).json()) as { blocked: boolean; after: { model: string; limit: number; used: number; left: number } };
    expect(status.after).toMatchObject({ model: "quota-model", limit: 20_000, used: 5000, left: 15_000 });
    expect(status.blocked).toBe(false);
    await page.goto("/#settings/usage");
    const quota = page.locator("section[aria-labelledby='ai-title']");
    await expect(quota).toBeVisible({ timeout: 30_000 });
    await expect(quota).toContainText("Danach geht es mit quota-model weiter – noch");
    await expect(quota).toContainText("Tokens diesen Monat");
  } finally {
    await command({ action: "admin.aiQuotas", rules: [] });
    const d = db();
    d.prepare("DELETE FROM ai_quota_usage WHERE user_id=?").run(userId);
    d.prepare("DELETE FROM ai_quota_after_usage WHERE user_id=?").run(userId);
    d.close();
  }
});
