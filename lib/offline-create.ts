// Content made without a connection (#370): new documents (also below
// another page), databases, whiteboards and notebooks, pages from a
// built-in template, and pictures or files added to a page. They are made
// on this device with ids of their own and wait in the one ordered offline
// queue of the person (lib/offline-queue.ts, components/offline-queue.tsx)
// – a page before what is made in it (its records, sub-pages, uploads) – and
// are sent in that order once the connection is back. The sidebar and the
// lists show them at once, marked "not yet synced".
//
// When the server refuses a page (the space was deleted meanwhile, no
// permission any more), everything that depends on it – records of a new
// database, its sub-pages, its uploads – fails with it: it moves to the list
// of failed changes with the reason, its content stays on the device (the
// page still opens there, uploads can be saved), and the person tries again
// or discards it. Pure functions here; the sending is the queue's.
import type { OfflinePageChange, OfflinePageKind, OfflineUploadChange, QueuedChange } from "./offline-queue";
import type { Field, Page, Row, View } from "./types";
import type { CatalogTemplate } from "./template-catalog";
import { databaseKinds, type DatabaseKind } from "./database-kinds";

// Uploads that wait on the device: up to 25 MB per file and 200 MB in all;
// bigger files need the connection.
export const OFFLINE_UPLOAD_MAX = 25 * 1024 * 1024;
export const OFFLINE_UPLOADS_TOTAL = 200 * 1024 * 1024;

export const offlinePageKinds: readonly OfflinePageKind[] = ["document", "database", "whiteboard", "notebook"];
export const isOfflinePageKind = (kind: unknown): kind is OfflinePageKind => offlinePageKinds.includes(kind as OfflinePageKind);

// A change that could not be sent, kept with the server's reason. `cause`:
// the page whose refusal took it along.
export type FailedChange = { change: QueuedChange; reason: string; at: number; cause?: string };

// Whether a built-in template works offline: its content comes with the
// app (lib/template-catalog.ts). Not: surveys (their form is the server's),
// the shortcut cards (written on the server) and draw.io pages (the editor
// opens for the diagram, which needs the server).
export function offlineTemplate(key: string, template: CatalogTemplate | undefined): boolean {
  if (!template) return false;
  if (template.kind === "document") return !template.openDiagram;
  return !template.survey && key !== "shortcuts";
}

// The icon a new page starts with (lib/seed.ts createPage).
export const kindIcon = (kind: OfflinePageKind) => (kind === "whiteboard" ? "whiteboard" : kind === "notebook" ? "notebook" : "file");

export type NewOfflinePage = {
  id: string;
  workspaceId: string;
  spaceId: string;
  parentId: string | null;
  kind: OfflinePageKind;
  title: string;
  databaseKind?: string;
  // A built-in template (checked with offlineTemplate) and its catalog entry.
  starter?: { key: string; template: CatalogTemplate };
  // Fresh ids for the template's example records and the notebook's sheet.
  newId: () => string;
  key: string;
  at: number;
};
export function pageChange(input: NewOfflinePage): OfflinePageChange {
  const template = input.starter?.template;
  const kind = template?.kind ?? input.kind;
  const change: OfflinePageChange = {
    id: input.newId(),
    kind: "page",
    pageId: input.id,
    workspaceId: input.workspaceId,
    spaceId: input.spaceId,
    parentId: input.parentId,
    pageKind: kind,
    title: input.title,
    icon: template?.icon || kindIcon(kind),
    at: input.at,
    key: input.key,
  };
  if (template?.fullWidth) change.fullWidth = true;
  if (input.starter) {
    change.starterTemplate = input.starter.key;
    if (kind === "database") change.rowIds = (template?.rows || []).map(() => input.newId());
  } else if (kind === "database")
    change.databaseKind = databaseKinds.includes(input.databaseKind as DatabaseKind) ? input.databaseKind : "tasks";
  if (kind === "notebook") change.sheetId = input.newId();
  return change;
}

