// Large selections (#675): pages.bulk takes up to PAGES_BULK_MAX pages in
// one transaction and stays fast (no renumbering of a whole list per page);
// above the limit, and above the limits of the other bulk actions a
// selection can reach, the refusal says so instead of "Ungültige Eingabe.".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tests-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { englishMessage, localizedMessage } = await import("../lib/i18n-errors");
const { PAGES_BULK_MAX, ROWS_BULK_MAX, FILES_BULK_MAX } = await import("../lib/bulk-limits");
import type { Identity } from "../lib/types";

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@example.test");
const owner: Identity = { id: uid, name: "owner", email: "owner@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false };
const wid = await createWorkspace(owner.id, "Large selection", true);
const space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, parentId?: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, parentId })) as { id: string }).id;
const bulk = async (operation: string, pageIds: string[], extra: Record<string, unknown> = {}) =>
  (await command(owner, { action: "pages.bulk", workspaceId: wid, operation, pageIds, ...extra })) as { count: number; created: string[] };
// Generous against a slow CI machine: before #675 moving 1000 pages took
// about 8 s and duplicating them over 30 s; now about 1–2 s each.
const GUARD_MS = 10_000;
const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  const value = await f();
  const ms = performance.now() - started;
  assert.ok(ms < GUARD_MS, `${label} took ${Math.round(ms)} ms`);
  return value;
};
const children = async (parent: string | null) =>
  await all<{ id: string; title: string; position: number }>(
    "SELECT id,title,position FROM pages WHERE space_id=? AND parent_id IS NOT DISTINCT FROM ? AND deleted_at IS NULL ORDER BY position,id",
    space,
    parent,
  );

test("the limit is the one the messages name", () => {
  assert.equal(PAGES_BULK_MAX, 1000);
  assert.equal(ROWS_BULK_MAX, 500);
  assert.equal(FILES_BULK_MAX, 500);
});

test(`moves, duplicates and trashes ${PAGES_BULK_MAX} selected pages at once`, async () => {
  const target = await create("Ziel");
  // A quarter of the selection are sub-pages of other selected pages: they
  // travel with their parent.
  const ids: string[] = [];
  for (let i = 0; i < PAGES_BULK_MAX; i++) ids.push(await create(`P${i}`, i % 4 === 3 ? ids[i - 1] : undefined));
  const roots = ids.filter((_, i) => i % 4 !== 3);

  assert.equal((await timed("move", () => bulk("move", ids, { parentId: target }))).count, roots.length);
  // In the order of the selection, numbered 0, 1, 2 …
  const moved = await children(target);
  assert.deepEqual(moved.map((p) => p.id), roots);
  assert.deepEqual(moved.map((p) => p.position), roots.map((_, i) => i));

  const duplicated = await timed("duplicate", () => bulk("duplicate", ids));
  assert.equal(duplicated.count, roots.length);
  assert.equal(duplicated.created.length, roots.length);
  // Every copy right after its source, the list numbered without ties.
  const after = await children(target);
  assert.equal(after.length, roots.length * 2);
  assert.deepEqual(after.map((p) => p.position), after.map((_, i) => i));
  roots.forEach((source, i) => {
    assert.equal(after[2 * i].id, source);
    assert.equal(after[2 * i + 1].id, duplicated.created[i]);
  });
  // The copies have their sub-pages too.
  assert.equal((await children(duplicated.created[2])).length, 1);

  assert.equal((await timed("delete", () => bulk("delete", ids))).count, roots.length);
  const trashed = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`, ...ids);
  assert.equal(Number(trashed!.n), ids.length);
  assert.equal((await children(target)).length, roots.length);

  assert.equal((await timed("lock", async () => (await command(owner, { action: "pages.bulk", workspaceId: wid, operation: "lock", pageIds: duplicated.created }))) as { count: number }).count, roots.length);
});

test("more pages than the limit: a specific message, nothing changed", async () => {
  const kept = await create("Bleibt");
  const ids = [kept, ...Array.from({ length: PAGES_BULK_MAX }, () => randomUUID())];
  await assert.rejects(
    async () => await bulk("delete", ids),
    (e: Error & { status?: number }) => {
      assert.equal(e.message, "Höchstens 1000 Seiten auf einmal.");
      assert.equal(e.status, 400);
      return true;
    },
  );
  assert.equal(englishMessage("Höchstens 1000 Seiten auf einmal."), "At most 1000 pages at a time.");
  assert.equal(localizedMessage("Höchstens 1000 Seiten auf einmal.", "de"), "Höchstens 1000 Seiten auf einmal.");
  // The reporter's language: no longer "Entrada inválida.".
  await (await import("../lib/i18n-catalogs-server")).ensureCatalog("pt");
  assert.equal(localizedMessage("Höchstens 1000 Seiten auf einmal.", "pt"), "No máximo 1000 páginas de cada vez.");
  assert.equal((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE id=?", kept))!.deleted_at, null);
});

test("records and files: the limit of their bulk actions is named too", async () => {
  const database = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "DB", kind: "database", databaseKind: "empty" })) as { id: string }).id;
  const other = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "DB 2", kind: "database", databaseKind: "empty" })) as { id: string }).id;
  const rows = Array.from({ length: ROWS_BULK_MAX + 1 }, () => ({ id: randomUUID(), version: 1 }));
  await assert.rejects(async () => await command(owner, { action: "rows.bulk", pageId: database, operation: "delete", rows }), /^Error: Höchstens 500 Einträge auf einmal\.$/);
  await assert.rejects(
    async () => await command(owner, { action: "rows.transfer", pageId: database, rowIds: rows.map((r) => r.id), targetPageId: other, mode: "copy" }),
    /^Error: Höchstens 500 Einträge auf einmal\.$/,
  );
  await assert.rejects(
    async () => await command(owner, { action: "file.delete", workspaceId: wid, fileIds: Array.from({ length: FILES_BULK_MAX + 1 }, () => randomUUID()) }),
    /^Error: Höchstens 500 Dateien auf einmal\.$/,
  );
  assert.equal(englishMessage("Höchstens 500 Einträge auf einmal."), "At most 500 records at a time.");
  assert.equal(englishMessage("Höchstens 500 Dateien auf einmal."), "At most 500 files at a time.");
});
