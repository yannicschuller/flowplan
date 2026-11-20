// "Ton bei neuen Benachrichtigungen" (#401, lib/notification-sound.ts,
// lib/user-notification-sound.ts): whether a look at the inbox makes a
// sound (new vs. own vs. count down vs. setting off vs. do-not-disturb),
// the tones, the setting saved per person and validated, the API
// documentation and the settings search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notification-sound-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const sound = { ...(await import("../lib/notification-sound")), ...(await import("../lib/notification-sound-client")) };
const { commandActions } = await import("../lib/openapi");
const { SETTINGS_SECTIONS } = await import("../lib/settings-sections");
const { wantedFor } = await import("../components/use-workspace-signals");

const NOW = Date.parse("2026-11-20T12:00:00Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const item = (id: string, kind: string | null, secondsAgo = 1, read = false) => ({ id, kind, createdAt: at(secondsAgo), read });
const decide = (over: Partial<Parameters<typeof sound.soundDecision>[0]> = {}) =>
  sound.soundDecision({ sound: "soft", items: [], now: NOW, known: new Set(), ownActionAgo: Infinity, ...over });

test("a new unread notification plays; the ids it saw are returned to remember", () => {
  assert.deepEqual(decide({ items: [item("a", "mention")] }), { play: true, fresh: ["a"] });
  // Known ones (heard in another tab, shown when the page opened) do not.
  assert.deepEqual(decide({ items: [item("a", "mention")], known: new Set(["a"]) }), { play: false, fresh: [] });
  // One new among known ones.
  assert.deepEqual(decide({ items: [item("b", "comment"), item("a", "mention")], known: new Set(["a"]) }), { play: true, fresh: ["b"] });
  // The server's time decides what is recent, not this computer's.
  assert.equal(decide({ items: [item("a", "share")], now: new Date(NOW).toISOString() }).play, true);
});

test("the count going down, read ones and old ones make no sound", () => {
  // Read or deleted: nothing new among what is left.
  assert.deepEqual(decide({ items: [item("a", "mention", 5, true)] }), { play: false, fresh: [] });
  assert.deepEqual(decide({ items: [], known: new Set(["a", "b"]) }), { play: false, fresh: [] });
  // Marked unread again: known, so not new.
  assert.equal(decide({ items: [item("a", "mention", 30)], known: new Set(["a"]) }).play, false);
  // Older than FRESH_MS: a late look is no arrival.
  assert.equal(decide({ items: [item("old", "mention", sound.FRESH_MS / 1000 + 5)] }).play, false);
  assert.equal(decide({ items: [item("edge", "mention", sound.FRESH_MS / 1000 - 5)] }).play, true);
});

test("one's own rule or workflow right after one's own change stays quiet; others' notifications do not", () => {
  for (const kind of ["automation", "workflow", "workflow_ops"]) {
    const own = decide({ items: [item("w", kind)], ownActionAgo: 2_000 });
    assert.equal(own.play, false, kind);
    // Still remembered: it does not ring later either.
    assert.deepEqual(own.fresh, ["w"]);
    assert.equal(decide({ items: [item("w", kind)], ownActionAgo: sound.OWN_ACTION_MS + 1 }).play, true, `${kind} later`);
  }
  // Mentions, comments, shares are never one's own (the server leaves out
  // whoever caused them) – they play even right after one's own change.
  for (const kind of ["mention", "comment", "share", "reminder", null]) assert.equal(decide({ items: [item("m", kind)], ownActionAgo: 100 }).play, true, String(kind));
  // One's own rule together with someone's mention: the mention plays.
  assert.equal(decide({ items: [item("w", "automation"), item("m", "mention")], ownActionAgo: 100 }).play, true);
});

test("setting off, do-not-disturb and the desktop app's own system notification: no sound, still remembered", () => {
  assert.deepEqual(decide({ sound: "off", items: [item("a", "mention")] }), { play: false, fresh: ["a"] });
  assert.deepEqual(decide({ quiet: true, items: [item("a", "mention")] }), { play: false, fresh: ["a"] });
  assert.deepEqual(decide({ handledElsewhere: true, items: [item("a", "mention")] }), { play: false, fresh: ["a"] });
  for (const value of ["soft", "clear", "bell"] as const) assert.equal(decide({ sound: value, items: [item("a", "mention")] }).play, true, value);
});

test("remembered ids: newest first, no duplicates, bounded", () => {
  assert.deepEqual(sound.rememberKnown(["a", "b"], ["c", "a"]), ["c", "a", "b"]);
  const many = Array.from({ length: 500 }, (_, i) => `n${i}`);
  assert.equal(sound.rememberKnown(many, ["x"]).length, sound.KNOWN_LIMIT);
  assert.equal(sound.rememberKnown(many, ["x"])[0], "x");
});

test("the sounds: short, quiet sine/triangle tones, nothing for off", () => {
  assert.deepEqual([...sound.NOTIFICATION_SOUNDS], ["off", "soft", "clear", "bell"]);
  assert.equal(sound.DEFAULT_NOTIFICATION_SOUND, "soft");
  for (const name of ["soft", "clear", "bell"] as const) {
    const length = sound.soundLength(name);
    assert.ok(length >= 0.15 && length <= 0.4, `${name}: ${length} s`);
    for (const tone of sound.SOUND_TONES[name]) {
      assert.ok(tone.wave === "sine" || tone.wave === "triangle");
      assert.ok(tone.gain > 0 && tone.gain <= 0.06, `${name} gain ${tone.gain}`);
      assert.ok(tone.frequency >= 200 && tone.frequency <= 3000);
    }
    // Together still quiet.
    assert.ok(sound.SOUND_TONES[name].reduce((sum, t) => sum + t.gain, 0) <= 0.1);
  }
  // Without a browser (no AudioContext) nothing plays and nothing throws.
  assert.equal(sound.playNotificationSound("soft"), false);
  assert.equal(sound.playNotificationSound("off", true), false);
  assert.equal(sound.audioUnlocked(), false);
});

test("stored values: only the four known ones, anything else is the default", () => {
  for (const value of [null, undefined, "", "loud", "SOFT", 0, 1, {}]) assert.equal(sound.notificationSoundOf(value), "soft", String(value));
  for (const value of ["off", "soft", "clear", "bell"]) assert.equal(sound.notificationSoundOf(value), value);
  // The browser's copy from the bootstrap.
  assert.equal(sound.notificationSound(), "soft");
  sound.setNotificationSoundLocal("bell");
  assert.equal(sound.notificationSound(), "bell");
  sound.setNotificationSoundLocal(undefined);
  assert.equal(sound.notificationSound(), "soft", "a bootstrap without the field means the default");
});

test("own changes in this browser are noted (without a browser: in memory)", () => {
  assert.equal(sound.ownActionAgo(1000), Infinity);
  sound.noteOwnAction(5000);
  assert.equal(sound.ownActionAgo(7000), 2000);
});

test("the live signal tells about every change of the notifications", () => {
  // The sound hook is called for these (components/use-workspace-signals.ts).
  assert.deepEqual(wantedFor({ type: "changed", parts: ["notifications"] }, null), { boot: true, page: false });
  const source = readFileSync(new URL("../components/use-workspace-signals.ts", import.meta.url), "utf8");
  assert.match(source, /event\.parts\.includes\("notifications"\)\) notified\?\.current\?\.\(\)/);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("each person saves the sound; values are validated; the bootstrap delivers it", async () => {
  const anna = await account("sound-anna"),
    ben = await account("sound-ben");
  const wid = await createWorkspace(anna.id, "Ton");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).notificationSound, "soft", "never chosen: the default (on)");
  assert.equal((await one<{ notification_sound: string | null }>("SELECT notification_sound FROM users WHERE id=?", anna.id))?.notification_sound, null);

  assert.deepEqual(await command(anna, { action: "profile.notificationSound", notificationSound: "bell" }), { notificationSound: "bell" });
  assert.equal((await bootstrap(anna, wid)).notificationSound, "bell");
  assert.equal((await bootstrap(ben, wid)).notificationSound, "soft", "only for that person");
  assert.deepEqual(await command(anna, { action: "profile.notificationSound", notificationSound: "off" }), { notificationSound: "off" });
  assert.equal((await bootstrap(anna, wid)).notificationSound, "off");

  for (const bad of ["loud", "", "SOFT", null, undefined, true, 1, { value: "bell" }])
    await rejects(() => command(anna, { action: "profile.notificationSound", notificationSound: bad }));
  assert.equal((await bootstrap(anna, wid)).notificationSound, "off", "a rejected value changes nothing");
  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET notification_sound=? WHERE id=?", "trumpet", ben.id);
  assert.equal((await bootstrap(ben, wid)).notificationSound, "soft");
});

test("the command is documented in the API", () => {
  const doc = commandActions.find((a) => a.action === "profile.notificationSound");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.notificationSound", notificationSound: "clear" }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.notificationSound", notificationSound: "loud" }).success, false);
  const sdk = readFileSync(new URL("../sdk/typescript/flowplan.ts", import.meta.url), "utf8");
  assert.match(sdk, /profile\.notificationSound/);
});

test("the setting can be found in the settings search, in the notifications section", async () => {
  const { searchSettings } = await import("../lib/settings-sections");
  const section = SETTINGS_SECTIONS.find((s) => s.id === "notifications");
  const entry = section?.entries?.find((e) => e.anchor === "notification-sound");
  assert.ok(entry);
  for (const query of ["Ton bei neuen", "glocke", "anhören", "notification sound", "chime"]) {
    const hits = searchSettings(SETTINGS_SECTIONS, query, (text) => text.de);
    assert.ok(hits.some((h) => h.section.id === "notifications" && h.anchor === "notification-sound"), query);
  }
  // The card carries that anchor.
  const card = readFileSync(new URL("../components/notification-sound-settings.tsx", import.meta.url), "utf8");
  assert.match(card, /<SettingGroup id="notification-sound"/);
});
