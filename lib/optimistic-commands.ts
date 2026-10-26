// What a command (/api/command) looks like before the server answered: pure
// functions from the request to the change of the workspace (Bootstrap) and
// of the open page, used as layers by components/workspace-app.tsx (see
// lib/optimistic.ts). Only commands whose result is known in advance get
// one; everything else waits for the server as before.
import { cellText } from "./cell-text";
import { databaseGroups, groupCellValue, groupingField, subgroupingField } from "./database-groups";
import { orderedGroupRows, orderedRowIds } from "./row-order";
import type { Bootstrap, Comment, Database, Page, Reaction, Row, View } from "./types";

export type Command = Record<string, unknown>;
// The parts of a page's data the layers change.
export type PageLike = {
  page: Page;
  rows?: Row[];
  comments?: Comment[];
  database?: Database;
  related?: Record<string, Row[]>;
};
export type CommandContext = {
  userId: string;
  userName: string;
  // The page data shown while the change was made (for titles, groups).
  data?: PageLike | null;
  now?: Date;
};
export type CommandOverlay<D extends PageLike = PageLike> = {
  boot?: (boot: Bootstrap) => Bootstrap;
  page?: (data: D) => D;
};

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
// The server's CURRENT_TIMESTAMP format (UTC, without "T").
export const sqlNow = (now = new Date()) => now.toISOString().replace("T", " ").slice(0, 19);

// All pages below `id` (and the page itself).
export function subtree(pages: Pick<Page, "id" | "parent_id">[], id: string) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pages)
      if (p.parent_id && ids.has(p.parent_id) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
  }
  return ids;
}

// The tree after page.move, as the server orders it: the page leaves its
// level and goes before/after the target or at the end of the new parent.
export function movePages(
  pages: Page[],
  move: { pageId: string; targetId?: string; placement?: string; parentId?: string | null; spaceId?: string },
): Page[] {
  const moving = pages.find((p) => p.id === move.pageId);
  if (!moving) return pages;
  const target = move.targetId ? pages.find((p) => p.id === move.targetId) : undefined;
  if (move.targetId && !target) return pages;
  const placement = move.placement || "inside";
  const parent = target ? (placement === "inside" ? target.id : target.parent_id) : (move.parentId ?? null);
  const parentPage = parent ? pages.find((p) => p.id === parent) : undefined;
  const space = parentPage?.space_id || target?.space_id || move.spaceId || moving.space_id;
  const below = subtree(pages, moving.id);
  if (parent && below.has(parent)) return pages;
  const moved = pages.map((p) =>
    p.id === moving.id ? { ...p, parent_id: parent, space_id: space } : below.has(p.id) ? { ...p, space_id: space } : p,
  );
  const self = moved.find((p) => p.id === moving.id)!;
  const siblings = moved.filter((p) => p.id !== moving.id).filter((p) => p.space_id === space && (p.parent_id ?? null) === parent && !p.deleted_at);
  const at =
    target && placement !== "inside" ? siblings.findIndex((p) => p.id === target.id) + (placement === "after" ? 1 : 0) : siblings.length;
  const order = [...siblings];
  order.splice(Math.max(0, at), 0, self);
  // The siblings get 0…n like on the server; the list is ordered by position
  // as the server sends it (each level of the tree keeps its own order).
  const position = new Map(order.map((p, i) => [p.id, i]));
  return moved
    .map((p) => (position.has(p.id) ? { ...p, position: position.get(p.id)! } : p))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.position - b.p.position || a.i - b.i)
    .map(({ p }) => p);
}

function trashPages(pages: Page[], ids: string[], now: Date) {
  const gone = new Set(ids.flatMap((id) => [...subtree(pages, id)]));
  const at = sqlNow(now);
  return pages.map((p) => (gone.has(p.id) && !p.deleted_at ? { ...p, deleted_at: at } : p));
}

