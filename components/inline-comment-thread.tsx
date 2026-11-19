"use client";
// One text comment thread (#314) – its messages, reactions, edits, the
// reply and "resolve" – and the form of a new comment. Shared by the panel
// below the document and the cards in the margin beside it (#387,
// components/comment-margin.tsx); the state (drafts, the open edit, the
// requests) stays in components/inline-comments.tsx. Loaded with the first
// thread or new comment, not with the document.
import { useState, type FormEvent } from "react";
import { ArrowCounterClockwise, Check, Link, PencilSimple, Smiley, Trash } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { pageLocationHash } from "@/lib/page-location";
import type { CommentNode } from "@/lib/comment-content";
import type { InlineMessage, InlineThread } from "@/lib/inline-comment-types";
import { CommentComposer, CommentBody } from "./comment-composer";
import { CommentQuote } from "./comment-quote";
import { useT } from "./i18n";
import { Avatar } from "./ui";

export type ThreadEditing = { message: InlineMessage; body: string; content?: CommentNode | null };
export type ThreadReply = { id: string; body: string; content?: CommentNode | null };

export type ThreadProps = {
  thread: InlineThread;
  pageId: string;
  rowId?: string;
  userId: string;
  busy: boolean;
  act: (action: string, data: Record<string, unknown>) => Promise<boolean>;
  editing: ThreadEditing | null;
  setEditing: (editing: ThreadEditing | null) => void;
  reply?: ThreadReply;
  onReply: (body: string, content?: CommentNode | null) => void;
  onReplySent: () => void;
  onReact: (messageId: string) => void;
  onDelete: (message: InlineMessage) => void;
  onError: (message: string) => void;
  // Whether the passage is still in the document.
  passage: boolean;
  onGoToText: () => void;
  // The panel: back to the list.
  onBack?: () => void;
  // The margin: the passage is right beside the card – no quote, no "go
  // to passage", no way back to a list.
  compact?: boolean;
};

