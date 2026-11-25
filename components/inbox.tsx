"use client";
// The inbox: notifications by day and, within a day, by group (what
// asks for something first), compact rows with the person or the type,
// similar ones collapsed, the action that fits as a button, read/unread and
// remove on hover (one ⋯ menu by touch), and older ones page by page.
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Alarm,
  ArrowRight,
  At,
  Bell,
  CaretDown,
  CaretRight,
  ChatCircle,
  CheckSquare,
  Checks,
  DotsThree,
  EnvelopeSimple,
  EnvelopeSimpleOpen,
  PencilSimple,
  ShareNetwork,
  ShieldWarning,
  Stamp,
  Trash,
  UserPlus,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import { api, Avatar } from "./ui";
import { useT } from "./i18n";
import { NotificationText } from "./notification-text";
import { relativeTime } from "./home/format";
import { serverMessage } from "@/lib/server-message";
import { categoryLabel, notificationActionLabel, notificationLine, similarKey, type NotificationLine } from "@/lib/notification-display";
import { notificationCategories, type NotificationCategory } from "@/lib/notification-kinds";
import type { Locale } from "@/lib/i18n";
import type { Bootstrap } from "@/lib/types";

type Note = Bootstrap["notifications"][number];
type Item = { n: Note; line: NotificationLine; unread: boolean; date: Date };
type Day = "today" | "yesterday" | "week" | "older";
const DAYS: Day[] = ["today", "yesterday", "week", "older"];

const subtypeIcon: Partial<Record<string, Icon>> = {
  mention: At,
  record_mention: At,
  comment_mention: At,
  comment: ChatCircle,
  comment_text: ChatCircle,
  comment_reply: ChatCircle,
  assignment: CheckSquare,
  task_due: CheckSquare,
  share: ShareNetwork,
  workspace_added: UserPlus,
  date_reminder: Alarm,
  approval: Stamp,
  incident: ShieldWarning,
  change: PencilSimple,
};
const categoryIcon: Record<NotificationCategory, Icon> = {
  mention: At,
  comment: ChatCircle,
  task: CheckSquare,
  share: Stamp,
  security: ShieldWarning,
  system: Wrench,
};
const iconOf = (line: NotificationLine) => (line.subtype && subtypeIcon[line.subtype]) || categoryIcon[line.category] || Bell;

const parseTime = (value: string) => new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value.replace(" ", "T") + "Z");
function dayOf(date: Date, now: number): Day {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const diff = (start.getTime() - date.getTime()) / 86_400_000;
  if (diff <= 0) return "today";
  if (diff <= 1) return "yesterday";
  if (diff <= 6) return "week";
  return "older";
}
function groupBy<K extends string>(items: Item[], key: (i: Item) => K, order: readonly K[]) {
  const map = new Map<K, Item[]>();
  for (const i of items) map.set(key(i), [...(map.get(key(i)) || []), i]);
  return order.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const);
}
// The line as one text: names of buttons, the formatted row's open button.
const lineText = (line: NotificationLine) =>
  [line.actor ? `${line.actor.name} ${line.title}` : line.title, line.place].filter(Boolean).join(" · ");

export type InboxProps = {
  notifications: Note[];
  more: boolean;
  unread: number;
  members: Bootstrap["members"];
  workspaces: Bootstrap["workspaces"];
  clock: number | null;
  locale: Locale;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onOpen: (n: Note) => void;
  // Added to a workspace (#320): open it, or leave it.
  onWorkspace: (n: Note, workspaceId: string, hash?: string) => void;
};

