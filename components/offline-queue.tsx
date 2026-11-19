"use client";
import { serverMessage } from "@/lib/server-message";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  mergeChange,
  queueKey,
  queueableActions,
  retryLater,
  withoutConflict,
  type Conflict,
  type OfflinePageChange,
  type OfflineUploadChange,
  type QueuedChange,
} from "@/lib/offline-queue";
import {
  afterCreate,
  createCommand,
  discardPage,
  discardUpload,
  failChange,
  failedPageOf,
  pendingPageIds,
  pendingUploads,
  renamePending,
  retryFailed,
  uploadRoom,
  type FailedChange,
} from "@/lib/offline-create";
import { setKick, setPending, setPreview, setUploader } from "@/lib/offline-pending";
import { cellText } from "@/lib/cell-text";
import { endedSession, friendlyError, Modal, sessionEnded } from "./ui";
import { IDEMPOTENCY_CODES, IDEMPOTENCY_HEADER, idempotencyKeyOf, newIdempotencyKey } from "@/lib/idempotency-key";
import { primePlaceholder } from "./image-placeholder";
import { boardStore, documentStore, dropInk, dropStore, dropUpload, keepUpload, keptInk, keptUpload, keptUploads } from "./offline-uploads";
import type { Field, Row } from "@/lib/types";

class HttpFailure extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
// Without an answer, or while the server still works on the same key: sent
// again on the next flush (the change stays in the queue).
class NotYet extends Error {}
async function answer(response: Response, url: string) {
  const result = await response.json().catch(() => null);
  // No JSON: a proxy answered while the server restarts (#284) – even its
  // "404 page not found" says nothing about the change, which stays queued.
  if (result === null && !response.ok) throw new NotYet();
  if (result?.code === IDEMPOTENCY_CODES.processing) throw new NotYet();
  // Signed out: the change waits for the next sign-in instead of being
  // discarded.
  if (response.status === 401) {
    endedSession(url, 401);
    throw new NotYet();
  }
  // The server briefly unreachable: sent again later, not discarded.
  if (retryLater(response.status)) throw new NotYet();
  if (!response.ok)
    throw new HttpFailure(serverMessage(result?.error) || tr("Fehler", "Error"), response.status);
  return result ?? {};
}
async function post(body: Record<string, unknown>, key?: string, url = "/api/command") {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { [IDEMPOTENCY_HEADER]: key } : {}) },
    body: JSON.stringify(body),
  });
  return await answer(response, url);
}
async function currentRows(pageId: string): Promise<Row[]> {
  const response = await fetch(`/api/pages/${pageId}`, { cache: "no-store" });
  if (retryLater(response.status)) throw new NotYet();
  const body = await response.json().catch(() => null);
  if (body === null && !response.ok) throw new NotYet(); // a proxy's page (#284)
  if (!response.ok) throw new HttpFailure(tr("Seite fehlt.", "Page missing."), response.status);
  return body?.rows || [];
}
// The content an editor or a board kept in IndexedDB (y-indexeddb), as one
// update; null when it holds nothing.
async function storedUpdate(name: string): Promise<Uint8Array | null> {
  const [Y, { IndexeddbPersistence }] = await Promise.all([import("yjs"), import("y-indexeddb")]);
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, doc);
  try {
    await persistence.whenSynced;
    return doc.store.clients.size ? Y.encodeStateAsUpdate(doc) : null;
  } finally {
    await persistence.destroy();
    doc.destroy();
  }
}
const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const read = <T,>(key: string): T[] => {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};
const offline = (e: unknown) => !(e instanceof HttpFailure);

