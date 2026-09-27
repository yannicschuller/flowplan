// Who looked at a page and when, what changed since one's own last visit,
// and following pages: followers get one notification per page until they
// look again (and, with e-mail on, it lands in the e-mail summary).
import { all, id, one, run } from "./db";
import { pageRole } from "./permissions";
import { compareParagraphs, type TextChange } from "./text-diff";
import { htmlParagraphs } from "./version-history";
import type { Identity, Page } from "./types";

const BASELINE_LIMIT = 300_000;
const now = () => Date.now();

export type SinceVisit = {
  seenAt: number;
  editors: string[];
  changes: TextChange[] | null;
  rows: number;
};

// Called when a person opens a page: what changed since their last visit
// (by others), then the visit is recorded with the current text.
export function visitPage(user: Identity, page: Page, html: string | null): SinceVisit | null {
  if (user.apiScope) return null;
  const visit = one<{ seen_at: number; html: string | null }>(
    "SELECT seen_at,html FROM page_visits WHERE user_id=? AND page_id=?",
    user.id,
    page.id,
  );
  let since: SinceVisit | null = null;
  if (visit) {
    const editors = all<{ name: string }>(
      `SELECT u.name FROM page_edits e JOIN users u ON u.id=e.user_id
       WHERE e.page_id=? AND e.user_id!=? AND e.at>? ORDER BY e.at DESC LIMIT 10`,
      page.id,
      user.id,
      visit.seen_at,
    ).map((e) => e.name);
    if (editors.length) {
      let changes: TextChange[] | null = null;
      if (html !== null && visit.html !== null && visit.html !== html) {
        changes = compareParagraphs(htmlParagraphs(visit.html), htmlParagraphs(html));
        // Only the changed paragraphs and a little context around them.
        if (changes) changes = trimContext(changes);
      }
      const rows =
        page.kind === "database"
          ? Number(
              one<{ n: number }>(
                "SELECT COUNT(*) n FROM rows WHERE page_id=? AND updated_by!=? AND updated_at>?",
                page.id,
                user.id,
                new Date(visit.seen_at).toISOString().replace("T", " ").slice(0, 19),
              )?.n || 0,
            )
          : 0;
      since = { seenAt: visit.seen_at, editors, changes, rows };
    }
  }
  const baseline = html !== null && html.length <= BASELINE_LIMIT ? html : null;
  run(
    `INSERT INTO page_visits(user_id,page_id,seen_at,html) VALUES(?,?,?,?)
     ON CONFLICT(user_id,page_id) DO UPDATE SET seen_at=excluded.seen_at,html=excluded.html`,
    user.id,
    page.id,
    now(),
    baseline,
  );
  // Looking at the page answers its change notification.
  run(
    "UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND page_id=? AND kind='change' AND read_at IS NULL",
    user.id,
    page.id,
  );
  return since;
}
function trimContext(changes: TextChange[]) {
  const keep = new Set<number>();
  changes.forEach((change, i) => {
    if (change.type === "same") return;
    for (let j = i - 1; j <= i + 1; j++) keep.add(j);
  });
  const out: TextChange[] = [];
  let skipped = false;
  changes.forEach((change, i) => {
    if (keep.has(i)) {
      if (skipped) out.push({ type: "same", text: "…" });
      skipped = false;
      out.push(change);
    } else skipped = true;
  });
  return out.slice(0, 200);
}

// People who opened the page, newest first; whether they saw the latest state.
export function pageReaders(user: Identity, page: Page) {
  const lastEdit = Number(
    one<{ at: number }>("SELECT MAX(at) at FROM page_edits WHERE page_id=?", page.id)?.at || 0,
  );
  return all<Identity & { seen_at: number }>(
    `SELECT u.*,v.seen_at FROM page_visits v JOIN users u ON u.id=v.user_id
     WHERE v.page_id=? AND u.disabled=0 ORDER BY v.seen_at DESC LIMIT 50`,
    page.id,
  )
    .filter((reader) => pageRole({ ...reader, groups: groupsOf(reader.id), isAdmin: false }, page))
    .map((reader) => ({
      id: reader.id,
      name: reader.name,
      avatar: reader.avatar || null,
      seenAt: reader.seen_at,
      current: reader.seen_at >= lastEdit,
      self: reader.id === user.id,
    }));
}
function groupsOf(userId: string) {
  return all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", userId).map(
    (g) => g.group_id,
  );
}

