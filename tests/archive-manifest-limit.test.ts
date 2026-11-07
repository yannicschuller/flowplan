// flowplan.json – pages, records, comments and versions without files – may
// be 64 MB in a content archive (it was 30 MB). Export, import, restore from
// a file and the room for database versions use the same limit
// (lib/archive-limits.ts), and a larger one is refused with a clear message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-archive-manifest-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { importArchive, readZip, readArchiveFile, writeZip } = await import("../lib/archive");
const { MANIFEST_LIMIT, MANIFEST_LIMIT_MB, MANIFEST_TOO_LARGE } = await import("../lib/archive-limits");
const { localizedMessage } = await import("../lib/i18n-errors");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Olga", "olga@example.test");
const owner = { id: uid, name: "Olga", email: "olga@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false } as Identity;
const wid = createWorkspace(owner.id, "Archiv");
// A manifest of the given size (valid JSON, compresses to almost nothing).
const manifest = (bytes: number) => Buffer.from(`{"pad":"${" ".repeat(bytes - 10)}"}`);

test("the limit is 64 MB, and archive.ts keeps no limit of its own", () => {
  assert.equal(MANIFEST_LIMIT_MB, 64);
  assert.equal(MANIFEST_LIMIT, 64 * 1024 * 1024);
  const source = readFileSync(join(import.meta.dirname, "../lib/archive.ts"), "utf8");
  assert.doesNotMatch(source, /const MANIFEST_LIMIT\b/);
  assert.doesNotMatch(source, /30 \* 1024 \* 1024/);
  assert.match(MANIFEST_TOO_LARGE, /64 MB/);
  assert.match(localizedMessage(MANIFEST_TOO_LARGE, "en"), /at most 64 MB/);
});

test("a flowplan.json between 30 and 64 MB is read, in memory and from a file", async () => {
  const entries = new Map([["flowplan.json", manifest(40 * 1024 * 1024)]]);
  const zip = await writeZip(entries);
  assert.equal((await readZip(zip)).get("flowplan.json")!.length, 40 * 1024 * 1024);
  const dir = mkdtempSync(join(process.env.FLOWPLAN_DATA_DIR!, "zip-"));
  writeFileSync(join(dir, "archive.zip"), zip);
  const read = await readArchiveFile(join(dir, "archive.zip"), join(dir, "spool"));
  assert.equal((read.get("flowplan.json") as Buffer).length, 40 * 1024 * 1024);
});

test("a larger flowplan.json is refused with the limit named – import and restore", async () => {
  const zip = await writeZip(new Map([["flowplan.json", manifest(MANIFEST_LIMIT + 1)]]));
  await assert.rejects(importArchive(owner, wid, zip), (e: Error & { status?: number }) => e.status === 413 && e.message === MANIFEST_TOO_LARGE);
  const dir = mkdtempSync(join(process.env.FLOWPLAN_DATA_DIR!, "zip-"));
  writeFileSync(join(dir, "archive.zip"), zip);
  // Restoring under Sicherungen reads the archive from a file.
  await assert.rejects(importArchive(owner, wid, join(dir, "archive.zip")), (e: Error & { status?: number }) => e.status === 413 && e.message === MANIFEST_TOO_LARGE);
});
