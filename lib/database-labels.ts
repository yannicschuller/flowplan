// Databases picked by name (#520): the relation's "Verknüpfte Datenbank",
// "Verschieben nach …", "Aufgaben in Datenbank verschieben …", the
// automation's and workflow's database choice. Several spaces often hold a
// database of the same title ("Notizen" in the personal and the family
// space), so the choices are grouped by space (in the sidebar's order) and
// sorted by title; two of the same title in one space get their parent page
// ("Notizen · Bereiche", "Notizen · Familie › Bereiche") until each entry is
// unique. Only labels and order: what is listed stays the caller's choice.

export type DatabaseRef = {
  id: string;
  title: string;
  space_id?: string | null;
  parent_id?: string | null;
  // The space's name as the server sent it, when the space is not among
  // the known ones.
  space?: string;
};
export type PageRef = { id: string; title: string; space_id?: string | null; parent_id?: string | null };
export type SpaceRef = { id: string; name: string };

export type DatabaseEntry = {
  id: string;
  title: string;
  // Within its space's group: the title, plus the parent path when another
  // database of the same title is in the same space.
  label: string;
  // The parent path that tells it apart ("" when none is needed).
  location: string;
  space: string;
  // Without a group around it: the title, plus space and parent path when
  // another listed database has the same title ("Notizen · Familie").
  fullLabel: string;
};
export type DatabaseGroup = { spaceId: string; space: string; databases: DatabaseEntry[] };

const SEP = " · ",
  PATH = " › ",
  DEPTH = 4;

const fold = (s: string) => s.normalize("NFC").trim().toLocaleLowerCase();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function groupDatabases(
  databases: DatabaseRef[],
  { pages = [], spaces = [], untitled = "Untitled" }: { pages?: PageRef[]; spaces?: SpaceRef[]; untitled?: string } = {},
): DatabaseGroup[] {
  const byId = new Map<string, PageRef>();
  for (const p of pages) byId.set(p.id, p);
  const spaceIndex = new Map(spaces.map((s, i) => [s.id, i]));
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
  const name = (title: string | undefined) => (title || "").trim() || untitled;
  // Parent titles, nearest first.
  const ancestors = (id: string, parent: string | null | undefined) => {
    const out: string[] = [];
    const seen = new Set([id]);
    let at = parent;
    while (at && !seen.has(at) && out.length < DEPTH) {
      seen.add(at);
      const p = byId.get(at);
      if (!p) break;
      out.push(name(p.title));
      at = p.parent_id;
    }
    return out;
  };
  type Item = { id: string; title: string; spaceId: string; space: string; up: string[]; location: string; label: string; suffix: string };
  const groups = new Map<string, Item[]>();
  const seenIds = new Set<string>();
  for (const d of databases) {
    if (seenIds.has(d.id)) continue;
    seenIds.add(d.id);
    const known = byId.get(d.id);
    const sid = d.space_id || known?.space_id || "";
    const space = (sid && spaceName.get(sid)) || d.space || "";
    const key = sid && spaceName.has(sid) ? sid : space ? `name:${space}` : sid;
    // The client's title where it knows the page (decrypted, #520).
    const title = name(known ? known.title : d.title);
    const item: Item = { id: d.id, title, spaceId: key, space, up: ancestors(d.id, d.parent_id ?? known?.parent_id), location: "", label: title, suffix: "" };
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  // Same title twice in a space: the shortest parent path that tells them
  // apart, and a number when even that does not.
  for (const items of groups.values()) {
    const same = new Map<string, Item[]>();
    for (const i of items) same.set(fold(i.title), [...(same.get(fold(i.title)) || []), i]);
    for (const twins of same.values()) {
      if (twins.length < 2) continue;
      const deepest = Math.max(...twins.map((i) => i.up.length));
      let depth = 1;
      const path = (i: Item, n: number) => i.up.slice(0, n).reverse().join(PATH);
      while (depth < deepest && new Set(twins.map((i) => fold(path(i, depth)))).size < twins.length) depth++;
      for (const i of twins) {
        i.location = path(i, depth);
        i.label = i.location ? i.title + SEP + i.location : i.title;
      }
      const count = new Map<string, number>();
      for (const i of [...twins].sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id))) {
        const n = (count.get(fold(i.label)) || 0) + 1;
        count.set(fold(i.label), n);
        if (n > 1) {
          i.suffix = ` (${n})`;
          i.label += i.suffix;
        }
      }
    }
  }
  const titles = new Map<string, number>();
  for (const items of groups.values()) for (const i of items) titles.set(fold(i.title), (titles.get(fold(i.title)) || 0) + 1);
  const order = (id: string) => spaceIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...groups.entries()]
    .sort(([a, x], [b, y]) => order(a) - order(b) || collator.compare(x[0].space, y[0].space) || a.localeCompare(b))
    .map(([spaceId, items]) => ({
      spaceId,
      space: items[0].space,
      databases: items
        .sort((a, b) => collator.compare(a.title, b.title) || collator.compare(a.label, b.label) || a.id.localeCompare(b.id))
        .map((i) => {
          const where = [i.space, i.location].filter(Boolean).join(PATH);
          return {
            id: i.id,
            title: i.title,
            label: i.label,
            location: i.location,
            space: i.space,
            fullLabel: (titles.get(fold(i.title)) || 0) > 1 && where ? i.title + SEP + where + i.suffix : i.label,
          };
        }),
    }));
}

// The databases in picker order, each once.
export const databaseList = (groups: DatabaseGroup[]) => groups.flatMap((g) => g.databases);

// One database's name where it is not picked from a list (the relation's
// settings once linked): "Notizen · Familie" when another of the given
// databases has the same title.
export function databaseLabel(id: string, databases: DatabaseRef[], options?: Parameters<typeof groupDatabases>[1]) {
  return databaseList(groupDatabases(databases, options)).find((d) => d.id === id)?.fullLabel;
}
