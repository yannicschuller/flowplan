"use client";
import {
  useEffect,
  useState,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import { ArrowSquareOut, ChatCircle } from "@phosphor-icons/react";
import { ReadOnlyDocument } from "./read-only-document";
import { defaultFeed } from "@/lib/database-feed";
import { cellText } from "@/lib/cell-text";
import type { Comment, Field, Row, User, View } from "@/lib/types";
import { Avatar } from "./ui";
function FeedEntry({
  row,
  titleField,
  properties,
  view,
  members,
  comments,
  display,
  open,
  orderHandle,
  rowEvents,
}: {
  row: Row;
  titleField: Field;
  properties: Field[];
  view: View;
  members: User[];
  comments: number;
  display: (row: Row, field: Field) => ReactNode;
  open: () => void;
  orderHandle: ReactNode;
  rowEvents: HTMLAttributes<HTMLElement>;
}) {
  const config = view.feed || defaultFeed;
  const [expanded, setExpanded] = useState(false);
  const name =
    members.find((m) => m.id === row.created_by)?.name || "Unbekannte Person";
  const title = cellText(row.cells[titleField.id]) || "Ohne Titel";
  const date = new Date(
    row.created_at.includes("T")
      ? row.created_at
      : row.created_at.replace(" ", "T") + "Z",
  );
  const preview = row.preview;
  return (
    <article
      {...rowEvents}
      className={`feed-entry ${rowEvents.className || ""}`}
      aria-label={title}
      data-row-id={row.id}
    >
      <header className="feed-entry-header">
        {config.showAuthor && <Avatar name={name} small />}
        <div className="feed-author">
          {config.showAuthor && <strong>{name}</strong>}
          {config.showDate && Number.isFinite(date.getTime()) && (
            <time dateTime={date.toISOString()}>
              {date.toLocaleString("de-DE", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
        </div>
        {orderHandle}
      </header>
      <h3 className="feed-entry-title">
        <button onClick={open}>{title}</button>
      </h3>
      {properties.length > 0 && (
        <dl className="feed-properties">
          {properties.map((field) => (
            <div key={field.id}>
              <dt>{field.name}</dt>
              <dd>{display(row, field)}</dd>
            </div>
          ))}
        </dl>
      )}
      {config.content !== "hidden" &&
        (preview?.hasContent ? (
          <>
            {config.content === "full" || expanded ? (
              <ReadOnlyDocument html={preview.html} className="feed-document" />
            ) : (
              <p className="feed-excerpt">
                {preview.text
                  ? [...preview.text].slice(0, 400).join("") +
                    ([...preview.text].length > 400 ? "…" : "")
                  : "Dieser Eintrag enthält Medien."}
              </p>
            )}
            {config.content === "compact" && (
              <button
                className="feed-expand"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
              >
                {expanded
                  ? "Inhaltsvorschau anzeigen"
                  : "Vollständigen Inhalt anzeigen"}
              </button>
            )}
          </>
        ) : (
          <p className="feed-empty muted">Kein Dokumentinhalt</p>
        ))}
      <footer className="feed-entry-footer">
        {config.showComments && (
          <button
            onClick={open}
            aria-label={`${comments} Kommentare zu ${title}`}
          >
            <ChatCircle size={17} />
            {comments} {comments === 1 ? "Kommentar" : "Kommentare"}
          </button>
        )}
        <button onClick={open}>
          <ArrowSquareOut size={16} />
          Eintrag öffnen
        </button>
      </footer>
    </article>
  );
}
export default function DatabaseFeed({
  rows,
  fields,
  visibleFields,
  view,
  members,
  comments,
  display,
  onOpen,
  orderHandle,
  query,
  rowEvents,
}: {
  rows: Row[];
  fields: Field[];
  visibleFields: Field[];
  view: View;
  members: User[];
  comments: Comment[];
  display: (row: Row, field: Field) => ReactNode;
  onOpen: (id: string) => void;
  orderHandle: (row: Row) => ReactNode;
  query: string;
  rowEvents: (row: Row) => HTMLAttributes<HTMLElement>;
}) {
  const [limit, setLimit] = useState(20);
  const selection = JSON.stringify([
    view.filters,
    view.filterGroup,
    view.sorts,
    query,
  ]);
  useEffect(() => setLimit(20), [selection]);
  const counts = new Map<string, number>();
  for (const comment of comments)
    if (comment.row_id)
      counts.set(comment.row_id, (counts.get(comment.row_id) || 0) + 1);
  const properties = visibleFields.filter((f) => f.id !== fields[0].id);
  return (
    <section className="database-feed" aria-label="Datenbank-Feed">
      <p className="feed-count muted" role="status">
        {Math.min(limit, rows.length)} von {rows.length} Einträgen
      </p>
      {rows.slice(0, limit).map((row) => (
        <FeedEntry
          key={`${row.id}-${view.feed?.content || "full"}`}
          row={row}
          rowEvents={rowEvents(row)}
          titleField={fields[0]}
          properties={properties}
          view={view}
          members={members}
          comments={counts.get(row.id) || 0}
          display={display}
          open={() => onOpen(row.id)}
          orderHandle={orderHandle(row)}
        />
      ))}
      {rows.length > limit && (
        <button
          className="button feed-more"
          onClick={() => setLimit((n) => n + 20)}
        >
          Weitere {Math.min(20, rows.length - limit)} Einträge anzeigen
        </button>
      )}
    </section>
  );
}
