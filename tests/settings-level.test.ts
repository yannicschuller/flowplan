// Settings levels (#294, lib/settings-level.ts): every personal setting has
// a level or inherits one, a person sees the settings up to their level,
// the search finds all of them, and the level is stored per person with
// the instance's default and an administrator's override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-settings-level-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.OIDC_ISSUER;
const { SETTINGS_SECTIONS, findSection, searchSettings } = await import("../lib/settings-sections");
const {
  SETTINGS_LEVELS,
  anchorLevel,
  entryLevel,
  hiddenEntries,
  isSettingsLevel,
  sectionLevel,
  sectionMinLevel,
  sectionVisible,
  settingsLevelOf,
  suggestedLevel,
  withinLevel,
} = await import("../lib/settings-level");

const section = (id: string) => findSection("settings", id)!;
const pick = (text: { de: string; en: string }) => text.de;

test("every personal section and entry has a valid level or inherits one; the administration has none", () => {
  for (const s of SETTINGS_SECTIONS) {
    if (s.area === "admin") {
      assert.equal(s.level, undefined, `admin/${s.id} is not levelled`);
      for (const e of s.entries || []) assert.equal(e.level, undefined, `admin/${s.id}: ${e.title.en}`);
      assert.ok(sectionVisible(s, "beginner"), `admin/${s.id} is always shown`);
      continue;
    }
    if (s.level !== undefined) assert.ok(isSettingsLevel(s.level), `settings/${s.id}: ${s.level}`);
    assert.ok(isSettingsLevel(sectionLevel(s)));
    for (const e of s.entries || []) {
      if (e.level !== undefined) assert.ok(isSettingsLevel(e.level), `settings/${s.id}: ${e.title.en} has ${e.level}`);
      assert.ok(isSettingsLevel(entryLevel(s, e)), `settings/${s.id}: ${e.title.en}`);
    }
  }
  // Something for each level, and enough for beginners.
  const levels = SETTINGS_SECTIONS.filter((s) => s.area === "settings").flatMap((s) => (s.entries || []).map((e) => entryLevel(s, e)));
  for (const level of SETTINGS_LEVELS) assert.ok(levels.includes(level), level);
  assert.ok(SETTINGS_SECTIONS.filter((s) => s.area === "settings" && sectionVisible(s, "beginner")).length >= 6);
});

test("inheritance: no level is beginner, entries take their section's", () => {
  assert.equal(sectionLevel({}), "beginner");
  assert.equal(entryLevel({ level: "normal" }, {}), "normal");
  assert.equal(entryLevel({ level: "normal" }, { level: "expert" }), "expert");
  assert.equal(entryLevel({}, {}), "beginner");
  // Examples from the registry.
  assert.equal(anchorLevel(section("appearance"), "ui-language"), "beginner");
  assert.equal(anchorLevel(section("appearance"), "motion"), "normal");
  assert.equal(anchorLevel(section("appearance"), "toolbar-layout"), "expert");
  assert.equal(anchorLevel(section("account"), "passkeys"), "beginner");
  assert.equal(anchorLevel(section("account"), "encryption"), "expert");
  assert.equal(anchorLevel(section("api"), "tokens"), "expert");
  assert.equal(anchorLevel(section("appearance"), "nothing-here"), null);
  assert.equal(anchorLevel(section("appearance"), null), null);
  // Several entries on one anchor: the lowest.
  assert.equal(anchorLevel({ level: "normal", entries: [{ title: { de: "a", en: "a" }, anchor: "x", level: "expert" }, { title: { de: "b", en: "b" }, anchor: "x" }] }, "x"), "normal");
});

