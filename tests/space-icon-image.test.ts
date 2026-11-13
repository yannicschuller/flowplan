// An uploaded image as the symbol of a space (#251): stored inline like the
// workspace image, validated the same way, only sent to people who see the
// space, and kept by duplicates and archives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Space } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-space-icon-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const { spaceIconSchema } = await import("../lib/space-appearance");
const { MAX_WORKSPACE_IMAGE } = await import("../lib/workspace-icon");

// A 1×1 PNG.
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = (actor: Identity, input: Record<string, unknown>): Promise<any> => command(actor, input);
const space = async (sid: string) => (await one<Space>("SELECT * FROM spaces WHERE id=?", sid))!;

async function fixture() {
  const owner = await user("Owner"),
    member = await user("Member"),
    wid = await createWorkspace(owner.id, "Icons");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  const sid = (await act(owner, { action: "space.create", workspaceId: wid, name: "Secret", private: true, icon: IMAGE })).id as string;
  return { owner, member, wid, sid };
}

test("the schema takes emojis, icon names and small PNG/JPEG/WebP data URLs only", () => {
  for (const ok of ["folder", "🚀", "icon:Rocket:#2f80ed", IMAGE, "data:image/webp;base64,UklGRg==", "data:image/jpeg;base64,/9j/4A=="])
    assert.ok(spaceIconSchema.safeParse(ok).success, ok);
  for (const bad of [
    "",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGI+",
    "data:image/png;base64,<script>",
    "data:image/png",
    `data:image/png;base64,${"A".repeat(MAX_WORKSPACE_IMAGE)}`,
    "x".repeat(31),
  ])
    assert.equal(spaceIconSchema.safeParse(bad).success, false, bad.slice(0, 40));
});

test("a private space's image reaches its members, not other people of the workspace", async () => {
  const f = await fixture();
  assert.equal((await space(f.sid)).icon, IMAGE);
  const own = await bootstrap(f.owner, f.wid);
  assert.equal(own.spaces.find((s) => s.id === f.sid)?.icon, IMAGE);
  const other = await bootstrap(f.member, f.wid);
  assert.equal(other.spaces.some((s) => s.id === f.sid), false);
  assert.equal(JSON.stringify(other).includes(IMAGE.slice(30)), false);
  // Neither as space manager nor in the trash.
  await act(f.owner, { action: "space.delete", spaceId: f.sid, version: (await space(f.sid)).version, confirmName: "Secret" });
  assert.equal(JSON.stringify(await bootstrap(f.member, f.wid)).includes(IMAGE.slice(30)), false);
  assert.equal((await bootstrap(f.owner, f.wid)).trashedSpaces.find((s) => s.id === f.sid)?.icon, IMAGE);
  // Purged: the image goes with the row.
  await act(f.owner, { action: "space.purge", spaceId: f.sid, version: (await space(f.sid)).version, confirmName: "Secret" });
  assert.equal(await one("SELECT 1 FROM spaces WHERE id=?", f.sid), undefined);
});

test("space.update sets, replaces and removes the image; invalid images are refused", async () => {
  const f = await fixture();
  const update = async (actor: Identity, icon: string) =>
    await act(actor, { action: "space.update", spaceId: f.sid, name: "Secret", private: true, icon });
  await update(f.owner, "🚀");
  assert.equal((await space(f.sid)).icon, "🚀");
  const other = IMAGE.replace("Ugg", "Ugh");
  await update(f.owner, other);
  assert.equal((await space(f.sid)).icon, other);
  await assert.rejects(update(f.owner, "data:image/svg+xml;base64,PHN2Zz4="));
  await assert.rejects(update(f.owner, `data:image/png;base64,${"A".repeat(MAX_WORKSPACE_IMAGE)}`));
  // Someone without the right to manage the space cannot change it.
  await assert.rejects(update(f.member, IMAGE), (e: Error & { status?: number }) => e.status === 403 || e.status === 404);
  assert.equal((await space(f.sid)).icon, other);
  // "Entfernen": back to the default symbol.
  await update(f.owner, "folder");
  assert.equal((await space(f.sid)).icon, "folder");
});

test("duplicates and archives keep the image", async () => {
  const f = await fixture();
  const copy = (await act(f.owner, {
    action: "space.duplicate",
    spaceId: f.sid,
    version: (await space(f.sid)).version,
    name: "Copy",
    visibility: "private",
  })).id as string;
  assert.equal((await space(copy)).icon, IMAGE);
  // The workspace image as well: archives with one used to be refused.
  await act(f.owner, { action: "workspace.update", workspaceId: f.wid, icon: IMAGE });
  // Longer than the 500 characters archives allow for other texts.
  const large = `data:image/webp;base64,${"A".repeat(4000)}`;
  await act(f.owner, { action: "space.update", spaceId: f.sid, name: "Secret", private: true, icon: large });
  await act(f.owner, { action: "workspace.update", workspaceId: f.wid, icon: large });
  const destination = await createWorkspace(f.owner.id, "Destination");
  await importArchive(f.owner, destination, await exportArchive(f.owner, f.wid));
  const imported = (await all<Space>("SELECT * FROM spaces WHERE workspace_id=?", destination)).find((s) => s.name === "Secret (Import)");
  assert.equal(imported?.icon, large);
});
