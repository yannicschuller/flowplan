// Workshop facilitation on whiteboards beyond what the board document
// itself carries (timer, votes and "Folge mir" live in its meta map):
//
// - Private mode: everyone brainstorms on their own; others' new items are
//   only counted until "Aufdecken". The private changes of each person are
//   stored here, outside the board (see lib/whiteboard-private-mode.ts), so
//   nothing private reaches another browser, the search, exports, previews,
//   AI features or the API until they are merged into the board.
// - Planning poker: a deck, the items to estimate one after another and
//   every person's card – sent to the others only after the reveal.
// - "Alle zu mir holen": a one-time jump of everyone's view.
//
// Changes are announced on the board's live channel (lib/whiteboard-
// presence.ts) as a bare signal; each browser then asks for its own view.
import * as Y from "yjs";
import { z } from "zod";
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { signalBoard } from "./whiteboard-presence";
import { whiteboardItems, whiteboardSnapshotItems, whiteboardSummary } from "./whiteboard";
import { PRIVATE_LIMITS, privateItemCount, updateClients } from "./whiteboard-private-mode";
import {
  deckSchema,
  deckValue,
  estimationSchema,
  estimationView,
  type EstimateVote,
  type Estimation,
  type EstimationView,
} from "./whiteboard-estimation";
import { command } from "./api";
import type { Field, Identity, Page } from "./types";

const uuid = z.string().uuid();
const coordinate = z.number().finite().min(-1e7).max(1e7);
const viewRect = z.object({
  x: coordinate,
  y: coordinate,
  w: z.number().finite().min(1).max(1e6),
  h: z.number().finite().min(1).max(1e6),
});
export type BoardRect = z.infer<typeof viewRect>;
const itemId = z.string().min(1).max(100);
export const facilitationAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("private.start"), frame: itemId.nullable().optional() }),
  z.object({
    action: z.literal("private.sync"),
    session: uuid,
    // The tab's private writer (a Yjs client id).
    client: z.number().int().min(1).max(0xffffffff),
    update: z.string().max(Math.ceil((PRIVATE_LIMITS.update * 4) / 3) + 4).optional(),
    // The revision of the person's private changes the tab already has.
    known: z.number().int().min(-1).optional(),
  }),
  z.object({ action: z.literal("private.reveal"), session: uuid }),
  z.object({ action: z.literal("estimate.start"), items: z.array(itemId).min(1).max(100), deck: deckSchema }),
  // null takes the own card back.
  z.object({ action: z.literal("estimate.vote"), round: uuid, value: deckValue.nullable() }),
  z.object({ action: z.literal("estimate.reveal"), round: uuid }),
  z.object({ action: z.literal("estimate.next"), round: uuid, index: z.number().int().min(0).max(99).optional() }),
  z.object({ action: z.literal("estimate.revote"), round: uuid }),
  z.object({ action: z.literal("estimate.end") }),
  z.object({
    action: z.literal("estimate.result"),
    item: itemId,
    value: deckValue,
    // A record card: the property the value goes into.
    record: z.object({ pageId: uuid, rowId: uuid, fieldId: z.string().min(1).max(100) }).optional(),
  }),
  z.object({ action: z.literal("gather"), view: viewRect, frame: itemId.optional() }),
]);
export type FacilitationAction = z.infer<typeof facilitationAction>;

export type Gather = { type: "gather"; id: string; by: string; name: string; view: BoardRect; frame?: string; at: number };
export type PrivateView = {
  id: string;
  frame: string | null;
  by: string;
  name: string;
  since: number;
  // Items: own, everybody else's together (never who or what), people with any.
  mine: number;
  others: number;
  people: number;
  // The private writers of this person (all their tabs).
  clients: number[];
};
export type FacilitationState = {
  private: PrivateView | null;
  // The last reveal (a minute long), for those who missed the moment.
  revealed: { id: string; at: number; count: number } | null;
  estimation: EstimationView | null;
  gather: Gather | null;
  now: number;
};