test("every card in Settings shows its level's mark", () => {
  // SettingGroup marks its heading with its own level, else its parent's or
  // its section's (components/settings-ui.tsx) – not only cards with a
  // registry entry, so the marks are consistent. Cards are SettingGroups: no
  // panel builds its own "setting-group" (the administration has no levels).
  const ui = readFileSync("components/settings-ui.tsx", "utf8");
  const group = ui.slice(ui.indexOf("export function SettingGroup"), ui.indexOf("export function DangerZone"));
  assert.match(group, /\{gate\.level && <LevelDot level=\{gate\.level\} \/>\}/, "the card shows the mark of the level it resolves to");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []));
  for (const file of files("components")) {
    if (file === join("components", "settings-ui.tsx") || file.startsWith(join("components", "settings", "admin"))) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /className=["{`][^"}`]*(?<![\w-])setting-group(?![\w-])/, `${file} builds a card without SettingGroup`);
  }
});

test("filtering: a person sees the settings up to their level", () => {
  assert.ok(withinLevel("beginner", "beginner"));
  assert.ok(withinLevel("normal", "expert"));
  assert.ok(!withinLevel("expert", "normal"));
  assert.ok(!withinLevel("normal", "beginner"));
  // Sections: with entries their lowest one decides.
  assert.equal(sectionMinLevel(section("appearance")), "beginner");
  assert.equal(sectionMinLevel(section("api")), "expert");
  assert.equal(sectionMinLevel(section("security")), "normal");
  const visible = (level: (typeof SETTINGS_LEVELS)[number]) => SETTINGS_SECTIONS.filter((s) => s.area === "settings" && sectionVisible(s, level)).map((s) => s.id);
  assert.ok(visible("beginner").includes("appearance"));
  assert.ok(!visible("beginner").includes("security"));
  assert.ok(visible("normal").includes("security"));
  for (const id of ["api", "webhooks", "autolinks", "extensions"]) {
    assert.ok(!visible("normal").includes(id), id);
    assert.ok(visible("expert").includes(id), id);
  }
  assert.deepEqual(visible("expert"), SETTINGS_SECTIONS.filter((s) => s.area === "settings").map((s) => s.id));
  // Inside a section: what is left out.
  const appearance = section("appearance");
  assert.equal(hiddenEntries(appearance, "expert"), 0);
  assert.equal(hiddenEntries(appearance, "normal"), appearance.entries!.filter((e) => e.level === "expert").length);
  assert.ok(hiddenEntries(appearance, "beginner") > hiddenEntries(appearance, "normal"));
});

test("the search finds settings of every level and says which", () => {
  const results = searchSettings(SETTINGS_SECTIONS, "Formatierungsleiste anpassen", pick);
  const hit = results.find((r) => r.anchor === "toolbar-layout");
  assert.ok(hit, "found");
  assert.equal(hit!.section.id, "appearance");
  assert.equal(hit!.level, "expert");
  // A whole section above the level.
  const tokens = searchSettings(SETTINGS_SECTIONS, "api token", pick);
  assert.ok(tokens.some((r) => r.section.id === "api" && r.level === "expert"));
  // A beginner's setting.
  assert.equal(searchSettings(SETTINGS_SECTIONS, "Passkeys", pick).find((r) => r.anchor === "passkeys")?.level, "beginner");
  // The administration has no levels.
  const admin = searchSettings(SETTINGS_SECTIONS, "Einstellungsstufe", pick).filter((r) => r.section.area === "admin");
  assert.ok(admin.length >= 2);
  assert.ok(admin.every((r) => r.level === undefined));
  assert.deepEqual(searchSettings(SETTINGS_SECTIONS, "  ", pick), []);
});

test("the level onboarding suggests, and stored values", () => {
  assert.equal(suggestedLevel("personal"), "beginner");
  assert.equal(suggestedLevel("team"), "normal");
  assert.equal(suggestedLevel("projects"), "normal");
  assert.equal(suggestedLevel("study"), "normal");
  assert.equal(suggestedLevel("writing"), "normal");
  assert.equal(suggestedLevel("other"), "normal");
  assert.equal(suggestedLevel(null), "normal");
  assert.equal(settingsLevelOf("expert"), "expert");
  assert.equal(settingsLevelOf("guru"), "normal");
  assert.equal(settingsLevelOf(null), "normal");
});

// ---- stored per person ----
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { identityFromToken, HttpError } = await import("../lib/auth");
const { createWorkspace } = await import("../lib/seed");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { runDataSteps, SETTINGS_LEVEL_STEP } = await import("../lib/data-steps");

async function account(name: string, admin = false) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  const identity = (await identityFromToken(token))!;
  return { ...identity, isAdmin: admin } as Identity;
}
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    if ((error as Error).name === "ZodError") return 400;
    throw error;
  }
};
const stored = async (uid: string) => (await one<{ settings_level: string | null }>("SELECT settings_level FROM users WHERE id=?", uid))!.settings_level;

test("new accounts follow the instance's default, Normal unless the administration chose another", async () => {
  assert.equal((await instanceSettings()).settingsLevelDefault, "normal");
  const anna = await account("Anna");
  const wid = await createWorkspace(anna.id, "Stufen");
  assert.equal(await stored(anna.id), null);
  assert.deepEqual((await bootstrap(anna, wid)).settingsLevel, { level: "normal", own: false });
  await saveInstanceSettings({ settingsLevelDefault: "beginner" });
  assert.deepEqual((await bootstrap(anna, wid)).settingsLevel, { level: "beginner", own: false });
  // The person's own choice wins and stays when the default changes.
  assert.deepEqual(await command(anna, { action: "profile.settingsLevel", level: "expert" }), { settingsLevel: { level: "expert", own: true } });
  await saveInstanceSettings({ settingsLevelDefault: "normal" });
  assert.deepEqual((await bootstrap(anna, wid)).settingsLevel, { level: "expert", own: true });
  await assert.rejects(() => saveInstanceSettings({ settingsLevelDefault: "guru" }));
  assert.equal((await instanceSettings()).settingsLevelDefault, "normal");
});

test("the own level: only the three values", async () => {
  const ben = await account("Ben");
  for (const bad of ["guru", "", null, 1, undefined, "Expert"]) assert.equal(await status(() => command(ben, { action: "profile.settingsLevel", level: bad })), 400, String(bad));
  assert.equal(await stored(ben.id), null, "a refused value changes nothing");
  await command(ben, { action: "profile.settingsLevel", level: "beginner" });
  assert.equal(await stored(ben.id), "beginner");
});

test("an administrator sets a person's level or the instance's default, audited", async () => {
  const admin = await account("Admin", true);
  const member = await account("Member");
  const target = await account("Target");
  const wid = await createWorkspace(target.id, "Ziel");
  assert.deepEqual(await command(admin, { action: "admin.settingsLevel", userId: target.id, level: "beginner" }), { level: "beginner", effective: "beginner" });
  assert.equal(await stored(target.id), "beginner");
  assert.deepEqual((await bootstrap(target, wid)).settingsLevel, { level: "beginner", own: true });
  assert.ok(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='admin.settingsLevel' AND resource_id=?", admin.id, target.id), "in the activity log");
  // The person can change it again.
  await command(target, { action: "profile.settingsLevel", level: "normal" });
  assert.equal(await stored(target.id), "normal");
  // Back to the instance's default: no own value.
  assert.deepEqual(await command(admin, { action: "admin.settingsLevel", userId: target.id, level: null }), { level: null, effective: "normal" });
  assert.equal(await stored(target.id), null);
  assert.deepEqual((await bootstrap(target, wid)).settingsLevel, { level: "normal", own: false });
  // Only valid values, only admins, only existing accounts.
  for (const bad of [{ level: "guru" }, { level: "default" }, { level: "" }, {}, { userId: "nope", level: "expert" }])
    assert.equal(await status(() => command(admin, { action: "admin.settingsLevel", userId: target.id, ...bad })), 400, JSON.stringify(bad));
  assert.equal(await status(() => command(member, { action: "admin.settingsLevel", userId: target.id, level: "expert" })), 403);
  assert.equal(await status(() => command(admin, { action: "admin.settingsLevel", userId: id(), level: "expert" })), 404);
  assert.equal(await stored(target.id), null);
});

test("accounts from before the levels keep seeing every setting", async () => {
  // As on an instance updated to #294: accounts without a level when the
  // data step runs get "expert"; own choices stay.
  const old = await account("Old");
  const chose = await account("Chose");
  await run("UPDATE users SET settings_level='beginner' WHERE id=?", chose.id);
  await run("DELETE FROM data_migrations WHERE name=?", SETTINGS_LEVEL_STEP);
  await runDataSteps([SETTINGS_LEVEL_STEP]);
  assert.equal(await stored(old.id), "expert");
  assert.equal(await stored(chose.id), "beginner");
  assert.ok(await one("SELECT 1 FROM data_migrations WHERE name=?", SETTINGS_LEVEL_STEP));
  // Accounts created afterwards follow the default.
  const fresh = await account("Fresh");
  assert.equal(await stored(fresh.id), null);
  await runDataSteps([SETTINGS_LEVEL_STEP]);
  assert.equal(await stored(fresh.id), null, "the step runs once");
});
