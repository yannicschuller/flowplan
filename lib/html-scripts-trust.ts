// "Bei dieser Datei immer zulassen" (#425): the HTML files whose scripts a
// person lets run whenever they open them, on all their devices – kept in
// users.html_scripts as JSON, only for that person. The viewer
// (components/html-viewer-dialog.tsx) starts with scripts running when the
// preview's HEAD request says so (X-Flowplan-Preview-Remembered, set by
// app/api/files/[id]/html/handler.ts); everyone else is still asked.
//
// An entry is the file's id and the SHA-256 of its content, computed here
// on the server: a file whose bytes changed asks again. Never for shared
// links and published pages (their preview route does not ask), and never
// while the instance switches scripts off (FLOWPLAN_HTML_PREVIEW_SCRIPTS=0).
// At most 500 files; allowing one more drops the oldest.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { readableFile, type StoredFile } from "./file-access";
import { localUpload, uploadPath } from "./storage";
import { isHtmlName } from "./html-files";
import { htmlPreviewLimit, htmlPreviewScriptsAllowed } from "./html-preview";
import { ct } from "./content-locale";
import type { Identity } from "./types";

export const HTML_SCRIPTS_MAX = 500;
type Entry = { id: string; hash: string; at: number };
const entrySchema = z.object({ id: z.uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/), at: z.number() });

// Read leniently: whatever is not a valid entry is left out.
export function htmlScriptsEntries(raw: string | null | undefined): Entry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const entry = entrySchema.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}
async function entriesOf(userId: string) {
  return htmlScriptsEntries((await one<{ html_scripts: string | null }>("SELECT html_scripts FROM users WHERE id=?", userId))?.html_scripts);
}
async function save(userId: string, entries: Entry[]) {
  await run("UPDATE users SET html_scripts=? WHERE id=?", entries.length ? JSON.stringify(entries.slice(-HTML_SCRIPTS_MAX)) : null, userId);
}

// The content's hash, as stored on this server (null: the bytes are gone).
export async function htmlFileHash(fileId: string): Promise<string | null> {
  const path = (await localUpload(fileId)) ?? uploadPath(fileId);
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

// A file the preview would show with scripts: an HTML download within the
// preview's limit (the same checks as lib/html-preview.ts).
async function previewableHash(file: StoredFile & { size?: number | null }) {
  if (!isHtmlName(file.name) || !/^(application\/octet-stream|text\/html)$/.test(file.mime)) throw new HttpError(415, "Keine HTML-Datei.");
  if (Number(file.size ?? 0) > htmlPreviewLimit()) throw new HttpError(413, ct("Die Datei ist zu groß für die Vorschau.", "The file is too large for the preview."));
  const hash = await htmlFileHash(file.id);
  if (!hash) throw new HttpError(404, "Datei fehlt.");
  return hash;
}

// What allowing needs: scripts allowed on the instance, a file the person
// may read, an HTML file within the preview's limit – and its hash. Read
// from disk, so lib/api.ts calls it before the command's transaction.
export async function htmlScriptsHash(user: Identity, input: Record<string, unknown>) {
  const fileId = z.uuid().parse(input.fileId);
  if (!htmlPreviewScriptsAllowed()) throw new HttpError(409, ct("Skripte in HTML-Vorschauen sind auf dieser Instanz abgeschaltet.", "Scripts in HTML previews are switched off on this instance."));
  // readableFile reads the whole row, the size included.
  return await previewableHash((await readableFile(user, fileId)) as StoredFile & { size?: number | null });
}

// profile.htmlScripts: { fileId, allow }. Allowing needs a file the person
// may read; forgetting always works (also for a file that is gone).
export async function setHtmlScripts(user: Identity, input: Record<string, unknown>, hash?: string, now = Date.now()) {
  const fileId = z.uuid().parse(input.fileId);
  const allow = z.boolean().parse(input.allow);
  const entries = (await entriesOf(user.id)).filter((e) => e.id !== fileId);
  if (allow) {
    // Checked again in the transaction; the hash from before it.
    await readableFile(user, fileId);
    entries.push({ id: fileId, hash: hash ?? (await htmlScriptsHash(user, input)), at: now });
  }
  await save(user.id, entries);
  return { fileId, allow };
}

// profile.htmlScriptsClear: every remembered file forgotten.
export async function clearHtmlScripts(user: Identity) {
  await save(user.id, []);
  return { ok: true };
}

// Whether the viewer starts with scripts for this file: remembered by this
// person, with the content it had then, and scripts allowed on the instance.
export async function htmlScriptsRemembered(user: Identity, fileId: string) {
  if (!htmlPreviewScriptsAllowed()) return false;
  const entry = (await entriesOf(user.id)).find((e) => e.id === fileId);
  if (!entry) return false;
  return (await htmlFileHash(fileId)) === entry.hash;
}

// For Settings → Sicherheitscheck: the remembered files, newest first, with
// name and page for those the person can still read (the others without).
export async function htmlScriptsList(user: Identity) {
  const entries = (await entriesOf(user.id)).slice().reverse();
  if (!entries.length) return [];
  const pages = new Map(
    (
      await all<{ id: string; title: string }>(
        `SELECT p.id,p.title FROM pages p JOIN files f ON f.page_id=p.id WHERE f.id IN (${entries.map(() => "?").join(",")})`,
        ...entries.map((e) => e.id),
      )
    ).map((p) => [p.id, p.title]),
  );
  const out: { fileId: string; name: string; pageId: string; page: string; at: number; available: boolean }[] = [];
  for (const entry of entries) {
    try {
      const file = await readableFile(user, entry.id);
      out.push({ fileId: entry.id, name: file.name, pageId: file.page_id, page: pages.get(file.page_id) ?? "", at: entry.at, available: true });
    } catch {
      out.push({ fileId: entry.id, name: "", pageId: "", page: "", at: entry.at, available: false });
    }
  }
  return out;
}
