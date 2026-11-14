// "Beim Öffnen auf dem Handy" (lib/start-screen.ts, lib/user-start-screen.ts):
// the quick capture as the start screen of phones – the decision on the
// device (setting × deep link × screen size), the server's phone guess,
// the setting saved per person and delivered with the bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-start-screen-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/start-screen")), ...(await import("../lib/start-screen-client")) };
const { commandActions } = await import("../lib/openapi");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.2.0";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

const phone = { setting: "capture" as const, pathname: "/", search: "", hash: "", shortSide: 390, navigation: "navigate" };

test("the start page by default; anything unknown is the default", () => {
  assert.equal(pref.DEFAULT_START_SCREEN, "home");
  for (const value of [null, undefined, "", "Capture", "last", 1]) assert.equal(pref.startScreenOf(value), "home", String(value));
  assert.equal(pref.startScreenOf("capture"), "capture");
  assert.equal(pref.startScreenOf("home"), "home");
});

test("the capture only with the setting, on a phone, at the bare address", () => {
  assert.equal(pref.startDecision(phone), "capture");
  assert.equal(pref.startDecision({ ...phone, hash: "#" }), "capture", "an empty fragment is the bare address");
  assert.equal(pref.startDecision({ ...phone, navigation: "reload" }), "capture", "reloading is a fresh start");
  assert.equal(pref.startDecision({ ...phone, navigation: undefined }), "capture");
  assert.equal(pref.startDecision({ ...phone, setting: "home" }), "app", "the setting off");
});

test("deep links always open the app", () => {
  for (const hash of ["#page=6f1d1f6e-1f5b-4f0b-9d7e-6a2b2f0c9a11", "#inbox", "#home", "#capture", "#search=x", "#settings/account", "#new"])
    assert.equal(pref.startDecision({ ...phone, hash }), "app", hash);
  for (const search of ["?invite=abc", "?useTemplate=starter:Notes", "?confirmed=1"]) assert.equal(pref.startDecision({ ...phone, search }), "app", search);
  for (const pathname of ["/share-target", "/share", "/login"]) assert.equal(pref.startDecision({ ...phone, pathname }), "app", pathname);
  assert.equal(pref.startDecision({ ...phone, navigation: "back_forward" }), "app", "back to the page from elsewhere");
});

test("tablets and computers always open the app", () => {
  for (const shortSide of [600, 744, 820, 1024, 1440, 0, NaN]) assert.equal(pref.startDecision({ ...phone, shortSide }), "app", String(shortSide));
  for (const shortSide of [320, 375, 390, 430, 480, 599]) assert.equal(pref.startDecision({ ...phone, shortSide }), "capture", String(shortSide));
});

test("the server's guess: phones by their user agent or client hint, never tablets", () => {
  assert.equal(pref.phoneUserAgent(IPHONE), true);
  assert.equal(pref.phoneUserAgent(ANDROID_PHONE), true);
  assert.equal(pref.phoneUserAgent(DESKTOP, "?1"), true, "Sec-CH-UA-Mobile");
  assert.equal(pref.phoneUserAgent(ANDROID_TABLET), false);
  assert.equal(pref.phoneUserAgent(IPAD), false);
  assert.equal(pref.phoneUserAgent(DESKTOP, "?0"), false);
  assert.equal(pref.phoneUserAgent(null), false);
});

test("the browser's copy follows the bootstrap", () => {
  assert.equal(pref.startScreen(), "home");
  pref.setStartScreenLocal("capture");
  assert.equal(pref.startScreen(), "capture");
  pref.setStartScreenLocal(undefined);
  assert.equal(pref.startScreen(), "home", "a bootstrap without the field means the default");
});

test("each person saves the choice; it comes with the bootstrap; values are validated", async () => {
  const anna = await account("start-anna"),
    ben = await account("start-ben");
  const wid = await createWorkspace(anna.id, "Start");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).startScreen, "home", "never chosen: the default");
  assert.deepEqual(await command(anna, { action: "profile.startScreen", startScreen: "capture" }), { startScreen: "capture" });
  assert.equal((await bootstrap(anna, wid)).startScreen, "capture");
  assert.equal((await bootstrap(ben, wid)).startScreen, "home", "only for the person who chose it");
  for (const bad of ["last", "", null, true])
    await assert.rejects(
      () => command(anna, { action: "profile.startScreen", startScreen: bad }),
      (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError",
    );
  assert.equal((await bootstrap(anna, wid)).startScreen, "capture", "a refused value changes nothing");
  await command(anna, { action: "profile.startScreen", startScreen: "home" });
  assert.equal((await bootstrap(anna, wid)).startScreen, "home");
});

test("documented in the OpenAPI document", () => {
  const doc = commandActions.find((a) => a.action === "profile.startScreen");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.startScreen", startScreen: "capture" }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.startScreen", startScreen: "last" }).success, false);
});
