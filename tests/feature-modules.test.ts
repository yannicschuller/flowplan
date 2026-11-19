// Switched-off features (#378, lib/feature-modules.ts): stored per person
// with the instance's default for new accounts, read leniently, saved
// strictly, an administrator's "back to the default" for one person or
// everyone – and only ever the interface: nothing about access changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-modules-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.OIDC_ISSUER;
const { FEATURE_MODULES, HOME_WIDGET_MODULE, PAGE_KIND_MODULE, SLASH_MODULE, VIEW_MODULE, hiddenModulesOf, isFeatureModule, moduleShownIn } = await import("../lib/feature-modules");
const client = await import("../lib/feature-modules-client");
// The person's side of the browser's copy (without the instance's `off`, #386).
const choice = ({ hidden, own, standard }: { hidden: unknown; own: boolean; standard: unknown }) => ({ hidden, own, standard });

test("stored values are read leniently, in a fixed order", () => {
  assert.deepEqual(hiddenModulesOf(null), []);
  assert.deepEqual(hiddenModulesOf(undefined), []);
  assert.deepEqual(hiddenModulesOf("not json"), []);
  assert.deepEqual(hiddenModulesOf('{"a":1}'), []);
  assert.deepEqual(hiddenModulesOf('["whiteboards","flashcards"]'), ["flashcards", "whiteboards"]);
  assert.deepEqual(hiddenModulesOf(["ai", "gone-later", "ai", 3, "journal"]), ["journal", "ai"]);
  assert.ok(isFeatureModule("drawio"));
  assert.ok(!isFeatureModule("library"));
});

test("every entry point names a known feature; table, list, documents and databases always stay", () => {
  for (const map of [PAGE_KIND_MODULE, SLASH_MODULE, VIEW_MODULE, HOME_WIDGET_MODULE])
    for (const [key, module] of Object.entries(map)) assert.ok(isFeatureModule(module), `${key}: ${module}`);
  assert.equal(PAGE_KIND_MODULE.document, undefined);
  assert.equal(PAGE_KIND_MODULE.database, undefined);
  assert.equal(VIEW_MODULE.table, undefined);
  assert.equal(VIEW_MODULE.list, undefined);
  // Every feature has an entry point somewhere (else its switch does nothing).
  const used = new Set([...Object.values(PAGE_KIND_MODULE), ...Object.values(SLASH_MODULE), ...Object.values(VIEW_MODULE), ...Object.values(HOME_WIDGET_MODULE)]);
  for (const module of FEATURE_MODULES) assert.ok(used.has(module), module);
  // The "/" menu ids exist in the editor.
  const editor = readFileSync("components/editor.tsx", "utf8");
  for (const id of Object.keys(SLASH_MODULE)) assert.ok(editor.includes(`id: "${id}"`), `slash entry ${id}`);
  assert.ok(moduleShownIn(["flashcards"], undefined));
  assert.ok(!moduleShownIn(["flashcards"], "flashcards"));
  assert.ok(moduleShownIn(["flashcards"], "whiteboards"));
});

