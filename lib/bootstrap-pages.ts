// The largest parts of the bootstrap – the page list (the sidebar, the
// trash, the page pickers) and the members of the workspace – kept across
// requests, and the bootstrap's answer with a cheap ETag (#383).
//
// Kept under versions that triggers move (lib/cache-versions.ts):
// - the stored pages of a workspace under "pages:<workspace>" (any change
//   of one of its pages), and what a person sees of them under that and
//   "roles" (everything pageRole() reads);
// - the members of a workspace under "roles" (memberships, guests) and
//   "people" (the names, addresses, avatars and the disabled state of
//   accounts).
// The rest of the bootstrap – settings, notifications, tasks due today, the
// state of the AI and some forty more sources, some of them changing with
// the clock – is built anew for every request, as before.
//
// The ETag is not a hash of the whole answer: it hashes the rest of the
// answer and names the kept parts by their versions. An unchanged refresh
// (the app asks every 10 s, components/workspace-app.tsx) then answers 304
// without serialising and hashing them again.
import { all, inTransaction } from "./db";
import { cacheVersion, VersionedCache } from "./cache-versions";
import { contentTag, jsonWithTag, tagMatches } from "./etag";
import { pageRole, workspaceRoles } from "./permissions";
import type { Identity, Page } from "./types";

export type Member = { id: string; name: string; email: string; disabled: number; avatar: string | null; role: string; guest: number };
type Kept<T> = { list: T[]; json?: string };
const store = globalThis as {
  flowplanWorkspacePages?: VersionedCache<readonly Page[]>;
  flowplanPageLists?: VersionedCache<Kept<Page>>;
  flowplanMemberLists?: VersionedCache<Kept<Member>>;
};
// Stored rows shared by everyone: frozen, so a caller that changed one
// would fail loudly instead of changing it for others.
const workspacePages = (store.flowplanWorkspacePages ??= new VersionedCache<readonly Page[]>(50));
// What one person sees of them (per workspace, person and guest state).
const pageLists = (store.flowplanPageLists ??= new VersionedCache<Kept<Page>>(500));
const memberLists = (store.flowplanMemberLists ??= new VersionedCache<Kept<Member>>(50));
// A kept part of an answer: where it is kept, under which version.
type PartTag = { key: string; version: string };
type Part = "pages" | "members";
const lists: Record<Part, VersionedCache<Kept<unknown>>> = { pages: pageLists as VersionedCache<Kept<unknown>>, members: memberLists as VersionedCache<Kept<unknown>> };
// The answers of bootstrap() with kept parts.
const answerTags = new WeakMap<object, Partial<Record<Part, PartTag>>>();

async function storedPages(workspaceId: string) {
  return (await all<Page>(
    // Synced blocks live inside the pages that show them, not in the tree.
    "SELECT * FROM pages WHERE workspace_id=? AND synced=0 ORDER BY position",
    workspaceId,
  )).map((p) => Object.freeze(p));
}
async function readable(user: Identity, pages: readonly Page[], workspaceId: string, guest: boolean) {
  await workspaceRoles(user, workspaceId);
  const out: Page[] = [];
  // Workflow pages are not for guests (#168).
  for (const p of pages) if (!(guest && p.kind === "workflow") && (await pageRole(user, p))) out.push(p);
  return out;
}

// The pages of the workspace this person may read, in their order, and
// where they are kept (null: not kept, inside a transaction).
// `stored`: all stored pages of the workspace but synced blocks.
export async function sidebarPages(user: Identity, workspaceId: string, guest: boolean): Promise<{ pages: Page[]; stored: readonly Page[]; tag: PartTag | null }> {
  if (inTransaction()) {
    const stored = await storedPages(workspaceId);
    return { pages: await readable(user, stored, workspaceId, guest), stored, tag: null };
  }
  // The versions before anything is read (lib/cache-versions.ts).
  const pagesVersion = await cacheVersion(`pages:${workspaceId}`);
  const version = `${pagesVersion}|${await cacheVersion("roles")}`;
  const key = `${workspaceId}:${user.id}:${guest ? 1 : 0}`;
  let stored = workspacePages.get(workspaceId, pagesVersion);
  if (!stored) workspacePages.set(workspaceId, pagesVersion, (stored = await storedPages(workspaceId)));
  const kept = pageLists.get(key, version);
  if (kept) return { pages: kept.list, stored, tag: { key, version } };
  const pages = await readable(user, stored, workspaceId, guest);
  pageLists.set(key, version, { list: pages });
  return { pages, stored, tag: { key, version } };
}

// The members of the workspace with their role and whether they are a
// guest; a guest sees only themselves.
export async function workspaceMembers(user: Identity, workspaceId: string, guest: boolean): Promise<{ members: Member[]; tag: PartTag | null }> {
  const load = async () =>
    (await all<Member>(
      `SELECT u.id,u.name,u.email,u.disabled,u.avatar,m.role,
       EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=u.id) guest
       FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?`,
      workspaceId,
    )).map((m) => Object.freeze(m));
  const only = (members: Member[]) => (guest ? members.filter((m) => m.id === user.id) : members);
  if (inTransaction()) return { members: only(await load()), tag: null };
  const version = `${await cacheVersion("roles")}|${await cacheVersion("people")}`;
  let list = memberLists.get(workspaceId, version)?.list;
  if (!list) memberLists.set(workspaceId, version, { list: (list = await load()) });
  // A guest's own list is not kept: it is one entry.
  return guest ? { members: only(list), tag: null } : { members: list, tag: { key: workspaceId, version } };
}

// Marks a bootstrap answer whose parts came from the functions above.
export function withKeptParts<T extends { pages: Page[]; members: Member[] }>(answer: T, tags: Partial<Record<Part, PartTag | null>>): T {
  const kept = Object.fromEntries(Object.entries(tags).filter(([, tag]) => !!tag)) as Partial<Record<Part, PartTag>>;
  if (Object.keys(kept).length) answerTags.set(answer, kept);
  return answer;
}

// The bootstrap as JSON with an ETag over the rest of the answer and the
// names of the kept parts; 304 when the browser has exactly that. An
// answer without kept parts is hashed whole (lib/etag.ts).
export function bootstrapResponse(req: Request, answer: Record<string, unknown>) {
  const tags = answerTags.get(answer);
  if (!tags) return jsonWithTag(req, answer);
  const parts = Object.keys(tags) as Part[];
  const rest = { ...answer };
  for (const part of parts) delete rest[part];
  const restJson = JSON.stringify(rest);
  // The kept parts by their names (the person is part of the page list's),
  // the rest by content.
  const etag = contentTag(`${parts.map((part) => `${part}:${tags[part]!.key}:${tags[part]!.version}`).join("\n")}\n${restJson}`);
  const headers = new Headers({ "Cache-Control": "no-store", ETag: etag });
  if (tagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", "application/json");
  // The members' JSON is kept with them (one list per workspace); a page
  // list's is not – one per person would hold the whole tree per person.
  const json = parts.map((part) => {
    const value = answer[part];
    const kept = part === "members" ? lists.members.get(tags[part]!.key, tags[part]!.version) : undefined;
    return `${JSON.stringify(part)}:${kept && kept.list === value ? (kept.json ??= JSON.stringify(value)) : JSON.stringify(value)}`;
  });
  return new Response(`{${json.join(",")}${restJson === "{}" ? "" : `,${restJson.slice(1)}`}`, { status: 200, headers });
}
