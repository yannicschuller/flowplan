// Text comments in the margin (#387): where the cards go
// (lib/comment-margin-layout.ts) and the person's setting "Textkommentare:
// am Rand / unter dem Dokument" (lib/comment-margin-pref.ts,
// lib/user-comment-margin.ts), saved on the server and delivered with the
// bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { layoutMarginCards, marginExtent, type MarginItem } from "../lib/comment-margin-layout";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-comment-margin-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/comment-margin-pref")), ...(await import("../lib/comment-margin-pref-client")) };
const { commandActions } = await import("../lib/openapi");

const tops = (items: MarginItem[], options?: Parameters<typeof layoutMarginCards>[1]) =>
  Object.fromEntries(layoutMarginCards(items, options).map((p) => [p.id, p.top]));
const order = (items: MarginItem[], options?: Parameters<typeof layoutMarginCards>[1]) =>
  layoutMarginCards(items, options).map((p) => p.id);

test("cards stand at their passages while they do not overlap", () => {
  const items = [
    { id: "a", anchor: 0, height: 60 },
    { id: "b", anchor: 200, height: 60 },
    { id: "c", anchor: 500, height: 80 },
  ];
  assert.deepEqual(tops(items), { a: 0, b: 200, c: 500 });
  assert.deepEqual(layoutMarginCards([]), []);
});

test("overlapping cards stack and are pushed down in the order of their passages", () => {
  const items = [
    { id: "late", anchor: 120, height: 50 },
    { id: "first", anchor: 100, height: 60 },
    { id: "same", anchor: 100, height: 40 },
  ];
  assert.deepEqual(order(items), ["first", "same", "late"], "by passage; equal passages keep their order");
  assert.deepEqual(tops(items, { gap: 8 }), { first: 100, same: 168, late: 216 });
  // A card far below the stack keeps its own place.
  assert.deepEqual(tops([...items, { id: "far", anchor: 900, height: 20 }], { gap: 8 }).far, 900);
  // Only as far as the stack reaches.
  assert.equal(tops([...items, { id: "near", anchor: 230, height: 20 }], { gap: 8 }).near, 274);
});

test("nothing goes above the top", () => {
  assert.deepEqual(tops([{ id: "a", anchor: -40, height: 30 }, { id: "b", anchor: -10, height: 30 }], { gap: 10, top: 0 }), { a: 0, b: 40 });
});

test("the active card stands at its passage; the cards above move up out of its way", () => {
  const items = [
    { id: "a", anchor: 100, height: 60 },
    { id: "b", anchor: 120, height: 60 },
    { id: "c", anchor: 140, height: 200 },
    { id: "d", anchor: 160, height: 40 },
  ];
  // Without an active card: a stack from a.
  assert.deepEqual(tops(items, { gap: 10 }), { a: 100, b: 170, c: 240, d: 450 });
  // c open: at 140; b ends 10 above it, a 10 above b; d below c.
  assert.deepEqual(tops(items, { gap: 10, active: "c" }), { a: 0, b: 70, c: 140, d: 350 });
  // a open: as without an active card (nothing above it).
  assert.deepEqual(tops(items, { gap: 10, active: "a" }), tops(items, { gap: 10 }));
  // An unknown active card changes nothing.
  assert.deepEqual(tops(items, { gap: 10, active: "gone" }), tops(items, { gap: 10 }));
});

test("cards above the active one only move up as far as they are in the way", () => {
  const items = [
    { id: "a", anchor: 0, height: 40 },
    { id: "b", anchor: 300, height: 40 },
    { id: "c", anchor: 320, height: 100 },
  ];
  assert.deepEqual(tops(items, { gap: 8, active: "c", top: 0 }), { a: 0, b: 272, c: 320 });
});

test("without room above, the active card moves down as little as it must", () => {
  const items = [
    { id: "a", anchor: 0, height: 100 },
    { id: "b", anchor: 20, height: 100 },
    { id: "c", anchor: 40, height: 50 },
    { id: "d", anchor: 60, height: 50 },
  ];
  const placed = tops(items, { gap: 10, active: "c", top: 0 });
  assert.deepEqual(placed, { a: 0, b: 110, c: 220, d: 280 });
  // No two cards overlap, whatever is active.
  for (const active of [null, "a", "b", "c", "d"]) {
    const placements = layoutMarginCards(items, { gap: 10, active, top: 0 });
    for (let i = 1; i < placements.length; i++) {
      const above = placements[i - 1],
        height = items.find((item) => item.id === above.id)!.height;
      assert.ok(placements[i].top >= above.top + height + 10, `${active}: ${placements[i].id} below ${above.id}`);
    }
    assert.ok(placements.every((p) => p.top >= 0));
  }
});

test("the margin reaches to the lowest card", () => {
  const items = [
    { id: "a", anchor: 0, height: 60 },
    { id: "b", anchor: 10, height: 90 },
  ];
  assert.equal(marginExtent(items, layoutMarginCards(items, { gap: 8 })), 158);
  assert.equal(marginExtent([], []), 0);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("the margin is the default; only an explicit 'below' counts", () => {
  assert.equal(pref.DEFAULT_COMMENT_MARGIN, true);
  for (const value of [null, undefined, 1, "1", true, "", 2]) assert.equal(pref.commentMarginOf(value), true, String(value));
  for (const value of [0, "0", false]) assert.equal(pref.commentMarginOf(value), false, String(value));
  assert.equal(pref.commentMargin(), true);
  pref.setCommentMarginLocal(false);
  assert.equal(pref.commentMargin(), false);
  pref.setCommentMarginLocal(undefined);
  assert.equal(pref.commentMargin(), true, "a bootstrap without the field means the default");
});

test("each person saves the choice; values are validated; the command is documented", async () => {
  const anna = await account("margin-anna"),
    ben = await account("margin-ben");
  const wid = await createWorkspace(anna.id, "Rand");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).commentMargin, true, "never chosen: the default");
  assert.equal((await one<{ comment_margin: number | null }>("SELECT comment_margin FROM users WHERE id=?", anna.id))?.comment_margin, null);
  assert.deepEqual(await command(anna, { action: "profile.commentMargin", commentMargin: false }), { commentMargin: false });
  assert.equal((await bootstrap(anna, wid)).commentMargin, false);
  assert.equal((await bootstrap(ben, wid)).commentMargin, true, "only for that person");
  for (const bad of ["no", 0, 1, null, undefined, "false"])
    await rejects(() => command(anna, { action: "profile.commentMargin", commentMargin: bad }));
  assert.equal((await bootstrap(anna, wid)).commentMargin, false, "a rejected value changes nothing");
  await command(anna, { action: "profile.commentMargin", commentMargin: true });
  assert.equal((await one<{ comment_margin: number }>("SELECT comment_margin FROM users WHERE id=?", anna.id))?.comment_margin, 1);
  const doc = commandActions.find((a) => a.action === "profile.commentMargin");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.commentMargin", commentMargin: false }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.commentMargin", commentMargin: "off" }).success, false);
});
