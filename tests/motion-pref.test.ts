// "Animationen" (#260, lib/motion-pref.ts, lib/user-motion.ts): normal,
// reduced or off, saved per person on the server, validated and delivered
// with the bootstrap; mirrored on <html> and read by lib/motion.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-motion-pref-"));
const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
after(async () => {
  await win.happyDOM.close();
});
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/motion-pref")), ...(await import("../lib/motion-pref-client")) };
const { motionLevel, prefersReducedMotion } = await import("../lib/motion");
const { commandActions } = await import("../lib/openapi");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("normal by default; unknown values read as the default; the system's reduce motion turns it off", () => {
  assert.equal(pref.DEFAULT_MOTION, "normal");
  for (const value of [null, undefined, "", "none", 0, false, "OFF"]) assert.equal(pref.motionPrefOf(value), "normal", String(value));
  assert.equal(pref.motionPrefOf("reduced"), "reduced");
  assert.equal(pref.motionPrefOf("off"), "off");
  for (const choice of pref.MOTION_PREFS) {
    assert.equal(pref.effectiveMotion(choice, true), "off", `${choice} with the system's reduce motion`);
    assert.equal(pref.effectiveMotion(choice, false), choice);
  }
  assert.equal(pref.motionAttribute("normal"), undefined, "no attribute for the default");
  assert.equal(pref.motionAttribute("reduced"), "reduced");
  assert.equal(pref.motionAttribute("off"), "off");
});

test("the browser's copy sets data-motion on <html>, which lib/motion.ts reads", () => {
  const root = document.documentElement;
  const media = (reduce: boolean) => ({ matchMedia: () => ({ matches: reduce }), document });
  assert.equal(pref.motionPref(), "normal");
  assert.equal(root.dataset.motion, undefined);
  pref.setMotionPrefLocal("off");
  assert.equal(root.dataset.motion, "off");
  assert.equal(motionLevel(media(false) as never), "off");
  assert.equal(prefersReducedMotion(media(false) as never), true);
  pref.setMotionPrefLocal("reduced");
  assert.equal(root.dataset.motion, "reduced");
  assert.equal(motionLevel(media(false) as never), "reduced");
  assert.equal(prefersReducedMotion(media(false) as never), true, "no glides or slides when reduced");
  assert.equal(motionLevel(media(true) as never), "off", "the system still wins");
  pref.setMotionPrefLocal(undefined);
  assert.equal(pref.motionPref(), "normal", "a bootstrap without the field means the default");
  assert.equal(root.dataset.motion, undefined);
  assert.equal(motionLevel(media(false) as never), "normal");
  assert.equal(prefersReducedMotion(media(false) as never), false);
});

test("each person saves the choice; it comes with the bootstrap and is validated", async () => {
  const anna = await account("motion-anna"),
    ben = await account("motion-ben");
  const wid = await createWorkspace(anna.id, "Bewegung");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).motion, "normal", "never chosen: the default");
  assert.equal((await one<{ motion: string | null }>("SELECT motion FROM users WHERE id=?", anna.id))?.motion, null);
  assert.deepEqual(await command(anna, { action: "profile.motion", motion: "off" }), { motion: "off" });
  assert.equal((await bootstrap(anna, wid)).motion, "off");
  assert.equal((await bootstrap(ben, wid)).motion, "normal", "only for that person");
  assert.deepEqual(await command(anna, { action: "profile.motion", motion: "reduced" }), { motion: "reduced" });
  for (const bad of ["none", "", null, true, 0, undefined, { value: "off" }, "Reduced"])
    await rejects(() => command(anna, { action: "profile.motion", motion: bad }));
  assert.equal((await bootstrap(anna, wid)).motion, "reduced", "a rejected value changes nothing");
  await command(anna, { action: "profile.motion", motion: "normal" });
  assert.equal((await bootstrap(anna, wid)).motion, "normal");
  await run("UPDATE users SET motion=? WHERE id=?", "bogus", ben.id);
  assert.equal((await bootstrap(ben, wid)).motion, "normal", "a value written elsewhere reads as the default");
});

test("the command is documented in the API", () => {
  const doc = commandActions.find((a) => a.action === "profile.motion");
  assert.ok(doc, "profile.motion in lib/openapi.ts");
  assert.equal(doc!.input.safeParse({ action: "profile.motion", motion: "off" }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.motion", motion: "slow" }).success, false);
});

test("the stylesheet: one set of tokens; opening keyframes of menus and dialogs never move or overshoot", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const token of ["--motion-fast: 100ms", "--motion-base: 150ms", "--motion-slow: 200ms", "--ease-standard: cubic-bezier(0.2, 0, 0, 1)"])
    assert.ok(css.includes(token), token);
  const keyframes = (name: string) => {
    const at = css.indexOf(`@keyframes ${name} {`);
    assert.ok(at >= 0, name);
    return css.slice(at, css.indexOf("}\n}", at) + 3);
  };
  for (const name of ["menu-in", "modal-in", "reaction-pop", "ai-panel-in", "ask-pill-in"]) {
    const body = keyframes(name);
    assert.doesNotMatch(body, /translate|transform/, `${name} only fades and scales`);
    assert.match(body, /scale: var\(--motion-scale\)/, `${name} scales from the token`);
  }
  assert.doesNotMatch(keyframes("menu-in"), /0\.96/);
  // Menus and dialogs keep the spring out.
  for (const line of css.split("\n").filter((l) => /animation: (menu-in|modal-in)\b/.test(l)))
    assert.doesNotMatch(line, /ease-spring/, line.trim());
  // "Aus" ends every animation and transition, like the system's setting.
  assert.match(css, /\[data-motion="off"\] \*,[\s\S]*?animation-duration: 0\.01ms !important;[\s\S]*?transition-duration: 0\.01ms !important;/);
  // "Reduziert": no scale, no slide.
  assert.match(css, /\[data-motion="reduced"\] \{[^}]*--motion-scale: 1;[^}]*--motion-move: 0;/);
  // No title or icon flies into the page any more.
  assert.doesNotMatch(css, /fp-page-title|fp-page-icon|fp-record/);
});
