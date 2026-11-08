// Who a workflow runs as (docs/specs/workflows.md §8.10, §9.1): the person
// who activated it, loaded fresh, never with admin rights, an API scope or
// a demo; checked before every step. And what that person may observe: an
// event only starts a run when the page (and record) is visible to them.
import { one } from "../db";
import { isGuest, memberRole, pageRole } from "../permissions";
import { rowRoleResolver } from "../row-access";
import { isEncryptedPage } from "../e2ee-server";
import type { Identity, Page, User } from "../types";

// The person, as the background sees them: no session, no admin rights.
export async function runnerIdentity(userId: string | null | undefined): Promise<Identity | null> {
  if (!userId) return null;
  const user = await one<User>("SELECT * FROM users WHERE id=? AND disabled=0", userId);
  if (!user || (user as { demo_until?: number | null }).demo_until) return null;
  return { ...user, groups: [], isAdmin: false } as Identity;
}

// Below a journal with a PIN: closed to workflows even while unlocked (§9.1,
// the same rule as for the AI) – a background run has no unlocked session.
export async function behindJournalPin(page: Pick<Page, "id" | "parent_id">): Promise<boolean> {
  if (!(await one("SELECT 1 FROM journal_settings WHERE lock_hash IS NOT NULL LIMIT 1"))) return false;
  const seen = new Set<string>();
  let current: Pick<Page, "id" | "parent_id"> | undefined = page;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (await one("SELECT 1 FROM journal_settings WHERE page_id=? AND lock_hash IS NOT NULL", current.id)) return true;
    current = current.parent_id ? await one<Page>("SELECT id,parent_id FROM pages WHERE id=?", current.parent_id) : undefined;
  }
  return false;
}

// Whether the person may see the page (and record) an event is about – the
// check of the webhooks (readerMaySee in lib/webhooks.ts) plus the PIN rule.
export async function mayObserve(who: Identity | null, pageId: string | null | undefined, rowId?: string | null) {
  if (!who) return false;
  if (!pageId) return true;
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page || page.deleted_at) return false;
  const role = await pageRole(who, page);
  if (!role || (await behindJournalPin(page)) || (await isEncryptedPage(page))) return false;
  if (!rowId) return true;
  const row = await one<{ id: string; access: string; created_by: string | null }>("SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  return !!row && !!(await rowRoleResolver(who, page, role))(row);
}

// The checks before every step of a live run (§8.10): the person exists and
// is active, a full member (no guest) and editor or owner of the workflow
// page. The reason when not (shown on the page and in the message).
export async function runnerProblem(workflowPage: Page, runner: Identity | null): Promise<string | null> {
  if (!runner) return "Die ausführende Person gibt es nicht mehr oder ihr Konto ist deaktiviert.";
  if (!(await memberRole(runner, workflowPage.workspace_id)) || (await isGuest(runner, workflowPage.workspace_id)))
    return `Läuft als ${runner.name}, die kein Mitglied des Arbeitsbereichs mehr ist.`;
  const role = await pageRole(runner, workflowPage);
  if (role !== "editor" && role !== "owner") return `Läuft als ${runner.name}, die keine Bearbeitungsrechte mehr hat.`;
  return null;
}
