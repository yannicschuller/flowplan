"use client";
// Split view: the right frame of the tabs (#279, components/frame-tabs.tsx)
// – opened with "In geteilter Ansicht öffnen", Ctrl/⌘+Shift-click on a
// link or in the page tree, dragging a page or a tab to the right edge. The
// pane loads and shows its active tab's page on its own – documents with
// their editor, databases, whiteboards and dashboards – under the frame's
// tab bar, framed as in the main frame (components/page-chrome.tsx, #652):
// cover, icon and title, tags and properties, related pages, sub-pages. The divider resizes both frames with the pointer or the arrow
// keys. components/workspace-app.tsx keeps which page is open in the
// address (?split=<id>) and hides the frame on narrow screens.
import dynamic from "next/dynamic";
import { ViewBoundary, loadView } from "@/components/view-fallback";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { api, PageSkeleton, reportError } from "./ui";
import type { DatabaseData } from "./database-view";
import { ViewSkeleton } from "./skeleton";
import { readModeIds } from "@/lib/read-mode";
import { featureModules } from "@/lib/feature-modules-client";
import { PAGE_KIND_MODULE } from "@/lib/feature-modules";
import { PageCover, PageDiscovery, PageHeader, PageMetaBar, SubPages, pageContentClass, type Backlink } from "./page-chrome";
import { showsFullWidth } from "@/lib/page-width-pref";
import { pageLocationHash } from "@/lib/page-location";
import type { WorkspaceTaxonomy } from "@/lib/page-properties";
import type { Page, Role, User } from "@/lib/types";
import type { AiStatus } from "@/lib/ai/features";

const DocumentEditor = dynamic(() => loadView(() => import("./editor")), { ssr: false, loading: () => <PageSkeleton compact /> });
const DatabaseView = dynamic(() => loadView(() => import("./database-view")), { ssr: false, loading: () => <ViewSkeleton /> });
const DashboardView = dynamic(() => loadView(() => import("./dashboard-view")), { ssr: false });
const NotebookView = dynamic(() => loadView(() => import("./notebook/notebook-view")), { ssr: false, loading: () => <PageSkeleton compact /> });
const Whiteboard = dynamic(() => loadView(() => import("./whiteboard/whiteboard")), { ssr: false, loading: () => <PageSkeleton compact /> });

