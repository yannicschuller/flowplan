// Guests editing whiteboards and notebooks through an edit link (#280),
// without an account and without uploads. Same gate as guest editing of
// documents (lib/shared-content.ts, lib/share-presence.ts): the link exists,
// is not expired and unlocked if it has a password (publicPage →
// publicTree → checkShareProtection), its role is "editor" (read-only
// records below it make it a comment link), the page is part of the link,
// not locked for writes, not in a journal with a PIN and not in an
// encrypted space. Writes count against the link's live-edit limit and its
// daily byte budget.
//
// Whiteboards: like documents, every link works on its own projection of
// the board (a Yjs document in share_live) that holds only what the link may
// see: no records, authors or votes, links and cards only to pages of the
// link, images only through the link's file addresses, covered notes
// without their content. Guests merge their changes into the projection
// like members do into the board; the server compares the projection
// before and after, checks every changed element and property and writes
// what is allowed into the real board as plain values. Nothing a guest sends
// reaches the board as Yjs structure, and nothing outside the link is ever
// in what a guest receives.
//
// Notebooks: handwriting is saved per sheet like for members
// (lib/page-ink-store.ts writePageInk) – pictures only those already on
// the notebook; adding, duplicating, deleting (into the notebook's trash)
// and reordering sheets.
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { z } from "zod";
import { all, one, run, id, nowText, transaction, audit, lockFor, sql } from "./db";
import { HttpError } from "./auth";
import { publicFile, publicPage } from "./publication";
import { isEncryptedPage } from "./e2ee-server";
import { liveKey, loadLive, saveLive } from "./shared-live";
import { limitLiveChanges, limitShareRequests } from "./shared-content";
import { GUEST_LIVE_MB, takeAnonymousBudget } from "./anonymous-budget";
import { whiteboardData, whiteboardItems, whiteboardSummary } from "./whiteboard";
import { sharedArray, whiteboardItemTypes } from "./whiteboard-model";
import { ITEM_ID, parseElementLink, safeHref } from "./whiteboard-links";
import { parseTimeline } from "./whiteboard-diagram-model";
import { moveCursor, watchBoard } from "./whiteboard-presence";
import { securityEvent } from "./security-events";
import { pageInkDocs, pageInkState, writePageInk } from "./page-ink-store";
import { emptyInk, inkFiles } from "./ink/model";
import { createNotebook, notebookCommand, notebookOutline, notebookPaper, notebookSheets, type NotebookSheet } from "./notebook";
import type { Identity, Page } from "./types";

type Kind = "whiteboard" | "notebook";

// The page of the link a guest works on, checked for live editing.
export async function canvasAccess(token: string, pageId: string, kind: Kind, write = false) {
  const context = await publicPage(token, pageId);
  if (context.role !== "editor") throw new HttpError(403, "Dieser Link erlaubt keine Live-Bearbeitung.");
  const page = context.page;
  if (page.kind !== kind) throw new HttpError(400, kind === "whiteboard" ? "Kein Whiteboard." : "Kein Notizbuch.");
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  if (write && page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  // The pages of the link (for a shared record its included sub-pages).
  return { page, shared: new Set(context.pages.map((p) => p.id)) };
}

// How guests of this link appear to the others (as on documents).
export async function guestName(token: string) {
  const link =
    (await one<{ name: string }>("SELECT name FROM share_links WHERE token=?", token)) ||
    (await one<{ name: string }>("SELECT name FROM record_shares WHERE token=?", token));
  return link?.name ? `Gast · ${link.name}`.slice(0, 100) : "Gast";
}
// A stable pseudonym for a member, per link: guests never see user ids.
const pseudonym = (token: string, userId: string) =>
  `member:${createHash("sha256").update(`share-member\u0000${token}\u0000${userId}`).digest("hex").slice(0, 16)}`;
const guestAuthor = (token: string) => `guest:${createHash("sha256").update(`share-guest\u0000${token}`).digest("hex").slice(0, 16)}`;

// ---- Whiteboards ----

type Props = Record<string, unknown>;
const MAX_PROJECTION = 8_000_000;
const MAX_ITEMS = 5000;
const MAX_VALUE = 200_000;
const FILE = /^\/api\/files\/([\w-]+)$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// Covered notes show only their outline (components/whiteboard/render.tsx).
const UNCOVERED_TYPES = new Set(["frame", "connector", "comment"]);
const OUTLINE = ["type", "x", "y", "w", "h", "z", "rotation", "covered", "locked", "groups", "rackId", "u"];
const OUTLINE_KEYS = new Set(OUTLINE);
// Never shown to guests.
const HIDDEN = new Set(["rowId", "author", "votes"]);
// Shown, but guests do not change them: what an element is and what it
// points to inside the workspace, votes, stamps, covering (facilitation).
const READ_ONLY = new Set(["type", "pageId", "rowId", "author", "votes", "stamps", "covered"]);
// What guests may add: everything but cards (pages and records of the
// workspace are picked from lists guests do not have).
const GUEST_TYPES = new Set<string>(whiteboardItemTypes.filter((t) => t !== "card"));

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, canonical((value as Props)[k])]),
    );
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function plainItems(doc: Y.Doc) {
  const out = new Map<string, Props>();
  doc.getMap<unknown>("items").forEach((value, key) => {
    if (value instanceof Y.Map) out.set(key, value.toJSON() as Props);
  });
  return out;
}

