"use client";
// Split view: a second page next to the open one (page menu "In geteilter
// Ansicht öffnen", Ctrl/⌘-click on a link or in the page tree, dragging a
// page to the right edge). The pane loads and shows its page on its own –
// documents with their editor, databases, whiteboards and dashboards – with
// a header of its own. The divider resizes both panes with the pointer or
// the arrow keys. components/workspace-app.tsx keeps which page is open in
// the address (?split=<id>) and turns it off on narrow screens.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { useStatusLabel, useT } from "./i18n";
import { api, PageIcon, PageSkeleton, reportError } from "./ui";
import DatabaseView, { type DatabaseData } from "./database-view";
import { readModeIds } from "@/lib/read-mode";
import type { Page, Role, User } from "@/lib/types";
import type { AiStatus } from "@/lib/ai/features";

const DocumentEditor = dynamic(() => import("./editor"), { ssr: false, loading: () => <PageSkeleton compact /> });
const DashboardView = dynamic(() => import("./dashboard-view"), { ssr: false });
const Whiteboard = dynamic(() => import("./whiteboard/whiteboard"), { ssr: false, loading: () => <PageSkeleton compact /> });

type PaneData = DatabaseData & {
  page: Page;
  role: Role;
  html: string;
  state: string | null;
  generation: string;
  whiteboard?: { state: string; generation: string };
  dashboard?: import("./dashboard-view").DashboardPayload;
  locked?: { journalId: string };
  journal?: unknown;
};

// The editor's HTML is not needed here; one function, so the editor does not restart.
const ignoreHtml = () => {};
// The share of the width the first pane takes, in percent.
export const SPLIT_MIN = 25,
  SPLIT_MAX = 75;
export const clampSplit = (value: number) => Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value)));

export function SplitDivider({
  value,
  onChange,
  container,
}: {
  value: number;
  onChange: (value: number) => void;
  container: () => HTMLElement | null;
}) {
  const t = useT();
  const dragging = useRef<number | null>(null);
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("Breite der geteilten Ansicht", "Width of the split view")}
      aria-valuenow={value}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      aria-valuetext={t(`${value} % links, ${100 - value} % rechts`, `${value} % left, ${100 - value} % right`)}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 2;
        const next =
          e.key === "ArrowLeft" ? value - step
          : e.key === "ArrowRight" ? value + step
          : e.key === "Home" ? SPLIT_MIN
          : e.key === "End" ? SPLIT_MAX
          : e.key === "Enter" ? 50
          : null;
        if (next === null) return;
        e.preventDefault();
        onChange(clampSplit(next));
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = e.pointerId;
        document.documentElement.classList.add("split-resizing");
      }}
      onPointerMove={(e) => {
        if (dragging.current !== e.pointerId) return;
        const box = container()?.getBoundingClientRect();
        if (!box?.width) return;
        onChange(clampSplit(((e.clientX - box.left) / box.width) * 100));
      }}
      onPointerUp={(e) => {
        if (dragging.current !== e.pointerId) return;
        dragging.current = null;
        document.documentElement.classList.remove("split-resizing");
      }}
      onPointerCancel={() => {
        dragging.current = null;
        document.documentElement.classList.remove("split-resizing");
      }}
      onDoubleClick={() => onChange(50)}
    />
  );
}

