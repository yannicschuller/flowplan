"use client";
// Getting around a journal without its days flooding the page tree (#49):
// the virtual items below a journal in the tree ("Heute", folders per year
// and month, "Alle Tage …") and, on a day page, the way to the previous and
// next entry, to today and to any day of a month. The logic lives in
// lib/journal-nav.ts.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarBlank, CaretDown, CaretLeft, CaretRight, CalendarCheck } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Collapse } from "./motion";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { monthGrid, neighbourDays, shiftDate, shiftMonth, type DayLike } from "@/lib/journal-nav";

export const monthLabel = new Intl.DateTimeFormat(LOCALE_TAG, { month: "long", year: "numeric", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat(LOCALE_TAG, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const utc = (day: string) => new Date(`${day}T00:00:00Z`);

export type TreeKeyItem = {
  children: boolean;
  closed: boolean;
  parentTree?: string | null;
  fold: (fold: boolean) => void;
  activate: () => void;
};

// A virtual entry of the page tree: a treeitem like a page row, but no page
// (no drag and drop, no drop target, no page menu).
export function JournalTreeItem({
  id,
  parentTree,
  level,
  stop,
  icon,
  label,
  count,
  open,
  muted,
  onToggle,
  onActivate,
  onFocus,
  onKey,
  children,
}: {
  id: string;
  parentTree: string;
  level: number;
  stop: string | null;
  icon: ReactNode;
  label: string;
  count?: number;
  // Folders only: whether it is unfolded.
  open?: boolean;
  muted?: boolean;
  onToggle?: (open: boolean) => void;
  onActivate?: () => void;
  onFocus: (id: string) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>, item: TreeKeyItem) => void;
  children?: ReactNode;
}) {
  const t = useT();
  const folder = open !== undefined && !!onToggle;
  const activate = () => (folder ? onToggle!(!open) : onActivate?.());
  const name =
    count === undefined || !folder ? label : count === 1 ? t(`${label}, 1 Tag`, `${label}, 1 day`) : t(`${label}, ${count} Tage`, `${label}, ${count} days`);
  return (
    <div>
      <div
        className={`page-nav journal-tree-item${muted ? " muted" : ""}`}
        data-tree-id={id}
        role="treeitem"
        aria-level={level + 1}
        aria-label={name}
        aria-selected={false}
        aria-expanded={folder ? open : undefined}
        tabIndex={stop === id ? 0 : -1}
        onFocus={() => onFocus(id)}
        onKeyDown={(e) =>
          onKey(e, {
            children: folder,
            closed: !open,
            parentTree,
            fold: (fold) => onToggle?.(!fold),
            activate,
          })
        }
        style={{ paddingLeft: 12 + level * 14 }}
      >
        {folder ? (
          <button
            className="tree-toggle"
            tabIndex={-1}
            aria-label={open ? t(`${label} schließen`, `Collapse ${label}`) : t(`${label} öffnen`, `Expand ${label}`)}
            onClick={() => onToggle!(!open)}
          >
            <CaretRight size={12} className="nav-caret" style={{ transform: open ? "rotate(90deg)" : undefined }} />
          </button>
        ) : (
          <span className="tree-toggle" aria-hidden="true" />
        )}
        <button className="page-nav-title" tabIndex={-1} onClick={activate}>
          {icon}
          <span className="page-nav-label">{label}</span>
          {count !== undefined && <span className="nav-count" aria-hidden="true">{count.toLocaleString(LOCALE_TAG)}</span>}
        </button>
      </div>
      {folder && (
        <Collapse open={!!open} className="nav-children">
          {open ? <div role="group">{children}</div> : null}
        </Collapse>
      )}
    </div>
  );
}

// Above a day page: previous and next entry, today and a month picker.
export function JournalDayNav({
  date,
  today,
  days,
  onOpen,
  onToday,
}: {
  date: string;
  today: string;
  // The journal's day pages (any order).
  days: (DayLike & { journal_date?: string | null })[];
  onOpen: (id: string) => void;
  onToday: () => void;
}) {
  const t = useT();
  const { previous, next } = useMemo(() => neighbourDays(days, date), [days, date]);
  const [picker, setPicker] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <nav className="journal-daynav" aria-label={t("Tage im Journal", "Days in the journal")}>
      <button
        type="button"
        className="journal-daynav-step"
        disabled={!previous}
        aria-label={previous ? t(`Vorheriger Tag: ${longDate.format(utc(previous.journal_date!))}`, `Previous day: ${longDate.format(utc(previous.journal_date!))}`) : t("Vorheriger Tag", "Previous day")}
        title={previous ? shortDate.format(utc(previous.journal_date!)) : undefined}
        onClick={() => previous && onOpen(previous.id)}
      >
        <CaretLeft size={15} />
        <span>{t("Vorheriger Tag", "Previous day")}</span>
      </button>
      <span className="journal-daynav-middle">
        <button
          type="button"
          className="journal-daynav-today"
          aria-current={date === today ? "date" : undefined}
          disabled={date === today}
          onClick={onToday}
        >
          <CalendarCheck size={15} />
          <span>{t("Heute", "Today")}</span>
        </button>
        <button
          ref={trigger}
          type="button"
          className="journal-daynav-month"
          aria-haspopup="dialog"
          aria-expanded={picker}
          aria-label={t(`Tag wählen, ${monthLabel.format(utc(date))}`, `Choose a day, ${monthLabel.format(utc(date))}`)}
          onClick={() => setPicker((v) => !v)}
        >
          <CalendarBlank size={15} />
          <span>{monthLabel.format(utc(date))}</span>
          <CaretDown size={12} />
        </button>
      </span>
      <button
        type="button"
        className="journal-daynav-step next"
        disabled={!next}
        aria-label={next ? t(`Nächster Tag: ${longDate.format(utc(next.journal_date!))}`, `Next day: ${longDate.format(utc(next.journal_date!))}`) : t("Nächster Tag", "Next day")}
        title={next ? shortDate.format(utc(next.journal_date!)) : undefined}
        onClick={() => next && onOpen(next.id)}
      >
        <span>{t("Nächster Tag", "Next day")}</span>
        <CaretRight size={15} />
      </button>
      {picker && (
        <MonthPicker
          date={date}
          today={today}
          days={days}
          onPick={(id) => {
            setPicker(false);
            onOpen(id);
          }}
          onClose={() => {
            setPicker(false);
            trigger.current?.focus();
          }}
        />
      )}
    </nav>
  );
}

// A month as a grid: days with an entry can be chosen. Arrow keys move by
// a day or a week (across months), Page Up/Down by a month, Escape closes.
function MonthPicker({
  date,
  today,
  days,
  onPick,
  onClose,
}: {
  date: string;
  today: string;
  days: (DayLike & { journal_date?: string | null })[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const byDate = useMemo(() => new Map(days.filter((d) => d.journal_date).map((d) => [d.journal_date!, d])), [days]);
  const [focus, setFocus] = useState(date);
  const month = focus.slice(0, 7);
  const grid = monthGrid(month);
  const count = grid.flat().filter((d) => d && byDate.has(d)).length;
  const root = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    // The focused day follows the arrow keys; at first the open day.
    root.current?.querySelector<HTMLElement>(`[data-date="${focus}"]`)?.focus({ preventScroll: !moved.current });
  }, [focus]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!root.current?.contains(target) && !target.closest(".journal-daynav-month")) onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose]);
  const go = (next: string) => {
    moved.current = true;
    setFocus(next);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) go(shiftDate(focus, step[e.key]));
    else if (e.key === "PageUp" || e.key === "PageDown") {
      const target = shiftMonth(month, e.key === "PageUp" ? -1 : 1);
      const last = Number(new Date(Date.UTC(Number(target.slice(0, 4)), Number(target.slice(5, 7)), 0)).getUTCDate());
      go(`${target}-${String(Math.min(Number(focus.slice(8)), last)).padStart(2, "0")}`);
    } else if (e.key === "Home") go(`${month}-01`);
    else if (e.key === "End") go(grid.flat().filter(Boolean).at(-1)!);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const weekdays = t("Mo Di Mi Do Fr Sa So", "Mo Tu We Th Fr Sa Su").split(" ");
  return (
    <div
      ref={root}
      className="journal-month-picker"
      role="dialog"
      aria-modal="false"
      aria-label={t("Tag im Journal wählen", "Choose a day in the journal")}
      onKeyDown={key}
    >
      <header>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Vorheriger Monat", "Previous month")}
          onClick={() => go(`${shiftMonth(month, -1)}-01`)}
        >
          <CaretLeft size={15} />
        </button>
        <strong aria-live="polite">
          {monthLabel.format(utc(`${month}-01`))}
          <small>{count === 1 ? t("1 Eintrag", "1 entry") : t(`${count} Einträge`, `${count} entries`)}</small>
        </strong>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Nächster Monat", "Next month")}
          onClick={() => go(`${shiftMonth(month, 1)}-01`)}
        >
          <CaretRight size={15} />
        </button>
      </header>
      <div role="grid" aria-label={monthLabel.format(utc(`${month}-01`))}>
        <div role="row" className="journal-month-picker-head">
          {weekdays.map((d) => (
            <span key={d} role="columnheader">
              {d}
            </span>
          ))}
        </div>
        {grid.map((week, i) => (
          <div role="row" key={i}>
            {week.map((cell, j) => {
              if (!cell) return <span key={`gap-${j}`} role="gridcell" />;
              const entry = byDate.get(cell);
              return (
                <span key={cell} role="gridcell">
                  <button
                    type="button"
                    data-date={cell}
                    tabIndex={cell === focus ? 0 : -1}
                    className={`${entry ? "has-entry" : ""}${cell === date ? " current" : ""}${cell === today ? " today" : ""}`}
                    aria-disabled={entry ? undefined : true}
                    aria-current={cell === date ? "date" : undefined}
                    aria-label={entry ? longDate.format(utc(cell)) : t(`${longDate.format(utc(cell))}, kein Eintrag`, `${longDate.format(utc(cell))}, no entry`)}
                    onFocus={() => setFocus(cell)}
                    onClick={() => entry && onPick(entry.id)}
                  >
                    {Number(cell.slice(8))}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