type BoardContext = {
  token: string;
  page: Page;
  shared: Set<string>;
  // Files the board shows (src/url) and whether the link may serve them.
  files: Map<string, boolean>;
};
async function boardContext(token: string, page: Page, shared: Set<string>, items: Map<string, Props>): Promise<BoardContext> {
  const files = new Map<string, boolean>();
  for (const raw of items.values())
    for (const key of ["src", "url"]) {
      const m = FILE.exec(typeof raw[key] === "string" ? (raw[key] as string) : "");
      if (m) files.set(m[1], false);
    }
  for (const fid of files.keys()) {
    const file = await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=? AND deleted_at IS NULL", fid);
    if (!file) continue;
    // The board's own files are published with it (it shows them); files
    // of other pages only if the link publishes them there.
    files.set(fid, file.page_id === page.id || (await publicFile(token, fid).then(() => true, () => false)));
  }
  return { token, page, shared, files };
}
// A link on an element: web, mail, this board's elements, or elements of
// boards of the link.
function guestLink(value: unknown, shared: Set<string>) {
  const safe = safeHref(value);
  if (!safe) return null;
  if (/^\/?#page=/.test(safe)) {
    const target = parseElementLink(safe);
    if (!target?.pageId || !shared.has(target.pageId)) return null;
  }
  return safe;
}
function shownSource(value: unknown, ctx: BoardContext) {
  if (typeof value !== "string") return undefined;
  const file = FILE.exec(value);
  if (file) return ctx.files.get(file[1]) ? `/api/share/${ctx.token}/files/${file[1]}` : undefined;
  return /^https:\/\//i.test(value) ? value : undefined;
}
// An element as the link shows it (null: not shown at all).
export function projectItem(raw: Props, ctx: BoardContext): Props {
  const out: Props = {};
  if (raw.covered && !UNCOVERED_TYPES.has(String(raw.type))) {
    for (const key of OUTLINE) if (raw[key] !== undefined) out[key] = raw[key];
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (HIDDEN.has(key) || value === undefined) continue;
    if (key === "pageId") {
      if (typeof value === "string" && ctx.shared.has(value)) out.pageId = value;
    } else if (key === "src" || key === "url") {
      const shown = shownSource(value, ctx);
      if (shown) out[key] = shown;
    } else if (key === "link") {
      const link = guestLink(value, ctx.shared);
      if (link) out.link = link;
    } else if (key === "timeline") {
      // Timelines of a database show nothing of it (lib/whiteboard-diagram-model.ts).
      const timeline = parseTimeline(value);
      if (timeline && !timeline.source) out.timeline = timeline;
    } else if (key === "messages" && Array.isArray(value)) {
      out.messages = value
        .filter((m): m is Props => !!m && typeof m === "object")
        .map((m) => ({
          id: String(m.id ?? ""),
          author: typeof m.author === "string" && m.author.startsWith("guest:") ? m.author : "",
          name: String(m.name ?? ""),
          text: String(m.text ?? ""),
          at: Number(m.at) || 0,
        }));
    } else if (key === "stamps" && value && typeof value === "object") {
      out.stamps = Object.fromEntries(Object.entries(value as Props).map(([who, stamp]) => [who.startsWith("guest:") ? who : pseudonym(ctx.token, who), stamp]));
    } else out[key] = value;
  }
  return out;
}
function projectAll(real: Y.Doc, ctx: BoardContext) {
  const out = new Map<string, Props>();
  for (const [key, raw] of plainItems(real)) out.set(key, projectItem(raw, ctx));
  return out;
}
// Brings the projection to `target`, changing only what differs.
function setProjection(doc: Y.Doc, target: Map<string, Props>) {
  const items = doc.getMap<unknown>("items");
  doc.transact(() => {
    for (const key of [...items.keys()]) if (!target.has(key)) items.delete(key);
    for (const [key, props] of target) {
      const current = items.get(key);
      if (!(current instanceof Y.Map)) {
        items.set(key, new Y.Map<unknown>(Object.entries(props)));
        continue;
      }
      const shown = current.toJSON() as Props;
      for (const k of Object.keys(shown)) if (!(k in props)) current.delete(k);
      for (const [k, v] of Object.entries(props)) if (!same(shown[k], v)) current.set(k, v);
    }
  }, "server");
}

