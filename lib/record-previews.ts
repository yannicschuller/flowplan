// The previews of the records of a database (#383): what the table, the
// gallery and the feed show of a record's text (lib/document-preview.ts),
// kept in row_previews (schema 110) instead of reading and sanitising every
// record document on every opening of the database.
//
// Triggers (lib/db.ts migrateRecordPreviews()) mark a record in
// row_preview_dirty when its text changes – its record document or its
// legacy content, whoever writes it. A kept preview counts only for a
// record that is not marked and in the current format; the others are made
// from their text as before and kept for the next time. The mark goes
// first, before the text is read: a change that comes in meanwhile marks
// the record again, and its preview is made anew next time.
import { all, run, transaction } from "./db";
import { documentPreview, PREVIEW_FORMAT, type DocumentPreview } from "./document-preview";

const BATCH = 200;
const EMPTY = "";

// The preview of every record of the database that has a text (`records`:
// its records as read, with their legacy content); records without one get
// the preview of an empty text from documentPreview("").
// `documents`: the records that have a record document.
export async function recordPreviews(databaseId: string, records: readonly { id: string; content?: string | null }[]): Promise<{ previews: Map<string, DocumentPreview>; documents: Set<string> }> {
  const previews = new Map<string, DocumentPreview>();
  for (const p of await all<{ row_id: string; preview: string }>(
    `SELECT p.row_id,p.preview FROM row_previews p JOIN rows r ON r.id=p.row_id
     WHERE r.page_id=? AND p.format=? AND NOT EXISTS(SELECT 1 FROM row_preview_dirty d WHERE d.row_id=p.row_id)`,
    databaseId,
    PREVIEW_FORMAT,
  ))
    previews.set(p.row_id, JSON.parse(p.preview) as DocumentPreview);
  // Records with a text but no current preview.
  const documents = new Set(
    (await all<{ row_id: string }>("SELECT d.row_id FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?", databaseId)).map((d) => d.row_id),
  );
  const missing = records.filter((r) => !previews.has(r.id) && (documents.has(r.id) || !!r.content)).map((r) => r.id);
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const marks = batch.map(() => "?").join(",");
    await transaction(async () => {
      await run(`DELETE FROM row_preview_dirty WHERE row_id IN (${marks})`, ...batch);
      for (const r of await all<{ id: string; source: string }>(
        `SELECT r.id,COALESCE(d.html,r.content,'') source FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id IN (${marks})`,
        ...batch,
      )) {
        const preview = documentPreview(r.source || EMPTY);
        previews.set(r.id, preview);
        await run(
          "INSERT INTO row_previews(row_id,preview,format) VALUES(?,?,?) ON CONFLICT(row_id) DO UPDATE SET preview=excluded.preview,format=excluded.format",
          r.id,
          JSON.stringify(preview),
          PREVIEW_FORMAT,
        );
      }
    });
  }
  return { previews, documents };
}
