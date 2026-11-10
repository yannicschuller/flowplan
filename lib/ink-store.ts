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
import { keepShapes } from "./ink/merge";
import { cleanRecognizedMap, parseRecognizedMap } from "./ink/recognized";
import type { Identity, Page } from "./types";

// Versions kept per file (the oldest go first).
export const INK_VERSIONS_KEPT = 50;

type FileRow = { id: string; page_id: string; name: string; mime: string };
type InkRow = { data: string; version: number; updated_by: string | null; updated_at: number; recognized: string };
export type InkState = {
  doc: InkDoc;
  version: number;
  canEdit: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  // Text recognised in the handwriting on the device, per PDF page
  // (lib/ink/recognition.ts); only ever plain text.
  recognized: Record<string, string>;
};

export const isPdfFile = (file: Pick<FileRow, "name" | "mime">) => file.mime === "application/pdf" || /\.pdf$/i.test(file.name || "");

async function userName(userId: string | null) {
  return userId ? ((await one<{ name: string }>("SELECT name FROM users WHERE id=?", userId))?.name ?? null) : null;
}
async function readableFile(user: Identity, fileId: string): Promise<{ file: FileRow; page: Page }> {
  const file = await one<FileRow>("SELECT id,page_id,name,mime FROM files WHERE id=?", fileId);
  if (!file) throw new HttpError(404, "Datei fehlt.");
  const page = await requirePage(user, file.page_id);
  await requireUnlocked(user, page);
  if ((await hiddenFileIds(user, page)).has(file.id)) throw new HttpError(404, "Datei fehlt.");
  if (!isPdfFile(file)) throw new HttpError(400, "Anmerkungen gibt es nur für PDFs.");
  return { file, page };
}
async function mayEdit(user: Identity, page: Page) {
  if (page.locked || await isEncryptedPage(page) || user.apiScope === "read") return false;
  try {
    await requirePage(user, page.id, true);
    return true;
  } catch {
    return false;
  }
}
const stored = async (fileId: string) => await one<InkRow>("SELECT data,version,updated_by,updated_at,recognized FROM file_ink WHERE file_id=?", fileId);
async function state(fileId: string, canEdit: boolean): Promise<InkState> {
  const row = await stored(fileId);
  return {
    doc: parseInk(row?.data),
    version: row?.version ?? 0,
    canEdit,
    updatedAt: row?.updated_at ?? null,
    updatedBy: await userName(row?.updated_by ?? null),
    recognized: parseRecognizedMap(row?.recognized),
  };
}

export async function readFileInk(user: Identity, fileId: string): Promise<InkState> {
  const { page } = await readableFile(user, fileId);
  // Pages of encrypted spaces hold no plaintext on the server.
  if (await isEncryptedPage(page)) return { doc: parseInk(null), version: 0, canEdit: false, updatedAt: null, updatedBy: null, recognized: {} };
  return await state(fileId, await mayEdit(user, page));
}

// Read-only through a share link or publication.
export async function publicFileInk(token: string, fileId: string): Promise<InkState> {
  const file = await publicFile(token, fileId);
  if (!isPdfFile(file)) throw new HttpError(400, "Anmerkungen gibt es nur für PDFs.");
  return await state(file.id, false);
}

