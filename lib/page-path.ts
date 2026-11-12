// The breadcrumb of the top bar (#231): where the open page sits in the
// structure – its ancestor pages (pages.parent_id), the database of an
// open record and the record – whichever way it was reached (link, search,
// sidebar, "My tasks"). Records will later carry sub-pages of their own
// (#231, part 3): they then follow the record as further segments.
//
// Permissions: the walk only uses pages the person may read – the list the
// workspace sends (bootstrap, filtered by pageRole) – and stops at the
// first parent that is not in it. A guest with a share on one page sees no
// title (nor the existence) of the private pages above it; a readable page
// above an unreadable one is not shown either, since reaching it would need
// the hidden page's own parent.
import { pageLocationHash } from "./page-location";

export type PathPage = {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  kind: string;
  journal_date?: string | null;
};
export type PathRecord = { rowId: string; title: string; icon: string; full?: boolean };
export type PathSegment = {
  // "record" for a database record; pages keep their own kind.
  kind: string;
  // A stable key: the page id, or "<page id>:<record id>".
  key: string;
  title: string;
  icon: string;
  hash: string;
  current?: boolean;
};

// More than this many levels means a loop in broken data.
const MAX_DEPTH = 64;

export function structuralPath(
  readable: readonly PathPage[],
  current: PathPage,
  record?: PathRecord | null,
): PathSegment[] {
  const byId = new Map(readable.map((p) => [p.id, p]));
  const ancestors: PathPage[] = [];
  const seen = new Set([current.id]);
  let parentId = current.parent_id;
  while (parentId && ancestors.length < MAX_DEPTH && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    ancestors.unshift(parent);
    parentId = parent.parent_id;
  }
  const page = (p: PathPage): PathSegment => ({
    kind: p.kind,
    key: p.id,
    title: p.title,
    icon: p.icon,
    hash: pageLocationHash({ pageId: p.id }),
  });
  const segments = [...ancestors.map(page), page(current)];
  if (record)
    segments.push({
      kind: "record",
      key: `${current.id}:${record.rowId}`,
      title: record.title,
      icon: record.icon,
      hash: pageLocationHash({ pageId: current.id, rowId: record.rowId, full: record.full }),
    });
  segments[segments.length - 1] = { ...segments[segments.length - 1], current: true };
  return segments;
}

export type CollapsedPath = { shown: (PathSegment | { more: PathSegment[] })[] };

// A path of more than `room` segments keeps its first one and the last
// room - 1; the middle becomes "…" with a menu of what it hides. With room
// for two or fewer (phones), only "…" and the current segment remain.
export function collapsePath(segments: readonly PathSegment[], room: number): CollapsedPath {
  const max = Math.max(2, Math.floor(room));
  if (segments.length <= max) return { shown: [...segments] };
  if (max === 2) return { shown: [{ more: segments.slice(0, -1) }, segments[segments.length - 1]] };
  const tail = max - 1;
  return {
    shown: [segments[0], { more: segments.slice(1, segments.length - tail) }, ...segments.slice(segments.length - tail)],
  };
}
export const isMore = (item: PathSegment | { more: PathSegment[] }): item is { more: PathSegment[] } => "more" in item;