const patchRows = (rows: Row[] | undefined, ids: Set<string>, cells: Record<string, unknown>) =>
  rows?.map((r) => (ids.has(r.id) ? { ...r, cells: { ...r.cells, ...cells } } : r));

function toggleReaction(list: Reaction[] = [], emoji: string, active: boolean, name: string): Reaction[] {
  const found = list.find((r) => r.emoji === emoji);
  if (active) {
    if (found?.mine) return list;
    return found
      ? list.map((r) => (r === found ? { ...r, count: r.count + 1, mine: true, names: [...r.names, name] } : r))
      : [...list, { emoji, count: 1, mine: true, names: [name] }];
  }
  if (!found?.mine) return list;
  return found.count <= 1
    ? list.filter((r) => r !== found)
    : list.map((r) => (r === found ? { ...r, count: r.count - 1, mine: false, names: r.names.filter((n) => n !== name) } : r));
}

type RowMoveInput = {
  viewId: string;
  rowId: string;
  targetId?: string;
  placement: "before" | "after" | "start" | "end";
  clearSorts?: boolean;
  group?: { from: string; to: string };
  subgroup?: { from: string; to: string };
};
// A record dragged in a view: its group (board column) and place, as the
// server's moveRow (lib/row-order-server.ts) will store them.
export function applyRowMove<D extends PageLike>(data: D, move: RowMoveInput): D {
  const database = data.database,
    rows = data.rows;
  if (!database || !rows) return data;
  const view = database.views.find((v) => v.id === move.viewId);
  const row = rows.find((r) => r.id === move.rowId);
  if (!view || !row || (view.sorts.length && !move.clearSorts)) return data;
  const related = { ...(data.related || {}), [data.page.id]: rows };
  let cells = row.cells;
  let groupRowOrder = view.groupRowOrder;
  if (move.group) {
    const field = groupingField(database.fields, view);
    if (!field) return data;
    const groups = databaseGroups(rows, field, related);
    const from = groups.find((g) => g.key === move.group!.from),
      to = groups.find((g) => g.key === move.group!.to);
    if (!from || !to) return data;
    if (from.key !== to.key) cells = { ...cells, [field.id]: groupCellValue(field, to.value, row.cells[field.id], from.key) };
    const subfield = move.subgroup ? subgroupingField(database.fields, view, field) : undefined;
    if (subfield && move.subgroup && move.subgroup.from !== move.subgroup.to) {
      const target = databaseGroups(to.rows, subfield, related).find((g) => g.key === move.subgroup!.to);
      if (target) cells = { ...cells, [subfield.id]: groupCellValue(subfield, target.value, row.cells[subfield.id], move.subgroup.from) };
    }
    if (view.type === "board" && !move.clearSorts) {
      const columns = groups.map((g) => ({ key: g.key, ids: orderedGroupRows(g.rows, view.groupRowOrder?.[g.key]).map((r) => r.id) }));
      const next: Record<string, string[]> = { ...(view.groupRowOrder || {}) };
      for (const c of columns) if (!next[c.key] && c.ids.length) next[c.key] = c.ids;
      const ids = columns.find((c) => c.key === to.key)!.ids.filter((id) => id !== row.id);
      const at =
        move.placement === "start" ? 0 : move.placement === "end" ? ids.length : ids.indexOf(move.targetId!) + (move.placement === "after" ? 1 : 0);
      ids.splice(Math.max(0, at), 0, row.id);
      next[to.key] = ids;
      if (from.key !== to.key && next[from.key]) {
        const left = next[from.key].filter((id) => id !== row.id);
        if (left.length) next[from.key] = left;
        else delete next[from.key];
      }
      groupRowOrder = next;
    }
  } else if (move.clearSorts) groupRowOrder = undefined;
  const order = orderedRowIds(rows, view).filter((id) => id !== row.id);
  const index =
    move.placement === "start" ? 0 : move.placement === "end" ? order.length : order.indexOf(move.targetId!) + (move.placement === "after" ? 1 : 0);
  order.splice(Math.max(0, index), 0, row.id);
  const views: View[] = database.views.map((v) =>
    v.id === view.id ? { ...v, rowOrder: order, sorts: move.clearSorts ? [] : v.sorts, groupRowOrder } : v,
  );
  return {
    ...data,
    database: { ...database, views },
    rows: cells === row.cells ? rows : rows.map((r) => (r.id === row.id ? { ...r, cells } : r)),
  };
}

