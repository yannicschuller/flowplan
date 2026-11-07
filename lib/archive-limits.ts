// Records per database in a content archive (lib/archive.ts), in a database
// version inside it and in a JSON backup ("workspace.import"): far beyond
// real databases. What bounds an archive is its size – flowplan.json's
// limit and the archive's – not a count that a large database reaches (it
// used to be 5,000 records, and archives of larger databases failed).
export const MAX_ARCHIVE_ROWS = 200_000;
