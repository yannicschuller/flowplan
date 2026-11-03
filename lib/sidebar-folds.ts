// The sidebar's folded and unfolded places (#97): the keys stored per person
// and workspace (lib/sidebar-state.ts, schema 86) and what the client does
// with them. Pure, no browser or Node APIs.
//
//   p:<page>            a page unfolded in the tree (pages start folded)
//   s:<space>           a space folded
//   g:favorites         the favourites folded
//   g:collections       the collections folded
//   jo:<journal>:<y|m>  a year or month folder of a journal opened by hand
//   jc:<journal>:<y|m>  … closed by hand (lib/journal-nav.ts)
export const SIDEBAR_STATE_LIMIT = 3000;
export const SIDEBAR_CHANGES_LIMIT = 2000;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^(?:p:${uuid}|s:${uuid}|g:(?:favorites|collections)|j[oc]:${uuid}:\\d{4}(?:-\\d{2})?)$`, "i");
export const isSidebarKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key);

// The page or space a key belongs to (null for groups).
function owner(key: string): { page?: string; space?: string } {
  if (key.startsWith("p:")) return { page: key.slice(2) };
  if (key.startsWith("s:")) return { space: key.slice(2) };
  if (key.startsWith("jo:") || key.startsWith("jc:")) return { page: key.slice(3, 39) };
  return {};
}

// Keys whose page or space still exists; unfolded pages only while they
// have sub-pages (folding a page without any changes nothing).
export function pruneSidebarKeys(
  keys: readonly string[],
  known: { pages: ReadonlySet<string>; parents: ReadonlySet<string>; spaces: ReadonlySet<string> },
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const key of keys) {
    if (!isSidebarKey(key) || seen.has(key)) continue;
    const o = owner(key);
    if (o.space && !known.spaces.has(o.space)) continue;
    if (o.page && !known.pages.has(o.page)) continue;
    if (key.startsWith("p:") && !known.parents.has(o.page!)) continue;
    seen.add(key);
    kept.push(key);
  }
  return kept.slice(-SIDEBAR_STATE_LIMIT);
}

// Changes on top of the stored keys: true adds (at the end, as the newest),
// false removes. Changes, not the whole list: two devices folding different
// things at the same time do not undo each other.
export function applySidebarChanges(keys: readonly string[], changes: Record<string, boolean>): string[] {
  const next = new Set(keys);
  for (const [key, on] of Object.entries(changes)) {
    if (!isSidebarKey(key)) continue;
    next.delete(key);
    if (on) next.add(key);
  }
  return [...next].slice(-SIDEBAR_STATE_LIMIT);
}

type TreePage = { id: string; parent_id: string | null; space_id: string; deleted_at?: string | null };

// The pages above `id`, nearest first: unfolded to show the open page.
export function ancestorIds(pages: readonly TreePage[], id: string | null | undefined): string[] {
  if (!id) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  for (let parent = byId.get(id)?.parent_id; parent && !seen.has(parent); parent = byId.get(parent)?.parent_id) {
    seen.add(parent);
    out.push(parent);
  }
  return out;
}

// "Alle aufklappen" / "Alle zuklappen" for a space: every page of the space
// that has sub-pages, as changes of their p: keys.
export function spaceFoldChanges(pages: readonly TreePage[], spaceId: string, open: boolean): Record<string, boolean> {
  const live = pages.filter((p) => !p.deleted_at);
  const parents = new Set(live.flatMap((p) => (p.parent_id ? [p.parent_id] : [])));
  const changes: Record<string, boolean> = {};
  for (const p of live)
    if (p.space_id === spaceId && parents.has(p.id) && Object.keys(changes).length < SIDEBAR_CHANGES_LIMIT) changes[`p:${p.id}`] = open;
  return changes;
}

// Journal folder keys of lib/journal-nav.ts ("journal:<id>:<y|m>") and back.
export const journalFoldKey = (folder: string, open: boolean) => `${open ? "jo" : "jc"}:${folder.slice("journal:".length)}`;
export function journalFolds(keys: Iterable<string>) {
  const open = new Set<string>(),
    closed = new Set<string>();
  for (const key of keys) {
    if (key.startsWith("jo:")) open.add(`journal:${key.slice(3)}`);
    else if (key.startsWith("jc:")) closed.add(`journal:${key.slice(3)}`);
  }
  return { open, closed };
}

// What this device folded before #97 (spaces, collections), as changes –
// taken over once, when the account has nothing stored yet.
export function legacyFoldChanges(spaces: Iterable<string>, collectionsFolded: boolean): Record<string, boolean> {
  const changes: Record<string, boolean> = {};
  for (const space of spaces) if (isSidebarKey(`s:${space}`)) changes[`s:${space}`] = true;
  if (collectionsFolded) changes["g:collections"] = true;
  return changes;
}

export type StoredSidebar = { keys: string[]; updatedAt: number } | null | undefined;
// The newer of the server's state and the copy on this device.
export function newerSidebar(server: StoredSidebar, device: StoredSidebar): StoredSidebar {
  if (!device) return server;
  if (!server) return device;
  return device.updatedAt > server.updatedAt ? device : server;
}