const GATHER_MS = 60_000;
const hub = globalThis as unknown as { flowplanGathers?: Map<string, Gather> };
const gathers = (hub.flowplanGathers ??= new Map());

type Session = { id: string; page_id: string; frame_id: string | null; started_by: string | null; started_name: string; started_at: number; revealed_at: number | null; revealed_count: number | null };
const activeSession = (pageId: string) =>
  one<Session>("SELECT * FROM whiteboard_private WHERE page_id=? AND revealed_at IS NULL ORDER BY started_at DESC LIMIT 1", pageId);
function board(user: Identity, pageId: string, write: boolean) {
  const page = requirePage(user, pageId, write);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  return page;
}
const unlocked = (page: Page) => {
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
};
const announce = (pageId: string) => signalBoard(pageId, { type: "facilitation" });

// ---- the state one person sees ----
export function facilitationState(user: Identity, pageId: string): FacilitationState {
  const page = board(user, pageId, false);
  const now = Date.now();
  const session = activeSession(page.id);
  let view: PrivateView | null = null;
  if (session) {
    const parts = all<{ user_id: string; items: number }>("SELECT user_id,items FROM whiteboard_private_parts WHERE session_id=?", session.id);
    view = {
      id: session.id,
      frame: session.frame_id,
      by: session.started_by || "",
      name: session.started_name,
      since: session.started_at,
      mine: parts.find((p) => p.user_id === user.id)?.items || 0,
      others: parts.filter((p) => p.user_id !== user.id).reduce((n, p) => n + p.items, 0),
      people: parts.filter((p) => p.items > 0).length,
      clients: all<{ client: number }>(
        "SELECT client FROM whiteboard_private_clients WHERE session_id=? AND user_id=?",
        session.id,
        user.id,
      ).map((r) => Number(r.client)),
    };
  }
  const last = one<Session>(
    "SELECT * FROM whiteboard_private WHERE page_id=? AND revealed_at>? ORDER BY revealed_at DESC LIMIT 1",
    page.id,
    now - 60_000,
  );
  const gather = gathers.get(page.id);
  return {
    private: view,
    revealed: last ? { id: last.id, at: last.revealed_at!, count: last.revealed_count || 0 } : null,
    estimation: estimationFor(page.id, user.id),
    gather: gather && now - gather.at < GATHER_MS ? gather : null,
    now,
  };
}
function estimation(pageId: string): Estimation | null {
  const row = one<{ data: string }>("SELECT data FROM whiteboard_estimation WHERE page_id=?", pageId);
  if (!row) return null;
  const parsed = estimationSchema.safeParse(JSON.parse(row.data));
  return parsed.success ? parsed.data : null;
}
const votesOf = (pageId: string, round: string) =>
  all<EstimateVote>("SELECT user_id AS userId,name,value FROM whiteboard_estimate_votes WHERE page_id=? AND round=? ORDER BY at", pageId, round);
function estimationFor(pageId: string, viewer: string) {
  const session = estimation(pageId);
  return session ? estimationView(session, votesOf(pageId, session.round), viewer) : null;
}
function saveEstimation(pageId: string, session: Estimation) {
  run(
    "INSERT INTO whiteboard_estimation(page_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
    pageId,
    JSON.stringify(estimationSchema.parse(session)),
    Date.now(),
  );
}