test("the browser's copy: the first bootstrap at once, a save wins over an older bootstrap, failures roll back", async () => {
  assert.deepEqual(client.hiddenModules(), []);
  client.primeFeatureModules({ hidden: ["whiteboards"], own: false, standard: ["whiteboards"] });
  assert.deepEqual(client.hiddenModules(), ["whiteboards"]);
  // Priming happens once; later bootstraps go through setFeatureModulesFromServer.
  client.primeFeatureModules({ hidden: [], own: false, standard: [] });
  assert.deepEqual(client.hiddenModules(), ["whiteboards"]);
  assert.ok(!client.moduleShown("whiteboards"));
  let release!: () => void;
  const sent: unknown[] = [];
  const saving = client.saveFeatureModules(async (body) => {
    sent.push(body);
    await new Promise<void>((resolve) => (release = resolve));
  }, ["flashcards", "whiteboards"]);
  assert.deepEqual(choice(client.featureModules()), { hidden: ["flashcards", "whiteboards"], own: true, standard: ["whiteboards"] });
  // A bootstrap loaded while saving is older: ignored.
  client.setFeatureModulesFromServer({ hidden: ["whiteboards"], own: false, standard: ["whiteboards"] });
  assert.deepEqual(client.hiddenModules(), ["flashcards", "whiteboards"]);
  await new Promise((r) => setTimeout(r, 0));
  release();
  await saving;
  assert.deepEqual(sent, [{ action: "profile.modules", hidden: ["flashcards", "whiteboards"] }]);
  // A failed save goes back.
  await assert.rejects(() => client.saveFeatureModules(() => Promise.reject(new Error("offline")), []));
  assert.deepEqual(client.hiddenModules(), ["flashcards", "whiteboards"]);
  // Back to the default.
  await client.saveFeatureModules(async () => undefined, null);
  assert.deepEqual(choice(client.featureModules()), { hidden: ["whiteboards"], own: false, standard: ["whiteboards"] });
  // The default changes (an administrator): followed without an own choice.
  client.setFeatureModulesStandard(["ai"]);
  assert.deepEqual(choice(client.featureModules()), { hidden: ["ai"], own: false, standard: ["ai"] });
  await client.saveFeatureModules(async () => undefined, ["journal"]);
  client.setFeatureModulesStandard(["drawio"]);
  assert.deepEqual(choice(client.featureModules()), { hidden: ["journal"], own: true, standard: ["drawio"] });
  client.setFeatureModulesStandard(["drawio"], true);
  assert.deepEqual(choice(client.featureModules()), { hidden: ["drawio"], own: false, standard: ["drawio"] });
});

// ---- stored per person ----
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { identityFromToken, HttpError } = await import("../lib/auth");
const { createWorkspace } = await import("../lib/seed");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { runDataSteps, FEATURE_MODULES_STEP } = await import("../lib/data-steps");

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
const stored = async (uid: string) => (await one<{ modules: string | null }>("SELECT modules FROM users WHERE id=?", uid))!.modules;

test("new accounts follow the instance's default; an own choice wins and stays", async () => {
  assert.deepEqual((await instanceSettings()).modulesDefault, []);
  const anna = await account("Anna");
  const wid = await createWorkspace(anna.id, "Funktionen");
  assert.equal(await stored(anna.id), null);
  assert.deepEqual((await bootstrap(anna, wid)).modules, { hidden: [], own: false, standard: [] });
  await saveInstanceSettings({ modulesDefault: ["whiteboards", "flashcards"] });
  assert.deepEqual((await instanceSettings()).modulesDefault, ["flashcards", "whiteboards"]);
  assert.deepEqual((await bootstrap(anna, wid)).modules, { hidden: ["flashcards", "whiteboards"], own: false, standard: ["flashcards", "whiteboards"] });
  assert.deepEqual(await command(anna, { action: "profile.modules", hidden: ["ai"] }), { modules: { hidden: ["ai"], own: true, standard: ["flashcards", "whiteboards"] } });
  await saveInstanceSettings({ modulesDefault: ["journal"] });
  assert.deepEqual((await bootstrap(anna, wid)).modules, { hidden: ["ai"], own: true, standard: ["journal"] });
  // Showing everything is a choice of its own too.
  await command(anna, { action: "profile.modules", hidden: [] });
  assert.equal(await stored(anna.id), "[]");
  assert.deepEqual((await bootstrap(anna, wid)).modules, { hidden: [], own: true, standard: ["journal"] });
  // null: back to the default.
  await command(anna, { action: "profile.modules", hidden: null });
  assert.equal(await stored(anna.id), null);
  assert.deepEqual((await bootstrap(anna, wid)).modules.hidden, ["journal"]);
  // The default is saved strictly.
  for (const bad of [["guru"], "flashcards", ["ai", "ai"], [1]]) await assert.rejects(() => saveInstanceSettings({ modulesDefault: bad }), JSON.stringify(bad));
  assert.deepEqual((await instanceSettings()).modulesDefault, ["journal"]);
  await saveInstanceSettings({ modulesDefault: [] });
});