export function SplitPane({
  pageId,
  userId,
  userName,
  demo,
  pages,
  members,
  ai,
  transcription,
  onClose,
  onOpenMain,
  onOpenPage,
}: {
  pageId: string;
  userId: string;
  userName: string;
  demo: boolean;
  pages: Page[];
  members: (User & { role?: Role })[];
  ai?: AiStatus;
  transcription: boolean;
  onClose: () => void;
  // Shows the page in the main view instead (the split closes).
  onOpenMain: (id: string) => void;
  onOpenPage: (id: string) => void;
}) {
  const t = useT();
  const statusLabel = useStatusLabel();
  const [data, setData] = useState<PaneData | null>(null),
    [failed, setFailed] = useState(false),
    [status, setStatus] = useState("Gespeichert");
  const current = useRef(pageId);
  current.current = pageId;
  const reload = useCallback(async () => {
    const id = current.current;
    try {
      const next = await api<PaneData>(`/api/pages/${id}`);
      if (current.current === id) {
        setData(next);
        setFailed(false);
      }
    } catch (error) {
      if (current.current !== id) return;
      setFailed(true);
      throw error;
    }
  }, []);
  useEffect(() => {
    setData(null);
    setFailed(false);
    reload().catch((error) => reportError(error));
  }, [pageId, reload]);
  // Databases and dashboards follow changes made elsewhere (documents sync live).
  useEffect(() => {
    if (!data || data.page.kind === "document") return;
    const timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible") void reload().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [data, reload]);
  const mutate = useCallback(
    async (body: Record<string, unknown>) => {
      const result = await api("/api/command", body);
      await reload();
      return result;
    },
    [reload],
  );
  const onError = useCallback((error: unknown) => void reportError(error), []);
  const page = data?.page || pages.find((p) => p.id === pageId);
  const editable =
    !!data && ["editor", "owner"].includes(data.role) && !data.page.locked && !(data.page.kind === "document" && readModeIds().includes(data.page.id));
  let body: React.ReactNode;
  if (failed) body = <div className="loading-content">{t("Seite nicht verfügbar.", "Page not available.")}</div>;
  else if (!data) body = <PageSkeleton kind={page?.kind === "database" ? "database" : "document"} />;
  else if (data.page.kind === "database")
    body = (
      <DatabaseView
        key={data.page.id}
        page={data.page}
        userId={userId}
        onRefresh={reload}
        data={data}
        members={members}
        pages={pages}
        editable={editable}
        ai={ai}
        mutate={mutate}
        onError={onError}
      />
    );
  else if (data.page.kind === "whiteboard" && data.whiteboard)
    body = (
      <Whiteboard
        key={`${data.page.id}-${data.whiteboard.generation}`}
        pageId={data.page.id}
        state={data.whiteboard.state}
        generation={data.whiteboard.generation}
        editable={editable}
        pages={pages.map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind }))}
        onReload={reload}
        onError={onError}
        onOpenPage={onOpenPage}
        userId={userId}
        userName={userName}
        demo={demo}
      />
    );
  else if (data.page.kind === "dashboard" && data.dashboard)
    body = (
      <DashboardView
        key={data.page.id}
        pageId={data.page.id}
        dashboard={data.dashboard}
        editable={editable}
        userId={userId}
        members={members}
        pages={pages}
        onRefresh={reload}
        onError={onError}
      />
    );
  else if (data.page.kind === "document" && !data.locked && !data.journal)
    body = (
      <DocumentEditor
        key={`${data.page.id}-${data.generation}`}
        generation={data.generation}
        pageId={data.page.id}
        userId={userId}
        pages={pages}
        members={members}
        state={data.state}
        html={data.html}
        editable={editable}
        onStatus={setStatus}
        onError={onError}
        onHtml={ignoreHtml}
        transcription={transcription}
      />
    );
  else
    body = (
      <div className="split-unsupported">
        <p>{t("Diese Seite lässt sich nur in der Hauptansicht öffnen.", "This page can only be opened in the main view.")}</p>
        <button type="button" className="button" onClick={() => onOpenMain(pageId)}>
          {t("In der Hauptansicht öffnen", "Open in the main view")}
        </button>
      </div>
    );
  return (
    <section className="split-pane" aria-label={t(`Geteilte Ansicht: ${page?.title || "Seite"}`, `Split view: ${page?.title || "Page"}`)}>
      <header className="split-pane-header">
        <PageIcon name={page?.kind === "database" ? "table" : page?.icon || "file"} size={16} />
        <strong title={page?.title}>{page?.title || t("Ohne Titel", "Untitled")}</strong>
        {data?.page.kind === "document" && <span className="split-pane-status">{statusLabel(status)}</span>}
        <button
          type="button"
          className="icon-button"
          title={t("In der Hauptansicht öffnen", "Open in the main view")}
          aria-label={t("In der Hauptansicht öffnen", "Open in the main view")}
          onClick={() => onOpenMain(pageId)}
        >
          <ArrowSquareOut size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t("Geteilte Ansicht schließen", "Close split view")}
          aria-label={t("Geteilte Ansicht schließen", "Close split view")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="split-pane-scroll">
        <article
          className={`page-content split-page-content ${data?.page.kind === "database" ? "database-page" : ""} ${data?.page.kind === "whiteboard" ? "whiteboard-page" : ""} font-${data?.page.font || "sans"}`}
        >
          {data && data.page.kind !== "whiteboard" && (
            <h1 className="split-page-title">
              <PageIcon name={data.page.icon} size={26} /> {data.page.title || t("Ohne Titel", "Untitled")}
            </h1>
          )}
          {body}
        </article>
      </div>
    </section>
  );
}