// Content changes: remembered per editor, followers are told.
export function recordPageEdit(user: Identity, pageId: string) {
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
  if (!page) return;
  const at = now();
  const recent = one<{ at: number }>(
    "SELECT at FROM page_edits WHERE page_id=? AND user_id=?",
    page.id,
    user.id,
  );
  // Typing sends many small changes; followers were told at the first one.
  if (recent && recent.at > at - 60_000) {
    run("UPDATE page_edits SET at=? WHERE page_id=? AND user_id=?", at, page.id, user.id);
    run("UPDATE page_visits SET seen_at=? WHERE user_id=? AND page_id=?", at, user.id, page.id);
    return;
  }
  run(
    `INSERT INTO page_edits(page_id,user_id,at) VALUES(?,?,?)
     ON CONFLICT(page_id,user_id) DO UPDATE SET at=excluded.at`,
    page.id,
    user.id,
    at,
  );
  // The editor has seen their own change.
  run("UPDATE page_visits SET seen_at=? WHERE user_id=? AND page_id=?", at, user.id, page.id);
  const followers = all<Identity>(
    `SELECT u.* FROM page_follows f JOIN users u ON u.id=f.user_id
     WHERE f.page_id=? AND f.user_id!=? AND u.disabled=0
     AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.user_id=f.user_id AND n.page_id=f.page_id AND n.kind='change' AND n.read_at IS NULL)
     AND NOT EXISTS(SELECT 1 FROM notification_prefs p WHERE p.user_id=f.user_id AND p.kind='change' AND p.inbox=0)`,
    page.id,
    user.id,
  );
  for (const follower of followers) {
    if (!pageRole({ ...follower, groups: groupsOf(follower.id), isAdmin: false }, page)) continue;
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'change')",
      id(),
      follower.id,
      `${user.name} hat „${page.title || "Ohne Titel"}“ geändert`,
      page.id,
    );
  }
}

export function isFollowing(user: Identity, pageId: string) {
  return !!one("SELECT 1 FROM page_follows WHERE user_id=? AND page_id=?", user.id, pageId);
}
export function setFollowing(user: Identity, pageId: string, follow: boolean) {
  if (follow)
    run(
      "INSERT OR IGNORE INTO page_follows(user_id,page_id,created_at) VALUES(?,?,?)",
      user.id,
      pageId,
      now(),
    );
  else run("DELETE FROM page_follows WHERE user_id=? AND page_id=?", user.id, pageId);
}
export function followerCount(pageId: string) {
  return Number(one<{ n: number }>("SELECT COUNT(*) n FROM page_follows WHERE page_id=?", pageId)?.n || 0);
}
// Pages the person opened lately, for the start page.
export function recentVisits(user: Identity, workspaceId: string, limit = 8) {
  return all<{ page_id: string; seen_at: number }>(
    `SELECT v.page_id,v.seen_at FROM page_visits v JOIN pages p ON p.id=v.page_id
     WHERE v.user_id=? AND p.workspace_id=? AND p.deleted_at IS NULL ORDER BY v.seen_at DESC LIMIT ?`,
    user.id,
    workspaceId,
    limit,
  ).map((v) => ({ pageId: v.page_id, seenAt: v.seen_at }));
}

// Page data as a person opens it: plus what changed since their last visit,
// who read it and whether they follow it.
export function withActivity<T extends { page: Page; html?: string; locked?: unknown }>(
  user: Identity,
  data: T,
) {
  if (data.locked) return data;
  const page = data.page;
  return {
    ...data,
    sinceVisit: visitPage(user, page, page.kind === "document" ? data.html || "" : null),
    readers: pageReaders(user, page),
    following: isFollowing(user, page.id),
    followers: followerCount(page.id),
  };
}
