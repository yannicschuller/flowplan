import * as Y from "yjs";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { escaped } from "./document-server";
import { itemText, type WhiteboardItem } from "./whiteboard-model";
import type { Identity, Page } from "./types";

// Whiteboards: the board is a Yjs document (see whiteboard-model.ts) that
// clients exchange like documents. The texts on the board are kept as a
// summary in documents.html for search, previews and exports.
type Stored = { state: Uint8Array; generation: string };
export function whiteboardItems(doc: Y.Doc): WhiteboardItem[] {
  const items: WhiteboardItem[] = [];
  doc.getMap<Y.Map<unknown>>("items").forEach((value, key) => {
    if (value instanceof Y.Map)
      items.push({ ...(value.toJSON() as WhiteboardItem), id: key });
  });
  return items.sort((a, b) => (a.z || 0) - (b.z || 0));
}
export function whiteboardSummary(items: WhiteboardItem[]) {
  return items
    .map(itemText)
    .filter(Boolean)
    .map((text) => `<p>${escaped(text.slice(0, 2000))}</p>`)
    .join("")
    .slice(0, 400000);
}
function stored(page: Page): Stored {
  let row = one<Stored>(
    "SELECT state,generation FROM whiteboards WHERE page_id=?",
    page.id,
  );
  if (!row) {
    const doc = new Y.Doc();
    doc.getMap("items");
    run(
      "INSERT OR IGNORE INTO whiteboards(page_id,state,generation) VALUES(?,?,?)",
      page.id,
      Y.encodeStateAsUpdate(doc),
      id(),
    );
    doc.destroy();
    row = one<Stored>(
      "SELECT state,generation FROM whiteboards WHERE page_id=?",
      page.id,
    )!;
  }
  return row;
}
export function whiteboardData(page: Page) {
  const s = stored(page);
  return {
    state: Buffer.from(s.state).toString("base64"),
    generation: s.generation,
  };
}
export function whiteboardSnapshotItems(page: Page) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stored(page).state);
    return whiteboardItems(doc);
  } finally {
    doc.destroy();
  }
}
const syncInput = z.object({
  pageId: z.string().uuid(),
  generation: z.string().max(100),
  update: z.string().max(8_000_000).optional(),
  cursor: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .nullable()
    .optional(),
});
export function syncWhiteboard(user: Identity, raw: unknown) {
  const b = syncInput.parse(raw);
  const page = requirePage(user, b.pageId, !!b.update);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  const s = stored(page);
  if (b.generation !== s.generation)
    throw new HttpError(
      409,
      "Eine neue Version des Whiteboards ist verfügbar. Es wird neu geladen.",
    );
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, s.state);
    if (b.update) {
      if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
      const before = Y.encodeStateVector(doc);
      Y.applyUpdate(doc, Buffer.from(b.update, "base64"));
      const changed = Y.encodeStateAsUpdate(doc, before).length > 2;
      if (changed) {
        const items = whiteboardItems(doc);
        if (items.length > 5000)
          throw new HttpError(413, "Zu viele Elemente auf dem Whiteboard.");
        if (
          !one(
            "SELECT id FROM snapshots WHERE page_id=? AND created_at>datetime('now','-5 minutes')",
            page.id,
          )
        )
          run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
            id(),
            page.id,
            s.state,
            whiteboardSummary(whiteboardSnapshotItems(page)),
            page.title,
            user.id,
          );
        run(
          "UPDATE whiteboards SET state=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
          Y.encodeStateAsUpdate(doc),
          page.id,
        );
        run(
          "UPDATE documents SET html=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
          whiteboardSummary(items),
          page.id,
        );
        run(
          "UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?",
          page.id,
        );
      }
    }
    if (b.cursor !== undefined)
      if (b.cursor)
        run(
          `INSERT INTO whiteboard_presence(page_id,user_id,name,x,y,seen) VALUES(?,?,?,?,?,?)
           ON CONFLICT(page_id,user_id) DO UPDATE SET name=excluded.name,x=excluded.x,y=excluded.y,seen=excluded.seen`,
          page.id,
          user.id,
          user.name,
          b.cursor.x,
          b.cursor.y,
          Date.now(),
        );
      else
        run(
          "DELETE FROM whiteboard_presence WHERE page_id=? AND user_id=?",
          page.id,
          user.id,
        );
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      presence: all<{ user_id: string; name: string; x: number; y: number }>(
        "SELECT user_id,name,x,y FROM whiteboard_presence WHERE page_id=? AND user_id!=? AND seen>?",
        page.id,
        user.id,
        Date.now() - 8000,
      ),
    };
  } finally {
    doc.destroy();
  }
}
// Copies (page duplicates, templates, archives) get the same board with a
// new identity; ids of pages on cards are mapped when copied along.
export function copyWhiteboard(
  source: string,
  target: string,
  pageIds?: Map<string, string>,
  rewrite: (value: string) => string = (value) => value,
) {
  const s = one<Stored>(
    "SELECT state,generation FROM whiteboards WHERE page_id=?",
    source,
  );
  if (s) writeWhiteboard(target, s.state, pageIds, rewrite);
}
// Stores a board for a new page from another board's state (copies,
// archives), with page ids on cards and image addresses mapped.
export function writeWhiteboard(
  target: string,
  state: Uint8Array,
  pageIds?: Map<string, string>,
  rewrite: (value: string) => string = (value) => value,
) {
  const from = new Y.Doc(),
    to = new Y.Doc();
  try {
    Y.applyUpdate(from, state);
    const items = to.getMap<Y.Map<unknown>>("items");
    for (const item of whiteboardItems(from)) {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(item))
        if (key !== "id")
          map.set(
            key,
            key === "pageId" && typeof value === "string"
              ? pageIds?.get(value) || value
              : key === "src" && typeof value === "string"
                ? rewrite(value)
                : value,
          );
      items.set(item.id, map);
    }
    run(
      "INSERT OR REPLACE INTO whiteboards(page_id,state,generation) VALUES(?,?,?)",
      target,
      Y.encodeStateAsUpdate(to),
      id(),
    );
    const summary = whiteboardSummary(whiteboardItems(to));
    run(
      "INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html",
      target,
      summary,
    );
  } finally {
    from.destroy();
    to.destroy();
  }
}
export function restoreWhiteboardSnapshot(page: Page, state: Uint8Array) {
  run(
    "UPDATE whiteboards SET state=?,generation=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
    state,
    id(),
    page.id,
  );
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    run(
      "UPDATE documents SET html=? WHERE page_id=?",
      whiteboardSummary(whiteboardItems(doc)),
      page.id,
    );
  } finally {
    doc.destroy();
  }
}
