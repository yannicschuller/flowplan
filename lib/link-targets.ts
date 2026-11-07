// The icons of pages and records that links point to (#96): a link in a
// document shows the target's own icon – emoji, uploaded picture or symbol –
// or the default of its kind. Pages in the sidebar tree are known to the
// client already; records and pages it does not know are asked for here
// (GET /api/link-targets?ids=<page>,<page>:<record>,…).
//
// Only what the person may read: the page (its space, role, not in the
// trash), and for records the record's own permissions. Anything else is
// left out of the answer – no icon, no kind, not even whether it exists.
// No titles: the link keeps its own text.
import { all, one } from "./db";
import { pageRole } from "./permissions";
import { rowRoleResolver } from "./row-access";
import { journalLocked } from "./journal-extras";
import type { Identity, Page } from "./types";

export const LINK_TARGETS_LIMIT = 100;
export type LinkTargetInfo = { icon: string; kind: string };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "<page>" or "<page>:<record>"; null for anything else.
export function parseTargetKey(key: string): { pageId: string; rowId?: string } | null {
  const [pageId, rowId, more] = key.split(":");
  if (more !== undefined || !ID.test(pageId || "") || (rowId !== undefined && !ID.test(rowId))) return null;
  return rowId ? { pageId, rowId } : { pageId };
}

export function linkTargets(user: Identity, keys: readonly string[]): Record<string, LinkTargetInfo> {
  const out: Record<string, LinkTargetInfo> = {};
  const pages = new Map<string, Page | null>();
  const resolvers = new Map<string, ReturnType<typeof rowRoleResolver>>();
  const readable = (pageId: string) => {
    if (!pages.has(pageId)) {
      const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId) || null;
      pages.set(pageId, page && !page.deleted_at && !page.synced && pageRole(user, page) && !journalLocked(user, page) ? page : null);
    }
    return pages.get(pageId) || null;
  };
  for (const key of [...new Set(keys)].slice(0, LINK_TARGETS_LIMIT)) {
    const target = parseTargetKey(key);
    if (!target) continue;
    const page = readable(target.pageId);
    if (!page) continue;
    if (!target.rowId) {
      out[key] = { icon: page.icon || "", kind: page.kind };
      continue;
    }
    if (page.kind !== "database") continue;
    const row = all<{ id: string; access: string; created_by: string; icon: string | null }>(
      "SELECT id,access,created_by,icon FROM rows WHERE id=? AND page_id=?",
      target.rowId,
      page.id,
    )[0];
    if (!row) continue;
    if (!resolvers.has(page.id)) resolvers.set(page.id, rowRoleResolver(user, page));
    if (!resolvers.get(page.id)!(row)) continue;
    out[key] = { icon: row.icon || "", kind: "record" };
  }
  return out;
}