// Waiting changes of this person on this device – record changes (see
// lib/offline-queue.ts) and pages, pictures and files made offline
// (lib/offline-create.ts) – with sending, conflicts and failed changes.
export function useOfflineQueue({
  userId,
  onSynced,
  notify,
}: {
  userId: string;
  onSynced: () => Promise<unknown>;
  // `error`: a page or file the server refused (shown as an error).
  notify: (message: string, error?: boolean) => void;
}) {
  const key = queueKey(userId);
  const [queue, setQueue] = useState<QueuedChange[]>([]),
    [conflicts, setConflicts] = useState<Conflict[]>([]),
    [failed, setFailed] = useState<FailedChange[]>([]),
    [syncing, setSyncing] = useState(false);
  const queueRef = useRef<QueuedChange[]>([]),
    failedRef = useRef<FailedChange[]>([]),
    running = useRef(false);
  // Pages made offline that the server does not have (waiting or failed)
  // and the uploads that wait, for the editor, board and notebook.
  const publish = useCallback(() => {
    const failedPages = failedRef.current.flatMap((f) => (f.change.kind === "page" && !f.change.created ? [f.change.pageId] : []));
    setPending([...pendingPageIds(queueRef.current), ...failedPages], pendingUploads(queueRef.current));
  }, []);
  const store = useCallback(
    (next: QueuedChange[]) => {
      queueRef.current = next;
      setQueue(next);
      publish();
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        notify(
          tr("Offline-Änderungen konnten auf diesem Gerät nicht gesichert werden.", "Offline changes could not be stored on this device."),
        );
      }
    },
    [key, notify, publish],
  );
  const storeFailed = useCallback(
    (next: FailedChange[]) => {
      failedRef.current = next;
      setFailed(next);
      publish();
      try {
        if (next.length) localStorage.setItem(`${key}:failed`, JSON.stringify(next));
        else localStorage.removeItem(`${key}:failed`);
      } catch {}
    },
    [key, publish],
  );
  useEffect(() => {
    queueRef.current = read<QueuedChange>(key);
    failedRef.current = read<FailedChange>(`${key}:failed`);
    setQueue(queueRef.current);
    setFailed(failedRef.current);
    publish();
    try {
      setConflicts(
        JSON.parse(localStorage.getItem(`${key}:conflicts`) || "[]"),
      );
    } catch {}
    // The local copies of pictures that wait, for the editor to show.
    let alive = true;
    void keptUploads(userId).then((list) => {
      if (!alive) return;
      for (const kept of list) setPreview(kept.fileId, URL.createObjectURL(kept.blob));
    });
    return () => {
      alive = false;
    };
  }, [key, userId, publish]);
  // Takes the list or a function of the current one, like setState: a long
  // flush must not overwrite conflicts resolved while it ran.
  const storeConflicts = useCallback(
    (next: Conflict[] | ((current: Conflict[]) => Conflict[])) => {
      setConflicts((current) => {
        const list = typeof next === "function" ? next(current) : next;
        try {
          localStorage.setItem(`${key}:conflicts`, JSON.stringify(list));
        } catch {}
        return list;
      });
    },
    [key],
  );
  // Takes a command instead of sending it; returns what the server would.
  const enqueue = useCallback(
    (b: Record<string, unknown>, rows: Row[]) => {
      const pageId = String(b.pageId),
        at = Date.now(),
        id = crypto.randomUUID(),
        // The key of the attempt that failed (api() put it on the body).
        key = idempotencyKeyOf(b, true);
      let change: QueuedChange;
      if (b.action === "row.create") {
        change = {
          id,
          kind: "create",
          pageId,
          rowId: typeof b.rowId === "string" ? b.rowId : crypto.randomUUID(),
          cells: (b.cells as Record<string, unknown>) || {},
          at,
        };
      } else if (b.action === "capture.record")
        change = {
          id,
          kind: "capture",
          pageId,
          rowId: typeof b.rowId === "string" ? b.rowId : crypto.randomUUID(),
          title: String(b.title || ""),
          text: String(b.text || ""),
          at,
        };
      else if (b.action === "row.delete")
        change = { id, kind: "delete", pageId, rowId: String(b.rowId), at };
      else {
        const row = rows.find((r) => r.id === b.rowId);
        const cells = (b.cells as Record<string, unknown>) || {};
        change = {
          id,
          kind: "update",
          pageId,
          rowId: String(b.rowId),
          version: Number(b.version),
          cells,
          base: Object.fromEntries(
            Object.keys(cells).map((f) => [f, row?.cells[f] ?? null]),
          ),
          at,
        };
      }
      store([...queueRef.current, { ...change, key }]);
      return { id: change.rowId, offline: true };
    },
    [store],
  );
  // A page made offline (lib/offline-create.ts pageChange).
  const addPage = useCallback((change: OfflinePageChange) => store([...queueRef.current, change]), [store]);
  // A new title or icon of a page that waits.
  const renamePage = useCallback(
    (pageId: string, patch: { title?: unknown; icon?: unknown }) => {
      const next = renamePending(queueRef.current, failedRef.current, pageId, patch);
      store(next.queue);
      storeFailed(next.failed);
    },
    [store, storeFailed],
  );
  // A picture or file for later: kept in IndexedDB, uploaded in its turn.
  const addUpload = useCallback(
    async (pageId: string, file: File) => {
      const room = uploadRoom(queueRef.current, failedRef.current, file.size);
      if (room !== "ok") return { refused: room } as const;
      const fileId = crypto.randomUUID();
      if (!(await keepUpload(userId, fileId, file, file.name, file.type))) return { refused: "storage" } as const;
      const change: OfflineUploadChange = {
        id: crypto.randomUUID(),
        kind: "upload",
        pageId,
        fileId,
        name: file.name,
        type: file.type,
        size: file.size,
        at: Date.now(),
        key: newIdempotencyKey(),
      };
      setPreview(fileId, URL.createObjectURL(file));
      store([...queueRef.current, change]);
      return { fileId, url: `/api/files/${fileId}` };
    },
    [store, userId],
  );
  // Leaves the device: stored content and blobs too.
  const cleanUp = useCallback(
    (removed: QueuedChange[]) => {
      for (const c of removed) {
        if (c.kind === "upload") void dropUpload(c.fileId);
        if (c.kind === "page") {
          dropStore(documentStore(userId, c.pageId));
          dropStore(boardStore(userId, c.pageId));
          dropInk(c.pageId);
        }
      }
    },
    [userId],
  );
  const discard = useCallback(
    (pageId: string) => {
      const next = discardPage(queueRef.current, failedRef.current, pageId);
      store(next.queue);
      storeFailed(next.failed);
      cleanUp(next.removed);
      return next.removed.length > 0;
    },
    [store, storeFailed, cleanUp],
  );
  const discardFile = useCallback(
    (fileId: string) => {
      storeFailed(discardUpload(failedRef.current, fileId));
      void dropUpload(fileId);
    },
    [storeFailed],
  );
  const removeById = useCallback((id: string) => store(queueRef.current.filter((c) => c.id !== id)), [store]);
  // A refused change moves to the failed ones (a page with what depends on it).
  const failById = useCallback(
    (id: string, reason: string) => {
      const index = queueRef.current.findIndex((c) => c.id === id);
      if (index < 0) return;
      const change = queueRef.current[index];
      const next = failChange(queueRef.current, failedRef.current, index, reason, Date.now());
      store(next.queue);
      storeFailed(next.failed);
      const what = change.kind === "page" ? change.title : change.kind === "upload" ? change.name : "";
      notify(
        tr(
          `„${what}“ konnte nicht synchronisiert werden: ${reason} Der Inhalt bleibt auf diesem Gerät.`,
          `“${what}” could not be synced: ${reason} The content stays on this device.`,
        ),
        true,
      );
    },
    [store, storeFailed, notify],
  );
  const sendUpload = useCallback(async (change: OfflineUploadChange) => {
    const kept = await keptUpload(change.fileId);
    if (!kept) throw new HttpFailure(tr("Die Datei ist nicht mehr auf diesem Gerät.", "The file is no longer on this device."), 410);
    const form = new FormData();
    form.set("pageId", change.pageId);
    form.set("fileId", change.fileId);
    form.set("file", new File([kept.blob], kept.name || "file", { type: kept.type || kept.blob.type }));
    const response = await fetch("/api/upload", { method: "POST", body: form, headers: { [IDEMPOTENCY_HEADER]: change.key || change.id } });
    const result = await answer(response, "/api/upload");
    primePlaceholder(result.url, result.placeholder);
    await dropUpload(change.fileId);
  }, []);
  // The page, its uploads (the content refers to them) and then its
  // content, kept on the device.
  const sendPage = useCallback(
    async (change: OfflinePageChange) => {
      const key = change.key || change.id;
      const docStore = documentStore(userId, change.pageId);
      if (!change.created) {
        const content = change.pageKind === "document" ? await storedUpdate(docStore) : null;
        await post(createCommand(change, !!content), key);
        const after = afterCreate(change, !!content);
        if (after) await post(after, `${key.slice(0, 110)}-after`);
        store(queueRef.current.map((c) => (c.id === change.id ? { ...change, created: true } : c)));
      }
      for (const upload of queueRef.current.filter((c): c is OfflineUploadChange => c.kind === "upload" && c.pageId === change.pageId)) {
        try {
          await sendUpload(upload);
          removeById(upload.id);
        } catch (e) {
          if (offline(e)) throw e;
          failById(upload.id, friendlyError(e));
        }
      }
      if (change.pageKind === "document") {
        const update = await storedUpdate(docStore);
        // Without a key: CRDT updates merge, sent twice they change nothing.
        if (update) await post({ action: "document.sync", pageId: change.pageId, generation: "1", update: base64(update) });
      } else if (change.pageKind === "whiteboard") {
        const name = boardStore(userId, change.pageId);
        const update = await storedUpdate(name);
        if (update) {
          const response = await fetch(`/api/pages/${change.pageId}`, { cache: "no-store" });
          const page = await answer(response, `/api/pages/${change.pageId}`);
          const generation = (page as { whiteboard?: { generation?: string } }).whiteboard?.generation;
          if (!generation) throw new NotYet();
          await post({ action: "whiteboard.sync", pageId: change.pageId, generation, update: base64(update) });
        }
        dropStore(name);
      } else if (change.pageKind === "notebook") {
        for (const [surface, items] of Object.entries(keptInk(change.pageId))) {
          if (!items.length) continue;
          // The ink model loads with the first notebook to send (keeps it out of the shell).
          const { emptyInk } = await import("@/lib/ink/model");
          const doc = emptyInk();
          doc.pages[surface] = items;
          await post({ base: 0, doc, knows: ["image"] }, `${key.slice(0, 100)}-ink-${surface}`.slice(0, 128).replace(/[^A-Za-z0-9_-]/g, "-"), `/api/pages/${change.pageId}/ink?surface=${encodeURIComponent(surface)}`);
        }
        dropInk(change.pageId);
      }
    },
    [userId, store, removeById, failById, sendUpload],
  );
  const flush = useCallback(async () => {
    if (running.current || !queueRef.current.length || !navigator.onLine || sessionEnded())
      return;
    running.current = true;
    setSyncing(true);
    const found: Conflict[] = [];
    try {
      while (queueRef.current.length) {
        const change = queueRef.current[0];
        // Made in a page that failed: it fails along, unsent.
        const lost = failedPageOf(change, failedRef.current);
        if (lost) {
          const reason = failedRef.current.find((f) => f.change.kind === "page" && f.change.pageId === lost)?.reason || "";
          const before = failedRef.current.length;
          const next = failChange(queueRef.current, failedRef.current, 0, reason, Date.now());
          store(next.queue);
          storeFailed(next.failed.map((f, i) => (i >= before ? { ...f, cause: lost } : f)));
          continue;
        }
        // Changes queued before keys existed: their id is a UUID too.
        const key = change.key || change.id;
        try {
          if (change.kind === "page") await sendPage(change);
          else if (change.kind === "upload") await sendUpload(change);
          else if (change.kind === "create")
            await post({
              action: "row.create",
              pageId: change.pageId,
              rowId: change.rowId,
              cells: change.cells,
              templateId: null,
            }, key);
          else if (change.kind === "capture")
            await post({
              action: "capture.record",
              pageId: change.pageId,
              rowId: change.rowId,
              title: change.title,
              text: change.text,
            }, key);
          else if (change.kind === "delete") {
            try {
              await post({
                action: "row.delete",
                pageId: change.pageId,
                rowId: change.rowId,
              }, key);
            } catch (e) {
              if (!(e instanceof HttpFailure && e.status === 404)) throw e;
            }
          } else {
            try {
              await post({
                action: "row.update",
                pageId: change.pageId,
                rowId: change.rowId,
                version: change.version,
                cells: change.cells,
              }, key);
            } catch (e) {
              if (!(e instanceof HttpFailure) || ![404, 409].includes(e.status))
                throw e;
              const current = (await currentRows(change.pageId)).find(
                (r) => r.id === change.rowId,
              );
              const merged = mergeChange(change, current);
              if ("conflict" in merged) found.push(merged.conflict);
              else if ("send" in merged)
                // Another request than the first: a key of its own.
                await post({
                  action: "row.update",
                  pageId: change.pageId,
                  rowId: change.rowId,
                  version: merged.version,
                  cells: merged.send,
                }, `${key.slice(0, 120)}-merged`);
            }
          }
        } catch (e) {
          if (offline(e)) break;
          const reason = friendlyError(e);
          // Pages and files are kept with the reason (nothing is lost);
          // a refused record change is discarded as before.
          if (change.kind === "page" || change.kind === "upload") {
            failById(change.id, reason);
            continue;
          }
          notify(tr(`Offline-Änderung verworfen: ${reason}`, `Offline change discarded: ${reason}`));
        }
        removeById(change.id);
      }
    } finally {
      running.current = false;
      setSyncing(false);
      if (found.length) storeConflicts((current) => [...current, ...found]);
      await onSynced().catch(() => undefined);
    }
  }, [store, storeFailed, storeConflicts, notify, onSynced, sendPage, sendUpload, failById, removeById]);
  const retry = useCallback(
    (id: string) => {
      const next = retryFailed(queueRef.current, failedRef.current, id);
      storeFailed(next.failed);
      store(next.queue);
      void flush();
    },
    [store, storeFailed, flush],
  );
  useEffect(() => {
    const online = () => void flush();
    window.addEventListener("online", online);
    const timer = setInterval(() => {
      if (queueRef.current.length) void flush();
    }, 30000);
    void flush();
    return () => {
      window.removeEventListener("online", online);
      clearInterval(timer);
    };
  }, [flush]);
  // The editor hands files to this queue; open views ask it to send.
  useEffect(() => {
    setUploader(addUpload);
    setKick(() => void flush());
    return () => {
      setUploader(null);
      setKick(null);
    };
  }, [addUpload, flush]);
  const resolve = useCallback(
    async (conflict: Conflict, keepMine: boolean) => {
      if (keepMine) {
        const { change } = conflict;
        const current = (await currentRows(change.pageId)).find(
          (r) => r.id === change.rowId,
        );
        if (current)
          await post({
            action: "row.update",
            pageId: change.pageId,
            rowId: change.rowId,
            version: current.version,
            cells: change.cells,
          }, newIdempotencyKey());
        // Deleted elsewhere: the own version comes back as a new record.
        else
          await post({
            action: "row.create",
            pageId: change.pageId,
            cells: { ...change.base, ...change.cells },
            templateId: null,
          }, newIdempotencyKey());
      }
      // From the list as it is now: a flush may have added conflicts.
      storeConflicts((current) => withoutConflict(current, conflict));
      await onSynced();
    },
    [storeConflicts, onSynced],
  );
  // The lists as they are now (before React shows them).
  const current = useCallback(() => ({ queue: queueRef.current, failed: failedRef.current }), []);
  return { queue, conflicts, failed, syncing, enqueue, flush, resolve, addPage, renamePage, addUpload, discard, discardFile, retry, current };
}
export const isQueueable = (b: Record<string, unknown>) =>
  queueableActions.has(String(b.action)) && typeof b.pageId === "string";

