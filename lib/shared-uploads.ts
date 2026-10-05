import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { sanitizeFileName, stripLocation } from "./upload-safety";
import { resolve } from "node:path";
import { all, id, onTransactionRollback, run, transaction, audit } from "./db";
import { HttpError } from "./auth";
import { publicPage } from "./publication";
import { enforceQuota } from "./instance-ops";
import { limitShareRequests } from "./shared-content";

export const MAX_GUEST_UPLOAD = 10 * 1024 * 1024;
// Guests may add pictures, PDFs and plain text; nothing that runs in a browser.
const allowed: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};
const signatures: [string, (b: Buffer) => boolean][] = [
  [
    "image/png",
    (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  ],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  [
    "image/webp",
    (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  ],
  ["application/pdf", (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
];
const DAY = 86400000;

// Uploads through an editing link belong to the shared page. Until the guest
// saves content that references them, only this link can read them; unused
// uploads are removed after a day.
export async function guestUpload(token: string, pageId: string, file: File) {
  if (file.size > MAX_GUEST_UPLOAD)
    throw new HttpError(413, "Gäste können Dateien bis 10 MB hochladen.");
  if (!allowed[file.type])
    throw new HttpError(
      415,
      "Erlaubt sind Bilder (PNG, JPEG, GIF, WebP), PDF und Text.",
    );
  const raw = Buffer.from(await file.arrayBuffer());
  // Photos lose their location (EXIF GPS) before they are stored.
  const data = stripLocation(raw, file.type);
  const signature = signatures.find(([mime]) => mime === file.type)?.[1];
  if (signature && !signature(data))
    throw new HttpError(415, "Der Dateiinhalt passt nicht zum Dateityp.");
  if (file.type === "text/plain" && data.includes(0))
    throw new HttpError(415, "Keine Textdatei.");
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  return transaction(() => {
    const { page, role } = publicPage(token, pageId);
    if (role !== "editor")
      throw new HttpError(403, "Dieser Link erlaubt keine Uploads.");
    if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
    limitShareRequests(token);
    purgeUnusedGuestUploads();
    enforceQuota(page.workspace_id, data.length);
    const fid = id(),
      path = resolve(dir, fid);
    mkdirSync(dir, { recursive: true });
    onTransactionRollback(() => {
      try {
        unlinkSync(path);
      } catch {}
    });
    writeFileSync(path, data, { flag: "wx" });
    const name = sanitizeFileName(file.name, `datei.${allowed[file.type]}`);
    run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,NULL)",
      fid,
      page.id,
      name,
      file.type,
      data.length,
    );
    run(
      "INSERT INTO share_uploads(file_id,token,created_at) VALUES(?,?,?)",
      fid,
      token,
      Date.now(),
    );
    audit("guest", "share.upload", page.id, name);
    return {
      url: `/api/share/${token}/files/${fid}`,
      name,
      mime: file.type,
    };
  });
}
// Guest uploads not referenced by any document after a day are deleted.
export function purgeUnusedGuestUploads(now = Date.now()) {
  const stale = all<{ id: string; page_id: string }>(
    `SELECT f.id,f.page_id FROM share_uploads s JOIN files f ON f.id=s.file_id
     WHERE s.created_at<? LIMIT 50`,
    now - DAY,
  );
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  for (const f of stale) {
    const needle = `%/api/files/${f.id}%`;
    const used = all(
      `SELECT 1 FROM documents WHERE page_id=? AND html LIKE ?
       UNION ALL SELECT 1 FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=? AND d.html LIKE ?
       LIMIT 1`,
      f.page_id,
      needle,
      f.page_id,
      needle,
    ).length;
    if (used) run("DELETE FROM share_uploads WHERE file_id=?", f.id);
    else {
      run("DELETE FROM files WHERE id=?", f.id);
      try {
        unlinkSync(resolve(dir, f.id));
      } catch {}
    }
  }
}