// The command that creates the page on the server. A document from a
// template gets the template from the server only when nothing was written
// in it on the device; otherwise its content (which holds the template's
// text) is sent as it is, so the text is not there twice.
export function createCommand(change: OfflinePageChange, hasContent: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action: "page.create",
    workspaceId: change.workspaceId,
    spaceId: change.spaceId,
    parentId: change.parentId,
    title: change.title,
    kind: change.pageKind,
    pageId: change.pageId,
  };
  if (change.starterTemplate && !(change.pageKind === "document" && hasContent)) body.starterTemplate = change.starterTemplate;
  if (body.starterTemplate && change.rowIds) body.rowIds = change.rowIds;
  if (change.databaseKind) body.databaseKind = change.databaseKind;
  if (change.sheetId) body.sheetId = change.sheetId;
  return body;
}
// What the page gets after page.create when the template was not applied
// by the server (a document written on): the template's icon and width.
export function afterCreate(change: OfflinePageChange, hasContent: boolean): Record<string, unknown> | null {
  if (!(change.starterTemplate && change.pageKind === "document" && hasContent)) return null;
  return { action: "page.update", pageId: change.pageId, patch: { icon: change.icon, ...(change.fullWidth ? { full_width: true } : {}) } };
}

// Room for an upload that waits on the device (with the failed ones, whose
// blobs are kept too).
export function uploadRoom(queue: QueuedChange[], failed: FailedChange[], size: number): "ok" | "file" | "total" {
  if (size > OFFLINE_UPLOAD_MAX) return "file";
  const waiting = [...queue, ...failed.map((f) => f.change)].reduce((sum, c) => sum + (c.kind === "upload" ? c.size : 0), 0);
  return waiting + size > OFFLINE_UPLOADS_TOTAL ? "total" : "ok";
}

// Pages made offline that the server does not have yet.
export function pendingPageIds(queue: QueuedChange[]): Set<string> {
  return new Set(queue.flatMap((c) => (c.kind === "page" && !c.created ? [c.pageId] : [])));
}
// Records made offline that the server does not have yet: their creation
// waits, or failed with the page it was made in (its content stays here).
export function pendingRows(queue: QueuedChange[], failed: FailedChange[] = []): { pageId: string; rowId: string }[] {
  return [...queue, ...failed.map((f) => f.change)].flatMap((c) => (c.kind === "create" && !c.sent ? [{ pageId: c.pageId, rowId: c.rowId }] : []));
}
export const pendingUploads = (queue: QueuedChange[]) => queue.filter((c): c is OfflineUploadChange => c.kind === "upload");

