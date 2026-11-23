"use client";
// Editing a page or record comment in place (#450), as a text comment's
// edit (components/inline-comment-thread.tsx): the same composer with the
// comment's text, files and previews, "Änderung speichern" / "Bearbeitung
// abbrechen". Loaded when an edit starts (components/page-comment.tsx), not
// with the page – it brings the editor. A refusal (the comment changed
// meanwhile, a mention without access) keeps the draft open.
import { useState } from "react";
import { CommentComposer } from "./comment-composer";
import { useT } from "./i18n";
import { commentReady, plainCommentContent, type CommentNode } from "@/lib/comment-content";
import type { Comment } from "@/lib/types";

export default function PageCommentEdit({
  pageId,
  comment,
  act,
  onDone,
}: {
  pageId: string;
  comment: Comment;
  act: (body: Record<string, unknown>) => Promise<unknown>;
  onDone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<{ body: string; content: CommentNode | null }>({
    body: comment.body,
    content: comment.content ?? null,
  });
  const [busy, setBusy] = useState(false);
  const ready = commentReady(draft.body, draft.content);
  return (
    <form
      className="page-comment-form page-comment-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !ready) return;
        setBusy(true);
        const result = await act({
          action: "comment.edit",
          pageId,
          commentId: comment.id,
          version: comment.version ?? 1,
          body: draft.body,
          content: draft.content || plainCommentContent(draft.body),
        });
        setBusy(false);
        if (result) onDone();
      }}
    >
      <CommentComposer
        label={t("Kommentartext bearbeiten", "Edit comment text")}
        pageId={pageId}
        rowId={comment.row_id ?? undefined}
        body={draft.body}
        content={draft.content}
        disabled={busy}
        autoFocus
        onChange={(body, content) => setDraft({ body, content })}
      />
      <div className="inline-comment-actions">
        <button className="button compact" disabled={busy || !ready}>
          {t("Änderung speichern", "Save change")}
        </button>
        <button type="button" className="text-button" onClick={onDone}>
          {t("Bearbeitung abbrechen", "Cancel editing")}
        </button>
      </div>
    </form>
  );
}
