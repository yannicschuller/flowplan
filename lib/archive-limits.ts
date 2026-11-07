// Records per database in a content archive (lib/archive.ts), in a database
// version inside it and in a JSON backup ("workspace.import"): far beyond
// real databases. What bounds an archive is its size – flowplan.json's
// limit and the archive's – not a count that a large database reaches (it
// used to be 5,000 records, and archives of larger databases failed).
export const MAX_ARCHIVE_ROWS = 200_000;
// flowplan.json, the archive's manifest: pages, records, comments and
// database versions without the files. Export, import and restore (an
// archive brought back under Sicherungen) check the same limit, and the
// versions that go into an archive share it (lib/archive.ts
// addDatabaseVersions). It used to be 30 MB.
export const MANIFEST_LIMIT_MB = 64;
export const MANIFEST_LIMIT = MANIFEST_LIMIT_MB * 1024 * 1024;
export const MANIFEST_TOO_LARGE = "Inhaltsarchiv zu groß: flowplan.json (Seiten, Einträge, Kommentare und Versionen ohne Dateien) darf höchstens 64 MB groß sein.";
