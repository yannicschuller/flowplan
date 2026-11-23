"use client";
// The form for a new page or record comment (#450): the same composer as
// text comments – formatting, "@" for people and pages, attachments and
// link previews – instead of the plain text field. Loaded once the field
// (components/page-comment-field.tsx) is used, not with the page or the
// record (it brings the editor).
//
// The comment shows at once and the field empties; a refusal brings the
// draft back. A double submit of the same draft posts it once.
import { useState } from "react";
import { CommentComposer } from "./comment-composer";
import { useT } from "./i18n";
import { commentReady, plainCommentContent, type CommentNode } from "@/lib/comment-content";
import { draftKey, draftSent, keyed } from "@/lib/idempotency-key";

export default function PageCommentForm({
  pageId,
  rowId,
  act,
  label,
  submitLabel,
  initialText = "",
  initialFiles,
}: {
  pageId: string;
  rowId?: string;
  act: (body: Record<string, unknown>) => Promise<unknown>;
  label?: string;
  submitLabel?: string;
  // What was typed, dropped or pasted into the field before.
  initialText?: string;
  initialFiles?: File[];
}) {
  const t = useT();
  const [draft, setDraft] = useState<{ body: string; content: CommentNode | null }>({ body: initialText, content: null });
  const ready = commentReady(draft.body, draft.content);
  return (
    <form
      className="page-comment-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        const sent = draft;
        const scope = `comment:${rowId || pageId}`;
        const content = sent.content || plainCommentContent(sent.body);
        setDraft({ body: "", content: null });
        const result = await act(
          keyed(
            { action: "comment.create", pageId, ...(rowId ? { rowId } : {}), body: sent.body, content },
            draftKey(scope, JSON.stringify(content)),
          ),
        );
        if (result) draftSent(scope);
        else setDraft((now) => (commentReady(now.body, now.content) ? now : sent));
      }}
    >
      <CommentComposer
        label={label || t("Kommentar", "Comment||noun")}
        pageId={pageId}
        rowId={rowId}
        body={draft.body}
        content={draft.content}
        onChange={(body, content) => setDraft({ body, content })}
        autoFocus
        initialFiles={initialFiles}
      />
      <button className="button primary compact" disabled={!ready}>
        {submitLabel || t("Kommentieren", "Comment")}
      </button>
    </form>
  );
}
