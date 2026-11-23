"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useCallback, useEffect, useState } from "react";
import { ChatCircle, Quotes } from "@phosphor-icons/react";
import { api, Avatar } from "./ui";
import { Reactions } from "./reactions";
import { CommentQuote } from "./comment-quote";
import { CommentBody } from "./comment-body";
import { pageLocationHash } from "@/lib/page-location";
import type { Comment } from "@/lib/types";
import type { InlineThread } from "@/lib/inline-comment-types";
import { liveOpenFor, THREADS_EVENT, threadsKey } from "@/lib/live-state";
import { commentColorOf } from "@/lib/comment-colors";
import dynamic from "next/dynamic";
import { loadView } from "./view-fallback";

// The replies and the reply field of a text comment (#450): loaded with the
// first text comment shown here.
const CommentHubReply = dynamic(() => loadView(() => import("./comment-hub-reply")), { ssr: false });

type Item =
  | { kind: "page"; at: string; comment: Comment }
  | { kind: "text"; at: string; thread: InlineThread };

// Page comments, guest comments and text comments in one list with shared
// filters. Text comments open their thread at the marked text.
export function CommentHub({
  pageId,
  comments,
  textComments,
  canResolve,
  act,
  time,
}: {
  pageId: string;
  comments: Comment[];
  textComments: boolean;
  canResolve: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  time: (value: string) => string;
}) {
  const t = useT();
  const [threads, setThreads] = useState<InlineThread[]>([]),
    [kind, setKind] = useState<"all" | "page" | "text">("all"),
    [status, setStatus] = useState<"open" | "resolved" | "all">("open"),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!textComments) return setThreads([]);
    try {
      setThreads(await api<InlineThread[]>(`/api/threads?page=${pageId}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pageId, textComments]);
  useEffect(() => {
    void load();
    // Like the inline threads: by the live channel's signal, else every 5 s.
    let last = Date.now();
    const timer = setInterval(() => {
      if (liveOpenFor(pageId) && Date.now() - last < 60_000) return;
      last = Date.now();
      void load();
    }, 5000);
    const signal = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== threadsKey(pageId)) return;
      last = Date.now();
      void load();
    };
    window.addEventListener(THREADS_EVENT, signal);
    return () => {
      clearInterval(timer);
      window.removeEventListener(THREADS_EVENT, signal);
    };
  }, [load, pageId]);
  const items: Item[] = [
    ...comments
      .filter((c) => !c.row_id)
      .map((c) => ({ kind: "page" as const, at: c.created_at, comment: c })),
    ...threads.map((t) => ({
      kind: "text" as const,
      at: t.created_at,
      thread: t,
    })),
  ]
    .filter((item) => kind === "all" || item.kind === kind)
    .filter((item) => {
      const resolved = !!(item.kind === "page"
        ? item.comment.resolved
        : item.thread.resolved);
      return status === "all" || resolved === (status === "resolved");
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const open = {
    page: comments.filter((c) => !c.row_id && !c.resolved).length,
    text: threads.filter((t) => !t.resolved).length,
  };
  return (
    <div className="comment-hub">
      <div className="comment-hub-filters">
        <div role="group" aria-label={t("Art der Kommentare", "Kind of comments")} className="chips">
          {(
            [
              ["all", t(`Alle (${open.page + open.text})`, `All (${open.page + open.text})`)],
              ["page", t(`Seite (${open.page})`, `Page (${open.page})`)],
              ["text", t(`Textstellen (${open.text})`, `Passages (${open.text})`)],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={`chip${kind === value ? " active" : ""}`}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <Select
          aria-label={t("Status der Kommentare", "Status of comments")}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="open">{t("Offen", "Open||status")}</option>
          <option value="resolved">{t("Erledigt", "Resolved")}</option>
          <option value="all">{t("Alle", "All")}</option>
        </Select>
      </div>
      {error && (
        <p className="inline-comment-error" role="alert">
          {error}
        </p>
      )}
      {items.map((item) =>
        item.kind === "page" ? (
          <div
            className={`comment ${item.comment.resolved ? "resolved" : ""}`}
            key={item.comment.id}
          >
            <Avatar name={item.comment.name} small />
            <div>
              <strong>{item.comment.name}</strong>
              <small>{time(item.comment.created_at)}</small>
              <CommentBody content={item.comment.content} body={item.comment.body} />
              {item.comment.author_id && (
                <Reactions
                  reactions={item.comment.reactions || []}
                  onToggle={(emoji, active) =>
                    act({
                      action: "comment.react",
                      pageId,
                      commentId: item.comment.id,
                      emoji,
                      active,
                    })
                  }
                />
              )}
              {canResolve && (
                <button
                  className="text-button"
                  onClick={() =>
                    act({
                      action: "comment.resolve",
                      pageId,
                      commentId: item.comment.id,
                      resolved: !item.comment.resolved,
                    })
                  }
                >
                  {item.comment.resolved
                    ? t("Wieder öffnen", "Reopen")
                    : t("Als erledigt markieren", "Mark as resolved")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className={`comment comment-text ${item.thread.resolved ? "resolved" : ""}`}
            key={item.thread.id}
            aria-label={t(`Textkommentar zu „${item.thread.anchor.quote.slice(0, 60)}“`, `Text comment on “${item.thread.anchor.quote.slice(0, 60)}”`)}
            role="group"
          >
            <Avatar name={item.thread.messages[0]?.name || "?"} small />
            <div>
              <strong>{item.thread.messages[0]?.name || t("Unbekannt", "Unknown")}</strong>
              <small>{time(item.thread.created_at)}</small>
              <blockquote data-comment-color={commentColorOf(item.thread.color)}>
                <Quotes size={12} />{" "}
                <CommentQuote quote={item.thread.anchor.quote} />
              </blockquote>
              <p>
                {item.thread.messages[0]?.body}
                {!!item.thread.messages[0]?.attachmentCount && (
                  <span className="comment-file-count"> 📎 {item.thread.messages[0].attachmentCount}</span>
                )}
              </p>
              <span className="comment-text-actions">
                <a
                  className="text-button"
                  href={pageLocationHash({ pageId, threadId: item.thread.id })}
                >
                  {item.thread.messageCount === 2
                    ? t("1 Antwort · Zur Textstelle", "1 reply · Go to passage")
                    : item.thread.messageCount > 2
                      ? t(`${item.thread.messageCount - 1} Antworten · Zur Textstelle`, `${item.thread.messageCount - 1} replies · Go to passage`)
                      : t("Zur Textstelle", "Go to passage")}
                </a>
                {item.thread.canResolve && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      await act({
                        action: "thread.resolve",
                        pageId,
                        threadId: item.thread.id,
                        version: item.thread.version,
                        resolved: !item.thread.resolved,
                      });
                      await load();
                    }}
                  >
                    {item.thread.resolved
                      ? t("Wieder öffnen", "Reopen")
                      : t("Als erledigt markieren", "Mark as resolved")}
                  </button>
                )}
              </span>
              <CommentHubReply pageId={pageId} thread={item.thread} onSent={load} />
            </div>
          </div>
        ),
      )}
      {!items.length && (
        <div className="empty-state small">
          <ChatCircle size={30} />
          <p>
            {status === "open" && (comments.length || threads.length)
              ? t("Keine offenen Kommentare.", "No open comments.")
              : t("Ein guter Austausch beginnt mit einem Kommentar.", "A good conversation starts with a comment.")}
          </p>
        </div>
      )}
    </div>
  );
}
