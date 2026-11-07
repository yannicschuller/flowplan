import * as Y from "yjs";
import { z } from "zod";
import { all, id, one, run, nowText } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { escaped } from "./document-server";
import { itemText, type WhiteboardItem } from "./whiteboard-model";
import { applyRackLayout } from "./whiteboard-rack";
import type { Identity, Page } from "./types";
// Private mode: private writers' changes stay out of the shared board.
import { assertNoPrivateGap, withoutPrivateChanges } from "./whiteboard-private-guard";

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
  // Racks give devices their place (lib/whiteboard-rack.ts).
  return applyRackLayout(items.sort((a, b) => (a.z || 0) - (b.z || 0)));
}
export function whiteboardSummary(items: WhiteboardItem[]) {
  return items
    // Covered cards stay out of search and previews until uncovered.
    .filter((item) => !item.covered)
    .map(itemText)
    .filter(Boolean)
    .map((text) => `<p>${escaped(text.slice(0, 2000))}</p>`)
    .join("")
    .slice(0, 400000);
}
async function stored(page: Page): Promise<Stored> {
  let row = await one<Stored>(
    "SELECT state,generation FROM whiteboards WHERE page_id=?",
    page.id,
  );
  if (!row) {
    const doc = new Y.Doc();
    doc.getMap("items");
    await run(
      "INSERT INTO whiteboards(page_id,state,generation) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      page.id,
      Y.encodeStateAsUpdate(doc),
      id(),
    );
    doc.destroy();
    row = (await one<Stored>(
      "SELECT state,generation FROM whiteboards WHERE page_id=?",
      page.id,
    ))!;
  }
  return row;
}
export async function whiteboardData(page: Page) {
  const s = await stored(page);
  return {
    state: Buffer.from(s.state).toString("base64"),
    generation: s.generation,
  };
}
export async function whiteboardSnapshotItems(page: Page) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, (await stored(page)).state);
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
export async function syncWhiteboard(user: Identity, raw: unknown) {
  const b = syncInput.parse(raw);
  const page = await requirePage(user, b.pageId, !!b.update);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  await requireUnlocked(user, page);
  const s = await stored(page);
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
      Y.applyUpdate(doc, await withoutPrivateChanges(page.id, Buffer.from(b.update, "base64")));
      await assertNoPrivateGap(page.id, doc);
      const changed = Y.encodeStateAsUpdate(doc, before).length > 2;
      if (changed) {
        const items = whiteboardItems(doc);
        if (items.length > 5000)
          throw new HttpError(413, "Zu viele Elemente auf dem Whiteboard.");
        if (
          !(await one(
            "SELECT id FROM snapshots WHERE page_id=? AND created_at>?",
            page.id, nowText(Date.now() - 300_000),
          ))
        )
          await run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
            id(),
            page.id,
            s.state,
            whiteboardSummary(await whiteboardSnapshotItems(page)),
            page.title,
            user.id,
          );
        await run(
          "UPDATE whiteboards SET state=?,updated_at=? WHERE page_id=?",
          Y.encodeStateAsUpdate(doc), nowText(),
          page.id,
        );
        await run(
          "UPDATE documents SET html=?,updated_at=? WHERE page_id=?",
          whiteboardSummary(items), nowText(),
          page.id,
        );
        await run(
          "UPDATE pages SET updated_at=? WHERE id=?", nowText(),
          page.id,
        );
      }
    }
    if (b.cursor !== undefined)
      if (b.cursor)
        await run(
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
        await run(
          "DELETE FROM whiteboard_presence WHERE page_id=? AND user_id=?",
          page.id,
          user.id,
        );
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      presence: await all<{ user_id: string; name: string; x: number; y: number }>(
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
export async function copyWhiteboard(
  source: string,
  target: string,
  pageIds?: Map<string, string>,
  rewrite: (value: string) => string = (value) => value,
) {
  const s = await one<Stored>(
    "SELECT state,generation FROM whiteboards WHERE page_id=?",
    source,
  );
  if (s) await writeWhiteboard(target, s.state, pageIds, rewrite);
}
// Stores a board for a new page from another board's state (copies,
// archives), with page ids on cards and image addresses mapped.
export async function writeWhiteboard(
  target: string,
  state: Uint8Array,
  pageIds?: Map<string, string>,
  rewrite: (value: string) => string = (value) => value,
  // Records on cards (archives give their records new ids).
  rowIds?: Map<string, string>,
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
              : key === "rowId" && typeof value === "string"
                ? rowIds?.get(value) || value
                : key === "src" && typeof value === "string"
                  ? rewrite(value)
                  : value,
          );
      items.set(item.id, map);
    }
    await run(
      "INSERT INTO whiteboards(page_id,state,generation) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,generation=excluded.generation,updated_at=excluded.updated_at",
      target,
      Y.encodeStateAsUpdate(to),
      id(),
    );
    const summary = whiteboardSummary(whiteboardItems(to));
    await run(
      "INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html",
      target,
      summary,
    );
  } finally {
    from.destroy();
    to.destroy();
  }
}
export async function restoreWhiteboardSnapshot(page: Page, state: Uint8Array) {
  await run(
    "UPDATE whiteboards SET state=?,generation=?,updated_at=? WHERE page_id=?",
    state,
    id(), nowText(),
    page.id,
  );
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    await run(
      "UPDATE documents SET html=? WHERE page_id=?",
      whiteboardSummary(whiteboardItems(doc)),
      page.id,
    );
  } finally {
    doc.destroy();
  }
}
