"use client";
// Replying to a text comment in the comments panel on the right (#450,
// components/comment-hub.tsx): the replies so far on request and the reply
// field of the threads (components/comment-composer.tsx, as in
// components/inline-comment-thread.tsx), so the conversation goes on
// without scrolling to the passage. Loaded with the first text comment the
// panel shows, not with the page.
import { useState } from "react";
import type { CommentNode } from "@/lib/comment-content";
import type { InlineMessage, InlineThread } from "@/lib/inline-comment-types";
import { CommentBody, CommentComposer } from "./comment-composer";
import { useT } from "./i18n";
import { api } from "./ui";

export default function CommentHubReply({
  pageId,
  thread,
  onSent,
}: {
  pageId: string;
  thread: InlineThread;
  // After a reply: the list loads the threads again (count, order).
  onSent: () => void | Promise<void>;
}) {
  const t = useT();
  const [body, setBody] = useState(""),
    [content, setContent] = useState<CommentNode | null>(null),
    [messageId, setMessageId] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [replies, setReplies] = useState<InlineMessage[] | null>(null),
    [loading, setLoading] = useState(false);
  const count = Math.max(0, thread.messageCount - 1);
  async function loadReplies() {
    setLoading(true);
    setError("");
    try {
      const all = await api<InlineThread[]>(`/api/threads?page=${pageId}&thread=${thread.id}`);
      setReplies(all.find((x) => x.id === thread.id)?.messages.slice(1) || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="comment-hub-reply">
      {count > 0 &&
        (replies ? (
          <ul className="comment-hub-replies" aria-label={t("Antworten", "Replies")}>
            {replies.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong>
                {m.deleted ? <p>{t("Kommentar gelöscht", "Comment deleted")}</p> : <CommentBody content={m.content} body={m.body} />}
              </li>
            ))}
          </ul>
        ) : (
          <button type="button" className="text-button" aria-expanded={false} disabled={loading} onClick={() => void loadReplies()}>
            {count === 1 ? t("1 Antwort zeigen", "Show 1 reply") : t(`${count} Antworten zeigen`, `Show ${count} replies`)}
          </button>
        ))}
      {thread.resolved ? null : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || !body.trim()) return;
            setBusy(true);
            setError("");
            try {
              await api("/api/command", { action: "thread.reply", pageId, threadId: thread.id, messageId, body, content });
              setBody("");
              setContent(null);
              setMessageId(crypto.randomUUID());
              await onSent();
              if (replies) await loadReplies();
            } catch (err) {
              // The text stays in the field; the same id makes a retry safe.
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <CommentComposer
            key={thread.id}
            label={t("Antwort", "Reply||noun")}
            pageId={pageId}
            body={body}
            content={content}
            disabled={busy}
            onChange={(text, next) => {
              setBody(text);
              setContent(next ?? null);
            }}
          />
          <button className="button primary compact" disabled={busy || !body.trim()}>
            {t("Antwort senden", "Send reply")}
          </button>
        </form>
      )}
      {error && (
        <p className="inline-comment-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
