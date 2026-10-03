"use client";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  mergeChange,
  queueKey,
  queueableActions,
  type Conflict,
  type QueuedChange,
} from "@/lib/offline-queue";
import { cellText } from "@/lib/cell-text";
import { Modal } from "./ui";
import type { Field, Row } from "@/lib/types";

class HttpFailure extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new HttpFailure(result.error || tr("Fehler", "Error"), response.status);
  return result;
}
async function currentRows(pageId: string): Promise<Row[]> {
  const response = await fetch(`/api/pages/${pageId}`, { cache: "no-store" });
  if (!response.ok) throw new HttpFailure(tr("Seite fehlt.", "Page missing."), response.status);
  return (await response.json()).rows || [];
}
const read = (key: string): QueuedChange[] => {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
};
const offline = (e: unknown) => !(e instanceof HttpFailure);

// Waiting record changes of this person on this device (see
// lib/offline-queue.ts) with sending and conflict handling.
export function useOfflineQueue({
  userId,
  onSynced,
  notify,
}: {
  userId: string;
  onSynced: () => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const key = queueKey(userId);
  const [queue, setQueue] = useState<QueuedChange[]>([]),
    [conflicts, setConflicts] = useState<Conflict[]>([]),
    [syncing, setSyncing] = useState(false);
  const queueRef = useRef<QueuedChange[]>([]),
    running = useRef(false);
  const store = useCallback(
    (next: QueuedChange[]) => {
      queueRef.current = next;
      setQueue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        notify(
          tr("Offline-Änderungen konnten auf diesem Gerät nicht gesichert werden.", "Offline changes could not be stored on this device."),
        );
      }
    },
    [key, notify],
  );
  useEffect(() => {
    queueRef.current = read(key);
    setQueue(queueRef.current);
    try {
      setConflicts(
        JSON.parse(localStorage.getItem(`${key}:conflicts`) || "[]"),
      );
    } catch {}
  }, [key]);
  const storeConflicts = useCallback(
    (next: Conflict[]) => {
      setConflicts(next);
      try {
        localStorage.setItem(`${key}:conflicts`, JSON.stringify(next));
      } catch {}
    },
    [key],
  );
  // Takes a command instead of sending it; returns what the server would.
  const enqueue = useCallback(
    (b: Record<string, unknown>, rows: Row[]) => {
      const pageId = String(b.pageId),
        at = Date.now(),
        id = crypto.randomUUID();
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
      } else if (b.action === "row.delete")
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
      store([...queueRef.current, change]);
      return { id: change.rowId, offline: true };
    },
    [store],
  );
  const flush = useCallback(async () => {
    if (running.current || !queueRef.current.length || !navigator.onLine)
      return;
    running.current = true;
    setSyncing(true);
    const found: Conflict[] = [];
    try {
      while (queueRef.current.length) {
        const change = queueRef.current[0];
        try {
          if (change.kind === "create")
            await post({
              action: "row.create",
              pageId: change.pageId,
              rowId: change.rowId,
              cells: change.cells,
              templateId: null,
            });
          else if (change.kind === "delete") {
            try {
              await post({
                action: "row.delete",
                pageId: change.pageId,
                rowId: change.rowId,
              });
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
              });
            } catch (e) {
              if (!(e instanceof HttpFailure) || ![404, 409].includes(e.status))
                throw e;
              const current = (await currentRows(change.pageId)).find(
                (r) => r.id === change.rowId,
              );
              const merged = mergeChange(change, current);
              if ("conflict" in merged) found.push(merged.conflict);
              else if ("send" in merged)
                await post({
                  action: "row.update",
                  pageId: change.pageId,
                  rowId: change.rowId,
                  version: merged.version,
                  cells: merged.send,
                });
            }
          }
        } catch (e) {
          if (offline(e)) break;
          notify(tr(`Offline-Änderung verworfen: ${(e as Error).message}`, `Offline change discarded: ${(e as Error).message}`));
        }
        store(queueRef.current.slice(1));
      }
    } finally {
      running.current = false;
      setSyncing(false);
      if (found.length) storeConflicts([...conflicts, ...found]);
      await onSynced().catch(() => undefined);
    }
  }, [store, storeConflicts, conflicts, notify, onSynced]);
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
  const resolve = useCallback(
    async (conflict: Conflict, keepMine: boolean) => {
      const rest = conflicts.filter((c) => c.change.id !== conflict.change.id);
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
          });
        // Deleted elsewhere: the own version comes back as a new record.
        else
          await post({
            action: "row.create",
            pageId: change.pageId,
            cells: { ...change.base, ...change.cells },
            templateId: null,
          });
      }
      storeConflicts(rest);
      await onSynced();
    },
    [conflicts, storeConflicts, onSynced],
  );
  return { queue, conflicts, syncing, enqueue, flush, resolve };
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
                <td>{cellText(conflict.change.cells[f]) || "leer"}</td>
                <td>{cellText(conflict.current![f]) || "leer"}</td>
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
