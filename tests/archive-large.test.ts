import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-large-archive-"),
);
const { run, id, all, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { exportArchiveStream, importArchive } = await import("../lib/archive");

test("large archives stream through disk in both directions", async () => {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "big",
    "big@example.test",
  );
  const owner = {
    id: uid,
    name: "big",
    email: "big@example.test",
    groups: [],
    isAdmin: true,
    disabled: 0,
    created_at: "",
  } as Identity;
  const wid = createWorkspace(owner.id, "Groß");
  command(owner, {
    action: "admin.settings",
    settings: {
      name: "",
      announcement: "",
      defaultQuotaMb: null,
      retentionDays: null,
      maxUploadMb: 20,
      allowWorkspaceCreation: true,
    },
  });
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Video",
    }) as { id: string }
  ).id;
  // 12 MB: above the former 10 MB per-file limit.
  const big = Buffer.alloc(12 * 1024 * 1024, 7);
  const dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  const fid = id();
  writeFileSync(join(dir, fid), big);
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page,
    "film.mp4",
    "video/mp4",
    big.length,
    owner.id,
  );
  const archive = join(process.env.FLOWPLAN_DATA_DIR!, "export.zip");
  await pipeline(exportArchiveStream(owner, wid), createWriteStream(archive));
  const target = createWorkspace(owner.id, "Ziel");
  const result = (await importArchive(owner, target, archive)) as {
    files: number;
    pageIds: Record<string, string>;
  };
  assert.equal(result.files, 1);
  const copy = one<{ id: string; size: number }>(
    "SELECT id,size FROM files WHERE page_id=?",
    result.pageIds[page],
  )!;
  assert.equal(copy.size, big.length);
  assert.ok(readFileSync(join(dir, copy.id)).equals(big));
  // The spool folder is cleaned up.
  const tmp = join(process.env.FLOWPLAN_DATA_DIR!, "tmp");
  assert.ok(!existsSync(tmp) || readdirSync(tmp).length === 0);
  // Tampered archives are still rejected.
  const bytes = readFileSync(archive);
  const broken = join(process.env.FLOWPLAN_DATA_DIR!, "broken.zip");
  writeFileSync(broken, bytes.subarray(0, bytes.length - 100));
  await assert.rejects(importArchive(owner, target, broken), /ZIP|Archiv/);
  assert.equal(
    all("SELECT id FROM pages WHERE workspace_id=? AND title='Video'", target)
      .length,
    1,
  );
});
