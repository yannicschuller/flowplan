"use client";
// The widgets of the start page as they show (components/home/home.tsx).
// Widgets from the bootstrap (pages, favourites, inbox …) render at once;
// the others get their data from POST /api/home/data (lib/home-widgets.ts),
// already limited to what the person may see. The editing tools live in
// components/home/home-editor.tsx and load only when needed.
import { oneDayPerJournal } from "@/lib/journal-nav";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  CheckSquare,
  ChatCircle,
  Fire,
  LockKey,
  Plus,
  FileText,
  Table,
  Tray,
  Notebook,
  PresentationChart,
  WarningCircle,
  CheckCircle,
  Stop,
  Play,
} from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { WidgetSkeleton } from "../skeleton";
import { PageIcon } from "../ui";
import { Sparkline } from "../sparkline";
import { serverMessage } from "@/lib/i18n-errors";
import { notificationUrl, pageLocationHash, parsePageLocation, type PageLocation } from "@/lib/page-location";
import { dueLabel, dueState } from "@/lib/task-due-plugin";
import { useCaptureTargets } from "../capture-target";
import { Select } from "../select";
import type { Bootstrap, Page, PageKind } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import type { HomeWidget, WidgetConfig } from "@/lib/home-layout-schema";
import { widgetIcon, widgetName } from "./meta";
import { clockTime, dayHeading, greeting, hours, localDay, longDate, relativeTime } from "./format";

// ---- What the widgets get from the start page ----

export type WidgetResult = { id: string; kind: string; ok: true; data: Record<string, any> } | { id: string; kind: string; ok: false; status: number; error: string };
export type HomeEnv = {
  boot: Bootstrap;
  // Pages of the workspace (titles of encrypted spaces decrypted).
  pages: Page[];
  clock: number | null;
  today: string;
  locale: Locale;
  canCreate: boolean;
  editing: boolean;
  data: Record<string, WidgetResult | undefined>;
  openPage: (id: string, target?: PageLocation) => void;
  addPage: (kind?: PageKind) => void;
  openCapture: () => void;
  go: (screen: "inbox" | "tasks" | "admin") => void;
  mutate: (body: Record<string, unknown>) => Promise<unknown>;
  notify: (message: string) => void;
  notifyError: (error: unknown) => void;
  // A widget action (lib/home-widgets.ts); the data reloads afterwards.
  action: (body: Record<string, unknown>) => Promise<boolean>;
  // Fetches the widgets' data again.
  reload: () => void;
  saveNote: (widgetId: string, text: string) => void;
};
export const HomeEnvContext = createContext<HomeEnv | null>(null);
const useEnv = () => useContext(HomeEnvContext)!;