// The pages a set of pages takes along: the changes made in them and, page
// by page, their sub-pages made offline (in queue order a sub-page comes
// after its parent).
function dependents(list: QueuedChange[], ids: Set<string>) {
  const pages = new Set(ids);
  const taken: number[] = [];
  list.forEach((c, i) => {
    if (c.kind === "page" && c.parentId && pages.has(c.parentId)) pages.add(c.pageId);
    if (pages.has(c.pageId)) taken.push(i);
  });
  return { pages, taken: new Set(taken) };
}
// The change at `index` was refused: it moves to the failed ones with the
// reason, and – for a page – with everything that depends on it.
export function failChange(queue: QueuedChange[], failed: FailedChange[], index: number, reason: string, at: number) {
  const change = queue[index];
  if (!change) return { queue, failed };
  if (change.kind !== "page") return { queue: queue.filter((_, i) => i !== index), failed: [...failed, { change, reason, at }] };
  const { taken } = dependents(queue, new Set([change.pageId]));
  taken.add(index);
  return {
    queue: queue.filter((_, i) => !taken.has(i)),
    failed: [...failed, ...queue.filter((_, i) => taken.has(i)).map((c) => (c === change ? { change, reason, at } : { change: c, reason, at, cause: change.pageId }))],
  };
}
// A change that refers to a page that failed (made after the failure, or
// sent again): it fails along without being sent.
export function failedPageOf(change: QueuedChange, failed: FailedChange[]): string | null {
  const ids = new Set(failed.flatMap((f) => (f.change.kind === "page" ? [f.change.pageId] : [])));
  if (ids.has(change.pageId)) return change.pageId;
  if (change.kind === "page" && change.parentId && ids.has(change.parentId)) return change.parentId;
  return null;
}
// "Try again": the failed page (or upload) and what failed with it go back
// to the end of the queue, in their order.
export function retryFailed(queue: QueuedChange[], failed: FailedChange[], id: string) {
  const own = failed.filter((f) => f.change.pageId === id || f.cause === id || (f.change.kind === "upload" && f.change.fileId === id));
  const back = new Set(own);
  // Sub-pages that failed with this page take their own records along.
  for (const f of failed) if (f.change.kind === "page" && back.has(f)) for (const g of failed) if (g.change.pageId === f.change.pageId) back.add(g);
  return { queue: [...queue, ...failed.filter((f) => back.has(f)).map((f) => f.change)], failed: failed.filter((f) => !back.has(f)) };
}
// Discarding a page made offline (failed or still waiting): it and what
// depends on it leave the device. `removed`: what to clean up (stored
// content, upload blobs).
export function discardPage(queue: QueuedChange[], failed: FailedChange[], pageId: string) {
  const all = [...queue, ...failed.map((f) => f.change)];
  const { pages } = dependents(all, new Set([pageId]));
  const gone = (c: QueuedChange) => pages.has(c.pageId);
  return { queue: queue.filter((c) => !gone(c)), failed: failed.filter((f) => !gone(f.change)), removed: all.filter(gone), pages };
}
export function discardUpload(failed: FailedChange[], fileId: string) {
  return failed.filter((f) => !(f.change.kind === "upload" && f.change.fileId === fileId));
}
// A new title or icon for a page that waits: it goes along with the create.
export function renamePending(queue: QueuedChange[], failed: FailedChange[], pageId: string, patch: { title?: unknown; icon?: unknown }) {
  const apply = (c: QueuedChange): QueuedChange =>
    c.kind === "page" && c.pageId === pageId && !c.created
      ? {
          ...c,
          ...(typeof patch.title === "string" && patch.title.trim() ? { title: patch.title.slice(0, 500) } : {}),
          ...(typeof patch.icon === "string" ? { icon: patch.icon.slice(0, 200) } : {}),
        }
      : c;
  return { queue: queue.map(apply), failed: failed.map((f) => ({ ...f, change: apply(f.change) })) };
}

export type LocalState = "pending" | "failed";
// A page made offline as the sidebar and the lists show it.
export function localPage(change: OfflinePageChange, userId: string, offline: LocalState): Page {
  return {
    id: change.pageId,
    workspace_id: change.workspaceId,
    space_id: change.spaceId,
    parent_id: change.parentId,
    title: change.title,
    icon: change.icon,
    cover: "",
    kind: change.pageKind,
    position: change.at,
    deleted_at: null,
    created_by: userId,
    updated_at: new Date(change.at).toISOString(),
    locked: 0,
    public_token: null,
    full_width: change.fullWidth ? 1 : 0,
    font: "sans",
    synced: 0,
    offline,
  };
}
// The workspace's pages with those made offline: the waiting and failed
// ones that the server does not list, and a mark on those it lists
// already while their content is still on its way.
export function withLocalPages(pages: Page[], queue: QueuedChange[], failed: FailedChange[], workspaceId: string, userId: string): Page[] {
  const local = new Map<string, Page>();
  for (const c of queue) if (c.kind === "page" && c.workspaceId === workspaceId) local.set(c.pageId, localPage(c, userId, "pending"));
  for (const f of failed) if (f.change.kind === "page" && f.change.workspaceId === workspaceId) local.set(f.change.pageId, localPage(f.change, userId, "failed"));
  if (!local.size) return pages;
  const known = new Set(pages.map((p) => p.id));
  return [
    ...pages.map((p) => (local.has(p.id) ? { ...p, offline: local.get(p.id)!.offline } : p)),
    ...[...local.values()].filter((p) => !known.has(p.id)),
  ];
}
// The page entry of a page made offline that the server does not have yet
// (waiting or failed).
export function localPageChange(queue: QueuedChange[], failed: FailedChange[], pageId: string): { change: OfflinePageChange; state: LocalState; reason?: string } | null {
  const waiting = queue.find((c): c is OfflinePageChange => c.kind === "page" && c.pageId === pageId && !c.created);
  if (waiting) return { change: waiting, state: "pending" };
  const lost = failed.find((f) => f.change.kind === "page" && f.change.pageId === pageId);
  return lost ? { change: lost.change as OfflinePageChange, state: "failed", reason: lost.reason } : null;
}
