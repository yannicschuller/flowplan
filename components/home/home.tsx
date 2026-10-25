"use client";
// The start page: a grid of widgets each person arranges for themselves
// ("Anpassen"), per workspace or as their default for all of them
// (lib/home-layout.ts). The grid has one column on phones, two on tablets
// and three or four on wide screens. Editing loads on demand
// (components/home/home-editor.tsx).
import dynamic from "next/dynamic";
import { ViewBoundary, loadView } from "@/components/view-fallback";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { api } from "../ui";
import type { Bootstrap, Page, PageKind } from "@/lib/types";
import type { PageLocation } from "@/lib/page-location";
import type { HomeState } from "@/lib/home-layout";
import { isServerKind, type HomeLayout } from "@/lib/home-layout-schema";
import { HomeEnvContext, WidgetBody, WidgetFrame, widgetHidden, type HomeEnv, type WidgetResult } from "./widgets";
import { localDay, localZone } from "./format";
import { headerStyle } from "./look";

const HomeEditor = dynamic(() => loadView(() => import("./home-editor")), { ssr: false });

export type HomeProps = {
  boot: Bootstrap;
  pages: Page[];
  clock: number | null;
  canCreate: boolean;
  // Asked to open the editor (command palette "Customize home page").
  customize: number;
  openPage: (id: string, target?: PageLocation) => void;
  addPage: (kind?: PageKind) => void;
  openCapture: () => void;
  go: (screen: "inbox" | "tasks" | "admin") => void;
  mutate: (body: Record<string, unknown>) => Promise<unknown>;
  notify: (message: string) => void;
  notifyError: (error: unknown) => void;
  onHome: (home: HomeState) => void;
  footnote?: ReactNode;
};

