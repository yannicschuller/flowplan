// Ink that belongs to a page (lib/ink/README.md): the sheets of a notebook
// (surface = sheet id) and the drawing blocks of a document (surface = the
// block's id). Same rules as the ink on PDFs (lib/ink-store.ts): readers of
// the page see it, editors change it, never in encrypted spaces or on
// locked pages; every save is a version.
//
// Saves are merged: a save based on an older version than the stored one
// is merged three-way with what was saved in between (lib/ink/merge.ts), so
// two people drawing on the same sheet or block at once both keep their
// strokes; the answer carries the merged ink and who saved in between.
//
// The ink of a drawing block lives here, not in the document's Yjs state:
// a document stays small, a stroke is one request, and concurrent strokes
// merge by id instead of one whole attribute replacing the other.
import { all, audit, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { emptyInk, INK_LIMITS, inkItemCount, inkText, parseInk, serializeInk, type InkDoc } from "./ink/model";
import { mergeInk } from "./ink/merge";
import { cleanRecognizedText } from "./ink/recognized";
import { recordPageEdit } from "./page-activity";
import type { Identity, Page } from "./types";

export const PAGE_INK_VERSIONS_KEPT = 30;
// Drawing blocks one document may hold.
export const MAX_SURFACES = 500;
const SURFACE = /^[\w-]{1,40}$/;
// Pages with surfaces: notebooks (sheets) and documents (drawing blocks).
const KINDS = new Set(["notebook", "document", "journal"]);

type InkRow = { data: string; version: number; updated_by: string | null; updated_at: number; recognized: string };
export type PageInkState = {
  doc: InkDoc;
  version: number;
  canEdit: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  recognized: string;
  // The ink came from the block it was copied from (not saved here yet).
  copied?: boolean;
};

const userName = (userId: string | null) => (userId ? (one<{ name: string }>("SELECT name FROM users WHERE id=?", userId)?.name ?? null) : null);
export function checkSurface(surface: unknown): string {
  if (typeof surface !== "string" || !SURFACE.test(surface)) throw new HttpError(400, "Ungültige Fläche.");
  return surface;
}
function inkPage(user: Identity, pageId: string): Page {
  const page = requirePage(user, pageId);
  requireUnlocked(user, page);
  if (!KINDS.has(page.kind)) throw new HttpError(400, "Diese Seite hat keine Handschrift.");
  return page;
}
export function mayEditInk(user: Identity, page: Page) {
  if (page.locked || isEncryptedPage(page) || user.apiScope === "read") return false;
  try {
    requirePage(user, page.id, true);
    return true;
  } catch {
    return false;
  }
}
// Notebook surfaces are its sheets.
function requireSurface(page: Page, surface: string) {
  if (page.kind === "notebook" && !one("SELECT 1 FROM notebook_sheets WHERE id=? AND page_id=?", surface, page.id))
    throw new HttpError(404, "Blatt nicht gefunden.");
}
const stored = (pageId: string, surface: string) =>
  one<InkRow>("SELECT data,version,updated_by,updated_at,recognized FROM page_ink WHERE page_id=? AND surface=?", pageId, surface);
// Only the surface's own page key is kept.
function surfaceDoc(doc: InkDoc, surface: string): InkDoc {
  const out = emptyInk();
  if (doc.pages[surface]?.length) out.pages[surface] = doc.pages[surface];
  return out;
}
function state(page: Page, surface: string, canEdit: boolean): PageInkState {
  const row = stored(page.id, surface);
  return {
    doc: surfaceDoc(parseInk(row?.data), surface),
    version: row?.version ?? 0,
    canEdit,
    updatedAt: row?.updated_at ?? null,
    updatedBy: userName(row?.updated_by ?? null),
    recognized: row?.recognized ?? "",
  };
}

// `from` ("pageId/surface"): a copied drawing block that has no ink of its
// own yet shows the ink of its source, if this person may read that page.
export function readPageInk(user: Identity, pageId: string, surface: string, from?: string | null): PageInkState {
  const page = inkPage(user, pageId);
  checkSurface(surface);
  if (isEncryptedPage(page)) return { doc: emptyInk(), version: 0, canEdit: false, updatedAt: null, updatedBy: null, recognized: "" };
  const result = state(page, surface, mayEditInk(user, page));
  if (result.version || !from || page.kind === "notebook") return result;
  const [sourcePage, sourceSurface] = String(from).split("/");
  try {
    const source = inkPage(user, sourcePage);
    if (isEncryptedPage(source)) return result;
    const row = stored(source.id, checkSurface(sourceSurface));
    if (!row) return result;
    const items = parseInk(row.data).pages[sourceSurface] || [];
    const doc = emptyInk();
    if (items.length) doc.pages[surface] = items;
    return { ...result, doc, copied: true };
  } catch {
    return result;
  }
}

// The versions of all surfaces of a page (for following changes of others).
export function pageInkVersions(user: Identity, pageId: string): Record<string, number> {
  const page = inkPage(user, pageId);
  if (isEncryptedPage(page)) return {};
  return Object.fromEntries(
    all<{ surface: string; version: number }>("SELECT surface,version FROM page_ink WHERE page_id=?", page.id).map((r) => [r.surface, r.version]),
  );
}

export type SavePageInkResult = {
  version: number;
  conflict: { by: string | null; at: number; version: number } | null;
  // The merged ink when someone saved in between.
  doc?: InkDoc;
};
export function savePageInk(user: Identity, pageId: string, surface: string, input: unknown, now = Date.now()): SavePageInkResult {
  const body = (input && typeof input === "object" ? input : {}) as { base?: unknown; doc?: unknown; recognized?: unknown };
  const base = Number(body.base);
  if (!Number.isInteger(base) || base < 0 || !body.doc || typeof body.doc !== "object") throw new HttpError(400, "Ungültige Eingabe.");
  checkSurface(surface);
  const page = inkPage(user, pageId);
  if (isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  requirePage(user, page.id, true);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (page.locked) throw new HttpError(409, "Seite ist gesperrt");
  requireSurface(page, surface);
  const ours = surfaceDoc(parseInk(body.doc), surface);
  return transaction(() => {
    const current = stored(page.id, surface);
    if (!current && page.kind !== "notebook") {
      const count = one<{ n: number }>("SELECT COUNT(*) n FROM page_ink WHERE page_id=?", page.id)?.n ?? 0;
      if (count >= MAX_SURFACES) throw new HttpError(413, "Zu viele Zeichnungen auf dieser Seite.");
    }
    let doc = ours;
    let merged = false;
    const conflict =
      current && current.version !== base ? { by: userName(current.updated_by), at: current.updated_at, version: current.version } : null;
    if (current && conflict) {
      // Three-way: what was saved at `base` (if still kept), ours, theirs.
      const original =
        base === 0
          ? emptyInk()
          : parseInk(one<{ data: string }>("SELECT data FROM page_ink_versions WHERE page_id=? AND surface=? AND version=?", page.id, surface, base)?.data);
      const known = base === 0 || !!one("SELECT 1 FROM page_ink_versions WHERE page_id=? AND surface=? AND version=?", page.id, surface, base);
      if (known) {
        doc = surfaceDoc(mergeInk(original, ours, parseInk(current.data)), surface);
        merged = true;
      }
    }
    const data = serializeInk(doc);
    if (data.length > INK_LIMITS.bytes) throw new HttpError(413, "Zu viel Handschrift auf einer Fläche.");
    const version = (current?.version ?? 0) + 1;
    // Recognised text sent with the ink belongs to this state; otherwise
    // the earlier text stays until the device recognises the new one.
    const recognized = body.recognized !== undefined ? cleanRecognizedText(body.recognized) : (current?.recognized ?? "");
    run(
      `INSERT INTO page_ink(page_id,surface,data,text,recognized,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(page_id,surface) DO UPDATE SET data=excluded.data,text=excluded.text,recognized=excluded.recognized,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      page.id,
      surface,
      data,
      inkText(doc).slice(0, 100000),
      doc.pages[surface]?.length ? recognized : "",
      version,
      user.id,
      now,
    );
    run("INSERT INTO page_ink_versions(page_id,surface,version,data,created_by,created_at) VALUES(?,?,?,?,?,?)", page.id, surface, version, data, user.id, now);
    run(
      "DELETE FROM page_ink_versions WHERE page_id=? AND surface=? AND version<=(SELECT version FROM page_ink_versions WHERE page_id=? AND surface=? ORDER BY version DESC LIMIT 1 OFFSET ?)",
      page.id,
      surface,
      page.id,
      surface,
      PAGE_INK_VERSIONS_KEPT,
    );
    run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
    audit(user.id, "page.ink", page.id, `${surface} (${inkItemCount(doc)})`);
    recordPageEdit(user, page.id);
    return { version, conflict, ...(merged ? { doc } : {}) };
  });
}

// Text the device recognised for the state `version` of a surface; dropped
// when the ink has changed since (a newer recognition follows).
export function savePageRecognized(user: Identity, pageId: string, surface: string, input: unknown) {
  const body = (input && typeof input === "object" ? input : {}) as { version?: unknown; recognized?: unknown };
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "Ungültige Eingabe.");
  checkSurface(surface);
  const page = inkPage(user, pageId);
  if (isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  requirePage(user, page.id, true);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (page.locked) throw new HttpError(409, "Seite ist gesperrt");
  const text = cleanRecognizedText(body.recognized);
  const changed = run("UPDATE page_ink SET recognized=? WHERE page_id=? AND surface=? AND version=?", text, page.id, surface, version);
  return { saved: Number(changed.changes) > 0 };
}

export function pageInkHistory(user: Identity, pageId: string, surface: string) {
  const page = inkPage(user, pageId);
  checkSurface(surface);
  if (isEncryptedPage(page)) return [];
  return all<{ version: number; data: string; created_at: number; name: string | null }>(
    "SELECT v.version,v.data,v.created_at,u.name FROM page_ink_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.page_id=? AND v.surface=? ORDER BY v.version DESC",
    page.id,
    surface,
  ).map((v) => ({ version: v.version, by: v.name, at: v.created_at, items: inkItemCount(parseInk(v.data)) }));
}
export function pageInkVersion(user: Identity, pageId: string, surface: string, version: number) {
  const page = inkPage(user, pageId);
  checkSurface(surface);
  const row = isEncryptedPage(page)
    ? null
    : one<{ data: string }>("SELECT data FROM page_ink_versions WHERE page_id=? AND surface=? AND version=?", page.id, surface, version);
  if (!row) throw new HttpError(404, "Version nicht gefunden.");
  return { version, doc: surfaceDoc(parseInk(row.data), surface) };
}

// ---- Server-side helpers (no permission checks: callers have done them) ----

// The current ink of every surface of a page.
export function pageInkDocs(pageId: string) {
  return new Map(
    all<{ surface: string; data: string; version: number; recognized: string }>("SELECT surface,data,version,recognized FROM page_ink WHERE page_id=?", pageId).map(
      (r) => [r.surface, { doc: surfaceDoc(parseInk(r.data), r.surface), version: r.version, recognized: r.recognized }],
    ),
  );
}
// Copies ink to another page (duplicates, imports); `surfaces` maps old to
// new surface ids (default: the same id). No versions are copied.
export function copyPageInk(fromPage: string, toPage: string, surfaces?: Map<string, string>, by: string | null = null) {
  for (const row of all<{ surface: string; data: string; text: string; recognized: string }>(
    "SELECT surface,data,text,recognized FROM page_ink WHERE page_id=?",
    fromPage,
  )) {
    const target = surfaces ? surfaces.get(row.surface) : row.surface;
    if (!target) continue;
    const doc = parseInk(row.data);
    const items = doc.pages[row.surface] || [];
    const moved = emptyInk();
    if (items.length) moved.pages[target] = items;
    writeSurface(toPage, target, moved, row.recognized, by);
  }
}
// Stores ink for a surface as a new version (imports, copies, templates).
export function writeSurface(pageId: string, surface: string, doc: InkDoc, recognized = "", by: string | null = null, now = Date.now()) {
  const clean = surfaceDoc(doc, surface);
  const data = serializeInk(clean);
  if (data.length > INK_LIMITS.bytes) throw new HttpError(413, "Zu viel Handschrift auf einer Fläche.");
  const version = (stored(pageId, surface)?.version ?? 0) + 1;
  run(
    `INSERT INTO page_ink(page_id,surface,data,text,recognized,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(page_id,surface) DO UPDATE SET data=excluded.data,text=excluded.text,recognized=excluded.recognized,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    pageId,
    surface,
    data,
    inkText(clean).slice(0, 100000),
    cleanRecognizedText(recognized),
    version,
    by,
    now,
  );
  run("INSERT INTO page_ink_versions(page_id,surface,version,data,created_by,created_at) VALUES(?,?,?,?,?,?)", pageId, surface, version, data, by, now);
}
export function deleteSurface(pageId: string, surface: string) {
  run("DELETE FROM page_ink WHERE page_id=? AND surface=?", pageId, surface);
  run("DELETE FROM page_ink_versions WHERE page_id=? AND surface=?", pageId, surface);
}

// Drawing blocks a document's HTML names (data-ink-block="…").
export function inkBlockIds(html: string) {
  return [...new Set([...html.matchAll(/data-ink-block="([\w-]{1,40})"/g)].map((m) => m[1]))];
}
// Text of the page's handwriting for search: typed text and what the
// device recognised. Notebooks: their sheets; documents: the drawing
// blocks still in the document.
export function pageInkSearchText(pageId: string, kind: string, html: string) {
  const rows = all<{ surface: string; text: string; recognized: string }>(
    kind === "notebook"
      ? "SELECT i.surface,i.text,i.recognized FROM page_ink i JOIN notebook_sheets s ON s.id=i.surface AND s.page_id=i.page_id WHERE i.page_id=? ORDER BY s.position"
      : "SELECT surface,text,recognized FROM page_ink WHERE page_id=?",
    pageId,
  );
  const blocks = kind === "notebook" ? null : new Set(inkBlockIds(html));
  return rows
    .filter((r) => !blocks || blocks.has(r.surface))
    .flatMap((r) => [r.text, r.recognized])
    .filter(Boolean)
    .join("\n");
}