type PaneData = DatabaseData & {
  page: Page;
  role: Role;
  html: string;
  state: string | null;
  generation: string;
  whiteboard?: { state: string; generation: string };
  dashboard?: import("./dashboard-view").DashboardPayload;
  notebook?: import("@/lib/notebook").NotebookPayload;
  locked?: { journalId: string };
  journal?: unknown;
  properties?: import("@/lib/page-properties").PageMeta;
  propertiesCollapsed?: boolean | null;
  backlinks?: Backlink[];
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
  tabBar,
  onOpenMain,
  onOpenPage,
  taxonomy,
  spaces,
  recordParents,
  allPagesWide,
  onAddSubPage,
  onChanged,
  reloadRef,
}: {
  pageId: string;
  userId: string;
  userName: string;
  demo: boolean;
  pages: Page[];
  members: (User & { role?: Role })[];
  ai?: AiStatus;
  transcription: boolean;
  // The frame's tabs (components/frame-tabs.tsx).
  tabBar: React.ReactNode;
  // Shows the page in the main view instead (its tab moves there).
  onOpenMain: (id: string) => void;
  onOpenPage: (id: string) => void;
  taxonomy: WorkspaceTaxonomy | undefined;
  spaces: { id: string; name: string }[];
  recordParents: { pageId: string; rowId: string }[] | undefined;
  // "Volle Breite" for every page (lib/page-width-pref.ts).
  allPagesWide: boolean;
  // "Unterseite hinzufügen": the new-page dialog of the main frame.
  onAddSubPage: (parentId: string, spaceId: string) => void;
  // After a change made here: the main frame and the tree follow.
  onChanged: () => void;
  // Set to this frame's reload while it shows: the main frame's changes
  // reload it too (the same database open in both frames).
  reloadRef?: React.RefObject<(() => Promise<void>) | null>;
}) {
  const t = useT();
  const [data, setData] = useState<PaneData | null>(null),
    [failed, setFailed] = useState(false),
    [, setStatus] = useState("Gespeichert");
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
  useEffect(() => {
    if (!reloadRef) return;
    reloadRef.current = reload;
    return () => {
      if (reloadRef.current === reload) reloadRef.current = null;
    };
  }, [reload, reloadRef]);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const mutate = useCallback(
    async (body: Record<string, unknown>) => {
      const result = await api("/api/command", body);
      await reload();
      changed.current();
      return result;
    },
    [reload],
  );
  const onError = useCallback((error: unknown) => void reportError(error), []);
  // For the page's head (title, tags, properties): a refusal shows as a toast.
  const act = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        return await mutate(body);
      } catch (error) {
        reportError(error);
        return null;
      }
    },
    [mutate],
  );
  const page = data?.page || pages.find((p) => p.id === pageId);
  // Read-only while its kind is switched off for the instance (#386).
  const kindOff = !!data && featureModules().off.some((m) => m === (data.page.journal_date ? "journal" : PAGE_KIND_MODULE[data.page.kind]));
  const editable =
    !!data && ["editor", "owner"].includes(data.role) && !data.page.locked && !(data.page.kind === "document" && readModeIds().includes(data.page.id)) && !kindOff;
  // A record or a page linking here: a record opens in the main frame (its
  // dialog), a page in this frame.
  const openHere = (id: string, rowId?: string) => {
    if (rowId) location.hash = pageLocationHash({ pageId: id, rowId });
    else onOpenPage(id);
  };
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
        pages={pages.map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, journal_date: p.journal_date, aliases: p.aliases }))}
        members={members}
        workspaceId={data.page.workspace_id}
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
  else if (data.page.kind === "notebook" && data.notebook)
    body = <NotebookView key={data.page.id} pageId={data.page.id} userId={userId} title={data.page.title} notebook={data.notebook} editable={editable && !data.page.locked} onError={onError} />;
  else if (data.page.kind === "document" && !data.locked && !data.journal)
    body = (
      <DocumentEditor
        key={`${data.page.id}-${data.generation}`}
        generation={data.generation}
        pageId={data.page.id}
        userId={userId}
        pages={pages}
        captionNumbers={!!data.page.caption_numbers}
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
  // The document editor with block handles: its head starts where the text
  // starts (#603, .with-block-room in app/globals.css).
  const blockRoom = editable && data?.page.kind === "document" && !data.locked && !data.journal;
  return (
    <section className="split-pane" aria-label={t(`Geteilte Ansicht: ${page?.title || t("Seite", "Page")}`, `Split view: ${page?.title || t("Seite", "Page")}`)}>
      {tabBar}
      <div className="split-pane-scroll" id="frame-panel-1" role="tabpanel">
        {/* The same layout and classes as the main frame's page (#652). */}
        <div className="page-layout">
          {!data ? (
            <article className="page-content">
              <ViewBoundary key={pageId}>{body}</ViewBoundary>
            </article>
          ) : (
            <article className={pageContentClass(data.page, { fullWidth: showsFullWidth(data.page.full_width, allPagesWide), blockRoom: !!blockRoom })}>
              <PageCover page={data.page} />
              <PageHeader
                key={data.page.id}
                page={data.page}
                readOnly={!editable}
                kindOff={kindOff}
                onTitle={(title) => void act({ action: "page.update", pageId: data.page.id, patch: { title } })}
              />
              {!data.locked && (
                <PageMetaBar
                  page={data.page}
                  taxonomy={taxonomy}
                  meta={data.properties}
                  collapsedChoice={data.propertiesCollapsed}
                  members={members}
                  editable={editable}
                  act={act}
                  spaces={spaces}
                />
              )}
              <ViewBoundary key={pageId}>{body}</ViewBoundary>
              <PageDiscovery
                page={data.page}
                closed={!!data.locked}
                editable={editable}
                backlinks={data.backlinks}
                onOpenRelated={openHere}
                onOpenMention={openHere}
                onOpenBacklink={(p) => openHere(p.id, p.rowId)}
                onLinked={() => void reload().then(() => changed.current(), () => {})}
                onError={onError}
              />
              <SubPages
                page={data.page}
                pages={pages}
                recordParents={recordParents}
                onOpen={(id) => onOpenPage(id)}
                onAdd={editable ? () => onAddSubPage(data.page.id, data.page.space_id) : undefined}
              />
            </article>
          )}
        </div>
      </div>
    </section>
  );
}

// A screen of the app (start page, inbox, settings …) in the right frame:
// those show in the left frame only.
export function SplitUnsupported({ tabBar, title, onOpenMain }: { tabBar: React.ReactNode; title: string; onOpenMain: () => void }) {
  const t = useT();
  return (
    <section className="split-pane" aria-label={t(`Geteilte Ansicht: ${title}`, `Split view: ${title}`)}>
      {tabBar}
      <div className="split-pane-scroll" id="frame-panel-1" role="tabpanel">
        <div className="page-content split-unsupported">
          <p>{t(`„${title}“ lässt sich nur in der linken Ansicht zeigen.`, `“${title}” can only be shown in the left view.`)}</p>
          <button type="button" className="button" onClick={onOpenMain}>
            {t("In der linken Ansicht öffnen", "Open in the left view")}
          </button>
        </div>
      </div>
    </section>
  );
}