// ---- the shared board ----
const sharedState = (pageId: string) => one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", pageId)?.state;
// Merges changes into the board like the normal sync does (a snapshot of the
// state before at most every five minutes, the search summary).
function applyToBoard(page: Page, user: Identity, updates: Uint8Array[]) {
  const state = sharedState(page.id);
  if (!state) throw new HttpError(404, "Seite nicht gefunden.");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    const before = Y.encodeStateVector(doc);
    for (const update of updates) Y.applyUpdate(doc, update);
    if (Y.encodeStateAsUpdate(doc, before).length <= 2) return;
    const items = whiteboardItems(doc);
    if (items.length > 5000) throw new HttpError(413, "Zu viele Elemente auf dem Whiteboard.");
    if (!one("SELECT id FROM snapshots WHERE page_id=? AND created_at>datetime('now','-5 minutes')", page.id))
      run(
        "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
        id(),
        page.id,
        state,
        whiteboardSummary(whiteboardSnapshotItems(page)),
        page.title,
        user.id,
      );
    run("UPDATE whiteboards SET state=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?", Y.encodeStateAsUpdate(doc), page.id);
    run("UPDATE documents SET html=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?", whiteboardSummary(items), page.id);
    run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
  } finally {
    doc.destroy();
  }
}
function boardItem(page: Page, key: string) {
  return whiteboardSnapshotItems(page).find((item) => item.id === key);
}
const decode = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > PRIVATE_LIMITS.update) throw new HttpError(413, "Anfrage zu groß.");
  try {
    return { bytes, clients: updateClients(bytes) };
  } catch {
    throw new HttpError(400, "Ungültige Eingabe.");
  }
};