export type SaveInkResult = { version: number; conflict: { by: string | null; at: number; version: number } | null };
export async function saveFileInk(user: Identity, fileId: string, input: unknown, now = Date.now()): Promise<SaveInkResult> {
  const body = (input && typeof input === "object" ? input : {}) as { base?: unknown; doc?: unknown; recognized?: unknown };
  const base = Number(body.base);
  if (!Number.isInteger(base) || base < 0 || !body.doc || typeof body.doc !== "object") throw new HttpError(400, "Ungültige Eingabe.");
  const { file, page } = await readableFile(user, fileId);
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  await requirePage(user, page.id, true);
  if (page.locked) throw new HttpError(409, "Seite ist gesperrt");
  const incoming = parseInk(body.doc);
  if (serializeInk(incoming).length > INK_LIMITS.bytes) throw new HttpError(413, "Zu viele Anmerkungen für eine Datei.");
  return await transaction(async () => {
    const current = await stored(file.id);
    // Strokes saved back unchanged by a version without shapes keep theirs.
    const doc = keepShapes(current ? parseInk(current.data) : null, incoming);
    const data = serializeInk(doc);
    if (data.length > INK_LIMITS.bytes) throw new HttpError(413, "Zu viele Anmerkungen für eine Datei.");
    const version = (current?.version ?? 0) + 1;
    // Someone else saved after this person opened the ink: theirs is kept as
    // a version, this one wins.
    const conflict =
      current && current.version !== base ? { by: await userName(current.updated_by), at: current.updated_at, version: current.version } : null;
    // Recognised text of pages that still have ink; sent along it replaces
    // that page's text, otherwise the earlier text stays until the device
    // recognises the new state.
    const recognized = { ...parseRecognizedMap(current?.recognized), ...cleanRecognizedMap(body.recognized) };
    for (const key of Object.keys(recognized)) if (!doc.pages[key]?.length) delete recognized[key];
    await run(
      `INSERT INTO file_ink(file_id,data,text,recognized,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(file_id) DO UPDATE SET data=excluded.data,text=excluded.text,recognized=excluded.recognized,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      file.id,
      data,
      inkText(doc).slice(0, 100000),
      JSON.stringify(cleanRecognizedMap(recognized)),
      version,
      user.id,
      now,
    );
    await run("INSERT INTO file_ink_versions(file_id,version,data,created_by,created_at) VALUES(?,?,?,?,?)", file.id, version, data, user.id, now);
    await run(
      "DELETE FROM file_ink_versions WHERE file_id=? AND version<=(SELECT version FROM file_ink_versions WHERE file_id=? ORDER BY version DESC LIMIT 1 OFFSET ?)",
      file.id,
      file.id,
      INK_VERSIONS_KEPT,
    );
    await audit(user.id, "file.ink", page.id, `${file.name} (${inkItemCount(doc)})`);
    return { version, conflict };
  });
}

// Text the device recognised on pages of the state `version`; dropped when
// the ink changed since (a newer recognition follows).
export async function saveFileRecognized(user: Identity, fileId: string, input: unknown) {
  const body = (input && typeof input === "object" ? input : {}) as { version?: unknown; recognized?: unknown };
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "Ungültige Eingabe.");
  const { file, page } = await readableFile(user, fileId);
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  await requirePage(user, page.id, true);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (page.locked) throw new HttpError(409, "Seite ist gesperrt");
  return await transaction(async () => {
    const current = await stored(file.id);
    if (!current || current.version !== version) return { saved: false };
    const doc = parseInk(current.data);
    const next = { ...parseRecognizedMap(current.recognized), ...cleanRecognizedMap(body.recognized) };
    for (const key of Object.keys(next)) if (!doc.pages[key]?.length) delete next[key];
    await run("UPDATE file_ink SET recognized=? WHERE file_id=? AND version=?", JSON.stringify(cleanRecognizedMap(next)), file.id, version);
    return { saved: true };
  });
}

export async function fileInkVersions(user: Identity, fileId: string) {
  const { page } = await readableFile(user, fileId);
  if (await isEncryptedPage(page)) return [];
  return (await all<{ version: number; data: string; created_by: string | null; created_at: number; name: string | null }>(
    "SELECT v.version,v.data,v.created_by,v.created_at,u.name FROM file_ink_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.file_id=? ORDER BY v.version DESC",
    fileId,
  )).map((v) => ({ version: v.version, by: v.name, at: v.created_at, items: inkItemCount(parseInk(v.data)) }));
}
export async function fileInkVersion(user: Identity, fileId: string, version: number) {
  const { page } = await readableFile(user, fileId);
  const row = (await isEncryptedPage(page))
    ? null
    : (await one<{ data: string }>("SELECT data FROM file_ink_versions WHERE file_id=? AND version=?", fileId, version));
  if (!row) throw new HttpError(404, "Version nicht gefunden.");
  return { version, doc: parseInk(row.data) };
}