type Verdict = { value: unknown } | { skip: true } | { refused: string };
// A property value a guest wrote, as the board stores it.
function guestValue(key: string, value: unknown, ctx: BoardContext, current?: Props): Verdict {
  if (READ_ONLY.has(key)) return { skip: true };
  if (!KEY.test(key)) return { refused: key };
  if (value === undefined) return { value: undefined };
  if ((JSON.stringify(value) ?? "").length > MAX_VALUE) return { refused: key };
  if (key === "src" || key === "url") {
    if (typeof value !== "string" || value.length > 2000) return { refused: key };
    if (/^https:\/\/[^\s<>"'`\\]+$/i.test(value)) return { value };
    // A picture or PDF already on the board, e.g. copied: back to its own address.
    const own = new RegExp(`^/api/share/${ctx.token.replace(/[^\w-]/g, "")}/files/([\\w-]+)$`).exec(value);
    if (own && ctx.files.get(own[1])) return { value: `/api/files/${own[1]}` };
    return { refused: key };
  }
  if (key === "link") {
    const link = guestLink(value, ctx.shared);
    return link ? { value: link } : { refused: key };
  }
  if (key === "timeline") {
    if (current?.timeline && (current.timeline as Props).source) return { skip: true };
    const timeline = parseTimeline(value);
    if (!timeline) return { refused: key };
    const { source: _source, ...own } = timeline;
    return { value: own };
  }
  return { value };
}
function guestMessages(list: unknown, known: Set<string>, author: string, name: string) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    if (!m || typeof m !== "object") return [];
    const message = m as Props;
    const mid = typeof message.id === "string" && /^[\w-]{1,64}$/.test(message.id) ? message.id : null;
    const text = typeof message.text === "string" ? message.text.trim().slice(0, 5000) : "";
    if (!mid || known.has(mid) || !text) return [];
    known.add(mid);
    return [{ id: mid, author, name, text, at: Date.now() }];
  });
}
// The guest's changes (projection before → after) written into the board.
function applyGuestChanges(real: Y.Doc, before: Map<string, Props>, after: Map<string, Props>, ctx: BoardContext, guest: { author: string; name: string }) {
  const items = real.getMap<unknown>("items");
  const refused: string[] = [];
  let changed = false,
    added = 0;
  real.transact(() => {
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(key),
        now = after.get(key);
      if (was && !now) {
        if (items.has(key)) {
          items.delete(key);
          changed = true;
        }
        continue;
      }
      if (!now || (was && same(was, now))) continue;
      if (!was) {
        // A new element.
        const type = String(now.type ?? "");
        const finite = ["x", "y", "w", "h"].every((k) => typeof now[k] === "number" && Number.isFinite(now[k] as number));
        if (!ITEM_ID.test(key) || items.has(key) || !GUEST_TYPES.has(type) || !finite || ++added > 1000) {
          refused.push(`new ${type || "?"}`);
          continue;
        }
        const map = new Y.Map<unknown>();
        map.set("type", type);
        for (const [k, v] of Object.entries(now)) {
          if (k === "type") continue;
          if (k === "messages") {
            const messages = guestMessages(v, new Set(), guest.author, guest.name);
            if (messages.length) map.set("messages", messages);
            continue;
          }
          const verdict = guestValue(k, v, ctx);
          if ("refused" in verdict) refused.push(k);
          else if ("value" in verdict && verdict.value !== undefined) map.set(k, verdict.value);
        }
        items.set(key, map);
        changed = true;
        continue;
      }
      const map = items.get(key);
      if (!(map instanceof Y.Map)) continue;
      const current = map.toJSON() as Props;
      const covered = !!current.covered && !UNCOVERED_TYPES.has(String(current.type));
      for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (same(was[k], now[k])) continue;
        // A covered note can be moved, not read or rewritten.
        if (covered && !OUTLINE_KEYS.has(k)) continue;
        if (k === "messages") {
          // Guests add to a thread; they do not rewrite it.
          const known = new Set((Array.isArray(current.messages) ? current.messages : []).map((m) => String((m as Props)?.id)));
          const messages = guestMessages(now.messages, known, guest.author, guest.name);
          if (messages.length) {
            sharedArray(map as Y.Map<unknown>, "messages").push(messages);
            changed = true;
          }
          continue;
        }
        const verdict = guestValue(k, now[k], ctx, current);
        if ("refused" in verdict) refused.push(k);
        else if ("value" in verdict) {
          if (verdict.value === undefined) map.delete(k);
          else map.set(k, verdict.value);
          changed = true;
        }
      }
    }
  }, "guest");
  return { changed, refused };
}

