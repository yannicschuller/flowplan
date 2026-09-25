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

function account(name: string) {
  const uid = id();
  run(
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
const owner = account("guest-owner"),
  guest = account("guest-user"),
  member = account("guest-member");
const wid = createWorkspace(owner.id, "Kundenprojekt");
run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const space = bootstrap(owner, wid).spaces[0].id;
const act = (input: Record<string, unknown>, as = owner) =>
  command(as, input) as { id: string };
const page = (title: string, parentId?: string) =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title,
    parentId,
  }).id;

test("guests only reach pages shared with them, capped by their role", () => {
  const internal = page("Interne Kalkulation"),
    shared = page("Abstimmung mit Kunde"),
    child = page("Protokoll", shared);
  run(
    "UPDATE documents SET html='<p>Freigabetermin im Oktober</p>' WHERE page_id=?",
    shared,
  );
  run(
    "UPDATE documents SET html='<p>Marge 40 Prozent</p>' WHERE page_id=?",
    internal,
  );
  act({
    action: "member.guest",
    workspaceId: wid,
    userId: guest.id,
    guest: true,
  });
  // Without a grant, a guest sees nothing of the team space.
  assert.throws(() => requirePage(guest, shared), /Berechtigung/);
  act({
    action: "grant.set",
    resourceId: shared,
    userId: guest.id,
    role: "editor",
  });
  assert.equal(requirePage(guest, shared, true).id, shared);
  assert.equal(requirePage(guest, child).id, child);
  assert.throws(() => requirePage(guest, internal), /Berechtigung/);
  const boot = bootstrap(guest, wid);
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
    bootstrap(member, wid).members.find((m) => m.id === guest.id)?.guest,
    1,
  );
  // Search follows the same boundary.
  const hits = (q: string) =>
    searchWorkspace(guest, wid, q).map((r) => r.title);
  assert.deepEqual(hits("Freigabetermin"), ["Abstimmung mit Kunde"]);
  assert.deepEqual(hits("Marge"), []);
  // Workspace-wide actions need full membership.
  assert.throws(
    () =>
      act(
        { action: "page.create", workspaceId: wid, spaceId: space, title: "x" },
        guest,
      ),
    /Gäste|Berechtigung/,
  );
  assert.throws(
    () =>
      act({ action: "space.create", workspaceId: wid, name: "Eigener" }, guest),
    /Gäste|Berechtigung/,
  );
  assert.throws(
    () =>
      act(
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
  act(
    { action: "page.update", pageId: shared, patch: { title: "Abstimmung" } },
    guest,
  );
  assert.equal(pageData(guest, shared).page.title, "Abstimmung");
  act({
    action: "member.role",
    workspaceId: wid,
    userId: guest.id,
    role: "viewer",
  });
  assert.throws(() => requirePage(guest, shared, true), /Berechtigung/);
  // Guests cannot become owners, owners cannot become guests.
  assert.throws(
    () =>
      act({
        action: "member.role",
        workspaceId: wid,
        userId: guest.id,
        role: "owner",
      }),
    /Gäste zuerst/,
  );
  assert.throws(
    () =>
      act({
        action: "member.guest",
        workspaceId: wid,
        userId: owner.id,
        guest: true,
      }),
    /Eigentümer/,
  );
  // Turning a guest into a member opens the team space.
  act({
    action: "member.guest",
    workspaceId: wid,
    userId: guest.id,
    guest: false,
  });
  assert.equal(requirePage(guest, internal).id, internal);
});

test("guest invitations add guests without downgrading existing members", () => {
  const invited = account("invited-guest");
  act({
    action: "member.invite",
    workspaceId: wid,
    email: invited.email,
    role: "editor",
    guest: true,
  });
  act({
    action: "member.invite",
    workspaceId: wid,
    email: member.email,
    role: "viewer",
    guest: true,
  });
  acceptInvites(invited as never, true);
  acceptInvites(member as never, true);
  const guestRow = (uid: string) =>
    one(
      "SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?",
      wid,
      uid,
    );
  assert.ok(guestRow(invited.id));
  assert.equal(guestRow(member.id), undefined);
  // Removing a guest also clears the guest mark.
  act({
    action: "member.role",
    workspaceId: wid,
    userId: invited.id,
    role: "remove",
  });
  assert.equal(guestRow(invited.id), undefined);
});
