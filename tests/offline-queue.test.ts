import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Row } from "../lib/types";
import {
  applyQueue,
  mergeChange,
  retryLater,
  withoutConflict,
  type Conflict,
  type QueuedChange,
} from "../lib/offline-queue";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-offline-queue-"),
);
const row = (id: string, cells: Record<string, unknown>, version = 1): Row => ({
  id,
  page_id: "p",
  cells,
  position: 0,
  created_at: "",
  updated_at: "",
  created_by: "",
  updated_by: "",
  version,
});
const update = (
  cells: Record<string, unknown>,
  base: Record<string, unknown>,
): Extract<QueuedChange, { kind: "update" }> => ({
  id: "c",
  kind: "update",
  pageId: "p",
  rowId: "r",
  version: 1,
  cells,
  base,
  at: 0,
});

test("waiting changes show in the rows of their database", () => {
  const rows = [row("a", { title: "A" }), row("b", { title: "B" })];
  const queue: QueuedChange[] = [
    {
      id: "1",
      kind: "update",
      pageId: "p",
      rowId: "a",
      version: 1,
      cells: { title: "A2" },
      base: { title: "A" },
      at: 1,
    },
    { id: "2", kind: "delete", pageId: "p", rowId: "b", at: 2 },
    {
      id: "3",
      kind: "create",
      pageId: "p",
      rowId: "c",
      cells: { title: "C" },
      at: 3,
    },
    { id: "4", kind: "create", pageId: "other", rowId: "d", cells: {}, at: 4 },
  ];
  assert.deepEqual(
    applyQueue(rows, queue, "p").map((r) => [r.id, r.cells.title]),
    [
      ["a", "A2"],
      ["c", "C"],
    ],
  );
});

test("a server that is briefly unreachable keeps the waiting changes", () => {
  // The proxy while the app restarts, a timeout, a rate limit: sent again.
  for (const status of [408, 429, 502, 503, 504]) assert.equal(retryLater(status), true, String(status));
  // A final answer: the change is discarded with a notice.
  for (const status of [400, 403, 404, 409, 413, 422, 423, 500]) assert.equal(retryLater(status), false, String(status));
});

test("resolving a conflict keeps the conflicts found meanwhile", () => {
  const conflict = (id: string): Conflict => ({ change: { ...update({ title: id }, { title: "Alt" }), id }, current: null, fields: ["title"] });
  const first = conflict("a"),
    meanwhile = conflict("b");
  // The list when the person clicked, then a flush added another one.
  const shown = [first],
    now = [...shown, meanwhile];
  assert.deepEqual(withoutConflict(now, first), [meanwhile]);
  assert.deepEqual(withoutConflict(shown, first), []);
});

test("changes merge with foreign edits of other fields and report conflicts", () => {
  // Someone else changed another field: only the own field is sent.
  assert.deepEqual(
    mergeChange(
      update({ title: "Mein" }, { title: "Alt" }),
      row("r", { title: "Alt", status: "Neu" }, 3),
    ),
    { send: { title: "Mein" }, version: 3 },
  );
  // The same value on both sides needs nothing.
  assert.deepEqual(
    mergeChange(
      update({ title: "X" }, { title: "Alt" }),
      row("r", { title: "X" }, 2),
    ),
    { skip: true },
  );
  // The same field changed differently is a conflict with the current value.
  const both = mergeChange(
    update({ title: "Mein", note: "n" }, { title: "Alt", note: "" }),
    row("r", { title: "Fremd", note: "" }, 2),
  );
  assert.ok("conflict" in both);
  assert.deepEqual(both.conflict.fields, ["title"]);
  assert.deepEqual(both.conflict.current, { title: "Fremd" });
  // A record deleted elsewhere is a conflict without current values.
  const gone = mergeChange(
    update({ title: "Mein" }, { title: "Alt" }),
    undefined,
  );
  assert.ok("conflict" in gone && gone.conflict.current === null);
});

test("records created offline keep their id and repeats are harmless", async () => {
  const { id, run, one } = await import("../lib/db");
  const { command, bootstrap } = await import("../lib/api");
  const { createWorkspace } = await import("../lib/seed");
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "o",
    "o@example.com",
  );
  const owner: Identity = {
    id: uid,
    name: "o",
    email: "o@example.com",
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
  const wid = await createWorkspace(owner.id, "Offline"),
    boot = await bootstrap(owner, wid);
  const db = async (title: string) =>
    (
      (await command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId: boot.spaces[0].id,
        title,
        kind: "database",
      })) as { id: string }
    ).id;
  const pid = await db("A"),
    other = await db("B");
  const rid = crypto.randomUUID();
  const create = async (pageId: string) =>
    await command(owner, {
      action: "row.create",
      pageId,
      rowId: rid,
      cells: { title: "Offline" },
      templateId: null,
    });
  assert.deepEqual(await create(pid), { id: rid });
  assert.deepEqual(await create(pid), { id: rid });
  assert.equal(
    Number((await one("SELECT count(*) n FROM rows WHERE id=?", rid))?.n),
    1,
  );
  await assert.rejects(
    async () => await create(other),
    (e: any) => e.status === 409,
  );
});
