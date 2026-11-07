// #161: backups into a folder on another file system (an SMB/NFS share or
// another volume) – rename() fails with EXDEV there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveFile } from "../lib/move-file";

const crossDevice = () => {
  throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
};

test("moves within a file system with rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "move-file-"));
  writeFileSync(join(dir, "a"), "eins");
  moveFile(join(dir, "a"), join(dir, "b"));
  assert.equal(readFileSync(join(dir, "b"), "utf8"), "eins");
  assert.ok(!existsSync(join(dir, "a")));
});

test("onto another file system it copies, renames next to the target and removes the source", () => {
  const from = mkdtempSync(join(tmpdir(), "move-file-from-"));
  const to = mkdtempSync(join(tmpdir(), "move-file-to-"));
  writeFileSync(join(from, "backup.sqlite"), "daten");
  moveFile(join(from, "backup.sqlite"), join(to, "flowplan-2026-11-06-23-59.sqlite"), crossDevice);
  assert.equal(readFileSync(join(to, "flowplan-2026-11-06-23-59.sqlite"), "utf8"), "daten");
  assert.ok(!existsSync(join(from, "backup.sqlite")));
  assert.deepEqual(readdirSync(to), ["flowplan-2026-11-06-23-59.sqlite"], "no .part file left");
});

test("other errors still fail, and a failed copy leaves no partial file", () => {
  const dir = mkdtempSync(join(tmpdir(), "move-file-"));
  assert.throws(() => moveFile(join(dir, "missing"), join(dir, "b")), /ENOENT/);
  assert.throws(() => moveFile(join(dir, "missing"), join(dir, "b"), crossDevice), /ENOENT/);
  assert.deepEqual(readdirSync(dir), []);
  void renameSync;
});