async function realBoard(page: Page, forUpdate: boolean) {
  const query = `SELECT state,generation FROM whiteboards WHERE page_id=?${forUpdate ? sql.forUpdate() : ""}`;
  let row = await one<{ state: Uint8Array; generation: string }>(query, page.id);
  if (!row) {
    await whiteboardData(page);
    row = (await one<{ state: Uint8Array; generation: string }>(query, page.id))!;
  }
  return row;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const NEW_VERSION = "Eine neue Version des Whiteboards ist verfügbar. Es wird neu geladen.";
const boardInput = z.object({
  pageId: z.uuid(),
  // The projection's generation the guest works on (from the first load).
  generation: z.string().max(100).optional(),
  update: z.string().max(5_600_000).optional(),
});
// Loads (without `generation`) or synchronises a guest's board: the
// projection's full state and its generation, like whiteboard.sync.
export async function syncSharedBoard(token: string, input: unknown) {
  const b = boardInput.parse(input);
  return await transaction(async () => {
    const { page, shared } = await canvasAccess(token, b.pageId, "whiteboard", !!b.update);
    const key = liveKey(token, page.id, "whiteboard");
    await lockFor(`share-board:${key}`);
    const board = await realBoard(page, !!b.update);
    const real = new Y.Doc(),
      projection = new Y.Doc();
    try {
      Y.applyUpdate(real, board.state);
      const stored = await loadLive(key);
      let pgen: string;
      // A projection that has grown with the history of guest edits, or a
      // board restored to another version, starts afresh (guests reload).
      if (!stored || stored.generation !== board.generation || stored.state.byteLength > MAX_PROJECTION) pgen = id();
      else {
        Y.applyUpdate(projection, stored.state);
        pgen = stored.pgen;
      }
      if (b.generation !== undefined && b.generation !== pgen) throw new HttpError(409, NEW_VERSION);
      let ctx = await boardContext(token, page, shared, plainItems(real));
      // Members' changes since the last exchange.
      setProjection(projection, projectAll(real, ctx));
      if (b.update) {
        if (b.generation === undefined) throw new HttpError(409, NEW_VERSION);
        // Every update counts, also one that changes nothing visible.
        await limitLiveChanges(token);
        await takeAnonymousBudget(`live:${token}`, Math.ceil((b.update.length * 3) / 4), GUEST_LIVE_MB);
        const before = plainItems(projection);
        try {
          Y.applyUpdate(projection, Buffer.from(b.update, "base64"), "guest");
        } catch {
          throw new HttpError(400, "Ungültige Änderung.");
        }
        const { changed, refused } = applyGuestChanges(real, before, plainItems(projection), ctx, {
          author: guestAuthor(token),
          name: await guestName(token),
        });
        // Values no browser of the board writes (scripts, foreign files).
        if (refused.length) securityEvent("blocked.content", { detail: `share link ${token.slice(0, 6)}… whiteboard ${refused.slice(0, 5).join(", ")}` });
        if (changed) {
          const items = whiteboardItems(real);
          if (items.length > MAX_ITEMS && items.length > before.size) throw new HttpError(413, "Zu viele Elemente auf dem Whiteboard.");
          if (!(await one("SELECT id FROM snapshots WHERE page_id=? AND created_at>?", page.id, nowText(Date.now() - 300_000)))) {
            const previous = new Y.Doc();
            try {
              Y.applyUpdate(previous, board.state);
              await run(
                "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
                id(),
                page.id,
                board.state,
                whiteboardSummary(whiteboardItems(previous)),
                page.title,
                "guest",
              );
            } finally {
              previous.destroy();
            }
            // Like the snapshots: once in five minutes of guest editing.
            await audit("guest", "share.whiteboard", page.id);
          }
          await run("UPDATE whiteboards SET state=?,updated_at=? WHERE page_id=?", Y.encodeStateAsUpdate(real), nowText(), page.id);
          await run("UPDATE documents SET html=?,updated_at=? WHERE page_id=?", whiteboardSummary(items), nowText(), page.id);
          await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), page.id);
          ctx = await boardContext(token, page, shared, plainItems(real));
        }
        // What was refused goes back to how the board has it.
        setProjection(projection, projectAll(real, ctx));
      }
      const state = Y.encodeStateAsUpdate(projection);
      await saveLive(key, { state, source_html: "", generation: board.generation, pgen });
      return { state: b64(state), generation: pgen, presence: [] as never[] };
    } finally {
      real.destroy();
      projection.destroy();
    }
  });
}