export default function InlineCommentThread({
  thread,
  pageId,
  rowId,
  userId,
  busy,
  act,
  editing,
  setEditing,
  reply,
  onReply,
  onReplySent,
  onReact,
  onDelete,
  onError,
  passage,
  onGoToText,
  onBack,
  compact = false,
}: ThreadProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const replyBody = reply?.body || "";
  return (
    <>
      {onBack && (
        <button className="text-button" onClick={onBack}>
          {t("← Alle Textkommentare", "← All text comments")}
        </button>
      )}
      {!compact && (
        <blockquote>
          <CommentQuote quote={thread.anchor.quote} />
        </blockquote>
      )}
      <div className="inline-comment-actions">
        <button
          className="text-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`${location.origin}/${pageLocationHash({ pageId, rowId, threadId: thread.id })}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            } catch {
              onError(t("Der Link konnte nicht kopiert werden. Bitte erlaube den Zugriff auf die Zwischenablage.", "The link could not be copied. Please allow access to the clipboard."));
            }
          }}
        >
          <Link /> {copied ? t("Link kopiert", "Link copied") : t("Kommentarlink kopieren", "Copy comment link")}
        </button>
        {!compact && (
          <button className="text-button" disabled={!passage} onClick={onGoToText}>
            {t("Zur Textstelle", "Go to passage")}
          </button>
        )}
        {!compact && !passage && <span className="muted">{t("Textstelle nicht mehr verfügbar", "Passage no longer available")}</span>}
        {thread.canResolve && (
          <button
            className="button compact"
            disabled={busy}
            onClick={() =>
              void act("thread.resolve", {
                version: thread.version,
                resolved: !thread.resolved,
              })
            }
          >
            {thread.resolved ? <ArrowCounterClockwise /> : <Check />}
            {thread.resolved ? t("Wieder öffnen", "Reopen") : t("Thread erledigen", "Resolve thread")}
          </button>
        )}
      </div>
      {thread.messages.map((m) => (
        <article className="inline-comment-message" key={m.id}>
          <Avatar name={m.name} small />
          <div>
            <strong>{m.name}</strong>
            <small>
              {new Date(m.created_at.replace(" ", "T") + "Z").toLocaleString(LOCALE_TAG)}
              {m.edited_at && !m.deleted ? t(" · bearbeitet", " · edited") : ""}
              {m.author_id === null ? t(" · importiert", " · imported") : ""}
            </small>
            {editing?.message.id === m.id ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (busy || !editing.body.trim()) return;
                  if (
                    await act("thread.edit", {
                      messageId: m.id,
                      version: editing.message.version,
                      body: editing.body,
                      content: editing.content,
                    })
                  )
                    setEditing(null);
                }}
              >
                <CommentComposer
                  key={m.id}
                  label={t("Kommentartext bearbeiten", "Edit comment text")}
                  pageId={pageId}
                  rowId={rowId}
                  body={editing.body}
                  content={editing.content}
                  disabled={busy}
                  autoFocus
                  onChange={(body, content) => setEditing({ ...editing, body, content })}
                />
                <button className="button" disabled={busy || !editing.body.trim()}>
                  {t("Änderung speichern", "Save change")}
                </button>
                <button type="button" className="text-button" onClick={() => setEditing(null)}>
                  {t("Bearbeitung abbrechen", "Cancel editing")}
                </button>
              </form>
            ) : m.deleted ? (
              <p>{t("Kommentar gelöscht", "Comment deleted")}</p>
            ) : (
              <CommentBody content={m.content} body={m.body} />
            )}
            {!m.deleted && (
              <div className="inline-comment-actions">
                {m.reactions.map((r) => (
                  <button
                    className="reaction-button"
                    aria-pressed={r.mine}
                    title={r.names.join(", ")}
                    aria-label={t(`${r.emoji} ${r.count} Reaktionen`, `${r.emoji} ${r.count} reactions`)}
                    key={r.emoji}
                    disabled={busy}
                    onClick={() =>
                      void act("thread.react", {
                        messageId: m.id,
                        emoji: r.emoji,
                        active: !r.mine,
                      })
                    }
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
                <button className="icon-button" aria-label={t("Emoji-Reaktion hinzufügen", "Add emoji reaction")} disabled={busy} onClick={() => onReact(m.id)}>
                  <Smiley />
                </button>
                {m.author_id === userId && (
                  <>
                    <button
                      className="icon-button"
                      aria-label={t("Kommentar bearbeiten", "Edit comment")}
                      disabled={busy}
                      onClick={() => setEditing({ message: m, body: m.body, content: m.content })}
                    >
                      <PencilSimple />
                    </button>
                    <button className="icon-button" aria-label={t("Kommentar löschen", "Delete comment")} disabled={busy} onClick={() => onDelete(m)}>
                      <Trash />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </article>
      ))}
      {thread.resolved ? (
        <p className="muted">{t("Dieser Thread ist erledigt.", "This thread is resolved.")}</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || !replyBody.trim()) return;
            if (
              await act("thread.reply", {
                messageId: reply?.id,
                body: replyBody,
                content: reply?.content,
              })
            )
              onReplySent();
          }}
        >
          <CommentComposer
            key={thread.id}
            label={t("Antwort", "Reply||noun")}
            pageId={pageId}
            rowId={rowId}
            body={replyBody}
            content={reply?.content}
            disabled={busy}
            onChange={onReply}
          />
          <button className="button primary" disabled={busy || !replyBody.trim()}>
            {t("Antwort senden", "Send reply")}
          </button>
        </form>
      )}
    </>
  );
}

// A new comment on a passage: the quote (not in the margin, where the
// passage is beside it), the text and send / cancel.
export function InlineCommentDraft({
  quote,
  pageId,
  rowId,
  body,
  content,
  busy,
  compact = false,
  onChange,
  onSubmit,
  onCancel,
}: {
  quote: string;
  pageId: string;
  rowId?: string;
  body: string;
  content: CommentNode | null;
  busy: boolean;
  compact?: boolean;
  onChange: (body: string, content: CommentNode | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <form
      className="inline-comment-new"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {!compact && (
        <blockquote>
          <CommentQuote quote={quote} />
        </blockquote>
      )}
      <CommentComposer
        label={t("Kommentar zur Textstelle", "Comment on the passage")}
        pageId={pageId}
        rowId={rowId}
        body={body}
        content={content}
        autoFocus
        disabled={busy}
        onChange={(text, next) => onChange(text, next ?? null)}
      />
      <div className="inline-comment-actions">
        <button className="button primary" disabled={busy || !body.trim()}>
          {t("Kommentar senden", "Send comment")}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t("Abbrechen", "Cancel")}
        </button>
      </div>
      {!compact && (
        <p className="muted">
          {t("Die markierte Textstelle wird beim Speichern erneut geprüft. Bei Änderungen bleibt dein Entwurf erhalten.", "The marked passage is checked again when saving. If it changed, your draft is kept.")}
        </p>
      )}
    </form>
  );
}