export function Inbox(props: InboxProps) {
  const t = useT();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [menu, setMenu] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Older pages (GET /api/notifications/inbox), kept here; changes to them
  // are applied here too, as the bootstrap's are by the app.
  const [older, setOlder] = useState<Note[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const now = props.clock ?? Date.now();
  const all = useMemo(() => {
    const seen = new Set(props.notifications.map((n) => n.id));
    return [...props.notifications, ...older.filter((n) => !seen.has(n.id))];
  }, [props.notifications, older]);
  const items: Item[] = useMemo(
    () => all.map((n) => ({ n, line: notificationLine(n, t, props.members, serverMessage), unread: !n.read_at, date: parseTime(n.created_at) })),
    [all, t, props.members],
  );
  const more = olderMore ?? props.more;
  const shown = items.filter((i) => filter === "all" || i.unread);

  useEffect(() => {
    if (!menu) return;
    const pointer = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".inbox-menu, .inbox-more")) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const patchOlder = (ids: Set<string>, op: "read" | "unread" | "delete") =>
    setOlder((list) =>
      op === "delete"
        ? list.filter((n) => !ids.has(n.id))
        : list.map((n) => (ids.has(n.id) ? { ...n, read_at: op === "read" ? n.read_at || new Date().toISOString() : null } : n)),
    );
  // One or several at once: one command (notification.bulk).
  const change = (list: Item[], op: "read" | "unread" | "delete") => {
    const target = op === "read" ? list.filter((i) => i.unread) : op === "unread" ? list.filter((i) => !i.unread) : list;
    if (!target.length) return;
    const ids = target.map((i) => i.n.id);
    patchOlder(new Set(ids), op);
    void props.act(
      ids.length === 1 && op !== "delete"
        ? { action: "notification.mark", notificationId: ids[0], read: op === "read" }
        : ids.length === 1
          ? { action: "notification.delete", notificationId: ids[0] }
          : { action: "notification.bulk", notificationIds: ids, op },
    );
  };
  const open = (i: Item) => {
    if (i.unread) patchOlder(new Set([i.n.id]), "read");
    props.onOpen(i.n);
  };
  const markAll = () => {
    setOlder((list) => list.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    void props.act({ action: "notification.read" });
  };
  const loadMore = async () => {
    const last = all[all.length - 1];
    if (!last || loading) return;
    setLoading(true);
    setError(false);
    try {
      const page = await api<{ notifications: Note[]; more: boolean }>(`/api/notifications/inbox?before=${encodeURIComponent(last.id)}`);
      setOlder((list) => [...list, ...page.notifications]);
      setOlderMore(page.more);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const markLabel = (i: Item) => (i.unread ? t("Als gelesen markieren", "Mark as read") : t("Als ungelesen markieren", "Mark as unread"));
  const removeLabel = (i: Item) => t(`Benachrichtigung entfernen: ${lineText(i.line)}`, `Remove notification: ${lineText(i.line)}`);

  const row = (i: Item, nested = false) => {
    const Glyph = iconOf(i.line);
    const action = notificationActionLabel(i.line, t);
    // Filled only where something waits for you: an approval, an incident.
    const added = /^workspace:([0-9a-f-]{36})$/i.exec(i.n.link || "")?.[1];
    const workspace = added ? props.workspaces.find((w) => w.id === added) : undefined;
    const face = (
      <span className="inbox-face" data-category={i.line.category} data-severity={i.line.severity}>
        {i.line.actor ? <Avatar name={i.line.actor.name} userId={i.line.actor.id} /> : <Glyph size={17} weight="bold" aria-hidden />}
        {i.line.actor && (
          <span className="inbox-face-badge" data-category={i.line.category} aria-hidden>
            <Glyph size={10} weight="bold" />
          </span>
        )}
      </span>
    );
    const time = (
      <time dateTime={i.date.toISOString()} title={i.date.toLocaleString()}>
        {relativeTime(i.n.created_at, now, props.locale)}
      </time>
    );
    const severity = i.line.severity && (
      <span className="inbox-severity" data-severity={i.line.severity}>
        {i.line.severity === "critical" ? t("Kritisch", "Critical") : t("Warnung", "Warning")}
      </span>
    );
    const text = (
      <span className="inbox-text">
        <span className="inbox-line">
          {i.line.plain ? (
            <span className="inbox-plain">{i.line.title}</span>
          ) : i.line.actor ? (
            <>
              <strong>{i.line.actor.name}</strong> {i.line.title}
            </>
          ) : (
            <strong>{i.line.title}</strong>
          )}
          {i.line.place && <span className="inbox-place"> · {i.line.place}</span>}
        </span>
        {(i.line.detail || severity) && (
          <span className="inbox-detail">
            {severity}
            {i.line.detail}
          </span>
        )}
      </span>
    );
    return (
      <li key={i.n.id} className={`notification-item${i.unread ? " unread" : ""}${nested ? " nested" : ""}`} data-notification={i.n.id}>
        {i.n.markup ? (
          // A formatted message (#330) has its own links and person chips –
          // no controls inside a button: the row opens on a click beside
          // them, the arrow is the button.
          <div
            className="notification-row formatted"
            data-notification-formatted
            onClick={(e) => {
              if ((e.target as Element).closest("a, button, [data-mention], .math-inline") || window.getSelection()?.toString()) return;
              open(i);
            }}
          >
            <span className="inbox-dot" aria-label={i.unread ? t("Ungelesen", "Unread") : undefined} />
            {face}
            <span className="inbox-text">
              <span className="inbox-line formatted">
                <NotificationText value={i.n.markup} members={props.members} />
              </span>
            </span>
            {time}
            <button type="button" className="icon-button notification-open" aria-label={t(`Öffnen: ${i.n.body}`, `Open: ${i.n.body}`)} onClick={() => open(i)}>
              <ArrowRight aria-hidden />
            </button>
          </div>
        ) : (
          <button type="button" className="notification-row" onClick={() => open(i)}>
            <span className="inbox-dot" aria-label={i.unread ? t("Ungelesen", "Unread") : undefined} />
            {face}
            {text}
            {time}
          </button>
        )}
        {(action || workspace) && (
          // On a phone only what waits for you keeps its button; the row and its ⋯ menu open the rest.
          <span className="inbox-cta" data-urgent={workspace || i.line.subtype === "approval" || i.line.subtype === "incident" ? "" : undefined}>
            {workspace ? (
              <>
                <button type="button" className="button compact" data-notification-open onClick={() => props.onWorkspace(i.n, workspace.id)}>
                  {t("Öffnen", "Open")}
                </button>
                <button type="button" className="button compact" data-notification-leave aria-label={t(`„${workspace.name}“ verlassen`, `Leave “${workspace.name}”`)} onClick={() => props.onWorkspace(i.n, workspace.id, "settings/workspace/danger")}>
                  {t("Verlassen", "Leave")}
                </button>
              </>
            ) : (
              <button type="button" className={`button compact${i.unread && (i.line.subtype === "approval" || i.line.subtype === "incident") ? " primary" : ""}`} aria-label={`${action}: ${lineText(i.line)}`} onClick={() => open(i)}>
                {action}
              </button>
            )}
          </span>
        )}
        <span className="inbox-tools">
          <button type="button" className="icon-button" aria-label={markLabel(i)} title={markLabel(i)} onClick={() => change([i], i.unread ? "read" : "unread")}>
            {i.unread ? <EnvelopeSimpleOpen aria-hidden /> : <EnvelopeSimple aria-hidden />}
          </button>
          <button type="button" className="icon-button" aria-label={removeLabel(i)} title={t("Entfernen", "Remove")} onClick={() => change([i], "delete")}>
            <Trash aria-hidden />
          </button>
        </span>
        <button
          type="button"
          className="icon-button inbox-more"
          aria-label={t(`Aktionen: ${lineText(i.line)}`, `Actions: ${lineText(i.line)}`)}
          aria-haspopup="menu"
          aria-expanded={menu === i.n.id}
          onClick={() => setMenu(menu === i.n.id ? null : i.n.id)}
        >
          <DotsThree weight="bold" aria-hidden />
        </button>
        {menu === i.n.id && (
          <div className="inbox-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => (setMenu(null), open(i))}>
              <ArrowRight aria-hidden /> {action || t("Öffnen", "Open")}
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(null), change([i], i.unread ? "read" : "unread"))}>
              {i.unread ? <EnvelopeSimpleOpen aria-hidden /> : <EnvelopeSimple aria-hidden />} {markLabel(i)}
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(null), change([i], "delete"))}>
              <Trash aria-hidden /> {t("Entfernen", "Remove")}
            </button>
          </div>
        )}
      </li>
    );
  };

  // Similar ones of a day and group as one row that opens.
  const cluster = (list: Item[]) => {
    const first = list[0];
    const key = `${first.n.id}:${list.length}`;
    const isOpen = expanded.has(first.n.id);
    const unread = list.filter((i) => i.unread).length;
    const Glyph = iconOf(first.line);
    const toggle = () =>
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(first.n.id)) next.delete(first.n.id);
        else next.add(first.n.id);
        return next;
      });
    const title =
      first.line.subtype === "incident"
        ? t(`${list.length} Sicherheitsvorfälle: ${first.line.title}`, `${list.length} security incidents: ${first.line.title}`)
        : first.line.actor
          ? t(`${first.line.actor.name}: ${list.length}× ${first.line.title}`, `${first.line.actor.name}: ${list.length}× ${first.line.title}`)
          : `${list.length}× ${first.line.title}`;
    return (
      <Fragment key={key}>
        <li className={`notification-item inbox-cluster${unread ? " unread" : ""}`}>
          <button type="button" className="notification-row" aria-expanded={isOpen} onClick={toggle}>
            <span className="inbox-dot" aria-label={unread ? t(`${unread} ungelesen`, `${unread} unread`) : undefined} />
            <span className="inbox-face" data-category={first.line.category} data-severity={list.some((i) => i.line.severity === "critical") ? "critical" : first.line.severity}>
              <Glyph size={17} weight="bold" aria-hidden />
              <span className="inbox-stack" aria-hidden>
                {list.length}
              </span>
            </span>
            <span className="inbox-text">
              <span className="inbox-line">
                <strong>{title}</strong>
                {first.line.place && <span className="inbox-place"> · {first.line.place}</span>}
              </span>
              <span className="inbox-detail">
                {first.line.severity && (
                  <span className="inbox-severity" data-severity={list.some((i) => i.line.severity === "critical") ? "critical" : first.line.severity}>
                    {list.some((i) => i.line.severity === "critical") ? t("Kritisch", "Critical") : t("Warnung", "Warning")}
                  </span>
                )}
                {list
                  .map((i) => i.line.detail)
                  .filter(Boolean)
                  .slice(0, 2)
                  .join(" · ")}
              </span>
            </span>
            <time dateTime={first.date.toISOString()}>{relativeTime(first.n.created_at, now, props.locale)}</time>
            {isOpen ? <CaretDown className="inbox-caret" aria-hidden /> : <CaretRight className="inbox-caret" aria-hidden />}
          </button>
          <span className="inbox-tools">
            {unread > 0 && (
              <button type="button" className="icon-button" aria-label={t("Alle davon als gelesen markieren", "Mark all of these as read")} title={t("Alle davon als gelesen markieren", "Mark all of these as read")} onClick={() => change(list, "read")}>
                <Checks aria-hidden />
              </button>
            )}
            <button type="button" className="icon-button" aria-label={t("Alle davon entfernen", "Remove all of these")} title={t("Alle davon entfernen", "Remove all of these")} onClick={() => change(list, "delete")}>
              <Trash aria-hidden />
            </button>
          </span>
        </li>
        {isOpen && list.map((i) => row(i, true))}
      </Fragment>
    );
  };

  const dayLabel = (d: Day) =>
    ({ today: t("Heute", "Today"), yesterday: t("Gestern", "Yesterday"), week: t("Diese Woche", "This week"), older: t("Älter", "Older") })[d];
  const unreadTotal = Math.max(props.unread, items.filter((i) => i.unread).length);

  return (
    <div className="inbox">
      <header className="inbox-header">
        <div>
          <h1>{t("Posteingang", "Inbox")}</h1>
          <p>{unreadTotal ? t(`${unreadTotal} ungelesen`, `${unreadTotal} unread`) : t("Alles gelesen", "All caught up")}</p>
        </div>
        <div className="inbox-toolbar">
          <div className="inbox-filter" role="radiogroup" aria-label={t("Benachrichtigungen filtern", "Filter notifications")}>
            <button type="button" role="radio" aria-checked={filter === "all"} onClick={() => setFilter("all")}>
              {t("Alle", "All")}
            </button>
            <button type="button" role="radio" aria-checked={filter === "unread"} onClick={() => setFilter("unread")}>
              {t("Ungelesen", "Unread")} <span className="inbox-count">{unreadTotal}</span>
            </button>
          </div>
          {unreadTotal > 0 && (
            <button type="button" className="button compact" onClick={markAll}>
              <Checks aria-hidden />
              {t("Alle als gelesen markieren", "Mark all as read")}
            </button>
          )}
        </div>
      </header>
      {groupBy(shown, (i) => dayOf(i.date, now), DAYS).map(([day, list]) => (
        <section key={day} className="inbox-day" aria-labelledby={`inbox-day-${day}`}>
          <h2 id={`inbox-day-${day}`}>{dayLabel(day)}</h2>
          {groupBy(list, (i) => i.line.category, notificationCategories).map(([category, group]) => {
            const Glyph = categoryIcon[category];
            // Similar ones together, in the order of their newest.
            const clusters: Item[][] = [];
            const byKey = new Map<string, Item[]>();
            for (const i of group) {
              const k = similarKey(i.n, i.line);
              const found = byKey.get(k);
              if (found) found.push(i);
              else {
                const fresh = [i];
                byKey.set(k, fresh);
                clusters.push(fresh);
              }
            }
            return (
              <div key={category} className="inbox-group">
                <h3 id={`inbox-${day}-${category}`}>
                  <Glyph size={13} weight="bold" aria-hidden />
                  {categoryLabel(category, t)}
                </h3>
                <ul aria-labelledby={`inbox-day-${day} inbox-${day}-${category}`}>
                  {clusters.map((c) => (c.length > 1 ? cluster(c) : row(c[0])))}
                </ul>
              </div>
            );
          })}
        </section>
      ))}
      {filter === "unread" && !!items.length && !items.some((i) => i.unread) && (
        <p className="muted inbox-note">{t("Keine ungelesenen Benachrichtigungen.", "No unread notifications.")}</p>
      )}
      {!items.length && (
        <div className="empty-state">
          <Bell size={38} />
          <h3>{t("Du bist auf dem Laufenden", "You are all caught up")}</h3>
          <p>{t("Erwähnungen, Kommentare, Aufgaben und Freigaben erscheinen hier.", "Mentions, comments, tasks and shares appear here.")}</p>
        </div>
      )}
      {more && !!items.length && (
        <div className="inbox-load">
          <button type="button" className="button" onClick={() => void loadMore()} disabled={loading} aria-busy={loading}>
            {loading ? t("Lädt …", "Loading …") : t("Ältere laden", "Load older")}
          </button>
          {error && <p className="muted" role="status">{t("Konnte nicht geladen werden. Bitte noch einmal versuchen.", "Could not load. Please try again.")}</p>}
        </div>
      )}
    </div>
  );
}