const cursorInput = z.object({
  pageId: z.uuid(),
  clientId: z.uuid(),
  point: z
    .object({
      x: z.number().finite().min(-1e7).max(1e7),
      y: z.number().finite().min(-1e7).max(1e7),
      laser: z.boolean().optional(),
      view: z
        .object({
          x: z.number().finite().min(-1e7).max(1e7),
          y: z.number().finite().min(-1e7).max(1e7),
          w: z.number().finite().min(1).max(1e6),
          h: z.number().finite().min(1).max(1e6),
        })
        .optional(),
    })
    .nullable(),
});
// A guest's pointer on the board, under the link's guest name.
export async function sharedBoardCursor(token: string, input: unknown) {
  const b = cursorInput.parse(input);
  const { page } = await canvasAccess(token, b.pageId, "whiteboard");
  moveCursor(page.id, { id: `guest:${b.clientId}`, name: await guestName(token) }, b.point);
}
// The others' pointers for a guest: members under a pseudonym, nothing of
// the workshop signals (voting, private mode …).
export function watchSharedBoard(token: string, pageId: string, clientId: string, send: (chunk: string) => void) {
  const rename = (cursor: Props) =>
    typeof cursor.userId === "string" && !cursor.userId.startsWith("guest:") ? { ...cursor, userId: pseudonym(token, cursor.userId) } : cursor;
  return watchBoard(pageId, `guest:${clientId}`, (event) => {
    const match = /^data: (.*)\n\n$/s.exec(event);
    if (!match) return send(event);
    let data: Props;
    try {
      data = JSON.parse(match[1]);
    } catch {
      return;
    }
    if (data.type === "snapshot") send(`data: ${JSON.stringify({ type: "snapshot", cursors: ((data.cursors as Props[]) || []).map(rename) })}\n\n`);
    else if (data.type === "cursor" || data.type === "leave") send(`data: ${JSON.stringify(rename(data))}\n\n`);
  });
}