// The layers of one command; null when its result is not known beforehand.
export function commandOverlay<D extends PageLike>(b: Command, ctx: CommandContext): CommandOverlay<D> | null {
  const now = ctx.now || new Date();
  const pageId = str(b.pageId);
  const onPage = (change: (data: D) => D) => (data: D) => (data.page.id === pageId ? change(data) : data);
  switch (b.action) {
    case "favorite": {
      if (!pageId) return null;
      return {
        boot: (boot) => ({
          ...boot,
          favorites: b.value ? [...new Set([...boot.favorites, pageId])] : boot.favorites.filter((id) => id !== pageId),
        }),
      };
    }
    case "favorite.row": {
      const rowId = str(b.rowId);
      if (!pageId || !rowId) return null;
      const row = ctx.data?.page.id === pageId ? ctx.data.rows?.find((r) => r.id === rowId) : undefined;
      const titleField = ctx.data?.database?.fields[0]?.id || "title";
      return {
        boot: (boot) => {
          const list = (boot.favoriteRows || []).filter((f) => f.rowId !== rowId);
          return {
            ...boot,
            favoriteRows: b.value ? [...list, { pageId, rowId, title: cellText(row?.cells[titleField]) }] : list,
          };
        },
      };
    }
    case "page.update": {
      if (!pageId || !b.patch || typeof b.patch !== "object") return null;
      const patch = Object.fromEntries(
        Object.entries(b.patch as Record<string, unknown>).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v]),
      ) as Partial<Page>;
      if (typeof patch.title === "string" && !patch.title.trim()) return null;
      return {
        boot: (boot) => ({ ...boot, pages: boot.pages.map((p) => (p.id === pageId ? { ...p, ...patch } : p)) }),
        page: onPage((data) => ({ ...data, page: { ...data.page, ...patch } })),
      };
    }
    case "page.delete":
      if (!pageId) return null;
      return { boot: (boot) => ({ ...boot, pages: trashPages(boot.pages, [pageId], now) }) };
    case "page.restore":
      if (!pageId) return null;
      return {
        boot: (boot) => {
          const ids = subtree(boot.pages, pageId);
          return { ...boot, pages: boot.pages.map((p) => (ids.has(p.id) ? { ...p, deleted_at: null } : p)) };
        },
      };
    case "page.move": {
      if (!pageId) return null;
      // Into another workspace the page leaves this tree: the reload shows it.
      if (b.workspaceId && b.spaceId && !b.targetId && !b.parentId) {
        return {
          boot: (boot) =>
            boot.spaces.some((s) => s.id === b.spaceId)
              ? { ...boot, pages: movePages(boot.pages, { pageId, spaceId: String(b.spaceId), parentId: null }) }
              : boot,
        };
      }
      return {
        boot: (boot) => ({
          ...boot,
          pages: movePages(boot.pages, {
            pageId,
            targetId: str(b.targetId),
            placement: str(b.placement),
            parentId: b.parentId === undefined ? undefined : (str(b.parentId) ?? null),
            spaceId: str(b.spaceId),
          }),
        }),
      };
    }
    case "pages.bulk": {
      const ids = Array.isArray(b.pageIds) ? b.pageIds.filter((x): x is string => typeof x === "string") : [];
      if (!ids.length) return null;
      if (b.operation === "delete") return { boot: (boot) => ({ ...boot, pages: trashPages(boot.pages, ids, now) }) };
      if (b.operation === "move")
        return {
          boot: (boot) => ({
            ...boot,
            pages: ids.reduce(
              (pages, id) => movePages(pages, { pageId: id, parentId: str(b.parentId) ?? null, spaceId: str(b.spaceId) }),
              boot.pages,
            ),
          }),
        };
      return null;
    }
    case "notification.read":
      return {
        boot: (boot) => ({
          ...boot,
          notifications: boot.notifications.map((n) => (n.read_at ? n : { ...n, read_at: sqlNow(now) })),
        }),
      };
    case "notification.mark":
    case "notification.delete": {
      const id = str(b.notificationId);
      if (!id) return null;
      return {
        boot: (boot) => ({
          ...boot,
          notifications:
            b.action === "notification.delete"
              ? boot.notifications.filter((n) => n.id !== id)
              : boot.notifications.map((n) => (n.id === id ? { ...n, read_at: b.read ? sqlNow(now) : null } : n)),
        }),
      };
    }
    case "row.update": {
      const rowId = str(b.rowId);
      if (!pageId || !rowId || !b.cells || typeof b.cells !== "object") return null;
      const cells = b.cells as Record<string, unknown>;
      return { page: onPage((data) => ({ ...data, rows: patchRows(data.rows, new Set([rowId]), cells) })) };
    }
    case "row.delete": {
      const rowId = str(b.rowId);
      if (!pageId || !rowId) return null;
      return { page: onPage((data) => ({ ...data, rows: data.rows?.filter((r) => r.id !== rowId) })) };
    }
    case "rows.bulk": {
      const ids = new Set(
        (Array.isArray(b.rows) ? b.rows : []).map((r) => str((r as { id?: unknown })?.id)).filter((x): x is string => !!x),
      );
      if (!pageId || !ids.size) return null;
      if (b.operation === "delete") return { page: onPage((data) => ({ ...data, rows: data.rows?.filter((r) => !ids.has(r.id)) })) };
      if (b.operation === "update" && b.cells && typeof b.cells === "object") {
        const cells = b.cells as Record<string, unknown>;
        return { page: onPage((data) => ({ ...data, rows: patchRows(data.rows, ids, cells) })) };
      }
      return null;
    }
    case "row.move":
      if (!pageId || typeof b.viewId !== "string" || typeof b.rowId !== "string") return null;
      return { page: onPage((data) => applyRowMove(data, b as unknown as RowMoveInput)) };
    case "database.update": {
      if (!pageId || !Array.isArray(b.fields) || !Array.isArray(b.views)) return null;
      // Relations to other databases change those too: left to the server.
      if (b.relation) return null;
      const fields = b.fields as Database["fields"],
        views = b.views as Database["views"];
      return {
        page: onPage((data) => (data.database ? { ...data, database: { ...data.database, fields, views } } : data)),
      };
    }
    case "comment.create": {
      const body = str(b.body)?.trim();
      if (!pageId || !body) return null;
      const comment: Comment = {
        id: `pending-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        page_id: pageId,
        row_id: str(b.rowId) ?? null,
        author_id: ctx.userId,
        name: ctx.userName,
        body,
        resolved: 0,
        created_at: sqlNow(now),
        reactions: [],
      };
      return { page: onPage((data) => ({ ...data, comments: [...(data.comments || []), comment] })) };
    }
    case "comment.resolve": {
      const id = str(b.commentId);
      if (!pageId || !id) return null;
      return {
        page: onPage((data) => ({
          ...data,
          comments: data.comments?.map((c) => (c.id === id ? { ...c, resolved: b.resolved ? 1 : 0 } : c)),
        })),
      };
    }
    case "comment.react": {
      const id = str(b.commentId),
        emoji = str(b.emoji);
      if (!pageId || !id || !emoji) return null;
      return {
        page: onPage((data) => ({
          ...data,
          comments: data.comments?.map((c) =>
            c.id === id ? { ...c, reactions: toggleReaction(c.reactions, emoji, b.active !== false, ctx.userName) } : c,
          ),
        })),
      };
    }
    default:
      return null;
  }
}