export function OfflineConflicts({
  conflicts,
  fields,
  resolve,
}: {
  conflicts: Conflict[];
  fields: (pageId: string) => Field[];
  resolve: (conflict: Conflict, keepMine: boolean) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const conflict = conflicts[0];
  if (!conflict) return null;
  const names = fields(conflict.change.pageId);
  const name = (id: string) => names.find((f) => f.id === id)?.name || id;
  const title =
    cellText(
      conflict.change.cells[names[0]?.id] ?? conflict.change.base[names[0]?.id],
    ) || t("Eintrag", "Record");
  const act = async (keepMine: boolean) => {
    setBusy(true);
    try {
      await resolve(conflict, keepMine);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={() => undefined}
      title={t("Konflikt mit Offline-Änderungen", "Conflict with offline changes")}
    >
      <p>
        „{title}{t("“ wurde geändert, während du offline warst", "” was changed while you were offline")}
        {conflicts.length > 1 ? t(` (1 von ${conflicts.length} Konflikten)`, ` (1 of ${conflicts.length} conflicts)`) : ""}.
      </p>
      {conflict.current ? (
        <table className="offline-conflict">
          <thead>
            <tr>
              <th>{t("Eigenschaft", "Property")}</th>
              <th>{t("Deine Änderung", "Your change")}</th>
              <th>{t("Aktueller Wert", "Current value")}</th>
            </tr>
          </thead>
          <tbody>
            {conflict.fields.map((f) => (
              <tr key={f}>
                <th scope="row">{name(f)}</th>
                <td>{cellText(conflict.change.cells[f]) || t("leer", "empty")}</td>
                <td>{cellText(conflict.current![f]) || t("leer", "empty")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t("Der Eintrag wurde inzwischen gelöscht.", "The record has been deleted in the meantime.")}</p>
      )}
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={() => act(false)}>
          {conflict.current ? t("Aktuellen Wert behalten", "Keep current value") : t("Änderung verwerfen", "Discard change")}
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => act(true)}
        >
          {conflict.current
            ? t("Meine Änderung übernehmen", "Apply my change")
            : t("Als neuen Eintrag anlegen", "Create as a new record")}
        </button>
      </div>
    </Modal>
  );
}