// ---- actions ----
export function facilitate(user: Identity, pageId: string, raw: unknown): unknown {
  const body = facilitationAction.parse(raw);
  const page = board(user, pageId, true);
  switch (body.action) {
    case "private.start": {
      const started = transaction(() => {
        if (activeSession(page.id)) throw new HttpError(409, "Der private Modus läuft bereits.");
        if (body.frame && boardItem(page, body.frame)?.type !== "frame") throw new HttpError(400, "Rahmen nicht gefunden.");
        // Sessions revealed long ago are of no use any more.
        run("DELETE FROM whiteboard_private WHERE page_id=? AND revealed_at<?", page.id, Date.now() - 7 * 86400_000);
        const sid = id();
        run(
          "INSERT INTO whiteboard_private(id,page_id,frame_id,started_by,started_name,started_at) VALUES(?,?,?,?,?,?)",
          sid,
          page.id,
          body.frame || null,
          user.id,
          user.name,
          Date.now(),
        );
        return sid;
      }, user);
      announce(page.id);
      return { id: started };
    }
    case "private.sync":
      return privateSync(user, page, body);
    case "private.reveal": {
      const count = transaction(() => {
        const session = one<Session>("SELECT * FROM whiteboard_private WHERE id=? AND page_id=?", body.session, page.id);
        if (!session) throw new HttpError(404, "Der private Modus ist beendet.");
        if (session.revealed_at) return session.revealed_count || 0;
        unlocked(page);
        const parts = all<{ state: Uint8Array | null; items: number }>("SELECT state,items FROM whiteboard_private_parts WHERE session_id=?", session.id);
        applyToBoard(page, user, parts.flatMap((p) => (p.state ? [p.state] : [])));
        const total = parts.reduce((n, p) => n + p.items, 0);
        run("UPDATE whiteboard_private SET revealed_at=?,revealed_count=? WHERE id=?", Date.now(), total, session.id);
        run("UPDATE whiteboard_private_parts SET state=NULL WHERE session_id=?", session.id);
        return total;
      }, user);
      announce(page.id);
      return { count };
    }
    case "estimate.start": {
      const items = whiteboardSnapshotItems(page);
      const keys = [...new Set(body.items)].filter((key) => {
        const item = items.find((i) => i.id === key);
        return item && (item.type === "sticky" || (item.type === "card" && !!item.rowId));
      });
      if (!keys.length) throw new HttpError(400, "Wähle Zettel oder Datensatzkarten zum Schätzen aus.");
      transaction(() => {
        const previous = estimation(page.id);
        if (previous) run("DELETE FROM whiteboard_estimate_votes WHERE page_id=?", page.id);
        saveEstimation(page.id, {
          id: id(),
          deck: body.deck,
          items: keys,
          index: 0,
          round: id(),
          revealed: false,
          by: user.id,
          name: user.name,
          startedAt: Date.now(),
          results: {},
        });
      }, user);
      announce(page.id);
      return estimationFor(page.id, user.id);
    }
    case "estimate.vote":
    case "estimate.reveal":
    case "estimate.next":
    case "estimate.revote": {
      transaction(() => {
        const session = estimation(page.id);
        if (!session || session.round !== body.round) throw new HttpError(409, "Diese Schätzrunde ist schon vorbei.");
        if (body.action === "estimate.vote") {
          if (session.revealed) throw new HttpError(409, "Die Karten sind schon aufgedeckt.");
          if (body.value === null) run("DELETE FROM whiteboard_estimate_votes WHERE page_id=? AND round=? AND user_id=?", page.id, session.round, user.id);
          else {
            if (!session.deck.values.includes(body.value)) throw new HttpError(400, "Diesen Wert gibt es im Kartensatz nicht.");
            run(
              "INSERT INTO whiteboard_estimate_votes(page_id,round,user_id,name,value,at) VALUES(?,?,?,?,?,?) ON CONFLICT(page_id,round,user_id) DO UPDATE SET value=excluded.value,name=excluded.name",
              page.id,
              session.round,
              user.id,
              user.name,
              body.value,
              Date.now(),
            );
          }
          return;
        }
        if (body.action === "estimate.reveal") {
          saveEstimation(page.id, { ...session, revealed: true });
          return;
        }
        // Next item (or a chosen one), or the same item once more.
        const index =
          body.action === "estimate.revote"
            ? session.index
            : Math.min(session.items.length - 1, body.index ?? session.index + 1);
        run("DELETE FROM whiteboard_estimate_votes WHERE page_id=? AND round=?", page.id, session.round);
        saveEstimation(page.id, { ...session, index, round: id(), revealed: false });
      }, user);
      announce(page.id);
      return estimationFor(page.id, user.id);
    }
    case "estimate.end":
      transaction(() => {
        run("DELETE FROM whiteboard_estimation WHERE page_id=?", page.id);
        run("DELETE FROM whiteboard_estimate_votes WHERE page_id=?", page.id);
      }, user);
      announce(page.id);
      return { ok: true };
    case "estimate.result": {
      const session = estimation(page.id);
      if (!session || !session.items.includes(body.item)) throw new HttpError(409, "Diese Schätzrunde ist schon vorbei.");
      if (!session.deck.values.includes(body.value)) throw new HttpError(400, "Diesen Wert gibt es im Kartensatz nicht.");
      if (body.record) {
        const card = boardItem(page, body.item);
        if (card?.type !== "card" || card.pageId !== body.record.pageId || card.rowId !== body.record.rowId)
          throw new HttpError(400, "Diese Karte zeigt einen anderen Datensatz.");
        writeEstimate(user, body.record, body.value);
      }
      transaction(() => {
        const now = estimation(page.id);
        if (now) saveEstimation(page.id, { ...now, results: { ...now.results, [body.item]: body.value } });
      }, user);
      announce(page.id);
      return estimationFor(page.id, user.id);
    }
    case "gather": {
      if (body.frame) {
        const frame = boardItem(page, body.frame);
        if (frame?.type !== "frame") throw new HttpError(400, "Rahmen nicht gefunden.");
      }
      const gather: Gather = {
        type: "gather",
        id: id(),
        by: user.id,
        name: user.name,
        view: body.view,
        ...(body.frame ? { frame: body.frame } : {}),
        at: Date.now(),
      };
      gathers.set(page.id, gather);
      signalBoard(page.id, gather, user.id);
      return gather;
    }
  }
}

