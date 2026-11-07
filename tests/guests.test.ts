import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-guests-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { acceptInvites } = await import("../lib/auth");
const { requirePage } = await import("../lib/permissions");
const { searchWorkspace } = await import("../lib/search-index");

async function account(name: string) {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = await account("guest-owner"),
  guest = await account("guest-user"),
  member = await account("guest-member");
const wid = await createWorkspace(owner.id, "Kundenprojekt");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>, as = owner) =>
  (await command(as, input)) as { id: string };
const page = async (title: string, parentId?: string) =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title,
    parentId,
  })).id;

test("guests only reach pages shared with them, capped by their role", async () => {
  const internal = await page("Interne Kalkulation"),
    shared = await page("Abstimmung mit Kunde"),
    child = await page("Protokoll", shared);
  await run(
    "UPDATE documents SET html='<p>Freigabetermin im Oktober</p>' WHERE page_id=?",
    shared,
  );
  await run(
    "UPDATE documents SET html='<p>Marge 40 Prozent</p>' WHERE page_id=?",
    internal,
  );
  await act({
    action: "member.guest",
    workspaceId: wid,
    userId: guest.id,
    guest: true,
  });
  // Without a grant, a guest sees nothing of the team space.
  await assert.rejects(async () => await requirePage(guest, shared), /Berechtigung/);
  await act({
    action: "grant.set",
    resourceId: shared,
    userId: guest.id,
    role: "editor",
  });
  assert.equal((await requirePage(guest, shared, true)).id, shared);
  assert.equal((await requirePage(guest, child)).id, child);
  await assert.rejects(async () => await requirePage(guest, internal), /Berechtigung/);
  const boot = await bootstrap(guest, wid);
  assert.equal(boot.workspace.guest, 1);
  assert.deepEqual(boot.pages.map((p) => p.title).sort(), [
    "Abstimmung mit Kunde",
    "Protokoll",
  ]);
  assert.deepEqual(
    boot.spaces.map((s) => s.id),
    [space],
  );
  assert.deepEqual(
    boot.members.map((m) => m.id),
    [guest.id],
  );
  // Members still see the whole member list including the guest flag.
  assert.equal(
    (await bootstrap(member, wid)).members.find((m) => m.id === guest.id)?.guest,
    1,
  );
  // Search follows the same boundary.
  const hits = async (q: string) =>
    (await searchWorkspace(guest, wid, q)).map((r) => r.title);
  assert.deepEqual(await hits("Freigabetermin"), ["Abstimmung mit Kunde"]);
  assert.deepEqual(await hits("Marge"), []);
  // Workspace-wide actions need full membership.
  await assert.rejects(
    async () =>
      await act(
        { action: "page.create", workspaceId: wid, spaceId: space, title: "x" },
        guest,
      ),
    /Gäste|Berechtigung/,
  );
  await assert.rejects(
    async () =>
      await act({ action: "space.create", workspaceId: wid, name: "Eigener" }, guest),
    /Gäste|Berechtigung/,
  );
  await assert.rejects(
    async () =>
      await act(
        {
          action: "member.invite",
          workspaceId: wid,
          email: "x@example.test",
          role: "viewer",
        },
        guest,
      ),
    /Gäste|Berechtigung/,
  );
  // Editing the shared page works; the stored role caps grants.
  await act(
    { action: "page.update", pageId: shared, patch: { title: "Abstimmung" } },
    guest,
  );
  assert.equal((await pageData(guest, shared)).page.title, "Abstimmung");
  await act({
    action: "member.role",
    workspaceId: wid,
    userId: guest.id,
    role: "viewer",
  });
  await assert.rejects(async () => await requirePage(guest, shared, true), /Berechtigung/);
  // Guests cannot become owners, owners cannot become guests.
  await assert.rejects(
    async () =>
      await act({
        action: "member.role",
        workspaceId: wid,
        userId: guest.id,
        role: "owner",
      }),
    /Gäste zuerst/,
  );
  await assert.rejects(
    async () =>
      await act({
        action: "member.guest",
        workspaceId: wid,
        userId: owner.id,
        guest: true,
      }),
    /Eigentümer/,
  );
  // Turning a guest into a member opens the team space.
  await act({
    action: "member.guest",
    workspaceId: wid,
    userId: guest.id,
    guest: false,
  });
  assert.equal((await requirePage(guest, internal)).id, internal);
});

test("guest invitations add guests without downgrading existing members", async () => {
  const invited = await account("invited-guest");
  await act({
    action: "member.invite",
    workspaceId: wid,
    email: invited.email,
    role: "editor",
    guest: true,
  });
  await act({
    action: "member.invite",
    workspaceId: wid,
    email: member.email,
    role: "viewer",
    guest: true,
  });
  await acceptInvites(invited as never, true);
  await acceptInvites(member as never, true);
  const guestRow = async (uid: string) =>
    await one(
      "SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?",
      wid,
      uid,
    );
  assert.ok(await guestRow(invited.id));
  assert.equal(await guestRow(member.id), undefined);
  // Removing a guest also clears the guest mark.
  await act({
    action: "member.role",
    workspaceId: wid,
    userId: invited.id,
    role: "remove",
  });
  assert.equal(await guestRow(invited.id), undefined);
});
