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
import { DatabaseSync } from "node:sqlite";
import type { Identity } from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "flowplan-instance-backup-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const {
  instanceBackupStream,
  stageInstanceRestore,
  pendingRestore,
  cancelRestore,
} = await import("../lib/instance-backup");
const { applyPendingRestore } = await import("../lib/instance-restore-apply");

test("instance backups restore database and uploads on the next start", async () => {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "backup",
    "backup@example.test",
  );
  const owner = {
    id: uid,
    name: "backup",
    email: "backup@example.test",
    groups: [],
    isAdmin: true,
    disabled: 0,
    created_at: "",
  } as Identity;
  const wid = createWorkspace(owner.id, "Gesichert");
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Vor der Sicherung",
    }) as { id: string }
  ).id;
  mkdirSync(join(dir, "uploads"), { recursive: true });
  const fid = id();
  writeFileSync(join(dir, "uploads", fid), "Anhang");
  const backup = join(tmpdir(), `backup-${id()}.zip`);
  await pipeline(instanceBackupStream(), createWriteStream(backup));
  // Changes after the backup are gone after the restore.
  command(owner, {
    action: "page.update",
    pageId: page,
    patch: { title: "Nach der Sicherung" },
  });
  const summary = await stageInstanceRestore(backup);
  assert.deepEqual(
    [summary.workspaces >= 1, summary.pages >= 1, summary.files],
    [true, true, 1],
  );
  assert.deepEqual(pendingRestore(), summary);
  const previous = applyPendingRestore(dir)!;
  assert.ok(existsSync(join(previous, "flowplan.sqlite")));
  const restored = new DatabaseSync(join(dir, "flowplan.sqlite"), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      {
        ...(restored
          .prepare("SELECT title FROM pages WHERE id=?")
          .get(page) as object),
      },
      { title: "Vor der Sicherung" },
    );
  } finally {
    restored.close();
  }
  assert.equal(readFileSync(join(dir, "uploads", fid), "utf8"), "Anhang");
  assert.equal(pendingRestore(), null);
  assert.equal(applyPendingRestore(dir), null);
});

test("only intact Flowplan instance backups are accepted", async () => {
  const write = async (files: Record<string, string>) => {
    const path = join(tmpdir(), `bad-${id()}.zip`);
    writeFileSync(
      path,
      await writeZip(
        new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
      ),
    );
    return path;
  };
  await assert.rejects(
    stageInstanceRestore(await write({ "flowplan.json": "{}" })),
    /unbekannte/,
  );
  await assert.rejects(
    stageInstanceRestore(
      await write({
        "manifest.json": JSON.stringify({ format: "flowplan-instance-1" }),
        "flowplan.sqlite": "kein sqlite",
      }),
    ),
    /beschädigt|keine gültige/,
  );
  await assert.rejects(
    stageInstanceRestore(
      await write({
        "manifest.json": JSON.stringify({ format: "anders" }),
        "flowplan.sqlite": "x",
      }),
    ),
    /Keine Flowplan-Instanzsicherung/,
  );
  await assert.rejects(
    stageInstanceRestore(
      await write({ "manifest.json": "{}", "uploads/ordner/x": "x" }),
    ),
    /unbekannte|Ungültige/,
  );
  assert.equal(pendingRestore(), null);
  cancelRestore();
  assert.ok(!readdirSync(dir).some((n) => n.startsWith("restore-staging")));
});
