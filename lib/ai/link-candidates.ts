// Which existing pages the writing assistant may link (lib/ai/links.ts):
// a small set of pages that fit the instruction and the text being written.
//
// Retrieval is that of "Ask the workspace" (lib/ai/ask.ts): the full-text
// index with the text's most frequent terms (all together and each on its
// own), semantic search where an administrator switched it on, plus pages
// whose title the text names literally – the ranks fused. Only pages, not
// records, comments or files. EVERY candidate passes aiFilter (page
// permissions, trash, PIN journals, end-to-end encrypted spaces, "Für KI
// gesperrt", the person's own AI rules) before any of its text is read; the
// page being written is never offered. Only titles and a short excerpt go
// into the prompt, within a fixed budget.
import { all, one } from "../db";
import type { Identity } from "../types";
import { aiFilter } from "./access";
import { textCandidates } from "./ask";
import { fold, questionTerms } from "./chunks";
import { linkHandle, type LinkTarget, type PromptLink } from "./links";
import { resolveAi } from "./resolve";
import { semanticCandidates } from "./semantic";
import { nameLookup, sourceText } from "./sources";

export const LINK_LIMITS = {
  // Pages offered, and the excerpt of each: fewer and shorter for models on
  // the own server (small contexts). At most about 8 × (120 + 200) characters.
  candidates: { remote: 8, local: 5 },
  excerptChars: { remote: 200, local: 120 },
  titleChars: 120,
  // The text searched with (instruction, selection, transcript).
  queryChars: 8_000,
  // Search terms, most frequent first.
  terms: 12,
  // Pages whose titles are compared with the text (the newest first).
  titlePages: 5_000,
  // Titles shorter than this are too unspecific to match literally.
  minTitleChars: 4,
} as const;

export type LinkCandidates = { prompt: PromptLink[]; targets: LinkTarget[] };
const NONE: LinkCandidates = { prompt: [], targets: [] };

// The terms of a longer text: those that occur most often, then in order.
export function linkTerms(text: string, max: number = LINK_LIMITS.terms): string[] {
  const counts = new Map<string, { n: number; first: number }>();
  for (const part of text.split(/\n+|(?<=[.!?;:])\s+/))
    for (const term of questionTerms(part)) {
      const entry = counts.get(term);
      if (entry) entry.n++;
      else counts.set(term, { n: 1, first: counts.size });
    }
  return [...counts]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, max)
    .map(([term]) => term);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Pages whose (folded) title occurs in the text as whole words, the longest
// titles first.
function titleMatches(workspaceId: string, text: string): string[] {
  const folded = fold(text);
  const found: { id: string; length: number }[] = [];
  for (const page of all<{ id: string; title: string }>(
    "SELECT id,title FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND COALESCE(synced,0)=0 AND title<>'' ORDER BY updated_at DESC LIMIT ?",
    workspaceId,
    LINK_LIMITS.titlePages,
  )) {
    const title = fold(page.title).replace(/\s+/g, " ").trim();
    if ([...title].length < LINK_LIMITS.minTitleChars || !folded.includes(title)) continue;
    if (!new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(title)}(?![\\p{L}\\p{N}])`, "u").test(folded)) continue;
    found.push({ id: page.id, length: title.length });
  }
  return found.sort((a, b) => b.length - a.length).map((p) => p.id);
}

const excerptOf = (chunks: string[], title: string, max: number) => {
  // The first chunk often starts with the page's heading: no need to repeat the title.
  const text = chunks
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(`^${escapeRegExp(title.trim())}\\s*`, "i"), "");
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
};

export type LinkCandidateInput = {
  workspaceId: string;
  // The page (or database of the record) being written: never offered.
  pageId: string;
  // The instruction and the text the answer is about.
  query: string;
  // A model on the own server: fewer, shorter candidates.
  local?: boolean;
  // Semantic search may embed the query (the answer goes to the instance's
  // provider as well – the query then reaches no one new).
  semantic?: boolean;
  signal?: AbortSignal;
};

// The pages to offer, numbered P1 … Pn; empty when "links" is not usable
// for the person or nothing fits.
export async function findLinkCandidates(user: Identity, input: LinkCandidateInput): Promise<LinkCandidates> {
  if (!resolveAi(user, "links", { workspaceId: input.workspaceId }).ok) return NONE;
  const query = input.query.slice(0, LINK_LIMITS.queryChars).trim();
  if (!query) return NONE;
  const max = input.local ? LINK_LIMITS.candidates.local : LINK_LIMITS.candidates.remote;
  const excerptChars = input.local ? LINK_LIMITS.excerptChars.local : LINK_LIMITS.excerptChars.remote;

  // Reciprocal rank fusion over all lists, pages only.
  const fused = new Map<string, number>();
  const addList = (ids: string[], weight = 1) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id) || id === input.pageId) continue;
      fused.set(id, (fused.get(id) || 0) + weight / (60 + seen.size));
      seen.add(id);
    }
  };
  const terms = linkTerms(query);
  const scope = { pages: null };
  const pagesOf = (rows: { page_id: string; row_id: string }[]) => rows.filter((r) => !r.row_id).map((r) => r.page_id);
  addList(pagesOf(textCandidates(input.workspaceId, terms, scope, 200)));
  if (terms.length > 1) for (const term of terms) addList(pagesOf(textCandidates(input.workspaceId, [term], scope, 60)));
  // A title named in the text is the clearest sign.
  addList(titleMatches(input.workspaceId, query), 3);
  if (input.semantic)
    try {
      const hits = await semanticCandidates(user, input.workspaceId, query.slice(0, 2000), { signal: input.signal, limited: true, limit: 40 });
      addList(hits.filter((h) => !h.rowId).map((h) => h.pageId));
    } catch (error) {
      // Linking is extra: a failing embedding model only loses meaning search.
      if ((error as Error)?.name === "AbortError") throw error;
      console.error("Semantische Suche (Verlinken) fehlgeschlagen:", (error as Error)?.message);
    }
  if (!fused.size) return NONE;

  // What the AI may read – before any text of a candidate is loaded.
  const ranked = [...fused].sort((a, b) => b[1] - a[1]).map(([pageId]) => ({ pageId }));
  const readable = aiFilter(user, ranked.slice(0, max * 6));
  const names = nameLookup();
  const prompt: PromptLink[] = [];
  const targets: LinkTarget[] = [];
  for (const { pageId } of readable) {
    if (targets.length >= max) break;
    const page = one<{ title: string; synced: number | null; workspace_id: string }>("SELECT title,synced,workspace_id FROM pages WHERE id=?", pageId);
    // Synced blocks live inside other pages; untitled pages make poor links.
    if (!page || page.synced || page.workspace_id !== input.workspaceId || !page.title.trim()) continue;
    const source = sourceText(pageId, null, names);
    if (!source) continue;
    const handle = linkHandle(targets.length + 1);
    const title = page.title.replace(/\s+/g, " ").trim();
    prompt.push({ handle, title: title.slice(0, LINK_LIMITS.titleChars), excerpt: excerptOf(source.chunks, title, excerptChars) });
    targets.push({ handle, pageId, title });
  }
  return { prompt, targets };
}

// The targets for the browser's header (base64 of UTF-8 JSON, like the
// sources of "ask").
export const encodeLinkTargets = (targets: LinkTarget[]) => Buffer.from(JSON.stringify(targets)).toString("base64");