// Opens a link of the widget API ("/#page=…&row=…").
function useOpen() {
  const env = useEnv();
  return (url: string | undefined) => {
    if (!url) return;
    const hash = url.replace(/^\//, "");
    if (hash.startsWith("#settings") || hash.startsWith("#admin")) {
      location.hash = hash;
      return;
    }
    const target = parsePageLocation(hash);
    if (target) env.openPage(target.pageId, target);
  };
}
const pageUrl = (pageId: string, rowId?: string | null) => `/${pageLocationHash({ pageId, ...(rowId ? { rowId } : {}) })}`;

// The name of a kind of page; kinds added later get a plain "Page".
export function kindLabel(kind: string, t: (de: string, en: string) => string) {
  switch (kind) {
    case "document":
      return t("Dokument", "Document");
    case "database":
      return t("Datenbank", "Database");
    case "whiteboard":
      return t("Whiteboard", "Whiteboard");
    case "journal":
      return t("Journal", "Journal");
    case "dashboard":
      return t("Dashboard", "Dashboard");
    default:
      return t("Seite", "Page");
  }
}

// ---- Frame ----

// Widgets drawn without a card: they open the page or are a row of cards.
export function plainWidget(widget: HomeWidget) {
  if (widget.kind === "greeting" || widget.kind === "quick") return true;
  if (widget.kind === "recent") return widget.config.style === "cards" || widget.size === "full";
  return widget.kind === "pages" && widget.size === "full";
}
// Shown only when there is something in it (outside the editor).
export function widgetHidden(widget: HomeWidget, env: HomeEnv) {
  if (env.editing) return false;
  if (widget.kind === "instance" && !env.boot.user.isAdmin) return true;
  if (widget.kind === "recent" && widget.config.mode === "viewed")
    return env.clock === null || !(env.boot.recentVisits || []).some((v) => env.pages.some((p) => p.id === v.pageId));
  if (widget.kind === "quick" && !env.canCreate) return true;
  return false;
}

export function WidgetFrame({ widget, children, tools }: { widget: HomeWidget; children?: ReactNode; tools?: ReactNode }) {
  const env = useEnv();
  const t = useT();
  const plain = plainWidget(widget);
  // The class names the start page had before it was customizable.
  const legacy = widget.kind === "recent" ? (widget.config.mode === "viewed" ? " visited-section" : " recent-section") : widget.kind === "pages" ? " workspace-pages" : "";
  return (
    <section
      className={`home-widget size-${widget.size} kind-${widget.kind}${legacy}${plain ? " plain" : " card"}${env.editing ? " editing" : ""}`}
      data-widget-id={widget.id}
      data-widget-kind={widget.kind}
      aria-labelledby={widget.kind === "greeting" ? undefined : `home-widget-${widget.id}`}
      aria-label={widget.kind === "greeting" ? widgetName(widget, t) : undefined}
    >
      {tools}
      <div className="home-widget-body" inert={env.editing}>
        {children ?? <WidgetBody widget={widget} />}
      </div>
    </section>
  );
}

function Heading({ widget, action, children }: { widget: HomeWidget; action?: ReactNode; children?: ReactNode }) {
  const t = useT();
  const Icon = widgetIcon(widget);
  return (
    <div className="section-heading home-widget-head">
      <h2 id={`home-widget-${widget.id}`}>
        <Icon size={18} aria-hidden />
        {widgetName(widget, t)}
      </h2>
      {children}
      {action}
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="home-empty">{children}</p>;
}
function More({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="text-button home-more" onClick={onClick}>
      {children}
      <ArrowUpRight size={14} aria-hidden />
    </button>
  );
}
// Server data: loading, failed, protected.
function useResult(widget: HomeWidget) {
  return useEnv().data[widget.id];
}
// In the shape of a widget's list (components/skeleton.tsx).
function Loading() {
  return <WidgetSkeleton />;
}
function Failed({ result }: { result: Extract<WidgetResult, { ok: false }> }) {
  const t = useT();
  return (
    <p className="home-empty home-failed">
      <WarningCircle size={16} aria-hidden />
      {result.status === 404
        ? t("Nicht verfügbar – die Seite gibt es in diesem Arbeitsbereich nicht (mehr), oder du darfst sie nicht sehen.", "Not available – the page is not (or no longer) in this workspace, or you may not see it.")
        : result.status === 403
          ? t("Dafür fehlt dir die Berechtigung.", "You do not have permission for this.")
          : serverMessage(result.error)}
    </p>
  );
}
function Protected({ encrypted, onOpen }: { encrypted?: boolean; onOpen?: () => void }) {
  const t = useT();
  return (
    <p className="home-empty home-protected">
      <LockKey size={16} aria-hidden />
      <span>
        {encrypted
          ? t("Ende-zu-Ende-verschlüsselt – der Inhalt erscheint nur auf der Seite selbst.", "End-to-end encrypted – the content shows only on the page itself.")
          : t("Mit PIN geschützt – öffne die Seite und gib die PIN ein.", "Protected with a PIN – open the page and enter the PIN.")}
      </span>
      {onOpen && (
        <button type="button" className="text-button" onClick={onOpen}>
          {t("Öffnen", "Open")}
        </button>
      )}
    </p>
  );
}
function Unconfigured({ children }: { children: ReactNode }) {
  return <p className="home-empty home-unconfigured">{children}</p>;
}

// ---- Bodies ----

export function WidgetBody({ widget }: { widget: HomeWidget }) {
  switch (widget.kind) {
    case "greeting":
      return <GreetingWidget widget={widget} config={widget.config} />;
    case "recent":
      return <RecentWidget widget={widget} config={widget.config} />;
    case "quick":
      return <QuickWidget widget={widget} config={widget.config} />;
    case "pages":
      return <PagesWidget widget={widget} config={widget.config} />;
    case "favorites":
      return <FavoritesWidget widget={widget} config={widget.config} />;
    case "inbox":
      return <InboxWidget widget={widget} config={widget.config} />;
    case "capture":
      return <CaptureWidget widget={widget} config={widget.config} />;
    case "notes":
      return <NotesWidget widget={widget} config={widget.config} />;
    case "links":
      return <LinksWidget widget={widget} config={widget.config} />;
    default:
      return <ServerWidget widget={widget} />;
  }
}

function ServerWidget({ widget }: { widget: HomeWidget }) {
  const result = useResult(widget);
  if (!result)
    return (
      <>
        <Heading widget={widget} />
        <Loading />
      </>
    );
  if (!result.ok)
    return (
      <>
        <Heading widget={widget} />
        <Failed result={result} />
      </>
    );
  const data = result.data;
  switch (widget.kind) {
    case "tasks":
      return <TasksWidget widget={widget} config={widget.config} data={data} />;
    case "journal":
      return <JournalWidget widget={widget} config={widget.config} data={data} />;
    case "calendar":
      return <CalendarWidget widget={widget} data={data} />;
    case "database":
      return <DatabaseWidget widget={widget} config={widget.config} data={data} />;
    case "pinned":
      return <PinnedWidget widget={widget} config={widget.config} data={data} />;
    case "focus":
      return <FocusWidget widget={widget} config={widget.config} data={data} />;
    case "habits":
      return <HabitsWidget widget={widget} data={data} />;
    case "counter":
      return <CounterWidget widget={widget} data={data} />;
    case "activity":
      return <ActivityWidget widget={widget} data={data} />;
    case "stats":
      return <StatsWidget widget={widget} data={data} />;
    case "instance":
      return <InstanceWidget widget={widget} data={data} />;
    default:
      return null;
  }
}

type Props<K extends HomeWidget["kind"]> = { widget: HomeWidget; config: WidgetConfig<K> };
type DataProps<K extends HomeWidget["kind"]> = Props<K> & { data: Record<string, any> };

function GreetingWidget({ config }: Props<"greeting">) {
  const t = useT();
  const env = useEnv();
  return (
    <div className="home-greeting">
      <span className="eyebrow">{config.showDate && env.clock !== null ? longDate(env.clock).toLocaleUpperCase() : t("DEIN ARBEITSBEREICH", "YOUR WORKSPACE")}</span>
      <h1>
        {greeting(env.clock, t)}, {env.boot.user.name.split(" ")[0]}
        <span className="greeting-dot">.</span>
      </h1>
      {config.showMessage && <p>{config.message || t("Gute Ideen beginnen hier. Mach dort weiter, wo du aufgehört hast.", "Good ideas start here. Pick up where you left off.")}</p>}
    </div>
  );
}

function RecentWidget({ widget, config }: Props<"recent">) {
  const t = useT();
  const env = useEnv();
  const viewed = config.mode === "viewed";
  const list: { page: Page; at: string | number }[] = viewed
    ? (env.boot.recentVisits || []).flatMap((v) => {
        const page = env.pages.find((p) => p.id === v.pageId);
        return page ? [{ page, at: v.seenAt }] : [];
      })
    : // One entry per journal (its latest day), not a run of days (#49).
      oneDayPerJournal([...env.pages].sort((a, b) => b.updated_at.localeCompare(a.updated_at))).map((page) => ({ page, at: page.updated_at }));
  const shown = list.slice(0, config.max);
  const when = (at: string | number) =>
    typeof at === "number" ? relativeTime(new Date(at).toISOString(), env.clock, env.locale) : relativeTime(at, env.clock, env.locale);
  return (
    <>
      <Heading widget={widget}>
        {!viewed && (
          <span className="home-page-count">
            {(() => {
              // Journal days apart (#49): "120 Seiten · 340 Journaltage".
              const counts = env.boot.pageCounts;
              if (!counts) return `${env.pages.length} ${t("Seiten in deinem Arbeitsbereich", "pages in your workspace")}`;
              return counts.days
                ? t(`${counts.pages} Seiten · ${counts.days} Journaltage in deinem Arbeitsbereich`, `${counts.pages} pages · ${counts.days} journal days in your workspace`)
                : t(`${counts.pages} Seiten in deinem Arbeitsbereich`, `${counts.pages} pages in your workspace`);
            })()}
          </span>
        )}
      </Heading>
      {!shown.length && <Empty>{viewed ? t("Noch nichts geöffnet.", "Nothing opened yet.") : t("Noch keine Seiten.", "No pages yet.")}</Empty>}
      {config.style === "cards" ? (
        <div className="recent-grid">
          {shown.map(({ page: p, at }, i) => (
            <button key={p.id} type="button" className="recent-card" data-prefetch-page={p.id} onClick={() => env.openPage(p.id)}>
              <div className={`recent-illustration illustration-${i % 4}`}>
                <PageIcon name={p.kind === "database" ? "table" : p.icon} size={38} />
                {p.kind === "database" ? (
                  <div className="mini-board" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </div>
                ) : (
                  <div className="mini-document" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </div>
                )}
              </div>
              <div className="recent-card-title">
                <PageIcon name={p.icon} />
                <strong>{p.title || t("Ohne Titel", "Untitled")}</strong>
              </div>
              <small>
                {viewed ? t("Angesehen", "Viewed") : t("Bearbeitet", "Edited")} {when(at)}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <div className="visited-list">
          {shown.map(({ page: p, at }) => (
            <button key={p.id} type="button" data-prefetch-page={p.id} onClick={() => env.openPage(p.id)}>
              <PageIcon name={p.icon} size={16} />
              <span>{p.title || t("Ohne Titel", "Untitled")}</span>
              <small>{when(at)}</small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function QuickWidget({ widget, config }: Props<"quick">) {
  const t = useT();
  const env = useEnv();
  const disabled = env.clock === null || !env.canCreate;
  const actions = {
    page: { icon: FileText, tone: "blue", title: t("Eine Idee festhalten", "Capture an idea"), text: t("Eine leere Seite voller Möglichkeiten", "A blank page full of possibilities"), run: () => env.addPage() },
    capture: { icon: Tray, tone: "green", title: t("Schnell erfassen", "Quick capture"), text: t("Jetzt notieren, später sortieren", "Note it now, sort it later"), run: () => env.openCapture() },
    database: { icon: Table, tone: "orange", title: t("Ein Projekt planen", "Plan a project"), text: t("Aufgaben, Termine und Überblick", "Tasks, dates and an overview"), run: () => env.addPage("database") },
    journal: { icon: Notebook, tone: "violet", title: t("Ein Journal beginnen", "Start a journal"), text: t("Jeden Tag ein paar Zeilen", "A few lines every day"), run: () => env.addPage("journal") },
    whiteboard: { icon: PresentationChart, tone: "rose", title: t("Frei skizzieren", "Sketch freely"), text: t("Ein Whiteboard für Ideen", "A whiteboard for ideas"), run: () => env.addPage("whiteboard") },
  } as const;
  return (
    <div className="quick-section">
      <h2 id={`home-widget-${widget.id}`}>{widgetName(widget, t)}</h2>
      <div className="quick-actions">
        {config.actions.map((key) => {
          const a = actions[key];
          return (
            <button key={key} type="button" disabled={disabled} onClick={a.run}>
              <span className={`quick-icon ${a.tone}`}>
                <a.icon size={25} />
              </span>
              <span>
                <strong>{a.title}</strong>
                <small>{a.text}</small>
              </span>
              <Plus size={20} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PagesWidget({ widget, config }: Props<"pages">) {
  const t = useT();
  const env = useEnv();
  const top = env.pages.filter((p) => !p.parent_id && (!config.spaceId || p.space_id === config.spaceId));
  return (
    <>
      <Heading
        widget={widget}
        action={
          env.canCreate ? (
            <button type="button" className="text-button" disabled={env.clock === null} onClick={() => env.addPage()}>
              <Plus size={16} />
              {t("Neue Seite", "New page")}
            </button>
          ) : undefined
        }
      />
      {!top.length && <Empty>{t("Hier gibt es noch keine Seiten.", "There are no pages here yet.")}</Empty>}
      {top.map((p) => (
        <button key={p.id} type="button" className="home-page-row" data-prefetch-page={p.id} onClick={() => env.openPage(p.id)}>
          <span className="page-row-icon">
            <PageIcon name={p.icon} size={20} />
          </span>
          <strong>{p.title || t("Ohne Titel", "Untitled")}</strong>
          <span>{kindLabel(p.kind, t)}</span>
          <ArrowUpRight size={17} />
        </button>
      ))}
    </>
  );
}

function FavoritesWidget({ widget, config }: Props<"favorites">) {
  const t = useT();
  const env = useEnv();
  const pages = env.pages.filter((p) => env.boot.favorites.includes(p.id));
  const rows = env.boot.favoriteRows || [];
  const total = pages.length + rows.length;
  return (
    <>
      <Heading widget={widget} />
      {!total && <Empty>{t("Markiere Seiten mit dem Stern, dann erscheinen sie hier.", "Star pages and they show up here.")}</Empty>}
      <ul className="home-list">
        {pages.slice(0, config.max).map((p) => (
          <li key={p.id}>
            <button type="button" data-prefetch-page={p.id} onClick={() => env.openPage(p.id)}>
              <PageIcon name={p.icon} size={16} />
              <span>{p.title || t("Ohne Titel", "Untitled")}</span>
            </button>
          </li>
        ))}
        {rows.slice(0, Math.max(0, config.max - pages.length)).map((r) => (
          <li key={r.rowId}>
            <button type="button" onClick={() => env.openPage(r.pageId, { pageId: r.pageId, rowId: r.rowId })}>
              <PageIcon name="file" size={16} />
              <span>{r.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function InboxWidget({ widget, config }: Props<"inbox">) {
  const t = useT();
  const env = useEnv();
  const unread = env.boot.notifications.filter((n) => !n.read_at).length;
  const list = env.boot.notifications.filter((n) => !config.unreadOnly || !n.read_at).slice(0, config.max);
  return (
    <>
      <Heading widget={widget} action={<More onClick={() => env.go("inbox")}>{t("Alle", "All")}</More>}>
        {unread > 0 && <span className="home-count">{t(`${unread} ungelesen`, `${unread} unread`)}</span>}
      </Heading>
      {!list.length && <Empty>{config.unreadOnly ? t("Alles gelesen.", "All read.") : t("Keine Benachrichtigungen.", "No notifications.")}</Empty>}
      <ul className="home-list home-inbox">
        {list.map((n) => (
          <li key={n.id} className={n.read_at ? "" : "unread"}>
            <button
              type="button"
              onClick={() => {
                if (!n.read_at) void env.mutate({ action: "notification.mark", notificationId: n.id, read: true }).catch(() => {});
                const url = notificationUrl(n);
                const target = parsePageLocation(url.slice(1));
                if (target) env.openPage(target.pageId, target);
                // A place of the app (an incident of the instance).
                else if (url !== "/#inbox") location.hash = url.slice(2);
                else env.go("inbox");
              }}
            >
              <ChatCircle size={16} aria-hidden />
              <span>
                {!n.read_at && <span className="unread-dot" aria-label={t("Ungelesen", "Unread")} />}
                {serverMessage(n.body)}
              </span>
              <small>{relativeTime(n.created_at, env.clock, env.locale)}</small>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function CaptureWidget({ widget, config }: Props<"capture">) {
  const t = useT();
  const env = useEnv();
  const [targets] = useCaptureTargets(env.boot.workspace.id);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const target =
    (config.targetId && targets?.databases.find((d) => d.id === config.targetId)?.id) || targets?.default || targets?.databases[0]?.id || "";
  const [chosen, setChosen] = useState("");
  const database = chosen || target;
  const save = async () => {
    if (!database || !title.trim()) return;
    setBusy(true);
    try {
      const result = (await env.mutate({ action: "capture.record", pageId: database, rowId: crypto.randomUUID(), title: title.trim(), text: "" })) as { offline?: boolean } | null;
      setTitle("");
      env.notify(result?.offline ? t("Erfasst – wird gesendet, sobald du online bist.", "Captured – sent once you are online.") : t("Erfasst.", "Captured."));
    } catch (e) {
      env.notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading widget={widget} />
      {targets && !targets.databases.length ? (
        <Empty>{t("Es gibt keine Datenbank, in die du schreiben darfst.", "There is no database you may write to.")}</Empty>
      ) : (
        <form
          className="home-capture"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("Was geht dir durch den Kopf?", "What's on your mind?")}
            aria-label={t("Neuer Eintrag", "New entry")}
            maxLength={300}
            disabled={busy}
          />
          {targets && targets.databases.length > 1 && !config.targetId && (
            <Select aria-label={t("Datenbank", "Database")} value={database} onChange={(e) => setChosen(e.target.value)}>
              {targets.databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          )}
          <button type="submit" className="button primary compact" disabled={busy || !title.trim() || !database}>
            {t("Erfassen", "Capture")}
          </button>
        </form>
      )}
    </>
  );
}

function NotesWidget({ widget, config }: Props<"notes">) {
  const t = useT();
  const env = useEnv();
  const [text, setText] = useState(config.text);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typing = useRef(false);
  // Another device saved meanwhile: shown unless typing here.
  useEffect(() => {
    if (!typing.current) setText(config.text);
  }, [config.text]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <>
      <Heading widget={widget}>
        <span className="home-count" aria-live="polite">
          {saved ? "" : t("Wird gespeichert …", "Saving …")}
        </span>
      </Heading>
      <textarea
        className="home-notes"
        value={text}
        maxLength={4000}
        aria-label={widgetName(widget, t)}
        placeholder={t("Gedanken, Telefonnummern, die Einkaufsliste …", "Thoughts, phone numbers, the shopping list …")}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          setSaved(false);
          typing.current = true;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            env.saveNote(widget.id, value);
            typing.current = false;
            setSaved(true);
          }, 700);
        }}
        onBlur={() => {
          if (!timer.current || saved) return;
          clearTimeout(timer.current);
          env.saveNote(widget.id, text);
          typing.current = false;
          setSaved(true);
        }}
      />
    </>
  );
}

function LinksWidget({ widget, config }: Props<"links">) {
  const t = useT();
  const host = (url: string) => {
    try {
      return url.startsWith("mailto:") ? url.slice(7) : new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  return (
    <>
      <Heading widget={widget} />
      {!config.links.length && <Empty>{t("Füge Links in den Einstellungen des Widgets hinzu.", "Add links in the widget's settings.")}</Empty>}
      <ul className="home-list">
        {config.links.map((link, i) => (
          <li key={i}>
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              <ArrowUpRight size={16} aria-hidden />
              <span>{link.title || host(link.url)}</span>
              {link.title && <small>{host(link.url)}</small>}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Server widgets ----

type Task = { source: "doc" | "row"; pageId: string; rowId: string | null; index?: number; key?: string; text: string; due: string | null; page: string; icon?: string; url?: string; canEdit: boolean };
function TasksWidget({ widget, config, data }: DataProps<"tasks">) {
  const t = useT();
  const env = useEnv();
  const open = useOpen();
  const [done, setDone] = useState<Set<string>>(new Set());
  const keyOf = (task: Task) => `${task.pageId}:${task.rowId}:${task.index ?? ""}`;
  if (data.unconfigured)
    return (
      <>
        <Heading widget={widget} />
        <Unconfigured>{t("Wähle in den Einstellungen des Widgets eine Datenbank und eine Ansicht.", "Choose a database and a view in the widget's settings.")}</Unconfigured>
      </>
    );
  if (data.locked || data.encrypted)
    return (
      <>
        <Heading widget={widget} />
        <Protected encrypted={data.encrypted} />
      </>
    );
  const items = (data.items || []) as Task[];
  const check = async (task: Task) => {
    const key = keyOf(task);
    setDone((s) => new Set(s).add(key));
    const ok = await env.action({ action: "task.complete", source: task.source, pageId: task.pageId, rowId: task.rowId, ...(task.index !== undefined ? { index: task.index } : {}), ...(task.key ? { key: task.key } : {}), done: true });
    if (!ok)
      setDone((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
  };
  return (
    <>
      <Heading
        widget={widget}
        action={
          config.source === "mine" ? (
            <More onClick={() => env.go("tasks")}>{t("Alle", "All")}</More>
          ) : data.url ? (
            <More onClick={() => open(data.url)}>{t("Öffnen", "Open")}</More>
          ) : undefined
        }
      >
        {data.total > 0 && <span className="home-count">{data.total}</span>}
      </Heading>
      {!items.length && (
        <Empty>
          {config.filter === "open" ? t("Keine offenen Aufgaben.", "No open tasks.") : t("Nichts fällig – schön!", "Nothing due – nice!")}
        </Empty>
      )}
      <ul className="home-list home-tasks">
        {items.map((task) => {
          const key = keyOf(task);
          const checked = done.has(key);
          return (
            <li key={`${key}:${task.text}`} className={checked ? "checked" : ""}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!task.canEdit || checked}
                aria-label={t(`${task.text} erledigt`, `${task.text} done`)}
                onChange={() => void check(task)}
              />
              <button type="button" className="home-task-text" onClick={() => (task.url ? open(task.url) : env.openPage(task.pageId, { pageId: task.pageId, ...(task.rowId ? { rowId: task.rowId } : {}) }))}>
                <span>{task.text || t("Ohne Text", "No text")}</span>
                <small>{task.page}</small>
              </button>
              {task.due && <span className={`task-due task-due-${dueState(task.due, checked, env.today)}`}>{dueLabel(task.due, env.today)}</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function JournalWidget({ widget, config, data }: DataProps<"journal">) {
  const t = useT();
  const env = useEnv();
  const open = useOpen();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const journal = data.journal as Record<string, any> | null;
  if (!journal)
    return (
      <>
        <Heading widget={widget} />
        <Empty>{t("Hier gibt es noch kein Journal.", "There is no journal here yet.")}</Empty>
        {env.canCreate && (
          <button type="button" className="button compact" onClick={() => env.addPage("journal")}>
            <Plus size={14} />
            {t("Journal anlegen", "Create a journal")}
          </button>
        )}
      </>
    );
  const name = journal.name || env.pages.find((p) => p.id === journal.id)?.title || "";
  if (journal.locked)
    return (
      <>
        <Heading widget={widget}>
          <span className="home-count">{name}</span>
        </Heading>
        <Protected onOpen={() => open(journal.url)} />
      </>
    );
  const write = async () => {
    if (!text.trim()) return;
    setBusy(true);
    if (await env.action({ action: "journal.note", journalId: journal.id, today: env.today, text })) {
      setText("");
      env.notify(t("Zum heutigen Eintrag hinzugefügt.", "Added to today's entry."));
    }
    setBusy(false);
  };
  return (
    <>
      <Heading widget={widget} action={<More onClick={() => open(journal.today)}>{journal.written ? t("Öffnen", "Open") : t("Schreiben", "Write")}</More>}>
        {name && <span className="home-count">{name}</span>}
      </Heading>
      <div className="home-journal-status">
        <span className={journal.written ? "written" : ""}>
          <CheckCircle size={16} weight={journal.written ? "fill" : "regular"} aria-hidden />
          {journal.written ? t("Heute geschrieben", "Written today") : t("Heute noch nichts geschrieben", "Nothing written today yet")}
        </span>
        {journal.streak > 0 && (
          <span className="home-streak">
            <Fire size={16} aria-hidden />
            {journal.streak === 1 ? t("1 Tag in Folge", "1 day in a row") : t(`${journal.streak} Tage in Folge`, `${journal.streak} days in a row`)}
          </span>
        )}
      </div>
      {journal.encrypted ? (
        <Protected encrypted />
      ) : (
        journal.excerpt && <p className="home-excerpt">{journal.excerpt}</p>
      )}
      {config.quickWrite && journal.canWrite && !journal.encrypted && (
        <form
          className="home-quick-write"
          onSubmit={(e) => {
            e.preventDefault();
            void write();
          }}
        >
          <textarea
            value={text}
            rows={2}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("Ein paar Zeilen für heute …", "A few lines for today …")}
            aria-label={t("Zum heutigen Eintrag hinzufügen", "Add to today's entry")}
            disabled={busy}
          />
          <button type="submit" className="button compact" disabled={busy || !text.trim()}>
            {t("Hinzufügen", "Add")}
          </button>
        </form>
      )}
    </>
  );
}

function CalendarWidget({ widget, data }: { widget: HomeWidget; data: Record<string, any> }) {
  const t = useT();
  const env = useEnv();
  const open = useOpen();
  const items = (data.items || []) as Record<string, any>[];
  const days = [...new Set(items.map((i) => String(i.day)))];
  return (
    <>
      <Heading widget={widget} />
      {!items.length && (
        <Empty>
          {data.calendars
            ? t("Keine Termine in diesem Zeitraum.", "No events in this period.")
            : t("Noch kein Kalender: eine Datenbank mit Kalenderansicht oder ein verbundener Kalender erscheint hier.", "No calendar yet: a database with a calendar view or a connected calendar shows up here.")}
        </Empty>
      )}
      {days.map((day) => (
        <div key={day} className="home-agenda-day">
          <h3>{dayHeading(day, env.today, t)}</h3>
          <ul className="home-list">
            {items
              .filter((i) => i.day === day)
              .map((i, n) => (
                <li key={`${i.title}:${n}`}>
                  <button type="button" onClick={() => (i.url ? open(i.url) : i.pageId && env.openPage(i.pageId, { pageId: i.pageId, ...(i.rowId ? { rowId: i.rowId } : {}) }))}>
                    {i.type === "task" ? <CheckSquare size={16} aria-hidden /> : <span className="home-agenda-time">{i.timed ? clockTime(i.start) : t("Ganztägig", "All day")}</span>}
                    <span>{i.title}</span>
                    <small>{i.calendar}</small>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function DatabaseWidget({ widget, config, data }: DataProps<"database">) {
  const t = useT();
  const env = useEnv();
  const open = useOpen();
  if (data.unconfigured)
    return (
      <>
        <Heading widget={widget} />
        <Unconfigured>{t("Wähle in den Einstellungen des Widgets eine Datenbank.", "Choose a database in the widget's settings.")}</Unconfigured>
      </>
    );
  const title = config.title || data.title || env.pages.find((p) => p.id === config.pageId)?.title || widgetName(widget, t);
  const head = (
    <div className="section-heading home-widget-head">
      <h2 id={`home-widget-${widget.id}`}>
        <Table size={18} aria-hidden />
        {title}
      </h2>
      {data.view && <span className="home-count">{data.view}</span>}
      {data.url && <More onClick={() => open(data.url)}>{t("Öffnen", "Open")}</More>}
    </div>
  );
  if (data.locked || data.encrypted)
    return (
      <>
        {head}
        <Protected encrypted={data.encrypted} />
      </>
    );
  const items = (data.items || []) as { id: string; title: string; values: string[]; url: string }[];
  const properties = (data.properties || []) as string[];
  return (
    <>
      {head}
      {!items.length && <Empty>{t("Keine Einträge in dieser Ansicht.", "No records in this view.")}</Empty>}
      {config.style === "table" && items.length > 0 ? (
        <div className="home-table-wrap">
          <table className="home-table">
            <thead>
              <tr>
                <th scope="col">{t("Name", "Name")}</th>
                {properties.map((p) => (
                  <th scope="col" key={p}>
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button type="button" className="text-button" onClick={() => open(row.url)}>
                      {row.title}
                    </button>
                  </td>
                  {properties.map((p, i) => (
                    <td key={p}>{row.values[i]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : config.style === "board" && items.length > 0 ? (
        <div className="home-board" role="list">
          {[...new Set(items.map((r) => r.values[0] || ""))].map((group) => (
            <div key={group} className="home-board-column" role="listitem">
              <h3>{group || (properties[0] ? t("Ohne Wert", "No value") : t("Einträge", "Records"))}</h3>
              {items
                .filter((r) => (r.values[0] || "") === group)
                .map((row) => (
                  <button key={row.id} type="button" className="home-board-card" onClick={() => open(row.url)}>
                    {row.title}
                  </button>
                ))}
            </div>
          ))}
        </div>
      ) : (
        <ul className="home-list">
          {items.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => open(row.url)}>
                <span>{row.title}</span>
                {row.values.filter(Boolean).length > 0 && <small>{row.values.filter(Boolean).join(" · ")}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {data.total > items.length && <p className="home-foot">{t(`${data.total - items.length} weitere`, `${data.total - items.length} more`)}</p>}
    </>
  );
}

function PinnedWidget({ widget, config, data }: DataProps<"pinned">) {
  const t = useT();
  const env = useEnv();
  const open = useOpen();
  if (data.unconfigured)
    return (
      <>
        <Heading widget={widget} />
        <Unconfigured>{t("Wähle in den Einstellungen des Widgets eine Seite.", "Choose a page in the widget's settings.")}</Unconfigured>
      </>
    );
  const page = env.pages.find((p) => p.id === data.id);
  const title = config.title || page?.title || data.title || t("Ohne Titel", "Untitled");
  const icon = page?.icon || data.icon || "file";
  const items = (data.items || []) as { id: string; title: string; icon?: string; url: string; values?: string[] }[];
  return (
    <>
      <div className="section-heading home-widget-head">
        <h2 id={`home-widget-${widget.id}`}>
          <PageIcon name={icon} size={18} />
          {title}
        </h2>
        <More onClick={() => env.openPage(data.id)}>{t("Öffnen", "Open")}</More>
      </div>
      {data.locked || data.encrypted ? (
        <Protected encrypted={data.encrypted} />
      ) : (
        <>
          {data.excerpt && <p className="home-excerpt">{data.excerpt}</p>}
          {items.length > 0 && (
            <ul className="home-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => open(item.url)}>
                    <PageIcon name={item.icon || "file"} size={16} />
                    <span>{item.title}</span>
                    {item.values && item.values.filter(Boolean).length > 0 && <small>{item.values.filter(Boolean).join(" · ")}</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!data.excerpt && !items.length && config.preview && <Empty>{t("Diese Seite ist noch leer.", "This page is still empty.")}</Empty>}
          {data.updatedAt && <p className="home-foot">{t("Bearbeitet", "Edited")} {relativeTime(data.updatedAt, env.clock, env.locale)}</p>}
        </>
      )}
    </>
  );
}

// mm:ss until a moment, ticking every second while shown.
function useCountdown(until: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return { left: 0, text: "" };
  const left = Math.max(0, until - now);
  const m = Math.floor(left / 60000),
    s = Math.floor((left % 60000) / 1000);
  return { left, text: `${m}:${String(s).padStart(2, "0")}` };
}
function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return "";
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}
function FocusWidget({ widget, config, data }: DataProps<"focus">) {
  const t = useT();
  const env = useEnv();
  const open = useOpen();
  const [busy, setBusy] = useState(false);
  const phase = data.phase as "idle" | "focus" | "break";
  const countdown = useCountdown(phase === "focus" ? data.focusEndsAt : phase === "break" ? data.breakEndsAt : null);
  const timer = data.timer as { start: number; title: string; database: string; url: string } | null;
  const elapsed = useElapsed(timer?.start ?? null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    await env.action(body);
    setBusy(false);
  };
  // The phase ended while shown: fetch the next state.
  const ended = phase !== "idle" && countdown.left === 0;
  const { reload } = env;
  useEffect(() => {
    if (ended) reload();
  }, [ended, reload]);
  return (
    <>
      <Heading widget={widget} />
      <div className={`home-focus phase-${phase}`}>
        {phase === "idle" ? (
          <div className="home-focus-start">
            {[...new Set([config.minutes, 25, 50])].slice(0, 3).map((minutes) => (
              <button key={minutes} type="button" className="button compact" disabled={busy} onClick={() => void run({ action: "focus.start", minutes, breakMinutes: 5 })}>
                <Play size={14} aria-hidden />
                {t(`${minutes} Min.`, `${minutes} min`)}
              </button>
            ))}
          </div>
        ) : (
          <div className="home-focus-running">
            <span className="home-focus-phase">{phase === "focus" ? t("Fokus", "Focus") : t("Pause", "Break")}</span>
            <strong className="home-focus-clock" aria-live="off">
              {countdown.text}
            </strong>
            <button type="button" className="button compact" disabled={busy} onClick={() => void run({ action: "focus.stop" })}>
              <Stop size={14} aria-hidden />
              {t("Beenden", "Stop")}
            </button>
          </div>
        )}
        {timer && (
          <div className="home-timer">
            <button type="button" className="text-button" onClick={() => open(timer.url)}>
              {timer.title || t("Zeiterfassung", "Time tracking")}
            </button>
            <span>{elapsed}</span>
            <button type="button" className="icon-button" aria-label={t("Zeiterfassung stoppen", "Stop time tracking")} disabled={busy} onClick={() => void run({ action: "timer.stop" })}>
              <Stop size={14} />
            </button>
          </div>
        )}
        <p className="home-foot">
          {t("Heute", "Today")} {hours(data.today ?? 0)} · {t("Diese Woche", "This week")} {hours(data.week ?? 0)}
        </p>
      </div>
    </>
  );
}

function HabitsWidget({ widget, data }: { widget: HomeWidget; data: Record<string, any> }) {
  const t = useT();
  const env = useEnv();
  const habits = data.habits as Record<string, any> | null;
  const [pending, setPending] = useState<Record<string, boolean>>({});
  if (!habits)
    return (
      <>
        <Heading widget={widget} />
        <Unconfigured>{t("Lege eine Datenbank mit einem Datum und Kontrollkästchen an – jede Spalte ist eine Gewohnheit.", "Create a database with a date and checkboxes – each one is a habit.")}</Unconfigured>
      </>
    );
  if (habits.locked || habits.encrypted)
    return (
      <>
        <Heading widget={widget} />
        <Protected encrypted={habits.encrypted} />
      </>
    );
  const items = (habits.items || []) as { fieldId: string; name: string; done: boolean }[];
  const done = items.filter((i) => pending[i.fieldId] ?? i.done).length;
  return (
    <>
      <Heading widget={widget}>
        <span className="home-count">
          {done}/{items.length}
        </span>
      </Heading>
      <div className="home-progress" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-label={habits.name}>
        <i style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
      </div>
      <ul className="home-list home-habits">
        {items.map((item) => {
          const checked = pending[item.fieldId] ?? item.done;
          return (
            <li key={item.fieldId}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!habits.canWrite}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setPending((p) => ({ ...p, [item.fieldId]: value }));
                    const ok = await env.action({ action: "habit.check", pageId: habits.id, fieldId: item.fieldId, done: value, today: env.today });
                    if (!ok)
                      setPending((p) => {
                        const next = { ...p };
                        delete next[item.fieldId];
                        return next;
                      });
                  }}
                />
                {item.name}
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CounterWidget({ widget, data }: { widget: HomeWidget; data: Record<string, any> }) {
  const t = useT();
  const open = useOpen();
  if (data.unconfigured)
    return (
      <>
        <Heading widget={widget} />
        <Unconfigured>{t("Wähle in den Einstellungen des Widgets eine Datenbank.", "Choose a database in the widget's settings.")}</Unconfigured>
      </>
    );
  if (data.locked || data.encrypted)
    return (
      <>
        <Heading widget={widget} />
        <Protected encrypted={data.encrypted} />
      </>
    );
  const own = (widget.config as { title?: string }).title;
  const history = (data.history || []) as { value: number | null }[];
  return (
    <>
      <div className="section-heading home-widget-head">
        <h2 id={`home-widget-${widget.id}`}>{own || data.title || widgetName(widget, t)}</h2>
        {data.url && <More onClick={() => open(data.url)}>{t("Öffnen", "Open")}</More>}
      </div>
      <p className="home-metric">
        <strong>{data.formatted}</strong>
        <span>
          {data.label}
          {data.view ? ` · ${data.view}` : ""}
        </span>
      </p>
      {history.length > 1 && <Sparkline values={history.map((h) => h.value)} label={t("Verlauf der letzten 14 Tage", "History of the last 14 days")} height={36} />}
    </>
  );
}

function ActivityWidget({ widget, data }: { widget: HomeWidget; data: Record<string, any> }) {
  const t = useT();
  const env = useEnv();
  const items = (data.items || []) as { type: "page" | "record"; pageId: string; rowId?: string; title: string; page?: string; icon: string; by: string; mine: boolean; at: number }[];
  return (
    <>
      <Heading widget={widget} />
      {!items.length && <Empty>{t("Noch keine Änderungen.", "No changes yet.")}</Empty>}
      <ul className="home-list home-activity">
        {items.map((item, i) => {
          // Titles of encrypted spaces come decrypted from the sidebar.
          const title = item.type === "page" ? env.pages.find((p) => p.id === item.pageId)?.title || item.title : item.title;
          const who = item.mine ? t("Du", "You") : item.by || t("Jemand", "Someone");
          return (
            <li key={`${item.pageId}:${item.rowId}:${i}`}>
              <button type="button" onClick={() => env.openPage(item.pageId, { pageId: item.pageId, ...(item.rowId ? { rowId: item.rowId } : {}) })}>
                <PageIcon name={item.type === "record" ? "file" : item.icon} size={16} />
                <span>
                  <strong>{title}</strong>
                  <small>
                    {item.type === "record" ? t(`${who} · in ${item.page}`, `${who} · in ${item.page}`) : who}
                  </small>
                </span>
                <small>{relativeTime(new Date(item.at).toISOString(), env.clock, env.locale)}</small>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function StatsWidget({ widget, data }: { widget: HomeWidget; data: Record<string, any> }) {
  const t = useT();
  const tiles = [
    { value: data.pagesEdited, label: t("Seiten bearbeitet", "Pages edited") },
    { value: data.pagesEditedByMe, label: t("davon von dir", "by you") },
    { value: data.recordsDone, label: t("Einträge erledigt", "Records completed") },
    { value: data.openTasks, label: data.overdueTasks ? t(`offene Aufgaben (${data.overdueTasks} überfällig)`, `open tasks (${data.overdueTasks} overdue)`) : t("offene Aufgaben", "open tasks") },
    { value: hours(data.hours ?? 0), label: t("Zeit erfasst", "Time tracked") },
  ];
  return (
    <>
      <Heading widget={widget} />
      <dl className="home-stats">
        {tiles.map((tile) => (
          <div key={tile.label}>
            <dt>{tile.label}</dt>
            <dd>{tile.value ?? 0}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function InstanceWidget({ widget, data }: { widget: HomeWidget; data: Record<string, any> }) {
  const t = useT();
  const env = useEnv();
  const issues = (data.issues || []) as { code: string; text: string; value?: number }[];
  return (
    <>
      <Heading widget={widget} action={<More onClick={() => env.go("admin")}>{t("Administration", "Administration")}</More>} />
      <p className={`home-instance level-${data.level}`}>
        {data.level === "ok" ? <CheckCircle size={18} weight="fill" aria-hidden /> : <WarningCircle size={18} weight="fill" aria-hidden />}
        {data.level === "ok" ? t("Alles in Ordnung", "All good") : data.level === "critical" ? t("Kritisch", "Critical") : t("Warnung", "Warning")}
      </p>
      {issues.length > 0 && (
        <ul className="home-list">
          {issues.map((issue) => (
            <li key={issue.code}>
              <span>
                {issue.text}
                {issue.value !== undefined ? ` (${issue.value})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// The day as the widgets see it (reset at local midnight by the clock).
export const today = () => localDay();
