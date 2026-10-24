// Ink on PDF files (the PDF viewer's "Annotate"): stored next to the file,
// which stays untouched. Everyone who may read the page the file belongs
// to sees the ink; who may edit the page may change it. Every save is a
// new version (file_ink_versions); a save based on an older version than
// the stored one still wins, and the answer says who saved in between.
// Format and API: lib/ink/README.md.
import { all, audit, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { hiddenFileIds } from "./row-files";
import { publicFile } from "./publication";
import { INK_LIMITS, inkItemCount, inkText, parseInk, serializeInk, type InkDoc } from "./ink/model";
import type { Identity, Page } from "./types";

// Versions kept per file (the oldest go first).
export const INK_VERSIONS_KEPT = 50;

type FileRow = { id: string; page_id: string; name: string; mime: string };
type InkRow = { data: string; version: number; updated_by: string | null; updated_at: number };
export type InkState = {
  doc: InkDoc;
  version: number;
  canEdit: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
};

export const isPdfFile = (file: Pick<FileRow, "name" | "mime">) => file.mime === "application/pdf" || /\.pdf$/i.test(file.name || "");

function userName(userId: string | null) {
  return userId ? (one<{ name: string }>("SELECT name FROM users WHERE id=?", userId)?.name ?? null) : null;
}
function readableFile(user: Identity, fileId: string): { file: FileRow; page: Page } {
  const file = one<FileRow>("SELECT id,page_id,name,mime FROM files WHERE id=?", fileId);
  if (!file) throw new HttpError(404, "Datei fehlt.");
  const page = requirePage(user, file.page_id);
  requireUnlocked(user, page);
  if (hiddenFileIds(user, page).has(file.id)) throw new HttpError(404, "Datei fehlt.");
  if (!isPdfFile(file)) throw new HttpError(400, "Anmerkungen gibt es nur für PDFs.");
  return { file, page };
}
function mayEdit(user: Identity, page: Page) {
  if (page.locked || isEncryptedPage(page) || user.apiScope === "read") return false;
  try {
    requirePage(user, page.id, true);
    return true;
  } catch {
    return false;
  }
}
const stored = (fileId: string) => one<InkRow>("SELECT data,version,updated_by,updated_at FROM file_ink WHERE file_id=?", fileId);
function state(fileId: string, canEdit: boolean): InkState {
  const row = stored(fileId);
  return {
    doc: parseInk(row?.data),
    version: row?.version ?? 0,
    canEdit,
    updatedAt: row?.updated_at ?? null,
    updatedBy: userName(row?.updated_by ?? null),
  };
}

export function readFileInk(user: Identity, fileId: string): InkState {
  const { page } = readableFile(user, fileId);
  // Pages of encrypted spaces hold no plaintext on the server.
  if (isEncryptedPage(page)) return { doc: parseInk(null), version: 0, canEdit: false, updatedAt: null, updatedBy: null };
  return state(fileId, mayEdit(user, page));
}

// Read-only through a share link or publication.
export function publicFileInk(token: string, fileId: string): InkState {
  const file = publicFile(token, fileId);
  if (!isPdfFile(file)) throw new HttpError(400, "Anmerkungen gibt es nur für PDFs.");
  return state(file.id, false);
}

export type SaveInkResult = { version: number; conflict: { by: string | null; at: number; version: number } | null };
export function saveFileInk(user: Identity, fileId: string, input: unknown, now = Date.now()): SaveInkResult {
  const body = (input && typeof input === "object" ? input : {}) as { base?: unknown; doc?: unknown };
  const base = Number(body.base);
  if (!Number.isInteger(base) || base < 0 || !body.doc || typeof body.doc !== "object") throw new HttpError(400, "Ungültige Eingabe.");
  const { file, page } = readableFile(user, fileId);
  if (isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  requirePage(user, page.id, true);
  if (page.locked) throw new HttpError(409, "Seite ist gesperrt");
  const doc = parseInk(body.doc);
  const data = serializeInk(doc);
  if (data.length > INK_LIMITS.bytes) throw new HttpError(413, "Zu viele Anmerkungen für eine Datei.");
  return transaction(() => {
    const current = stored(file.id);
    const version = (current?.version ?? 0) + 1;
    // Someone else saved after this person opened the ink: theirs is kept as
    // a version, this one wins.
    const conflict =
      current && current.version !== base ? { by: userName(current.updated_by), at: current.updated_at, version: current.version } : null;
    run(
      `INSERT INTO file_ink(file_id,data,text,version,updated_by,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(file_id) DO UPDATE SET data=excluded.data,text=excluded.text,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      file.id,
      data,
      inkText(doc).slice(0, 100000),
      version,
      user.id,
      now,
    );
    run("INSERT INTO file_ink_versions(file_id,version,data,created_by,created_at) VALUES(?,?,?,?,?)", file.id, version, data, user.id, now);
    run(
      "DELETE FROM file_ink_versions WHERE file_id=? AND version<=(SELECT version FROM file_ink_versions WHERE file_id=? ORDER BY version DESC LIMIT 1 OFFSET ?)",
      file.id,
      file.id,
      INK_VERSIONS_KEPT,
    );
    audit(user.id, "file.ink", page.id, `${file.name} (${inkItemCount(doc)})`);
    return { version, conflict };
  });
}

export function fileInkVersions(user: Identity, fileId: string) {
  const { page } = readableFile(user, fileId);
  if (isEncryptedPage(page)) return [];
  return all<{ version: number; data: string; created_by: string | null; created_at: number; name: string | null }>(
    "SELECT v.version,v.data,v.created_by,v.created_at,u.name FROM file_ink_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.file_id=? ORDER BY v.version DESC",
    fileId,
  ).map((v) => ({ version: v.version, by: v.name, at: v.created_at, items: inkItemCount(parseInk(v.data)) }));
}
export function fileInkVersion(user: Identity, fileId: string, version: number) {
  const { page } = readableFile(user, fileId);
  const row = isEncryptedPage(page)
    ? null
    : one<{ data: string }>("SELECT data FROM file_ink_versions WHERE file_id=? AND version=?", fileId, version);
  if (!row) throw new HttpError(404, "Version nicht gefunden.");
  return { version, doc: parseInk(row.data) };
}
