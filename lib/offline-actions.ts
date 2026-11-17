// What works without a connection and what does not (#333). Offline the
// device edits what its offline copy holds: documents (lib/offline-*.ts,
// the editor's IndexedDB), database records – also new ones – through the
// offline queue (lib/offline-queue.ts) and today's journal entry
// (lib/journal-offline.ts). Creating anything else needs the server: these
// commands are not sent offline; the person gets a calm note instead of a
// failed request (components/ui.tsx needsConnection, OfflineNotice).
export const onlineOnlyActions: ReadonlySet<string> = new Set([
  "page.create",
  "page.duplicate",
  "page.import",
  "space.create",
  "workspace.create",
  "workspace.import",
  "collection.create",
  "collection.duplicate",
  "synced.create",
  "notebook.import",
  "rows.import",
  "workflow.import",
  "citation.import",
  "bookmarks.import",
  "vcard.import",
  "publication.copy",
  // An answer of a database's form: its checks and defaults are the server's.
  "form.submit",
]);
export const needsServer = (body: { action?: unknown }) => typeof body.action === "string" && onlineOnlyActions.has(body.action);
