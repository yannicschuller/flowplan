// Curated release notes (#223): the files in release-notes/, the release
// script (scripts/release-notes.mjs: GitHub release and CHANGELOG.md), which
// versions "Neu in Flowplan" shows for a person (lib/release-notes.ts,
// lib/user-update-notes.ts) and the setting with its three levels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import type { ReleaseNotes } from "../lib/update-notes-pref";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-release-notes-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { commandActionNames } = await import("../lib/openapi");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const notesLib = await import("../lib/release-notes");
const userNotes = await import("../lib/user-update-notes");
const pref = await import("../lib/update-notes-pref");
const script = await import("../scripts/release-notes.mjs");

const DIR = join(process.cwd(), "release-notes");
const item = (en: string, extra: Record<string, unknown> = {}) => ({ de: `DE ${en}`, en, ...extra });

test("every curated file is valid for the server and for the release script", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 2, "0.9.3 backfilled and the next release written");
  for (const file of files) {
    const version = file.slice(0, -5);
    assert.ok(notesLib.isVersion(version), `${file}: the file name is a version`);
    const data = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    const parsed = notesLib.releaseNotesFileSchema.safeParse(data);
    assert.ok(parsed.success, `${file}: ${parsed.success ? "" : parsed.error.message}`);
    assert.deepEqual(script.checkNotes(data), [], file);
    for (const s of pref.RELEASE_NOTE_SECTIONS)
      for (const i of data[s] || []) {
        // Plain lines for people: no Markdown, no internal noise.
        assert.doesNotMatch(`${i.de} ${i.en}`, /[`*_]{1,2}\w|\]\(|\b(CI|refactor|Tests?:|Help docs)\b/, `${file}: ${i.en}`);
        assert.notEqual(i.de, i.en, `${file}: German and English differ (${i.en})`);
      }
  }
  // The server reads them all, newest first.
  const loaded = notesLib.loadReleaseNotes(DIR).map((n) => n.version);
  assert.deepEqual(loaded, [...loaded].sort((a, b) => -a.localeCompare(b, "en", { numeric: true })));
  assert.ok(loaded.includes("0.9.3"));
});

test("broken notes are refused by both checks", () => {
  const bad: unknown[] = [
    {},
    { features: [] },
    { features: [{ de: "Nur Deutsch" }] },
    { features: [{ en: "Only English" }] },
    { features: [item("Two\nlines")] },
    { features: [item("x".repeat(301))] },
    { features: [item("Issue as text", { issues: ["#12"] })] },
    { features: [item("Extra key", { title: "no" })] },
    { news: [item("Unknown section")] },
    { date: "11.11.2026", features: [item("A date in the wrong format")] },
    { features: "not a list" },
  ];
  for (const data of bad) {
    assert.equal(notesLib.releaseNotesFileSchema.safeParse(data).success, false, JSON.stringify(data));
    assert.ok(script.checkNotes(data).length > 0, JSON.stringify(data));
  }
  const good = { date: "2026-11-11", breaking: [item("Something changed", { issues: [1, 2] })], fixes: [item("Fixed it", { fr: "Corrigé", zh: "已修复" })] };
  assert.equal(notesLib.releaseNotesFileSchema.safeParse(good).success, true);
  assert.deepEqual(script.checkNotes(good), []);
});

test("a broken or wrongly named file is left out by the server, the rest still shows", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-notes-dir-"));
  writeFileSync(join(dir, "1.0.0.json"), JSON.stringify({ features: [item("Good one")] }));
  writeFileSync(join(dir, "1.0.1.json"), "{ not json");
  writeFileSync(join(dir, "next.json"), JSON.stringify({ features: [item("No version")] }));
  writeFileSync(join(dir, "README.md"), "not notes");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(notesLib.loadReleaseNotes(dir).map((n) => n.version), ["1.0.0"]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(notesLib.loadReleaseNotes(join(dir, "missing")), []);
});

const notes = (version: string, extra: Partial<ReleaseNotes> = {}): ReleaseNotes => ({ version, features: [item(`New in ${version}`)], ...extra });
const ALL: ReleaseNotes[] = [
  notes("2.0.0", { breaking: [item("Old API removed")] }),
  notes("2.0.0-beta.2"),
  notes("2.0.0-beta.1", { breaking: [item("Beta break")] }),
  notes("1.10.0"),
  notes("1.9.1"),
  notes("1.9.0", { breaking: [item("Config renamed")] }),
  notes("1.2.3"),
];
const versions = (list: ReleaseNotes[]) => list.map((n) => n.version);

test("version range: after the last seen, up to the running one, semver order, pre-releases only for pre-release builds", () => {
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.9.0", "1.10.0")), ["1.10.0", "1.9.1"], "1.10 is newer than 1.9 (not text order)");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.10.0", "1.10.0")), [], "nothing new");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.10.0", "1.9.1")), [], "a downgrade shows nothing");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.2.3", "1.9.5")), ["1.9.1", "1.9.0"], "a version without notes of its own");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.10.0", "2.0.0")), ["2.0.0"], "the release covers its betas");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.10.0", "2.0.0-beta.2")), ["2.0.0-beta.2", "2.0.0-beta.1"], "a beta build shows the betas up to itself");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "2.0.0-beta.1", "2.0.0-beta.2")), ["2.0.0-beta.2"]);
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "2.0.0-beta.2", "2.0.0")), ["2.0.0"], "from the beta to the release");
  assert.deepEqual(versions(notesLib.notesBetween(ALL, null, "1.9.1")), ["1.9.1", "1.9.0", "1.2.3"]);
  // The next release's notes, written ahead, never show on the version before it.
  assert.deepEqual(versions(notesLib.notesBetween(ALL, "1.2.3", "1.2.3")), []);
  assert.deepEqual(notesLib.notesBetween(ALL, "1.2.3", ""), [], "a development build without a version");
  assert.deepEqual(notesLib.notesBetween(ALL, "1.2.3", "main"), []);
});

test("the three levels: all, only breaking changes (and only those), never", () => {
  const skipped = notesLib.notesBetween(ALL, "1.2.3", "1.10.0");
  assert.deepEqual(versions(notesLib.notesForLevel(skipped, "all")), ["1.10.0", "1.9.1", "1.9.0"]);
  const breaking = notesLib.notesForLevel(skipped, "breaking");
  assert.deepEqual(breaking, [{ version: "1.9.0", breaking: [item("Config renamed")] }], "only the version with breaking changes, without its other sections");
  assert.deepEqual(notesLib.notesForLevel(notesLib.notesBetween(ALL, "1.9.0", "1.10.0"), "breaking"), [], "no breaking changes skipped: no dialog");
  assert.deepEqual(notesLib.notesForLevel(skipped, "never"), []);
  assert.equal(pref.updateNotesLevelOf("breaking"), "breaking");
  for (const v of [null, undefined, "", "some", 1]) assert.equal(pref.updateNotesLevelOf(v), "all");
});

test("texts in the reader's language; French and Chinese fall back to English", () => {
  const i = { de: "Neu", en: "New", fr: "Nouveau" };
  assert.equal(pref.noteText(i, "de"), "Neu");
  assert.equal(pref.noteText(i, "en-US"), "New");
  assert.equal(pref.noteText(i, "fr"), "Nouveau");
  assert.equal(pref.noteText(i, "zh"), "New");
});

async function account(name: string, used = true) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  if (used) await run("UPDATE users SET onboarded_at=?,last_open_at=? WHERE id=?", Date.now(), Date.now(), uid);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const seen = async (u: Identity) => (await one<{ seen_version: string | null }>("SELECT seen_version FROM users WHERE id=?", u.id))?.seen_version;

test("a person sees the skipped versions once; closing marks the running version as seen", async () => {
  const anna = await account("notes-anna");
  await run("UPDATE users SET seen_version=? WHERE id=?", "1.2.3", anna.id);
  const first = await userNotes.userUpdateNotes(anna, { current: "1.10.0", notes: ALL });
  assert.equal(first.level, "all");
  assert.deepEqual(versions(first.pending || []), ["1.10.0", "1.9.1", "1.9.0"]);
  assert.match(first.changelog || "", /^https:\/\/github\.com\/.+CHANGELOG\.md$/);
  // Until the dialog is closed, it comes again (a reload before closing).
  assert.equal((await userNotes.userUpdateNotes(anna, { current: "1.10.0", notes: ALL })).pending?.length, 3);
  assert.deepEqual(await userNotes.setUserUpdateNotes(anna, { seen: true }, { current: "1.10.0" }), { level: "all", seenVersion: "1.10.0" });
  assert.equal((await userNotes.userUpdateNotes(anna, { current: "1.10.0", notes: ALL })).pending, undefined);
  // Seen only moves forward: a rollback does not reset it.
  await userNotes.setUserUpdateNotes(anna, { seen: true }, { current: "1.9.0" });
  assert.equal(await seen(anna), "1.10.0");
  assert.equal((await userNotes.userUpdateNotes(anna, { current: "1.9.0", notes: ALL })).pending, undefined);
  assert.equal(await seen(anna), "1.10.0");
});

test("new accounts start at the running version with the administration's default, no backlog", async () => {
  const fresh = await account("notes-new", false);
  assert.deepEqual(await userNotes.userUpdateNotes(fresh, { current: "1.10.0", notes: ALL }), { level: "all" });
  assert.equal(await seen(fresh), "1.10.0");
  assert.equal((await userNotes.userUpdateNotes(fresh, { current: "2.0.0", notes: ALL })).pending?.[0]?.version, "2.0.0", "the next update shows");

  await saveInstanceSettings({ updateNotesDefault: "breaking" });
  const other = await account("notes-new-2", false);
  assert.deepEqual(await userNotes.userUpdateNotes(other, { current: "1.10.0", notes: ALL }), { level: "breaking" });
  assert.equal((await one<{ update_notes: string }>("SELECT update_notes FROM users WHERE id=?", other.id))?.update_notes, "breaking");
  // Existing accounts keep theirs: the default is only for new ones.
  const anna = await account("notes-old");
  await run("UPDATE users SET seen_version=? WHERE id=?", "1.9.1", anna.id);
  assert.equal((await userNotes.userUpdateNotes(anna, { current: "1.10.0", notes: ALL })).level, "all");
  await saveInstanceSettings({ updateNotesDefault: "all" });

  // Accounts from before the dialog existed see the running version's notes once.
  const legacy = await account("notes-legacy");
  assert.deepEqual(versions((await userNotes.userUpdateNotes(legacy, { current: "1.10.0", notes: ALL })).pending || []), ["1.10.0"]);
});

test("the levels decide whether the dialog comes; with nothing to show the version counts as seen", async () => {
  const ben = await account("notes-ben");
  await run("UPDATE users SET seen_version=?,update_notes=? WHERE id=?", "1.2.3", "breaking", ben.id);
  const shown = await userNotes.userUpdateNotes(ben, { current: "1.10.0", notes: ALL });
  assert.equal(shown.level, "breaking");
  assert.deepEqual(shown.pending, [{ version: "1.9.0", breaking: [item("Config renamed")] }]);
  await userNotes.setUserUpdateNotes(ben, { seen: true }, { current: "1.10.0" });
  // 1.10.0 → 2.0.0-beta.2 has a breaking beta; a release build then skips betas.
  await run("UPDATE users SET seen_version=? WHERE id=?", "1.9.0", ben.id);
  assert.equal((await userNotes.userUpdateNotes(ben, { current: "1.10.0", notes: ALL })).pending, undefined, "no breaking change skipped");
  assert.equal(await seen(ben), "1.10.0", "and the version counts as seen");

  await userNotes.setUserUpdateNotes(ben, { level: "never" });
  assert.equal((await userNotes.userUpdateNotes(ben, { current: "2.0.0", notes: ALL })).pending, undefined);
  assert.equal(await seen(ben), "2.0.0");

  // API tokens and the demo only read.
  await run("UPDATE users SET seen_version=?,update_notes=NULL WHERE id=?", "1.2.3", ben.id);
  assert.equal((await userNotes.userUpdateNotes({ ...ben, apiScope: "read" }, { current: "2.0.0", notes: ALL })).pending, undefined);
  assert.equal(await seen(ben), "1.2.3");
});

test("commands: profile.updateNotes and releaseNotes.list, validated, in the bootstrap and the API docs", async () => {
  const cara = await account("notes-cara");
  const wid = await createWorkspace(cara.id, "Neuigkeiten");
  const boot = await bootstrap(cara, wid);
  assert.ok(boot.updateNotes, "the bootstrap carries the level");
  assert.equal(boot.updateNotes.level, "all");
  assert.deepEqual(await command(cara, { action: "profile.updateNotes", level: "breaking" }), { level: "breaking", seenVersion: (await seen(cara)) ?? null });
  assert.equal((await bootstrap(cara, wid)).updateNotes?.level, "breaking");
  for (const bad of [{}, { level: "some" }, { level: null }, { seen: false }, { seen: "yes" }])
    await assert.rejects(() => command(cara, { action: "profile.updateNotes", ...bad }), (e: unknown) => (e as Error).name === "ZodError" || (e as { status?: number }).status === 400, JSON.stringify(bad));
  assert.equal((await bootstrap(cara, wid)).updateNotes?.level, "breaking", "a rejected value changes nothing");

  const list = (await command(cara, { action: "releaseNotes.list", limit: 2 })) as { versions: ReleaseNotes[]; changelog: string };
  assert.ok(list.versions.length <= 2);
  assert.match(list.changelog, /CHANGELOG\.md$/);
  const recent = userNotes.recentReleaseNotes({}, { current: "1.10.0", notes: ALL });
  assert.deepEqual(versions(recent.versions), ["1.10.0", "1.9.1", "1.9.0", "1.2.3"], "whatever the level, up to the running version, no betas");
  assert.equal(userNotes.recentReleaseNotes({ limit: 1 }, { current: "1.10.0", notes: ALL }).versions.length, 1);
  assert.throws(() => userNotes.recentReleaseNotes({ limit: 0 }));
  assert.ok(commandActionNames.includes("profile.updateNotes"));
  assert.ok(commandActionNames.includes("releaseNotes.list"));
});

const URL_ = "https://github.com/example/flowplan";
const COMMITS = [
  { sha: "a".repeat(40), subject: "Tasks: five states (#201)" },
  { sha: "b".repeat(40), subject: "Links with [brackets]" },
];

test("release script without a curated file: the commit list as before", () => {
  const body = script.renderNotes({ version: "1.2.4", previous: "v1.2.3", commits: COMMITS, curated: null, url: URL_ });
  assert.equal(
    body,
    [
      "## Changes",
      "",
      `- Tasks: five states (#201) ([aaaaaaa](${URL_}/commit/${"a".repeat(40)}))`,
      `- Links with \\[brackets\\] ([bbbbbbb](${URL_}/commit/${"b".repeat(40)}))`,
      "",
      `**Full changelog:** [v1.2.3...v1.2.4](${URL_}/compare/v1.2.3...v1.2.4)`,
    ].join("\n"),
  );
  assert.match(script.renderNotes({ version: "1.2.4", previous: "", commits: [], curated: null, url: URL_ }), /Maintenance release without code changes\.[\s\S]*Full history/);
  const section = script.changelogSection({ version: "1.2.4", date: "2026-11-12", commits: COMMITS, curated: null, url: URL_ });
  assert.ok(section.startsWith("## v1.2.4 – 2026-11-12\n\n- Tasks: five states (#201)"));
  assert.doesNotMatch(section, /<details>/);
});

test("release script with a curated file: English sections, issue links, the commits folded away", () => {
  const curated = {
    features: [item("Five task states", { issues: [201] })],
    breaking: [item("The old export is gone")],
    fixes: [item("Menus open on Android", { issues: [207, 210] })],
    security: [],
  };
  const body = script.renderNotes({ version: "1.2.4", previous: "v1.2.3", commits: COMMITS, curated, url: URL_ });
  const headings = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["Breaking changes", "New", "Bug fixes"], "fixed order, empty sections left out");
  assert.match(body, new RegExp(`- Five task states \\(\\[#201\\]\\(${URL_}/issues/201\\)\\)`));
  assert.match(body, /- Menus open on Android \(\[#207\]\(.+\/issues\/207\), \[#210\]\(.+\/issues\/210\)\)/);
  assert.equal(script.curatedMarkdown({ fixes: [item("Fixed it.", { issues: [12] })] }, URL_), `### Bug fixes\n\n- Fixed it ([#12](${URL_}/issues/12)).`, "issues before the full stop");
  assert.doesNotMatch(body, /DE /, "English only");
  assert.match(body, /<details>\n<summary>All commits<\/summary>\n\n- Tasks: five states \(#201\)[\s\S]*<\/details>\n\n\*\*Full changelog:\*\*/);
  assert.ok(body.indexOf("### Bug fixes") < body.indexOf("<details>"), "curated notes first");

  const section = script.changelogSection({ version: "1.2.4", date: "2026-11-12", commits: COMMITS, curated, url: URL_ });
  assert.match(section, /^## v1\.2\.4 – 2026-11-12\n\n### Breaking changes\n\n- The old export is gone\n\n### New/);
  const existing = "# Changelog\n\nOld head.\n\n## v1.2.4 – 2026-11-11\n\n- first try\n\n## v1.2.3 – 2026-11-10\n\n- older\n";
  const updated = script.updateChangelog(existing, section, "1.2.4");
  assert.equal(updated.match(/## v1\.2\.4 /g)?.length, 1, "a version released again replaces its section");
  assert.match(updated, /## v1\.2\.3 – 2026-11-10\n\n- older\n$/);
});

test("release script reads and checks the version's file", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-notes-script-"));
  assert.equal(script.readCurated("1.2.4", dir), null, "no file: null (the workflow warns)");
  writeFileSync(join(dir, "1.2.4.json"), JSON.stringify({ fixes: [item("Fine")] }));
  assert.deepEqual(script.readCurated("1.2.4", dir), { fixes: [item("Fine")] });
  writeFileSync(join(dir, "1.2.5.json"), JSON.stringify({ fixes: [{ en: "No German" }] }));
  assert.throws(() => script.readCurated("1.2.5", dir), /1\.2\.5\.json is not valid:\n- fixes\[0\]\.de is missing/);
  writeFileSync(join(dir, "1.2.6.json"), "{");
  assert.throws(() => script.readCurated("1.2.6", dir), /not valid JSON/);
  // The repository's own next release is ready for the workflow.
  const next = readdirSync(DIR).map((f) => f.slice(0, -5)).sort((a, b) => -a.localeCompare(b, "en", { numeric: true }))[0];
  assert.ok(script.readCurated(next, DIR));
});
