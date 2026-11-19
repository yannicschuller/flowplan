// "Startinhalt für neue Konten" (#381, Administration → Instanz): an
// administrator picks one space, and every account that gets its personal
// workspace from now on (first sign-in with e-mail and password, SSO, LDAP
// or SCIM; lib/seed.ts ensureWorkspace) finds a copy of its pages there –
// sub-pages, databases with records, fields and views, whiteboards,
// dashboards, notebooks, workflows and their files, through the same copy
// as "Seite duplizieren" (lib/page-tree.ts duplicatePages). Comments,
// version history, shares and public links, permissions and presence stay
// behind: duplicatePages copies none of them. The pages are read as the
// administrator who chose the space, so nobody gets what that person
// could not read; the copy belongs to the new account.
//
// Existing accounts keep their workspaces, and demo accounts their own
// examples (lib/demo.ts). If the space is gone or the copy fails, the
// account still gets its workspace, with the built-in pages, and the
// server log says why.
import { HttpError } from "./auth";
import { all, inSavepoint, one, run, transaction } from "./db";
import { encryptedSpace } from "./e2ee-server";
import { forEachAsync } from "./each-async";
import { instanceSettings, type InstanceSettings } from "./instance-settings";
import { duplicatePages } from "./page-tree";
import { spaceRole } from "./permissions";
import { createWorkspace, seedExamples, seedWelcome } from "./seed";
import type { Identity, Page, Space, User } from "./types";

// An account as the copy acts for it: its own page and space grants count
// (group_members), never the administration.
async function actingAs(userId: string | null | undefined): Promise<Identity | null> {
  if (!userId) return null;
  const user = await one<User>("SELECT * FROM users WHERE id=? AND disabled=0 AND demo_until IS NULL", userId);
  return user ? { ...user, groups: [], isAdmin: false } : null;
}

// Why a space cannot be starter content for `reader`, or null when it can.
async function unusable(reader: Identity, space: Space | undefined): Promise<string | null> {
  if (!space || space.deleted_at) return "space gone";
  if (await encryptedSpace(space.id)) return "space end-to-end encrypted";
  if (!(await spaceRole(reader, space))) return "space not readable by the administrator who chose it";
  return null;
}

// Spaces an administrator may choose: readable to them, not in the trash,
// not end-to-end encrypted (the server cannot read those pages).
export async function starterSpaceChoices(admin: Identity) {
  const spaces = await all<Space & { workspace_name: string; encrypted?: number }>(
    "SELECT s.*,w.name workspace_name FROM spaces s JOIN workspaces w ON w.id=s.workspace_id JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=? WHERE s.deleted_at IS NULL ORDER BY lower(w.name),lower(s.name)",
    admin.id,
  );
  const out: { id: string; name: string; workspace: string }[] = [];
  for (const s of spaces) if (!s.encrypted && (await spaceRole(admin, s))) out.push({ id: s.id, name: s.name, workspace: s.workspace_name });
  return out;
}

// The chosen space as Administration → Instanz shows it: null when none is
// chosen; `problem` when new accounts would get the built-in pages instead.
export async function starterSpaceStatus(settings?: InstanceSettings) {
  const { starterSpace, starterBy } = settings ?? (await instanceSettings());
  if (!starterSpace) return null;
  const space = await one<Space & { workspace_name: string }>(
    "SELECT s.*,w.name workspace_name FROM spaces s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?",
    starterSpace,
  );
  const reader = await actingAs(starterBy);
  const problem = !reader ? "admin gone" : await unusable(reader, space);
  return {
    id: starterSpace,
    name: space?.name ?? null,
    workspace: space?.workspace_name ?? null,
    pages: space ? Number((await one<{ n: number }>("SELECT count(*) n FROM pages WHERE space_id=? AND deleted_at IS NULL", space.id))?.n ?? 0) : 0,
    problem: problem as null | "admin gone" | "space gone" | "space end-to-end encrypted" | "space not readable by the administrator who chose it",
  };
}

// What admin.settings may store: the chooser of a space is the
// administrator who saves it (never taken from the request), and only a
// space they may read.
export async function starterSettingsInput(admin: Identity, input: unknown) {
  if (!input || typeof input !== "object") return input;
  const next: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete next.starterBy;
  if (!("starterSpace" in next)) return next;
  const chosen = next.starterSpace;
  if (chosen === null || chosen === "") {
    next.starterSpace = null;
    next.starterBy = null;
    return next;
  }
  if (typeof chosen !== "string") throw new HttpError(400, "Ungültige Eingabe.");
  const space = await one<Space>("SELECT * FROM spaces WHERE id=?", chosen);
  const problem = await unusable(admin, space);
  if (problem === "space end-to-end encrypted")
    throw new HttpError(409, "Ein Ende-zu-Ende-verschlüsselter Bereich kann kein Startinhalt sein.");
  if (problem) throw new HttpError(404, "Bereich nicht gefunden.");
  next.starterBy = admin.id;
  return next;
}

// Copies the chosen space's pages into `spaceId` for `owner`. False (and a
// line in the server log) when there is nothing to copy or it fails; the
// copy then leaves nothing behind.
export async function copyStarterContent(settings: InstanceSettings, owner: Identity, workspaceId: string, spaceId: string) {
  const source = settings.starterSpace;
  if (!source) return false;
  try {
    const reader = await actingAs(settings.starterBy);
    if (!reader) throw new Error("the administrator who chose the space is gone");
    const space = await one<Space>("SELECT * FROM spaces WHERE id=?", source);
    const problem = await unusable(reader, space);
    if (problem) throw new Error(problem);
    const pages = await all<Page>(
      "SELECT * FROM pages WHERE space_id=? AND workspace_id=? AND deleted_at IS NULL ORDER BY position,id",
      space!.id,
      space!.workspace_id,
    );
    // A savepoint: a failed copy is undone, the workspace stays.
    await inSavepoint(() => duplicatePages(reader, pages, workspaceId, spaceId, undefined, owner));
    return true;
  } catch (error) {
    console.error(`Starter content (space ${source}) not copied for account ${owner.id}, using the built-in pages:`, (error as Error).message);
    return false;
  }
}

// A new personal workspace with the starter content, or with the built-in
// welcome page and examples when none is chosen or it cannot be copied.
export async function createPersonalWorkspace(userId: string, name: string) {
  const settings = await instanceSettings();
  const owner = await one<User>("SELECT * FROM users WHERE id=?", userId);
  if (!settings.starterSpace || !owner) return await createWorkspace(userId, name, true);
  const identity: Identity = { ...owner, groups: [], isAdmin: false };
  return await transaction(async () => {
    const wid = await createWorkspace(userId, name, false, false);
    const sid = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
    if (!(await copyStarterContent(settings, identity, wid, sid))) {
      await seedWelcome(wid, sid, userId);
      await seedExamples(wid, sid, userId);
      return wid;
    }
    if (settings.starterKeepWelcome) {
      // The welcome page first, then the starter pages in their order.
      const home = await seedWelcome(wid, sid, userId);
      const roots = (await all<{ id: string }>(
        "SELECT id FROM pages WHERE space_id=? AND parent_id IS NULL AND id!=? ORDER BY position,id",
        sid,
        home,
      )).map((p) => p.id);
      await forEachAsync([home, ...roots], async (page, i) => await run("UPDATE pages SET position=? WHERE id=?", i, page));
    }
    return wid;
  }, identity);
}
