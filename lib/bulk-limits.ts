// How many items one bulk action takes at once (#675). Shared by the
// server (the check, with a specific message instead of "Ungültige
// Eingabe.") and the browser (the actions are disabled above it, so an
// all-or-nothing action never silently becomes a partial one).
//
// pages.bulk runs in one transaction, all or nothing. Measured with
// generated pages (a quarter of them sub-pages, little content) on a busy
// 4-core machine: 1000 pages move in about 0.8 s, duplicate in 1.6 s, go to
// the trash in 0.7 s, lock in 0.8 s; 2000 took 2 s to move and 4–9 s to
// duplicate. Pages with real content duplicate slower, so 1000 keeps a
// small instance well below ten seconds.
export const PAGES_BULK_MAX = 1000;
// rows.bulk (update, duplicate, delete) and rows.transfer (copy or move into
// another database): one transaction, with an undo snapshot each.
export const ROWS_BULK_MAX = 500;
// file.delete from the media library (lib/file-trash.ts).
export const FILES_BULK_MAX = 500;
