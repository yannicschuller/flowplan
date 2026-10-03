"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import {
  useEffect,
  useState,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import {
  ArrowSquareOut,
  ChatCircle,
  PencilSimple,
} from "@phosphor-icons/react";
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
  editing,
  onEdit,
  editor,
  onComment,
}: {
  editing: boolean;
  onEdit?: (editing: boolean) => void;
  // Inline editors provided by the database view (properties and document).
  editor?: { property: (field: Field) => ReactNode; document: ReactNode };
  onComment?: (body: string) => Promise<unknown>;
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
  const t = useT();
  const config = view.feed || defaultFeed;
  const [expanded, setExpanded] = useState(false),
    [comment, setComment] = useState(""),
    [sending, setSending] = useState(false);
  const name =
    members.find((m) => m.id === row.created_by)?.name || t("Unbekannte Person", "Unknown person");
  const title = cellText(row.cells[titleField.id]) || t("Ohne Titel", "Untitled");
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
              {date.toLocaleString(LOCALE_TAG, {
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
      {editing && editor ? (
        <div className="feed-editor" aria-label={`${title} bearbeiten`}>
          {[titleField, ...properties].map((field) => (
            <div className="feed-edit-property" key={field.id}>
              <span>{field.name}</span>
              {editor.property(field)}
            </div>
          ))}
          <div className="feed-edit-document">{editor.document}</div>
        </div>
      ) : (
        <h3 className="feed-entry-title">
          <button onClick={open}>{title}</button>
        </h3>
      )}
      {!editing && properties.length > 0 && (
        <dl className="feed-properties">
          {properties.map((field) => (
            <div key={field.id}>
              <dt>{field.name}</dt>
              <dd>{display(row, field)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!editing &&
        config.content !== "hidden" &&
        (preview?.hasContent ? (
          <>
            {config.content === "full" || expanded ? (
              <ReadOnlyDocument html={preview.html} className="feed-document" />
            ) : (
              <p className="feed-excerpt">
                {preview.text
                  ? [...preview.text].slice(0, 400).join("") +
                    ([...preview.text].length > 400 ? "…" : "")
                  : t("Dieser Eintrag enthält Medien.", "This record contains media.")}
              </p>
            )}
            {config.content === "compact" && (
              <button
                className="feed-expand"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
              >
                {expanded
                  ? t("Inhaltsvorschau anzeigen", "Show content preview")
                  : t("Vollständigen Inhalt anzeigen", "Show full content")}
              </button>
            )}
          </>
        ) : (
          <p className="feed-empty muted">{t("Kein Dokumentinhalt", "No document content")}</p>
        ))}
      <footer className="feed-entry-footer">
        {config.showComments && (
          <button
            onClick={open}
            aria-label={t(`${comments} Kommentare zu ${title}`, `${comments} comments on ${title}`)}
          >
            <ChatCircle size={17} />
            {comments} {comments === 1 ? t("Kommentar", "Comment") : t("Kommentare", "Comments")}
          </button>
        )}
        {onEdit && (
          <button onClick={() => onEdit(!editing)} aria-pressed={editing}>
            <PencilSimple size={16} />
            {editing ? t("Fertig", "Done") : t("Bearbeiten", "Edit")}
          </button>
        )}
        <button onClick={open}>
          <ArrowSquareOut size={16} />
          {t("Eintrag öffnen", "Open record")}
        </button>
      </footer>
      {config.showComments && onComment && (
        <form
          className="feed-comment"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!comment.trim() || sending) return;
            setSending(true);
            try {
              if (await onComment(comment.trim())) setComment("");
            } finally {
              setSending(false);
            }
          }}
        >
          <input
            aria-label={t(`Kommentar zu ${title}`, `Comment on ${title}`)}
            placeholder={t("Kommentar schreiben …", "Write a comment …")}
            value={comment}
            maxLength={5000}
            onChange={(e) => setComment(e.target.value)}
          />
          <button
            className="button compact"
            disabled={!comment.trim() || sending}
          >
            {t("Senden", "Send")}
          </button>
        </form>
      )}
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
  editor,
  onComment,
}: {
  editor?: (row: Row) => {
    property: (field: Field) => ReactNode;
    document: ReactNode;
  };
  onComment?: (row: Row, body: string) => Promise<unknown>;
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
  const t = useT();
  const [limit, setLimit] = useState(20),
    [editingRow, setEditingRow] = useState<string | null>(null);
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
    <section className="database-feed" aria-label={t("Datenbank-Feed", "Database feed")}>
      <p className="feed-count muted" role="status">
        {Math.min(limit, rows.length)} {t("von", "of")}{" "}{rows.length} {t("Einträgen", "records")}
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
          editing={editingRow === row.id}
          onEdit={
            editor ? (on) => setEditingRow(on ? row.id : null) : undefined
          }
          editor={editingRow === row.id ? editor?.(row) : undefined}
          onComment={onComment ? (body) => onComment(row, body) : undefined}
        />
      ))}
      {rows.length > limit && (
        <button
          className="button feed-more"
          onClick={() => setLimit((n) => n + 20)}
        >
          {t("Weitere", "More")}{" "}{Math.min(20, rows.length - limit)} {t("Einträge anzeigen", "Show records")}
        </button>
      )}
    </section>
  );
}
