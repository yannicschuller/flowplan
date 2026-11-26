"use client";
// The board of "Meine Aufgaben" (#564): the due groups as columns –
// Überfällig, Heute, Nächste 7 Tage, Später, Ohne Datum (and Erledigt while
// "Erledigte zeigen" is on). A card is a task from a document or a record;
// dragging it to another column gives it that column's date (lib/board-
// due.ts), and "Verschieben nach …" on every card does the same from the
// keyboard and on phones, where the columns scroll sideways and cards are
// moved with the menu only (touch dragging would fight the scrolling).
// Loaded only when the board is chosen (components/my-tasks.tsx).
import { useRef, useState, type ReactNode } from "react";
import { ArrowsLeftRight, CalendarBlank, CalendarX } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Avatar, PageIcon } from "./ui";
import { ContextMenu, type ContextMenuItem } from "./context-menu";
import { dueLabel, dueState, localToday } from "@/lib/task-due";
import { dueGroupName } from "@/lib/due-groups";
import { BOARD_COLUMNS, DROP_TARGETS, columnOf, dropDue, type BoardColumn } from "@/lib/board-due";

export type BoardCard = {
  key: string;
  title: string;
  checked: boolean;
  due: string | null;
  busy: boolean;
  // Where it lives: the page or the database.
  source: { title: string; icon: string };
  // In "Alle Arbeitsbereiche": the workspace's label.
  workspace?: ReactNode;
  people: { id: string; name: string }[];
  // Whether its date can be changed (a record needs a due date property).
  movable: boolean;
  onOpen: () => void;
  onToggle: (checked: boolean) => void;
  onMove: (due: string | null) => void;
};

const DRAG_TYPE = "application/x-flowplan-task";

export function MyTasksBoard({ cards, touch }: { cards: BoardCard[]; touch: boolean }) {
  const t = useT();
  const today = localToday();
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ card: BoardCard; x: number; y: number; button: HTMLElement } | null>(null);
  const dragged = useRef<string | null>(null);
  const columns: { name: string; cards: BoardCard[] }[] = BOARD_COLUMNS.map((name) => ({ name, cards: [] as BoardCard[] }));
  const done: BoardCard[] = [];
  for (const card of cards) {
    if (card.checked) done.push(card);
    else columns.find((c) => c.name === columnOf(card.due, today))!.cards.push(card);
  }
  if (done.length) columns.push({ name: "Erledigt", cards: done });
  const moveTo = (card: BoardCard, column: string) => {
    const due = dropDue(column, card.due, today);
    if (due !== undefined) card.onMove(due);
  };
  const choices: Record<string, string> = {
    Heute: t("Heute", "Today"),
    "Nächste 7 Tage": t("Nächste 7 Tage (morgen)", "Next 7 days (tomorrow)"),
    Später: t("Später (in 8 Tagen)", "Later (in 8 days)"),
    "Ohne Datum": t("Ohne Datum (Datum entfernen)", "No date (remove the date)"),
  };
  const menuItems = (card: BoardCard): ContextMenuItem[] =>
    DROP_TARGETS.filter((c) => columnOf(card.due, today) !== c).map((c) => ({
      icon: c === "Ohne Datum" ? <CalendarX size={15} /> : <CalendarBlank size={15} />,
      label: choices[c],
      run: () => moveTo(card, c),
    }));
  const drop = (column: string) => (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const key = e.dataTransfer.getData(DRAG_TYPE) || dragged.current;
    const card = cards.find((c) => c.key === key);
    if (card && card.movable && !card.checked) moveTo(card, column);
  };
  return (
    <div className={`my-tasks-board${touch ? " touch" : ""}`} role="group" aria-label={t("Aufgaben nach Fälligkeit", "Tasks by due date")}>
      {columns.map((column) => {
        const target = DROP_TARGETS.includes(column.name as BoardColumn);
        return (
          <section
            key={column.name}
            aria-label={dueGroupName(column.name, t)}
            className={`my-tasks-column${column.name === "Überfällig" ? " overdue" : ""}${over === column.name ? " over" : ""}${dragging && !target ? " closed" : ""}`}
            data-column={column.name}
            onDragOver={
              target && !touch
                ? (e) => {
                    if (!dragged.current) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (over !== column.name) setOver(column.name);
                  }
                : undefined
            }
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === column.name ? null : o));
            }}
            onDrop={target && !touch ? drop(column.name) : undefined}
          >
            <h2>
              {dueGroupName(column.name, t)} <small>{column.cards.length}</small>
            </h2>
            <ul>
              {column.cards.map((card) => {
                const title = card.title || t("Ohne Text", "No text");
                return (
                  <li
                    key={card.key}
                    data-task-key={card.key}
                    className={`my-task-card${card.checked ? " checked" : ""}${dragging === card.key ? " dragging" : ""}`}
                    draggable={!touch && card.movable && !card.checked && !card.busy}
                    onDragStart={(e) => {
                      dragged.current = card.key;
                      e.dataTransfer.setData(DRAG_TYPE, card.key);
                      e.dataTransfer.effectAllowed = "move";
                      // After the drag has begun: changing the page in dragstart can end it at once.
                      const key = card.key;
                      requestAnimationFrame(() => dragged.current === key && setDragging(key));
                    }}
                    onDragEnd={() => {
                      dragged.current = null;
                      setDragging(null);
                      setOver(null);
                    }}
                  >
                    <div className="my-task-card-head">
                      <input
                        type="checkbox"
                        aria-label={t(`${title} erledigt`, `${title} completed`)}
                        checked={card.checked}
                        disabled={card.busy}
                        onChange={(e) => card.onToggle(e.target.checked)}
                      />
                      <button type="button" className="my-task-card-title" onClick={card.onOpen}>
                        {title}
                      </button>
                      {card.movable && !card.checked && (
                        <button
                          type="button"
                          className="icon-button my-task-card-move"
                          aria-haspopup="menu"
                          aria-label={t(`${title} verschieben nach …`, `Move ${title} to …`)}
                          title={t("Verschieben nach …", "Move to …")}
                          disabled={card.busy}
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenu({ card, x: rect.right - 220, y: rect.bottom + 4, button: e.currentTarget });
                          }}
                        >
                          <ArrowsLeftRight size={14} />
                        </button>
                      )}
                    </div>
                    <div className="my-task-card-meta">
                      <span className="my-task-card-source">
                        <PageIcon name={card.source.icon} size={13} />
                        <span>{card.source.title || t("Ohne Titel", "Untitled")}</span>
                      </span>
                      {card.due && (
                        <span className={`task-due task-due-${dueState(card.due, card.checked)}`}>
                          <span className="task-due-icon" aria-hidden="true">📅</span>
                          {dueLabel(card.due)}
                        </span>
                      )}
                      {card.workspace}
                      {card.people.length > 0 && (
                        <span className="my-record-people">
                          {card.people.slice(0, 3).map((p) => (
                            <Avatar key={p.id} name={p.name} userId={p.id} small />
                          ))}
                          {card.people.length > 3 && <span className="my-record-more">+{card.people.length - 3}</span>}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {!column.cards.length && <p className="my-tasks-column-empty">{t("Keine Aufgaben", "No tasks")}</p>}
          </section>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("Verschieben nach", "Move to")}
          items={menuItems(menu.card)}
          onClose={() => {
            const button = menu.button;
            setMenu(null);
            requestAnimationFrame(() => button.isConnected && button.focus());
          }}
        />
      )}
    </div>
  );
}
