// How large a collaborative document (a page or a record's document) may
// grow. Every sync decodes, re-encodes and renders the whole document
// (~30 ms per MB), so one very large document slows down everyone editing
// it and the server. FLOWPLAN_MAX_DOCUMENT_MB changes the cap (default 16).
import { HttpError } from "./auth";
import { ct } from "./content-locale";

export function maxDocumentMb() {
  const value = Number(process.env.FLOWPLAN_MAX_DOCUMENT_MB);
  return Number.isFinite(value) && value > 0 ? value : 16;
}

// After an update is merged: refused when the document is above the cap and
// grew. A document that is too large already can still shrink (or keep its
// size), so nothing that was saved before becomes uneditable for removals.
export function requireDocumentSize(merged: Uint8Array, previousBytes: number) {
  const mb = maxDocumentMb();
  if (merged.byteLength > mb * 1024 * 1024 && merged.byteLength > previousBytes)
    throw new HttpError(
      413,
      ct(
        `Das Dokument ist zu groß (höchstens ${mb} MB). Bitte teile den Inhalt auf mehrere Seiten auf.`,
        `The document is too large (at most ${mb} MB). Please split the content across several pages.`,
      ),
    );
}