// ---- Notebooks ----

// Links on sheets: to sheets, or to pages of the link.
const sheetsForGuests = (sheets: NotebookSheet[], shared: Set<string>): NotebookSheet[] =>
  sheets.map((sheet) => {
    if (!sheet.links) return sheet;
    const links = sheet.links.filter((l) => "sheet" in l.target || shared.has(l.target.page));
    const { links: _all, ...rest } = sheet;
    return links.length ? { ...rest, links } : rest;
  });

export async function sharedNotebook(token: string, pageId: string) {
  const { page, shared } = await canvasAccess(token, pageId, "notebook");
  const inks = await pageInkDocs(page.id);
  const sheets = await notebookSheets(page.id);
  return {
    paper: await notebookPaper(page.id),
    sheets: sheetsForGuests(sheets, shared).map((sheet) => {
      const ink = inks.get(sheet.id);
      return { ...sheet, ink: ink?.doc ?? emptyInk(), version: ink?.version ?? 0 };
    }),
    canEdit: !page.locked,
    outline: await notebookOutline(page.id, sheets),
  };
}
export async function sharedInkVersions(token: string, pageId: string) {
  const { page } = await canvasAccess(token, pageId, "notebook");
  return Object.fromEntries((await all<{ surface: string; version: number }>("SELECT surface,version FROM page_ink WHERE page_id=?", page.id)).map((r) => [r.surface, r.version]));
}
export async function sharedInk(token: string, pageId: string, surface: string) {
  const { page } = await canvasAccess(token, pageId, "notebook");
  const state = await pageInkState(page, surface, !page.locked);
  return { doc: state.doc, version: state.version, canEdit: state.canEdit };
}
export async function saveSharedInk(token: string, pageId: string, surface: string, input: unknown) {
  return await transaction(async () => {
    const { page } = await canvasAccess(token, pageId, "notebook", true);
    await limitLiveChanges(token);
    await takeAnonymousBudget(`live:${token}`, JSON.stringify(input ?? null).length, GUEST_LIVE_MB);
    // Pictures: only those the notebook already shows.
    const files = new Set<string>();
    for (const ink of (await pageInkDocs(page.id)).values()) for (const file of inkFiles(ink.doc)) files.add(file.toLowerCase());
    const body = (input && typeof input === "object" ? input : {}) as { base?: unknown; doc?: unknown };
    const result = await writePageInk(page, surface, { base: body.base, doc: body.doc, knows: ["image"] }, { id: null, audit: "guest", files });
    return result;
  });
}
// Notebook commands for guests act as nobody in particular.
const GUEST = { id: "guest", name: "Gast", email: "", groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
const commandInput = z.object({
  pageId: z.uuid(),
  op: z.enum(["sheet.add", "sheet.duplicate", "sheet.delete", "sheet.move"]),
  after: z.string().max(40).nullable().optional(),
  at: z.literal("start").optional(),
  sheetId: z.string().max(40).optional(),
  order: z.array(z.string().max(40)).max(2000).optional(),
});
export async function sharedNotebookCommand(token: string, input: unknown) {
  const b = commandInput.parse(input);
  return await transaction(async () => {
    const { page, shared } = await canvasAccess(token, b.pageId, "notebook", true);
    await limitShareRequests(token);
    await createNotebook(page.id);
    // Only these fields: no paper templates, no files.
    const result = await notebookCommand(GUEST, page, `notebook.${b.op}`, {
      ...(b.after !== undefined ? { after: b.after } : {}),
      ...(b.at ? { at: b.at } : {}),
      ...(b.sheetId ? { sheetId: b.sheetId } : {}),
      ...(b.order ? { order: b.order } : {}),
    });
    await audit("guest", "share.notebook", page.id, b.op);
    return { ...result, sheets: sheetsForGuests(result.sheets, shared) };
  });
}
