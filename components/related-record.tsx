"use client";
// A record of another database opened from a relation cell (#192): it shows
// in that database's own record dialog on top of the current view, loaded
// and saved exactly as there (GET /api/pages/<id> with the viewer's
// permissions, changes through /api/command), so closing it returns to the
// view it was opened from. "In Datenbank öffnen" (or a Ctrl/⌘-click on the
// relation) goes to the record in its database instead. The overlay is an
// entry of the tab's history with the same address (lib/related-record.ts):
// Back closes it, closing it goes back to the entry before.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { api, Modal, reportError } from "./ui";
import { ViewSkeleton } from "./skeleton";
import { loadView } from "./view-fallback";
import type { DatabaseData } from "./database-view";
import { leaveTo } from "@/lib/history-nav";
import { pageLocationHash } from "@/lib/page-location";
import { onRelatedEntry, plainClick, pushRelatedEntry } from "@/lib/related-record";
import type { AiStatus } from "@/lib/ai/features";
import type { Page, Role, User } from "@/lib/types";

const DatabaseView = dynamic(() => loadView(() => import("./database-view")), { ssr: false });
const JournalLockScreen = dynamic(() => import("./journal-parts").then((m) => m.JournalLockScreen), { ssr: false });

export type RelatedTarget = { pageId: string; rowId: string };
type Open = RelatedTarget & { token: string };

// The overlay's state for one view: open(), close() (Back, the dialog's
// close button, Escape, dragging the sheet down) and openInDatabase().
export function useRelatedRecord() {
  const [target, setTarget] = useState<Open | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const current = useRef<Open | null>(null);
  current.current = target;
  useEffect(() => {
    if (!target) return;
    // Back (or forward) away from the overlay's entry closes it; a link
    // inside the record (backlinks, mentions) leads elsewhere and closes it.
    const pop = () => {
      if (!onRelatedEntry(history, target.token)) setTarget(null);
    };
    const leave = () => setTarget(null);
    window.addEventListener("popstate", pop);
    window.addEventListener("hashchange", leave);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("hashchange", leave);
    };
  }, [target]);
  const open = useCallback((next: RelatedTarget, from?: HTMLElement | null) => {
    opener.current = from || null;
    const token = Math.random().toString(36).slice(2);
    // Another record from inside the overlay takes its entry.
    const previous = current.current;
    pushRelatedEntry(history, token, !!previous && onRelatedEntry(history, previous.token));
    setTarget({ ...next, token });
  }, []);
  const close = useCallback(() => {
    const open = current.current;
    if (!open) return;
    setTarget(null);
    if (onRelatedEntry(history, open.token)) history.back();
    const back = opener.current;
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus();
    });
  }, []);
  // full: as a page of its own ("Als Seite öffnen", #231).
  const openInDatabase = useCallback((full?: boolean) => {
    const open = current.current;
    if (!open) return;
    setTarget(null);
    // In place of the overlay's entry: Back from the database returns to
    // the view the record was opened from.
    leaveTo(pageLocationHash({ pageId: open.pageId, rowId: open.rowId, full: full === true }), onRelatedEntry(history, open.token) ? "replace" : "push");
  }, []);
  return { target, open, close, openInDatabase };
}

type RecordData = DatabaseData & {
  page: Page;
  role: Role;
  locked?: { journalId: string; canReset?: boolean };
};

export function RelatedRecord({
  target,
  onClose,
  onOpenInDatabase,
  onChanged,
  onError,
  userId,
  members,
  pages,
  ai,
  favoriteRows,
}: {
  target: RelatedTarget;
  onClose: () => void;
  onOpenInDatabase: (full?: boolean) => void;
  // The view behind it shows titles, icons and rollups of this record.
  onChanged: () => Promise<unknown>;
  onError: (message: string) => void;
  userId: string;
  members: User[];
  pages: Page[];
  ai?: AiStatus;
  favoriteRows?: { pageId: string; rowId: string; title: string }[];
}) {
  const t = useT();
  const [data, setData] = useState<RecordData | null>(null),
    [failed, setFailed] = useState(false);
  const pageId = target.pageId;
  const reload = useCallback(async () => {
    try {
      const next = await api<RecordData>(`/api/pages/${pageId}`);
      setData(next);
      setFailed(false);
    } catch (error) {
      setFailed(true);
      throw error;
    }
  }, [pageId]);
  useEffect(() => {
    setData(null);
    setFailed(false);
    reload().catch((error) => reportError(error));
  }, [reload]);
  // Changes made elsewhere meanwhile, as in the split view.
  useEffect(() => {
    if (!data?.database) return;
    const timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible") void reload().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [data?.database, reload]);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const mutate = useCallback(
    async (body: Record<string, unknown>) => {
      const result = await api("/api/command", body);
      await reload();
      void changed.current().catch(() => {});
      return result;
    },
    [reload],
  );
  const usable = !!data?.database && !data.locked && data.rows.some((r) => r.id === target.rowId);
  if (data && usable)
    return (
      <DatabaseView
        key={`${data.page.id}-${target.rowId}`}
        record={{ id: target.rowId, onClose, onOpenInDatabase }}
        page={data.page}
        data={data}
        userId={userId}
        members={members}
        pages={pages}
        // As in the database itself (components/workspace-app.tsx);
        // record permissions and read-only properties apply inside.
        editable={["editor", "owner"].includes(data.role) && !data.page.locked}
        ai={ai}
        favoriteRows={favoriteRows}
        mutate={mutate}
        onRefresh={reload}
        onError={onError}
      />
    );
  const href = pageLocationHash(target);
  return (
    <Modal open onClose={onClose} title={t("Eintrag", "Record")} wide sheet className="record-dialog related-record-pending">
      {!data && !failed ? (
        <ViewSkeleton />
      ) : data?.locked ? (
        <JournalLockScreen journalId={data.locked.journalId} canReset={!!data.locked.canReset} onUnlocked={reload} />
      ) : (
        <p className="muted">
          {data?.database || failed
            ? t("Dieser Eintrag ist nicht verfügbar.", "This record is not available.")
            : t("Dieser Eintrag lässt sich nur in seiner Datenbank öffnen.", "This record can only be opened in its database.")}
        </p>
      )}
      {(failed || (data && !data.locked)) && (
        <p>
          <a
            className="button"
            href={href}
            onClick={(e) => {
              if (!plainClick(e)) return;
              e.preventDefault();
              onOpenInDatabase();
            }}
          >
            {t("In Datenbank öffnen", "Open in database")}
          </a>
        </p>
      )}
    </Modal>
  );
}
