"use client";
// One page or record comment (#450) – in the comment panel
// (components/comment-hub.tsx) and among a record's comments
// (components/database-view.tsx): its text, reactions and, for its author,
// editing in place and deleting, as text comments do
// (components/inline-comment-thread.tsx): pencil and bin beside the
// reactions, "· bearbeitet" after an edit, a confirmation before deleting.
// The composer loads only when an edit starts (components/page-comment-edit.tsx).
import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import type { Comment } from "@/lib/types";
import { CommentBody } from "./comment-body";
import { Reactions } from "./reactions";
import { useT } from "./i18n";
import { Avatar, Modal } from "./ui";
import { loadView } from "./view-fallback";

const PageCommentEdit = dynamic(() => loadView(() => import("./page-comment-edit")), { ssr: false });

export function PageComment({
  comment,
  pageId,
  userId,
  act,
  time,
  children,
}: {
  comment: Comment;
  pageId: string;
  // The signed-in person: their own comments can be edited and deleted.
  userId?: string;
  act: (body: Record<string, unknown>) => Promise<unknown>;
  // When it was written, as the list shows it (the record's list shows none).
  time?: string;
  // More actions after the reactions (the panel's "Als erledigt markieren").
  children?: ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false);
  // Guests' comments have no author; a comment still being sent has no id yet.
  const mine = !!userId && comment.author_id === userId && !comment.id.startsWith("pending-");
  const edited = !!comment.edited_at;
  return (
    <div className={`comment ${comment.resolved ? "resolved" : ""}`}>
      <Avatar name={comment.name} small />
      <div>
        <strong>{comment.name}</strong>
        {(time || edited) && (
          <small>
            {time}
            {edited ? (time ? t(" · bearbeitet", " · edited") : t("bearbeitet", "edited")) : ""}
          </small>
        )}
        {editing ? (
          <PageCommentEdit pageId={pageId} comment={comment} act={act} onDone={() => setEditing(false)} />
        ) : (
          <CommentBody content={comment.content} body={comment.body} />
        )}
        {!editing && (comment.author_id || mine) && (
          <div className="page-comment-actions">
            {comment.author_id && (
              <Reactions
                reactions={comment.reactions || []}
                onToggle={(emoji, active) =>
                  act({
                    action: "comment.react",
                    pageId,
                    commentId: comment.id,
                    emoji,
                    active,
                  })
                }
              />
            )}
            {mine && (
              <>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("Kommentar bearbeiten", "Edit comment")}
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  <PencilSimple />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("Kommentar löschen", "Delete comment")}
                  disabled={busy}
                  onClick={() => setDeleting(true)}
                >
                  <Trash />
                </button>
              </>
            )}
          </div>
        )}
        {children}
      </div>
      <Modal open={deleting} onClose={() => setDeleting(false)} title={t("Kommentar löschen", "Delete comment")}>
        <p>
          {t(
            "Der Kommentar wird mit seinen Reaktionen entfernt. Angehängte Dateien, die sonst nirgends verwendet werden, kommen in den Papierkorb.",
            "The comment is removed with its reactions. Attached files that are not used anywhere else go to the trash.",
          )}
        </p>
        <button
          className="button danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await act({ action: "comment.delete", pageId, commentId: comment.id, version: comment.version ?? 1 });
            setBusy(false);
            if (result) setDeleting(false);
          }}
        >
          {t("Kommentar endgültig löschen", "Delete comment permanently")}
        </button>
      </Modal>
    </div>
  );
}
