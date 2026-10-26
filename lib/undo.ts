// "Rückgängig" for destructive and bulk changes: for a command that went
// through, the commands that take it back (the existing restore and inverse
// actions), and the words of the toast that offers them
// (components/toast.tsx). Pure, so the tests check every inverse.
//
// The inverse commands are built when "Undo" is pressed, from the state at
// that moment (after the reload that followed the change): records carry
// their new version then. A change someone else made to the same values in
// between makes the server refuse the undo instead of overwriting it.
import { cellText } from "./cell-text";
import { isEmptyValue } from "./empty-value";
import { tr } from "./locale-tag";
import { subtree, type Command, type PageLike } from "./optimistic-commands";
import type { Bootstrap, Page } from "./types";

export type UndoState = { boot: Bootstrap; data: PageLike | null };
export type UndoPlan = {
  // "„Notizen“ in den Papierkorb gelegt" – the toast adds "Rückgängig".
  message: string;
  // Built when undo is chosen; run one after the other.
  commands: (now: UndoState) => Command[];
  // The page that was open and is gone: it opens again after undoing.
  reopen?: string;
};

const title = (page?: Pick<Page, "title">) => page?.title?.trim() || tr("Ohne Titel", "Untitled");
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

// Where a page sits in the tree, as a page.move that puts it back there.
export function placeOf(pages: Page[], pageId: string): Command | null {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return null;
  const siblings = pages.filter(
    (p) => p.space_id === page.space_id && (p.parent_id ?? null) === (page.parent_id ?? null) && !p.deleted_at,
  );
  const at = siblings.findIndex((p) => p.id === pageId);
  const before = siblings[at - 1],
    after = siblings[at + 1];
  if (before) return { action: "page.move", pageId, targetId: before.id, placement: "after" };
  if (after) return { action: "page.move", pageId, targetId: after.id, placement: "before" };
  return { action: "page.move", pageId, parentId: page.parent_id ?? null, spaceId: page.space_id };
}

// The selected pages without those inside another selected one (restoring
// a page restores what is below it).
function topmost(pages: Page[], ids: string[]) {
  const below = new Set(ids.flatMap((id) => [...subtree(pages, id)].filter((x) => x !== id)));
  return ids.filter((id) => !below.has(id));
}

const rowsLabel = (n: number) => (n === 1 ? tr("1 Eintrag", "1 record") : tr(`${n} Einträge`, `${n} records`));
const pagesLabel = (n: number) => (n === 1 ? tr("1 Seite", "1 page") : tr(`${n} Seiten`, `${n} pages`));

