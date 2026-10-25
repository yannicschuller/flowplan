// Siri, Shortcuts, Spotlight and Focus filters of the iPhone and iPad app
// (App Intents in flowplan-app), on top of the device token of
// lib/mobile-devices.ts – like the widgets (lib/mobile-widgets.ts), whose
// capture and task actions the intents use for writing:
//
//   GET  /api/mobile/intents/pages?q=…|ids=…   pages to open ("Open page …"):
//                                              by title, by id, or suggested
//   GET  /api/mobile/intents/search?q=…        full-text search across the
//                                              person's workspaces
//   GET  /api/mobile/intents/workspaces        for the Focus filter
//   POST /api/mobile/intents/focus             the Focus filter's push rule
//                                              (lib/mobile-focus.ts)
//
// Only what the person may see in the web app: the same page and record
// permissions, nothing of end-to-end encrypted spaces (titles included),
// journals behind a PIN only by name, as in the sidebar.
import { z } from "zod";
import { all } from "./db";
import { ct } from "./content-locale";
import { lockedPageIds } from "./journal-extras";
import { pageLocationHash } from "./page-location";
import { pageRole } from "./permissions";
import { MARK_END, MARK_START, searchWorkspace } from "./search-index";
import type { Identity, Page } from "./types";

export const MAX_PAGES = 20;
export const MAX_RESULTS = 10;
const TITLE = 80;
const KINDS = ["document", "database", "whiteboard", "dashboard", "journal", "notebook"] as const;

const clip = (text: string, max = TITLE) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const url = (pageId: string, rowId?: string | null) => `/${pageLocationHash({ pageId, ...(rowId ? { rowId } : {}) })}`;
const untitled = () => ct("Ohne Titel", "Untitled");

export const pagesQuery = z.object({
  q: z.string().max(200).optional(),
  ids: z.array(z.uuid()).max(MAX_PAGES).optional(),
});
export const searchQuery = z.object({ q: z.string().trim().min(1).max(200) });

export type IntentPage = {
  id: string;
  name: string;
  icon: string;
  kind: string;
  space: string;
  workspace: string;
  workspaceId: string;
  url: string;
  locked?: true;
};

type Candidate = Page & { space_name: string; workspace_name: string; encrypted: number };
const CANDIDATE = `SELECT p.*,s.name space_name,w.name workspace_name,COALESCE(s.encrypted,0) encrypted FROM pages p
  JOIN spaces s ON s.id=p.space_id JOIN workspaces w ON w.id=p.workspace_id
  JOIN members m ON m.workspace_id=p.workspace_id AND m.user_id=?
  WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL AND COALESCE(p.synced,0)=0 AND p.journal_date IS NULL
    AND p.kind IN (${KINDS.map(() => "?").join(",")})`;

// Readable, not encrypted; a journal behind a PIN only by its name.
function visible(user: Identity, candidates: Candidate[], max: number) {
  const locked = new Map<string, Set<string>>();
  const out: IntentPage[] = [];
  for (const page of candidates) {
    if (out.length >= max) break;
    if (page.encrypted || !pageRole(user, page)) continue;
    if (out.some((p) => p.id === page.id)) continue;
    if (!locked.has(page.workspace_id)) locked.set(page.workspace_id, lockedPageIds(user, page.workspace_id));
    out.push({
      id: page.id,
      name: clip(page.title || untitled()),
      icon: page.icon || "",
      kind: page.kind,
      space: clip(page.space_name, 40),
      workspace: clip(page.workspace_name, 40),
      workspaceId: page.workspace_id,
      url: url(page.id),
      ...(locked.get(page.workspace_id)!.has(page.id) ? { locked: true as const } : {}),
    });
  }
  return out;
}

// Pages by id (Shortcuts resolving a saved choice), by title (Siri asking
// "which page?"), or – without either – the person's favorites and the pages
// they opened last.
export function intentPages(user: Identity, input: unknown) {
  const { q, ids } = pagesQuery.parse(input);
  if (ids?.length) {
    const found = all<Candidate>(`${CANDIDATE} AND p.id IN (${ids.map(() => "?").join(",")})`, user.id, ...KINDS, ...ids);
    return { pages: visible(user, ids.map((id) => found.find((p) => p.id === id)).filter((p): p is Candidate => !!p), MAX_PAGES) };
  }
  const text = (q || "").replace(/[\u0000-\u001f]/g, " ").trim();
  if (!text) {
    const candidates = all<Candidate>(
      `${CANDIDATE} ORDER BY EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=? AND f.page_id=p.id) DESC,
         COALESCE((SELECT v.seen_at FROM page_visits v WHERE v.user_id=? AND v.page_id=p.id),0) DESC,p.updated_at DESC LIMIT 200`,
      user.id,
      ...KINDS,
      user.id,
      user.id,
    );
    return { pages: visible(user, candidates, MAX_PAGES) };
  }
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const prefix = `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const candidates = all<Candidate>(
    `${CANDIDATE} AND p.title LIKE ? ESCAPE '\\'
     ORDER BY (p.title LIKE ? ESCAPE '\\') DESC,p.updated_at DESC LIMIT 500`,
    user.id,
    ...KINDS,
    like,
    prefix,
  );
  return { pages: visible(user, candidates, MAX_PAGES) };
}

export type IntentResult = {
  id: string;
  rowId?: string;
  title: string;
  page?: string;
  kind: string;
  snippet: string;
  workspace: string;
  url: string;
};

const workspacesOf = (user: Identity) =>
  all<{ id: string; name: string }>(
    "SELECT w.id,w.name FROM members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.name COLLATE NOCASE",
    user.id,
  );

// The full-text search of the web app in every workspace of the person, the
// best hits of each in turn; snippets as plain text.
export function intentSearch(user: Identity, input: unknown) {
  const { q } = searchQuery.parse(input);
  const lists = workspacesOf(user).map((w) => ({
    workspace: w,
    hits: searchWorkspace(user, w.id, q).filter((hit) => hit.kind !== "file"),
  }));
  const results: IntentResult[] = [];
  for (let i = 0; results.length < MAX_RESULTS && lists.some((l) => l.hits.length > i); i++) {
    for (const { workspace, hits } of lists) {
      const hit = hits[i];
      if (!hit || results.length >= MAX_RESULTS) continue;
      if (results.some((r) => r.id === hit.id && r.rowId === hit.rowId)) continue;
      results.push({
        id: hit.id,
        ...(hit.rowId ? { rowId: hit.rowId } : {}),
        title: clip(hit.title || untitled()),
        ...(hit.pageTitle ? { page: clip(hit.pageTitle || untitled(), 60) } : {}),
        kind: hit.kind,
        snippet: clip(hit.snippet.replaceAll(MARK_START, "").replaceAll(MARK_END, ""), 160),
        workspace: clip(workspace.name, 40),
        url: url(hit.id, hit.rowId),
      });
    }
  }
  return { query: q, results };
}

// The workspaces to choose from in a Focus filter.
export function intentWorkspaces(user: Identity) {
  return { workspaces: workspacesOf(user).map((w) => ({ id: w.id, name: clip(w.name, 60) })) };
}
