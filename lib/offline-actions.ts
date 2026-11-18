// What works without a connection and what does not (#333). Offline the
// device edits what its offline copy holds: documents (lib/offline-*.ts,
// the editor's IndexedDB), database records – also new ones – through the
// offline queue (lib/offline-queue.ts) and today's journal entry
// (lib/journal-offline.ts). New documents, databases, whiteboards and
// notebooks, pages from built-in templates and uploads in documents are
// made on the device and wait in the same queue (#370, lib/offline-create.ts)
// – the "New page" dialog does that itself, without sending page.create.
// Creating anything else needs the server: these commands are not sent
// offline; the person gets a calm note instead of a failed request
// (components/ui.tsx needsConnection, OfflineNotice).
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
// Requests other than commands that need the server: flashcards made by
// the AI (lib/ai/flashcards.ts), the Anki import (an upload and a job of
// the server) and the export of a deck (CSV, .apkg). Rating flashcards is
// not among them – study.review and study.reviews wait on the device
// (lib/study-offline.ts, docs/specs/flashcards.md §10.4).
export const onlineOnlyRequests: readonly RegExp[] = [/^\/api\/ai\/flashcards\//, /^\/api\/import\/source(\/|\?|$)/, /^\/api\/pages\/[^/?]+\/study\/export(\?|$)/];
export const needsServerRequest = (url: string) => onlineOnlyRequests.some((pattern) => pattern.test(url));