export function undoFor(b: Command, before: UndoState, openPageId?: string | null): UndoPlan | null {
  const pageId = str(b.pageId);
  const pages = before.boot.pages;
  const data = before.data && before.data.page.id === pageId ? before.data : null;
  const rowTitle = (rowId: string) => {
    const field = data?.database?.fields[0]?.id || "title";
    return cellText(data?.rows?.find((r) => r.id === rowId)?.cells[field]).trim();
  };
  switch (b.action) {
    case "page.delete": {
      if (!pageId) return null;
      return {
        message: tr(`„${title(pages.find((p) => p.id === pageId))}“ in den Papierkorb gelegt`, `“${title(pages.find((p) => p.id === pageId))}” moved to the trash`),
        commands: () => [{ action: "page.restore", pageId }],
        ...(openPageId && subtree(pages, pageId).has(openPageId) ? { reopen: openPageId } : {}),
      };
    }
    case "page.move": {
      if (!pageId) return null;
      // Into another workspace: the page is no longer here to move back.
      if (b.spaceId && !before.boot.spaces.some((s) => s.id === b.spaceId)) return null;
      const back = placeOf(pages, pageId);
      if (!back) return null;
      return {
        message: tr(`„${title(pages.find((p) => p.id === pageId))}“ verschoben`, `“${title(pages.find((p) => p.id === pageId))}” moved`),
        commands: () => [back],
      };
    }
    case "pages.bulk": {
      const ids = Array.isArray(b.pageIds) ? b.pageIds.filter((x): x is string => typeof x === "string") : [];
      if (!ids.length) return null;
      if (b.operation === "delete")
        return {
          message: tr(`${pagesLabel(ids.length)} in den Papierkorb gelegt`, `${pagesLabel(ids.length)} moved to the trash`),
          commands: () => topmost(pages, ids).map((id) => ({ action: "page.restore", pageId: id })),
          ...(openPageId && ids.some((id) => subtree(pages, id).has(openPageId)) ? { reopen: openPageId } : {}),
        };
      if (b.operation === "move") {
        const backs = ids.map((id) => placeOf(pages, id)).filter((c): c is Command => !!c);
        if (!backs.length) return null;
        return {
          message: tr(`${pagesLabel(ids.length)} verschoben`, `${pagesLabel(ids.length)} moved`),
          commands: () => backs,
        };
      }
      return null;
    }
    case "row.delete": {
      const rowId = str(b.rowId);
      if (!pageId || !rowId) return null;
      const name = rowTitle(rowId);
      return {
        message: name
          ? tr(`„${name}“ in den Papierkorb gelegt`, `“${name}” moved to the trash`)
          : tr("Eintrag in den Papierkorb gelegt", "Record moved to the trash"),
        commands: () => [{ action: "row.trash.restore", trashId: rowId }],
      };
    }
    case "rows.bulk": {
      const ids = (Array.isArray(b.rows) ? b.rows : [])
        .map((r) => str((r as { id?: unknown })?.id))
        .filter((x): x is string => !!x);
      if (!pageId || !ids.length) return null;
      if (b.operation === "delete")
        return {
          message: tr(`${rowsLabel(ids.length)} in den Papierkorb gelegt`, `${rowsLabel(ids.length)} moved to the trash`),
          commands: () => ids.map((id) => ({ action: "row.trash.restore", trashId: id })),
        };
      if (b.operation === "update" && b.cells && typeof b.cells === "object" && data?.rows) {
        const fieldIds = Object.keys(b.cells as object);
        const old = new Map(
          data.rows
            .filter((r) => ids.includes(r.id))
            .map((r) => [r.id, { version: r.version, cells: Object.fromEntries(fieldIds.map((f) => [f, r.cells[f] ?? null])) }]),
        );
        return {
          message: tr(`${rowsLabel(ids.length)} geändert`, `${rowsLabel(ids.length)} changed`),
          commands: (now) =>
            [...old].map(([rowId, previous]) => ({
              action: "row.update",
              pageId,
              rowId,
              version: versionAfter(now, pageId, rowId, previous.version, b.cells as Record<string, unknown>),
              cells: previous.cells,
            })),
        };
      }
      return null;
    }
    case "row.update": {
      // A date (or another value) removed from a record.
      const rowId = str(b.rowId);
      if (!pageId || !rowId || !data?.rows || !data.database || !b.cells || typeof b.cells !== "object") return null;
      const row = data.rows.find((r) => r.id === rowId);
      if (!row) return null;
      const cleared = Object.entries(b.cells as Record<string, unknown>).filter(([fieldId, value]) => {
        const field = data.database!.fields.find((f) => f.id === fieldId);
        return field?.type === "date" && isEmptyValue(value) && !isEmptyValue(row.cells[fieldId]);
      });
      if (!cleared.length) return null;
      const field = data.database.fields.find((f) => f.id === cleared[0][0])!;
      return {
        message: tr(`Datum „${field.name}“ entfernt`, `Date “${field.name}” removed`),
        commands: (now) => [
          {
            action: "row.update",
            pageId,
            rowId,
            version: versionAfter(now, pageId, rowId, row.version, b.cells as Record<string, unknown>),
            cells: Object.fromEntries(cleared.map(([fieldId]) => [fieldId, row.cells[fieldId]])),
          },
        ],
      };
    }
    case "row.move": {
      // A record dragged into another column or group.
      const rowId = str(b.rowId);
      const group = b.group as { from?: string; to?: string } | undefined;
      if (!pageId || !rowId || !data?.rows || !group || group.from === group.to) return null;
      const row = data.rows.find((r) => r.id === rowId);
      if (!row) return null;
      const name = rowTitle(rowId);
      return {
        message: name ? tr(`„${name}“ verschoben`, `“${name}” moved`) : tr("Eintrag verschoben", "Record moved"),
        commands: (now) => {
          const current = now.data?.page.id === pageId ? now.data.rows?.find((r) => r.id === rowId) : undefined;
          if (!current) return [];
          const changed = Object.keys(current.cells).filter(
            (key) => JSON.stringify(current.cells[key]) !== JSON.stringify(row.cells[key]),
          );
          const previous = Object.fromEntries(
            [...new Set([...changed, ...Object.keys(row.cells).filter((key) => !(key in current.cells))])].map((key) => [
              key,
              row.cells[key] ?? null,
            ]),
          );
          return Object.keys(previous).length
            ? [{ action: "row.update", pageId, rowId, version: current.version, cells: previous }]
            : [];
        },
      };
    }
    case "database.update": {
      // A property removed: the definition comes back (the records kept
      // their values).
      if (!pageId || !data?.database || !Array.isArray(b.fields) || b.relation) return null;
      const kept = new Set((b.fields as { id: string }[]).map((f) => f.id));
      const removed = data.database.fields.filter((f) => !kept.has(f.id));
      if (!removed.length) return null;
      const { fields, views } = data.database;
      return {
        message:
          removed.length === 1
            ? tr(`Eigenschaft „${removed[0].name}“ entfernt`, `Property “${removed[0].name}” removed`)
            : tr(`${removed.length} Eigenschaften entfernt`, `${removed.length} properties removed`),
        commands: (now) => [
          {
            action: "database.update",
            pageId,
            version: now.data?.page.id === pageId && now.data.database ? now.data.database.version : data.database!.version + 1,
            fields,
            views,
          },
        ],
      };
    }
    case "comment.resolve": {
      if (!pageId || !b.resolved || typeof b.commentId !== "string") return null;
      return {
        message: tr("Kommentar erledigt", "Comment resolved"),
        commands: () => [{ action: "comment.resolve", pageId, commentId: b.commentId, resolved: false }],
      };
    }
    default:
      return null;
  }
}

// The version to undo on: the record's current one while the changed
// values are still what this change set (an automation may have touched
// other properties since), else the one right after the change – then a
// later edit by someone else makes the server refuse the undo.
function versionAfter(now: UndoState, pageId: string, rowId: string, before: number, expected: Record<string, unknown>) {
  const row = now.data?.page.id === pageId ? now.data.rows?.find((r) => r.id === rowId) : undefined;
  const same = row && Object.entries(expected).every(([key, value]) => JSON.stringify(row.cells[key] ?? null) === JSON.stringify(value ?? null));
  return same ? row.version : before + 1;
}