// One tab's private changes: registers its writer, keeps the changes with
// the person's others and answers with all of them (other tabs, a reload).
function privateSync(user: Identity, page: Page, body: Extract<FacilitationAction, { action: "private.sync" }>) {
  let changed = false;
  const result = transaction(() => {
    const session = one<Session>("SELECT * FROM whiteboard_private WHERE id=? AND page_id=?", body.session, page.id);
    if (!session) throw new HttpError(404, "Der private Modus ist beendet.");
    const registered = one<{ session_id: string; user_id: string }>(
      "SELECT session_id,user_id FROM whiteboard_private_clients WHERE page_id=? AND client=?",
      page.id,
      body.client,
    );
    if (registered && (registered.session_id !== session.id || registered.user_id !== user.id))
      throw new HttpError(409, "Diese Kennung ist schon vergeben.");
    if (!registered) {
      if (session.revealed_at) throw new HttpError(409, "Der private Modus ist beendet.");
      const state = sharedState(page.id);
      if (state && Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state)).has(body.client))
        throw new HttpError(409, "Diese Kennung ist schon vergeben.");
      if ((one<{ n: number }>("SELECT COUNT(*) n FROM whiteboard_private_clients WHERE session_id=? AND user_id=?", session.id, user.id)?.n || 0) >= 200)
        throw new HttpError(429, "Zu viele Anfragen. Bitte gleich erneut versuchen.");
      run("INSERT INTO whiteboard_private_clients(page_id,client,session_id,user_id) VALUES(?,?,?,?)", page.id, body.client, session.id, user.id);
    }
    const clients = all<{ client: number }>(
      "SELECT client FROM whiteboard_private_clients WHERE session_id=? AND user_id=?",
      session.id,
      user.id,
    ).map((r) => Number(r.client));
    if (body.update) {
      const { bytes, clients: writers } = decode(body.update);
      if ([...writers].some((c) => !clients.includes(c))) throw new HttpError(403, "Nur eigene private Änderungen.");
      if (session.revealed_at) {
        // Late changes (a tab that was offline): they are public by now.
        unlocked(page);
        applyToBoard(page, user, [bytes]);
        changed = true;
      } else {
        const part = one<{ state: Uint8Array | null; items: number }>(
          "SELECT state,items FROM whiteboard_private_parts WHERE session_id=? AND user_id=?",
          session.id,
          user.id,
        );
        const merged = part?.state ? Y.mergeUpdates([part.state, bytes]) : bytes;
        if (merged.length > PRIVATE_LIMITS.bytes) throw new HttpError(413, "Zu viele private Inhalte.");
        const items = privateItemCount(merged);
        if (items > PRIVATE_LIMITS.items) throw new HttpError(413, "Zu viele private Inhalte.");
        run(
          `INSERT INTO whiteboard_private_parts(session_id,user_id,state,items,rev) VALUES(?,?,?,?,1)
           ON CONFLICT(session_id,user_id) DO UPDATE SET state=excluded.state,items=excluded.items,rev=rev+1`,
          session.id,
          user.id,
          merged,
          items,
        );
        changed = items !== (part?.items || 0);
      }
    }
    const part = one<{ state: Uint8Array | null; rev: number }>(
      "SELECT state,rev FROM whiteboard_private_parts WHERE session_id=? AND user_id=?",
      session.id,
      user.id,
    );
    const rev = part?.rev || 0;
    return {
      clients,
      rev,
      revealed: !!session.revealed_at,
      ...(part?.state && rev !== body.known ? { state: Buffer.from(part.state).toString("base64") } : {}),
    };
  }, user);
  if (changed) announce(page.id);
  return result;
}

// "Ergebnis übernehmen" on a record card: into a number, select or text
// property, with every check of a normal change of the record.
function writeEstimate(user: Identity, ref: { pageId: string; rowId: string; fieldId: string }, value: string) {
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", ref.pageId)?.fields || "[]") as Field[];
  const field = fields.find((f) => f.id === ref.fieldId);
  if (!field || !["number", "select", "text"].includes(field.type)) throw new HttpError(400, "Eigenschaft kann nicht bearbeitet werden.");
  let cell: unknown = value;
  if (field.type === "number") {
    const n = Number(value.replace(",", "."));
    if (!Number.isFinite(n)) throw new HttpError(400, "Dieser Wert ist keine Zahl.");
    cell = n;
  } else if (field.type === "select" && !field.options?.includes(value))
    throw new HttpError(400, "Diesen Wert gibt es in der Auswahl nicht.");
  const row = one<{ version: number }>("SELECT version FROM rows WHERE id=? AND page_id=?", ref.rowId, ref.pageId);
  if (!row) throw new HttpError(404, "Datensatz fehlt.");
  command(user, { action: "row.update", pageId: ref.pageId, rowId: ref.rowId, version: row.version, cells: { [field.id]: cell } });
}
