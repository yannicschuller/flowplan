// The rows of a pg_dump restore inside a COPY (lib/pg-backup.ts copyLine):
// what psql gets for each line of pg_restore's output. No PostgreSQL needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-pg-copy-"));
const { copyLine, ForeignObjectsError } = await import("../lib/pg-backup");

const all = { keep: null, fields: 3, skip: false };
const filtered = { keep: [1, 2], fields: 3, skip: false };
const skipped = { keep: [], fields: 3, skip: true };

test("rows go on as they are, or with only the known columns; the end marker ends the COPY", () => {
  assert.deepEqual(copyLine(all, "1\tada\t\\N"), { end: false, send: "1\tada\t\\N" });
  assert.deepEqual(copyLine(filtered, "x\t1\tada"), { end: false, send: "1\tada" });
  assert.deepEqual(copyLine(all, "\\."), { end: true, send: "\\." });
  assert.deepEqual(copyLine(filtered, "\\."), { end: true, send: "\\." });
  assert.deepEqual(copyLine(skipped, "a\tb\tc"), { end: false, send: null });
  assert.deepEqual(copyLine(skipped, "\\."), { end: true, send: null });
  // pg_dump escapes a backslash in a value: "\\." is a row, not the end.
  assert.deepEqual(copyLine(all, "\\\\.\tb\tc"), { end: false, send: "\\\\.\tb\tc" });
  assert.throws(() => copyLine(filtered, "only\ttwo"), ForeignObjectsError);
});

test("a filtered row that would read as the end marker for psql is refused", () => {
  // The unknown first column dropped, "\." would end psql's COPY – the
  // lines after it would run as SQL.
  assert.throws(() => copyLine(filtered, "x\t\\.\t"), ForeignObjectsError);
  assert.throws(() => copyLine({ keep: [1], fields: 2, skip: false }, "x\t\\."), ForeignObjectsError);
  assert.throws(() => copyLine(filtered, "x\t\\.DROP\tTABLE"), ForeignObjectsError);
  // Unfiltered, a line that starts with "\." but is not the marker is no row pg_dump writes.
  assert.throws(() => copyLine(all, "\\.\tb\tc"), ForeignObjectsError);
  assert.throws(() => copyLine(all, "\\.x"), ForeignObjectsError);
});
