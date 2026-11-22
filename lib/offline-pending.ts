// What the offline queue (components/offline-queue.tsx) holds, for the
// parts of the app that are not given it as props: the editor, the
// whiteboard and the notebook ask whether their page is still only on this
// device (#370) – then they keep their content here and send nothing – and
// the editor holds its document back while pictures of the page still wait
// to be uploaded, a record made offline opens with an empty document of its
// own that waits behind the record's creation (components/row-document.tsx), so the shared document never points at a file the server
// does not have yet. Images of such uploads show their local copy
// (components/image-placeholder-view.ts). A small store for the tab.

let pages = new Set<string>();
let rows = new Set<string>();
let uploads = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const previews = new Map<string, string>();
const previewListeners = new Map<string, Set<(url: string) => void>>();

export function setPending(
  pageIds: Iterable<string>,
  files: Iterable<{ pageId: string; fileId: string }>,
  rowIds: Iterable<{ pageId: string; rowId: string }> = [],
) {
  pages = new Set(pageIds);
  rows = new Set([...rowIds].map((r) => `${r.pageId}/${r.rowId}`));
  uploads = new Map();
  for (const f of files) {
    const set = uploads.get(f.pageId) || new Set<string>();
    set.add(f.fileId);
    uploads.set(f.pageId, set);
  }
  for (const listener of [...listeners]) listener();
}
// The page was made offline and is not on the server yet.
export const isPendingPage = (pageId: string) => pages.has(pageId);
// The record was made offline and is not on the server yet (its creation
// waits in the queue, or failed with the page it was made in).
export const isPendingRow = (pageId: string, rowId: string) => rows.has(`${pageId}/${rowId}`);
// Pictures or files of the page wait to be uploaded.
export const hasPendingUploads = (pageId: string) => !!uploads.get(pageId)?.size;
export const isPendingFile = (fileId: string) => [...uploads.values()].some((set) => set.has(fileId));
export function onPendingChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The file id of an upload's address (/api/files/<id>).
export function fileIdOf(src: string | null | undefined) {
  return /^\/api\/files\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(src || "")?.[1]?.toLowerCase() ?? null;
}
// The local copy of a file that waits (an object URL of its blob).
export function setPreview(fileId: string, url: string) {
  previews.set(fileId, url);
  for (const listener of [...(previewListeners.get(fileId) || [])]) listener(url);
}
export const previewOf = (fileId: string) => previews.get(fileId) ?? null;
export function onPreview(fileId: string, listener: (url: string) => void) {
  const set = previewListeners.get(fileId) || new Set();
  set.add(listener);
  previewListeners.set(fileId, set);
  return () => {
    set.delete(listener);
  };
}

// How the editor hands a file to the queue: set by the queue of the open
// workspace (components/offline-queue.tsx); null where there is none.
export type QueueUpload = (pageId: string, file: File) => Promise<{ fileId: string; url: string } | { refused: "file" | "total" | "storage" }>;
let uploader: QueueUpload | null = null;
export const setUploader = (fn: QueueUpload | null) => {
  uploader = fn;
};
export const offlineUploader = () => uploader;
// Asks the queue to send now (a page that waits is needed by an open view).
let kick: (() => void) | null = null;
export const setKick = (fn: (() => void) | null) => {
  kick = fn;
};
export const sendPendingNow = () => kick?.();
