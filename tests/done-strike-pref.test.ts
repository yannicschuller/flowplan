// "Erledigte Aufgaben durchstreichen" (#458, lib/done-strike-pref.ts,
// lib/user-done-strike.ts): done tasks struck through, on by default. The
// choice is saved per person on the server, validated and comes with the
// bootstrap; off, a class on <html> takes the line away in every task list
// of the web app, cancelled tasks keep theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-done-strike-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { commandActionNames } = await import("../lib/openapi");
const pref = { ...(await import("../lib/done-strike-pref")), ...(await import("../lib/done-strike-pref-client")) };

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>, status: number) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === status || (status === 400 && (e as Error).name === "ZodError"));

test("stored values are read leniently: only an explicit off takes the line away", () => {
  assert.equal(pref.DEFAULT_STRIKE_DONE_TASKS, true);
  for (const value of [0, false, "0"]) assert.equal(pref.strikeDoneTasksOf(value), false, String(value));
  for (const value of [1, true, null, undefined, "", "off", 2, {}]) assert.equal(pref.strikeDoneTasksOf(value), true, String(value));
});

test("the browser's copy changes with the bootstrap and tells its listeners", () => {
  assert.equal(pref.strikeDoneTasks(), true);
  pref.setStrikeDoneTasksLocal(false);
  assert.equal(pref.strikeDoneTasks(), false);
  pref.setStrikeDoneTasksLocal(undefined);
  assert.equal(pref.strikeDoneTasks(), true, "a bootstrap without the field means the default");
});

test("the command is documented for the API and the SDKs", () => {
  assert.ok(commandActionNames.includes("profile.strikeDoneTasks"));
});

test("the stylesheet takes the line away with the class wherever task lists show, cancelled tasks keep it", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const cls = `:root.${pref.DONE_TASKS_PLAIN_CLASS}`;
  const start = css.indexOf(cls);
  assert.ok(start > 0, "rules for the class");
  const block = css.slice(start, css.indexOf("}", css.indexOf("text-decoration: none", start)) + 1);
  for (const place of [".document-editor", ".my-tasks-group", ".home-tasks", ".record-subtasks", ".sprint-rows", ".task-due-done"])
    assert.ok(block.includes(`${cls} ${place}`), place);
  assert.match(css, new RegExp(`${cls.replace(/[.:]/g, "\\$&")} \\.document-editor [^{]*\\[data-status="cancelled"\\][^{]*\\{\\s*text-decoration: line-through;`));
});

test("each person saves their choice; it comes with the bootstrap on every device and is validated", async () => {
  const anna = await account("strike-anna"),
    ben = await account("strike-ben");
  const wid = await createWorkspace(anna.id, "Strike");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).strikeDoneTasks, true, "never chosen: the default");
  assert.equal((await one<{ strike_done_tasks: number | null }>("SELECT strike_done_tasks FROM users WHERE id=?", anna.id))?.strike_done_tasks, null);

  assert.deepEqual(await command(anna, { action: "profile.strikeDoneTasks", strikeDoneTasks: false }), { strikeDoneTasks: false });
  assert.equal((await bootstrap(anna, wid)).strikeDoneTasks, false);
  assert.equal((await bootstrap(ben, wid)).strikeDoneTasks, true, "only for that person");

  assert.deepEqual(await command(anna, { action: "profile.strikeDoneTasks", strikeDoneTasks: true }), { strikeDoneTasks: true });
  assert.equal((await bootstrap(anna, wid)).strikeDoneTasks, true);
  await command(anna, { action: "profile.strikeDoneTasks", strikeDoneTasks: false });

  for (const bad of ["off", "", null, 0, 1, undefined, { value: false }])
    await rejects(() => command(anna, { action: "profile.strikeDoneTasks", strikeDoneTasks: bad }), 400);
  assert.equal((await bootstrap(anna, wid)).strikeDoneTasks, false, "a rejected value changes nothing");

  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET strike_done_tasks=? WHERE id=?", 7, ben.id);
  assert.equal((await bootstrap(ben, wid)).strikeDoneTasks, true);
});
