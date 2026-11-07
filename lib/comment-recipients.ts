// Who hears about a new comment – a page comment, a record comment or the
// first message of a text comment. Never the whole workspace: only people
// the comment concerns.
//   - who follows the page (whoever creates a page follows it; the bell),
//   - the page's owner (lib/page-review.ts),
//   - for a record: whoever created it and the people its person
//     properties name,
//   - who already commented on the same page or record (page comments and
//     text comments) – the conversation's participants.
// Mentions are added by the caller (text comments: the mention nodes;
// page and record comments: "@Name" in the text, commentTextMentions). The
// author, disabled accounts and anyone who may not read the page or the
// record are left out.
import { all, one } from "./db";
import { isGuest, pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import type { Field, Identity, Page } from "./types";

function asRecipient(userId: string): Identity | null {
  const user = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", userId);
  if (!user) return null;
  const groups = all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", userId).map((g) => g.group_id);
  return { ...user, groups, isAdmin: false };
}

// Whether this person may read the page and, for a record, the record.
export function mayHear(userId: string, page: Page, rowId: string | null) {
  const recipient = asRecipient(userId);
  return !!recipient && !!pageRole(recipient, page) && (!rowId || !hiddenRowIds(recipient, page).has(rowId));
}

function recordPeople(page: Page, rowId: string) {
  const row = one<{ cells: string; created_by: string | null }>("SELECT cells,created_by FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  if (!row) return [];
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]") as Field[];
  const cells = JSON.parse(row.cells || "{}") as Record<string, unknown>;
  const people: string[] = row.created_by ? [row.created_by] : [];
  for (const f of fields)
    if (f.type === "person")
      for (const value of [cells[f.id]].flat()) if (typeof value === "string" && value) people.push(value);
  return people;
}

export function commentRecipients(author: Identity, page: Page, rowId: string | null, mentions: Iterable<string> = []) {
  const candidates = new Set<string>([
    ...all<{ user_id: string }>("SELECT user_id FROM page_follows WHERE page_id=?", page.id).map((f) => f.user_id),
    ...(page.owner_id ? [page.owner_id] : []),
    ...(rowId ? recordPeople(page, rowId) : []),
    ...all<{ author_id: string }>(
      "SELECT DISTINCT author_id FROM comments WHERE page_id=? AND row_id IS ? AND author_id IS NOT NULL",
      page.id,
      rowId,
    ).map((c) => c.author_id),
    ...all<{ author_id: string }>(
      "SELECT DISTINCT m.author_id FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE t.page_id=? AND t.row_id IS ? AND m.author_id IS NOT NULL",
      page.id,
      rowId,
    ).map((m) => m.author_id),
    ...mentions,
  ]);
  candidates.delete(author.id);
  return [...candidates].filter((uid) => mayHear(uid, page, rowId));
}

// People named with "@Name" in the plain text of a page or record comment:
// members of the workspace, matched by their full name (or e-mail address),
// case-insensitive, the longest name at each "@" – "@Anna Berg" is Anna
// Berg, not Anna. An "@" inside a word (an e-mail address in the text) is
// no mention. Guests see nobody of the workspace, so their "@" names nobody.
// Who may not read the page or record is filtered by commentRecipients.
export function commentTextMentions(author: Identity, page: Page, body: string) {
  if (!body.includes("@") || isGuest(author, page.workspace_id)) return [];
  const members = all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,COALESCE(u.email,'') email FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=? AND u.disabled=0",
    page.workspace_id,
  ).flatMap((m) =>
    [m.name, m.email]
      .map((n) => n.trim().toLocaleLowerCase())
      .filter((n) => n.length > 0)
      .map((n) => ({ id: m.id, n })),
  );
  const text = body.toLocaleLowerCase();
  const found = new Set<string>();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_.+-]/u.test(text[at - 1])) continue;
    const rest = text.slice(at + 1);
    let best: { id: string; n: string } | null = null;
    for (const m of members)
      if ((!best || m.n.length > best.n.length) && rest.startsWith(m.n) && !/^[\p{L}\p{N}_]/u.test(rest.slice(m.n.length)))
        best = m;
    if (best) found.add(best.id);
  }
  return [...found];
}