export default function HomeScreen(props: HomeProps) {
  const { boot, clock, notifyError } = props;
  const t = useT();
  const locale = useLocale();
  const workspaceId = boot.workspace.id;
  const saved = boot.home?.layout;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HomeLayout | null>(null);
  const layout = (editing && draft) || saved;
  // The day changes at midnight with the clock.
  const today = useMemo(() => localDay(clock === null ? new Date() : new Date(clock)), [clock]);

  // ---- Data of the server widgets ----
  const [data, setData] = useState<Record<string, WidgetResult | undefined>>({});
  const [version, setVersion] = useState(0);
  const serverWidgets = useMemo(
    () => (layout?.widgets || []).filter((w) => isServerKind(w.kind) && (w.kind !== "instance" || boot.user.isAdmin)),
    [layout, boot.user.isAdmin],
  );
  const request = JSON.stringify(serverWidgets.map((w) => ({ id: w.id, kind: w.kind, config: w.config })));
  const lastLoad = useRef(0);
  useEffect(() => {
    const widgets = JSON.parse(request) as { id: string }[];
    if (!widgets.length) return;
    let current = true;
    // While editing, settings change quickly: wait a moment.
    const timer = setTimeout(
      () => {
        lastLoad.current = Date.now();
        api<{ widgets: WidgetResult[] }>("/api/home/data", { workspaceId, today, zone: localZone(), widgets })
          .then((result) => {
            if (!current) return;
            setData((prior) => {
              const next = { ...prior };
              for (const w of result.widgets) next[w.id] = w;
              return next;
            });
          })
          .catch(() => {
            // Offline or failed: what was shown stays.
          });
      },
      editing ? 350 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [request, workspaceId, today, version, editing]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // Back on the start page or the tab: fresh data, at most every 20 s.
  useEffect(() => {
    if (Date.now() - lastLoad.current > 20_000) reload();
  }, [boot, reload]);
  useEffect(() => {
    const visible = () => document.visibilityState === "visible" && Date.now() - lastLoad.current > 20_000 && reload();
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => document.visibilityState === "visible" && reload(), 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
    };
  }, [reload]);

  const action = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        await api("/api/home/action", body);
        reload();
        return true;
      } catch (e) {
        notifyError(e);
        return false;
      }
    },
    [reload, notifyError],
  );
  const { onHome } = props;
  const saveNote = useCallback(
    (widgetId: string, text: string) => {
      api("/api/command", { action: "home.note", workspaceId, widgetId, text }).catch(notifyError);
      // Kept in the layout here too, so leaving and coming back shows it.
      if (boot.home)
        onHome({
          ...boot.home,
          layout: { ...boot.home.layout, widgets: boot.home.layout.widgets.map((w) => (w.id === widgetId && w.kind === "notes" ? { ...w, config: { ...w.config, text } } : w)) },
        });
    },
    [workspaceId, boot.home, onHome, notifyError],
  );

  // ---- Editing ----
  const start = useCallback(() => {
    if (!saved) return;
    setDraft(structuredClone(saved));
    setEditing(true);
  }, [saved]);
  const lastSignal = useRef(props.customize);
  useEffect(() => {
    if (props.customize === lastSignal.current) return;
    lastSignal.current = props.customize;
    start();
  }, [props.customize, start]);
  // Another workspace: leave the editor.
  useEffect(() => {
    setEditing(false);
    setDraft(null);
    setData({});
  }, [workspaceId]);
  const customizeButton = useRef<HTMLButtonElement>(null);
  const finish = useCallback((home?: HomeState) => {
    if (home) onHome(home);
    setEditing(false);
    setDraft(null);
    requestAnimationFrame(() => customizeButton.current?.focus());
  }, [onHome]);

  const env: HomeEnv = {
    boot,
    pages: props.pages,
    clock,
    today,
    locale,
    canCreate: props.canCreate,
    editing,
    data,
    openPage: props.openPage,
    addPage: props.addPage,
    openCapture: props.openCapture,
    go: props.go,
    mutate: props.mutate,
    notify: props.notify,
    notifyError,
    action,
    reload,
    saveNote,
  };
  if (!layout) return null;
  const look = layout.appearance;
  const cover = headerStyle(look.header);
  const hasGreeting = layout.widgets.some((w) => w.kind === "greeting");
  return (
    <HomeEnvContext.Provider value={env}>
      <div className={`home-screen bg-${look.background}`}>
        <div className={`home-content density-${look.density} width-${look.width}${editing ? " editing" : ""}`}>
          {editing && draft ? (
            <ViewBoundary>
            <HomeEditor
              draft={draft}
              setDraft={setDraft}
              state={boot.home!}
              workspace={boot.workspace}
              isAdmin={boot.user.isAdmin}
              pages={props.pages}
              spaces={boot.spaces}
              onDone={finish}
              onError={notifyError}
            />
            </ViewBoundary>
          ) : (
            <>
              <div className="home-top">
                <button ref={customizeButton} type="button" className="button compact home-customize" onClick={start} disabled={clock === null}>
                  <SlidersHorizontal size={16} aria-hidden />
                  {t("Anpassen", "Customize")}
                </button>
              </div>
              {(cover || look.icon) && (
                <div className={`home-header${cover ? " with-cover" : ""}`}>
                  {cover && <div className="home-cover" style={cover} aria-hidden />}
                  {look.icon && (
                    <span className="home-icon" aria-hidden>
                      {look.icon}
                    </span>
                  )}
                </div>
              )}
              {!hasGreeting && <h1 className="sr-only">{t("Startseite", "Home")}</h1>}
              <div className="home-grid-wrap">
                <div className="home-grid">
                  {layout.widgets
                    .filter((w) => !widgetHidden(w, env))
                    .map((w) => (
                      <WidgetFrame key={w.id} widget={w}>
                        <WidgetBody widget={w} />
                      </WidgetFrame>
                    ))}
                </div>
              </div>
              {props.footnote}
            </>
          )}
        </div>
      </div>
    </HomeEnvContext.Provider>
  );
}
