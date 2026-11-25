import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { keepInstanceAi } from "./instance-ai";

keepInstanceAi();

// Export / import of the limits (Administration → Grenzen & Aufbewahrung →
// Export / Import, lib/limits-file.ts): an administrator pastes a file with
// the plans, checks it (every change in plain words), applies it, and a
// member of the directory group "Flowplan Plus" (pushed over SCIM) sees the
// plan's limits under Settings → Speicher & KI. The same file again: no changes.
test("limits file: check, apply, the member sees the plan's limits", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const session = (groups: string[], name: string) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `limits-file:${uid}`, name, `${uid}@example.test`, Date.now());
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600000);
    return { uid, token };
  };
  const mobile = info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {};
  const open = async (token: string) => {
    const context = await browser.newContext({ ...mobile, locale: "de-DE" });
    await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    return { context, page: p };
  };
  const stamp = Date.now();
  const plus = `Flowplan Plus ${stamp}`;
  const pro = `Flowplan Pro ${stamp}`;
  const name = `Mara ${stamp}`;
  const member = session([], name);
  const scimGroup = randomUUID();
  db.prepare("INSERT INTO scim_groups(id,display_name,version,created_at,updated_at) VALUES(?,?,1,?,?)").run(scimGroup, plus, Date.now(), Date.now());
  db.prepare("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)").run(scimGroup, member.uid);
  // What the file changes beyond its groups goes back afterwards.
  const keys = ["defaultUserStorageMb", "maxUploadMb", "moreLimitsUrl", "aiQuota", "limitsFile"];
  const savedSettings = db.prepare(`SELECT key,value FROM instance_settings WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as { key: string; value: string }[];
  const savedRules = db.prepare("SELECT * FROM ai_quota_rules").all() as Record<string, string | number | null>[];
  const adminSession = session(["flowplan-admins"], `Admin ${stamp}`);
  const admin = await open(adminSession.token);
  const me = await open(member.token);
  const sample = {
    version: 1,
    plans: [
      { group: plus, kind: "plan", storageMb: 25600, uploadMb: 1024, aiActions: 1000, aiModels: "sonnet", aiAfter: "haiku", prices: [{ interval: "month", eur: 5 }] },
      { group: pro, kind: "plan", storageMb: 102400, uploadMb: 1024, aiActions: 5000, aiModels: "all", aiAfter: "haiku" },
    ],
    flowplan: {
      defaults: { storageMb: 500, uploadMb: 10 },
      aiQuota: { defaultActions: 30, defaultAfter: "off" },
      moreLimitsUrl: "https://billing.example.test/preise",
    },
  };
  try {
    // An Anthropic provider that is never asked, with its three families.
    const r = await admin.page.request.post(`${origin}/api/command`, {
      headers: { origin },
      data: {
        action: "admin.ai",
        settings: {
          enabled: true,
          provider: { kind: "anthropic", baseUrl: "http://127.0.0.1:9", model: "claude-haiku-4-5", embeddingModel: "" },
          prices: [
            { model: "claude-haiku-4-5", input: 1, output: 5 },
            { model: "claude-sonnet-4-6", input: 3, output: 15 },
            { model: "claude-opus-4-1", input: 15, output: 75 },
          ],
        },
      },
    });
    expect(r.ok(), await r.text()).toBe(true);

    await admin.page.goto(`${origin}/#settings/instance/limits/limits-file`);
    const section = admin.page.locator("section#limits-file");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await section.getByLabel("Datei (JSON)").fill(JSON.stringify(sample, null, 2));
    await section.getByRole("button", { name: "Prüfen" }).click();
    const result = section.getByRole("status", { name: "Ergebnis der Prüfung" });
    await expect(result).toContainText(`Gruppe ${plus}: Speicher nicht festgelegt → 25.600 MB`);
    await expect(result).toContainText(`KI-Regel für ${pro}: neu, 5.000 Aktionen (25.000.000 Tokens) im Monat, danach claude-haiku-4-5`);
    await expect(result).toContainText(`KI-Modell für ${plus}: neu, claude-sonnet-4-6`);
    await expect(result).toContainText(`KI-Modell für ${pro}: neu, claude-opus-4-1`);
    // The check wrote nothing.
    expect(db.prepare("SELECT 1 FROM group_limits WHERE target=?").get(`dir:${plus}`)).toBeUndefined();
    await admin.page.screenshot({ path: `test-results/admin-verification/${info.project.name}-limits-file-check.png`, fullPage: true });

    admin.page.once("dialog", (d) => void d.accept());
    await section.getByRole("button", { name: "Übernehmen" }).click();
    await expect(section).toContainText("Änderungen übernommen.");
    await expect
      .poll(() => (db.prepare("SELECT limits FROM group_limits WHERE target=?").get(`dir:${plus}`) as { limits: string } | undefined)?.limits)
      .toBe(JSON.stringify({ storageMb: 25600, uploadMb: 1024 }));

    // The same file again: nothing to do.
    await section.getByRole("button", { name: "Prüfen" }).click();
    await expect(result).toContainText("Keine Änderungen – alles ist schon so eingestellt.");
    await expect(section.getByRole("button", { name: "Übernehmen" })).toBeDisabled();

    // The member sees the plan's limits and where they come from
    // (Settings → Speicher & KI).
    await me.page.goto(`${origin}/#settings/usage`);
    const storage = me.page.locator("#storage");
    await expect(storage).toContainText("von 25 GB", { timeout: 20_000 });
    await expect(storage).toContainText(`aus Gruppe ${plus}`);
    await expect(storage.locator("#upload")).toContainText("1 GB");
    await expect(me.page.getByRole("link", { name: "Mehr Speicher oder KI?" })).toHaveAttribute("href", "https://billing.example.test/preise");
    await me.page.screenshot({ path: `test-results/admin-verification/${info.project.name}-limits-file-member.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    db.prepare("DELETE FROM group_limits WHERE target IN (?,?)").run(`dir:${plus}`, `dir:${pro}`);
    db.prepare("DELETE FROM ai_model_rules WHERE target IN (?,?)").run(`dir:${plus}`, `dir:${pro}`);
    db.prepare("DELETE FROM ai_quota_rules").run();
    for (const row of savedRules) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ai_quota_rules(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...(Object.values(row) as (string | number | null)[]));
    }
    db.prepare(`DELETE FROM instance_settings WHERE key IN (${keys.map(() => "?").join(",")})`).run(...keys);
    for (const s of savedSettings) db.prepare("INSERT INTO instance_settings(key,value) VALUES(?,?)").run(s.key, s.value);
    db.prepare("DELETE FROM scim_groups WHERE id=?").run(scimGroup);
    await me.context.close();
    await admin.context.close();
    db.close();
  }
});