test("the own choice: only known features, each once", async () => {
  const ben = await account("Ben");
  for (const bad of [["guru"], ["ai", "ai"], "ai", 1, undefined, [null]])
    assert.equal(await status(() => command(ben, { action: "profile.modules", hidden: bad })), 400, JSON.stringify(bad));
  assert.equal(await stored(ben.id), null, "a refused value changes nothing");
  await command(ben, { action: "profile.modules", hidden: ["whiteboards", "drawio"] });
  assert.equal(await stored(ben.id), '["whiteboards","drawio"]');
});

test("hidden features change nothing about access: pages of that kind still load", async () => {
  const owner = await account("Owner");
  const wid = await createWorkspace(owner.id, "Bretter");
  const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
  const board = (await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Board", kind: "whiteboard" })) as { id: string };
  await command(owner, { action: "profile.modules", hidden: ["whiteboards", "flashcards"] });
  // Still in the tree of the bootstrap, and it opens.
  const boot = await bootstrap(owner, wid);
  assert.ok(boot.pages.some((p) => p.id === board.id && p.kind === "whiteboard"));
  // A new one can still be created through the API (only the interface hides it).
  const another = (await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Noch eins", kind: "whiteboard" })) as { id: string };
  assert.ok(another.id);
});

test("an administrator puts a person or everyone back on the default, in the activity log", async () => {
  const admin = await account("Admin", true);
  const member = await account("Member");
  const target = await account("Target");
  const other = await account("Other");
  await command(target, { action: "profile.modules", hidden: ["ai"] });
  await command(other, { action: "profile.modules", hidden: [] });
  await saveInstanceSettings({ modulesDefault: ["drawio"] });
  assert.deepEqual(await command(admin, { action: "admin.modules", userId: target.id }), { modules: { hidden: ["drawio"], own: false, standard: ["drawio"] } });
  assert.equal(await stored(target.id), null);
  assert.ok(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='admin.modules' AND resource_id=?", admin.id, target.id));
  assert.equal(await status(() => command(member, { action: "admin.modules", userId: target.id })), 403);
  assert.equal(await status(() => command(admin, { action: "admin.modules", userId: id() })), 404);
  assert.equal(await status(() => command(admin, { action: "admin.modules", userId: "nope" })), 400);
  // Everyone: own choices go, the default applies (also when it changes).
  assert.equal(await status(() => command(member, { action: "admin.modulesApplyAll" })), 403);
  const applied = (await command(admin, { action: "admin.modulesApplyAll" })) as { changed: number; standard: string[] };
  assert.ok(applied.changed >= 1);
  assert.deepEqual(applied.standard, ["drawio"]);
  assert.equal(await stored(other.id), null);
  assert.ok(!(await one("SELECT 1 FROM users WHERE modules IS NOT NULL AND demo_until IS NULL")));
  assert.ok(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='admin.modulesApplyAll'", admin.id));
  await saveInstanceSettings({ modulesDefault: [] });
});

test("accounts from before the switches keep every feature, whatever the default", async () => {
  const old = await account("Old");
  const chose = await account("Chose");
  await run("UPDATE users SET modules='[\"ai\"]' WHERE id=?", chose.id);
  await run("DELETE FROM data_migrations WHERE name=?", FEATURE_MODULES_STEP);
  await runDataSteps([FEATURE_MODULES_STEP]);
  assert.equal(await stored(old.id), "[]");
  assert.equal(await stored(chose.id), '["ai"]');
  const fresh = await account("Fresh");
  assert.equal(await stored(fresh.id), null);
  await runDataSteps([FEATURE_MODULES_STEP]);
  assert.equal(await stored(fresh.id), null, "the step runs once");
});
