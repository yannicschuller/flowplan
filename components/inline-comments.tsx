"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { CommentComposer, CommentBody } from "./comment-composer";
import type { CommentNode } from "@/lib/comment-content";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  ChatCircle,
  Check,
  ArrowCounterClockwise,
  Smiley,
  PencilSimple,
  Trash,
  X,
  Link,
} from "@phosphor-icons/react";
import { parsePageLocation, pageLocationHash } from "@/lib/page-location";
import { api, Avatar, Modal } from "./ui";
import EmojiPicker from "./emoji-picker";
import { readCommentDrafts, saveCommentDrafts } from "@/lib/comment-drafts";
import { flushOpenDocuments } from "@/lib/document-flush";
import {
  editorCommentBinding,
  selectedCommentAnchor,
  setCommentHighlights,
} from "@/lib/inline-comment-plugin";
import { commentRange } from "@/lib/comment-positions";
import type {
  InlineThread,
  CommentAnchor,
  InlineMessage,
} from "@/lib/inline-comment-types";

export function InlineComments({
  editor,
  pageId,
  rowId,
  generation,
  userId,
}: {
  editor: Editor | null;
  pageId: string;
  rowId?: string;
  generation: string;
  userId: string;
}) {
  const t = useT();
  const panel = useRef<HTMLElement | null>(null);
  const linkedThread = useRef<string | null>(null);
  const scrolledThread = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadedActive, setLoadedActive] = useState<string | null | undefined>(
    undefined,
  );
  const draftKey = `flowplan-comment-drafts:${userId}:${pageId}:${rowId || "page"}`;
  const [threads, setThreads] = useState<InlineThread[]>([]),
    [active, setActive] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [filter, setFilter] = useState("open");
  const [draft, setDraft] = useState<{
      anchor: CommentAnchor;
      threadId: string;
      messageId: string;
    } | null>(null),
    [body, setBody] = useState(() => readCommentDrafts(draftKey).body);
  const [bodyContent, setBodyContent] = useState<CommentNode | null>(
    () => readCommentDrafts(draftKey).content || null,
  );
  const [replyDrafts, setReplyDrafts] = useState<
    Record<string, { id: string; body: string; content?: CommentNode | null }>
  >(() => readCommentDrafts(draftKey).replies);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  useEffect(() => {
    setDraftStorageFailed(
      !saveCommentDrafts(draftKey, body, replyDrafts, bodyContent),
    );
  }, [draftKey, body, replyDrafts, bodyContent]);
  const reply = active ? replyDrafts[active]?.body || "" : "";
  function setReply(value: string, content?: CommentNode | null) {
    if (active)
      setReplyDrafts((prev) => ({
        ...prev,
        [active]: {
          id: prev[active]?.id || crypto.randomUUID(),
          body: value,
          content,
        },
      }));
  }
  const [editing, setEditing] = useState<{
      message: InlineMessage;
      body: string;
      content?: CommentNode | null;
    } | null>(null),
    [reaction, setReaction] = useState<string | null>(null),
    [deleting, setDeleting] = useState<InlineMessage | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const mounted = useRef(true),
    inflight = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (force = false) => {
      if (inflight.current && !force) return;
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(
          `/api/threads?page=${pageId}${rowId ? `&row=${rowId}` : ""}${active ? `&thread=${active}` : ""}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || t("Kommentare konnten nicht geladen werden.", "Comments could not be loaded."),
          );
        if (mounted.current && inflight.current === controller) {
          setThreads(data);
          setLoadedActive(active);
        }
      } catch (e) {
        if (
          mounted.current &&
          inflight.current === controller &&
          !controller.signal.aborted
        ) {
          setThreads([]);
          setError((e as Error).message);
        }
      } finally {
        clearTimeout(timeout);
        if (inflight.current === controller) inflight.current = null;
      }
    },
    [pageId, rowId, active],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const interval = setInterval(() => {
      if (navigator.onLine && !document.hidden) void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      inflight.current?.abort();
      clearInterval(interval);
    };
  }, [refresh]);
  useEffect(() => {
    if (editor) setCommentHighlights(editor, threads, open ? active : null);
  }, [editor, threads, active, open]);
  useEffect(() => {
    const navigate = () => {
      const target = parsePageLocation(location.hash);
      if (
        target?.pageId === pageId &&
        (target.rowId || undefined) === rowId &&
        target.threadId
      ) {
        linkedThread.current = target.threadId;
        scrolledThread.current = null;
        setActive(target.threadId);
        setOpen(true);
        setDraft(null);
        setEditing(null);
        setError("");
      } else if (linkedThread.current) {
        linkedThread.current = null;
        setOpen(false);
        setActive(null);
      }
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [pageId, rowId]);
  useEffect(() => {
    if (
      open &&
      active &&
      linkedThread.current === active &&
      loadedActive === active &&
      scrolledThread.current !== active
    ) {
      panel.current?.scrollIntoView({ block: "start" });
      scrolledThread.current = active;
    }
  }, [open, active, loadedActive]);
  function close() {
    setOpen(false);
    const target = parsePageLocation(location.hash);
    if (
      target?.pageId === pageId &&
      (target.rowId || undefined) === rowId &&
      target.threadId
    ) {
      linkedThread.current = null;
      history.replaceState(null, "", pageLocationHash({ pageId, rowId }));
    }
  }
  function begin() {
    if (!editor) return;
    try {
      const anchor = selectedCommentAnchor(editor, generation);
      setDraft({
        anchor,
        threadId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
      });
      setOpen(true);
      setActive(null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setOpen(true);
    }
  }
  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => {
    if (!editor) return;
    const create = () => beginRef.current(),
      show = (event: Event) => {
        setActive((event as CustomEvent<string>).detail);
        setOpen(true);
        setDraft(null);
      },
      update = () => setRevision((n) => n + 1);
    const dom = editor.view.dom;
    dom.addEventListener("comment-create", create);
    dom.addEventListener("comment-open", show);
    editor.on("transaction", update);
    return () => {
      dom.removeEventListener("comment-create", create);
      dom.removeEventListener("comment-open", show);
      editor.off("transaction", update);
    };
  }, [editor]);
  const thread = threads.find((t) => t.id === active);
  async function act(action: string, data: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api("/api/command", {
        action,
        pageId,
        rowId,
        threadId: active,
        ...data,
      });
      await refresh(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      void refresh(true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function navigate(id: string) {
    setActive(id);
    setDraft(null);
    setEditing(null);
    setError("");
  }
  function range(t: InlineThread) {
    const binding = editor && editorCommentBinding(editor);
    return binding ? commentRange(binding, t.anchor, generation) : null;
  }
  function goToText(t: InlineThread) {
    const r = range(t);
    if (r && editor) {
      const node = editor.state.doc.nodeAt(r.from),
        chain = editor.chain().focus();
      if (node?.isBlock && r.to === r.from + node.nodeSize)
        chain.setNodeSelection(r.from);
      else chain.setTextSelection(r);
      chain.scrollIntoView().run();
    }
  }
  // revision updates the availability of anchors when remote text changes.
  void revision;
  return (
    <>
      <div className="inline-comment-tools">
        <button
          className="button compact"
          onMouseDown={(e) => e.preventDefault()}
          onClick={begin}
          title={t("Auswahl oder aktuellen Block kommentieren (⌘/Strg+Alt+M)", "Comment on the selection or current block (⌘/Ctrl+Alt+M)")}
        >
          <ChatCircle /> {t("Text kommentieren", "Comment on text")}
        </button>
        <button
          className="text-button"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {t("Textkommentare (", "Text comments (")}{threads.filter((t) => !t.resolved).length})
        </button>
      </div>
      {open && (
        <section
          ref={panel}
          className="inline-comment-panel"
          aria-label={t("Textkommentare", "Text comments")}
        >
          <header>
            <h3>{t("Textkommentare", "Text comments")}</h3>
            <button
              className="icon-button"
              aria-label={t("Textkommentare schließen", "Close text comments")}
              onClick={close}
            >
              <X />
            </button>
          </header>
          {draftStorageFailed && (
            <p role="status">
              {t("Dein Entwurf bleibt im geöffneten Editor. Der Browser konnte ihn für einen Seitenwechsel nicht sichern.", "Your draft stays in the open editor. The browser could not keep it for a page change.")}
            </p>
          )}
          {error && (
            <p className="inline-comment-error" role="alert">
              {error}
            </p>
          )}
          {draft ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy || !body.trim()) return;
                setBusy(true);
                setError("");
                try {
                  await flushOpenDocuments();
                  if (
                    await act("thread.create", {
                      ...draft,
                      body,
                      content: bodyContent,
                    })
                  ) {
                    setActive(draft.threadId);
                    setDraft(null);
                    setBody("");
                    setBodyContent(null);
                  }
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <blockquote>
                {draft.anchor.quote.replaceAll("\uFFFC", "[Medienblock]")}
              </blockquote>
              <CommentComposer
                label={t("Kommentar zur Textstelle", "Comment on the passage")}
                pageId={pageId}
                rowId={rowId}
                body={body}
                content={bodyContent}
                autoFocus
                disabled={busy}
                onChange={(text, content) => {
                  setBody(text);
                  setBodyContent(content);
                }}
              />
              <div className="inline-comment-actions">
                <button
                  className="button primary"
                  disabled={busy || !body.trim()}
                >
                  {t("Kommentar senden", "Send comment")}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  {t("Abbrechen", "Cancel")}
                </button>
              </div>
              <p className="muted">
                {t("Die markierte Textstelle wird beim Speichern erneut geprüft. Bei Änderungen bleibt dein Entwurf erhalten.", "The marked passage is checked again when saving. If it changed, your draft is kept.")}
              </p>
            </form>
          ) : active && !thread ? (
            <p role="status">
              {loadedActive === active
                ? t("Dieser Kommentar ist nicht mehr verfügbar oder gehört zu einer anderen Seite.", "This comment is no longer available or belongs to another page.")
                : t("Thread wird geladen …", "Loading thread …")}
            </p>
          ) : thread && !thread.complete ? (
            <p role="status">{t("Thread wird geladen …", "Loading thread …")}</p>
          ) : thread ? (
            <>
              <button
                className="text-button"
                onClick={() => {
                  setActive(null);
                  setEditing(null);
                }}
              >
                {t("← Alle Textkommentare", "← All text comments")}
              </button>
              <blockquote>
                {thread.anchor.quote.replaceAll("\uFFFC", "[Medienblock]")}
              </blockquote>
              <div className="inline-comment-actions">
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${location.origin}/${pageLocationHash({ pageId, rowId, threadId: thread.id })}`,
                      );
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2500);
                    } catch {
                      setError(
                        t("Der Link konnte nicht kopiert werden. Bitte erlaube den Zugriff auf die Zwischenablage.", "The link could not be copied. Please allow access to the clipboard."),
                      );
                    }
                  }}
                >
                  <Link /> {copied ? t("Link kopiert", "Link copied") : t("Kommentarlink kopieren", "Copy comment link")}
                </button>
                <button
                  className="text-button"
                  disabled={!range(thread)}
                  onClick={() => goToText(thread)}
                >
                  {t("Zur Textstelle", "Go to passage")}
                </button>
                {!range(thread) && (
                  <span className="muted">{t("Textstelle nicht mehr verfügbar", "Passage no longer available")}</span>
                )}
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
                      {new Date(
                        m.created_at.replace(" ", "T") + "Z",
                      ).toLocaleString("de-DE")}
                      {m.edited_at && !m.deleted ? " · bearbeitet" : ""}
                      {m.author_id === null ? " · importiert" : ""}
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
                          onChange={(body, content) =>
                            setEditing({ ...editing, body, content })
                          }
                        />
                        <button
                          className="button"
                          disabled={busy || !editing.body.trim()}
                        >
                          {t("Änderung speichern", "Save change")}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setEditing(null)}
                        >
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
                        <button
                          className="icon-button"
                          aria-label={t("Emoji-Reaktion hinzufügen", "Add emoji reaction")}
                          disabled={busy}
                          onClick={() => setReaction(m.id)}
                        >
                          <Smiley />
                        </button>
                        {m.author_id === userId && (
                          <>
                            <button
                              className="icon-button"
                              aria-label={t("Kommentar bearbeiten", "Edit comment")}
                              disabled={busy}
                              onClick={() =>
                                setEditing({
                                  message: m,
                                  body: m.body,
                                  content: m.content,
                                })
                              }
                            >
                              <PencilSimple />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={t("Kommentar löschen", "Delete comment")}
                              disabled={busy}
                              onClick={() => setDeleting(m)}
                            >
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
                    if (busy || !reply.trim()) return;
                    if (
                      await act("thread.reply", {
                        messageId: replyDrafts[thread.id]?.id,
                        body: reply,
                        content: replyDrafts[thread.id]?.content,
                      })
                    ) {
                      setReply("");
                      setReplyDrafts((prev) => ({
                        ...prev,
                        [thread.id]: { id: crypto.randomUUID(), body: "" },
                      }));
                    }
                  }}
                >
                  <CommentComposer
                    key={thread.id}
                    label={t("Antwort", "Reply")}
                    pageId={pageId}
                    rowId={rowId}
                    body={reply}
                    content={replyDrafts[thread.id]?.content}
                    disabled={busy}
                    onChange={setReply}
                  />
                  <button
                    className="button primary"
                    disabled={busy || !reply.trim()}
                  >
                    {t("Antwort senden", "Send reply")}
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <label>
                {t("Anzeigen", "Show")}
                <Select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="open">{t("Offene Threads", "Open threads")}</option>
                  <option value="resolved">{t("Erledigte Threads", "Resolved threads")}</option>
                  <option value="all">{t("Alle Threads", "All threads")}</option>
                </Select>
              </label>
              {threads
                .filter(
                  (thread) =>
                    filter === "all" ||
                    (filter === "resolved" ? thread.resolved : !thread.resolved),
                )
                .map((thread) => (
                  <button
                    className="inline-thread-link"
                    key={thread.id}
                    onClick={() => navigate(thread.id)}
                  >
                    <blockquote>
                      {thread.anchor.quote.replaceAll("\uFFFC", "[Medienblock]")}
                    </blockquote>
                    <span>
                      {thread.messages.find((m) => !m.deleted)?.body ||
                        t("Kommentar gelöscht", "Comment deleted")}
                    </span>
                    <small>
                      {thread.messageCount} {t("Beiträge", "posts")}
                      {!range(thread) ? t(" · Textstelle nicht mehr verfügbar", " · passage no longer available") : ""}
                    </small>
                  </button>
                ))}
              {!threads.length && (
                <p className="muted">
                  {t("Wähle Text oder einen Block aus und klicke auf „Text kommentieren“.", "Select text or a block and click “Comment on text”.")}
                </p>
              )}
            </>
          )}
        </section>
      )}
      <Modal
        open={!!reaction}
        onClose={() => setReaction(null)}
        title={t("Emoji-Reaktion", "Emoji reaction")}
      >
        <EmojiPicker
          allowSymbols={false}
          onSelect={async (emoji) => {
            if (
              await act("thread.react", {
                messageId: reaction,
                emoji,
                active: true,
              })
            )
              setReaction(null);
          }}
        />
        {error && <p role="alert">{error}</p>}
      </Modal>
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t("Kommentar löschen", "Delete comment")}
      >
        <p>
          {t("Der Kommentar wird entfernt. Antworten bleiben im Thread erhalten.", "The comment is removed. Replies stay in the thread.")}
        </p>
        <button
          className="button danger"
          disabled={busy}
          onClick={async () => {
            if (
              deleting &&
              (await act("thread.deleteMessage", {
                messageId: deleting.id,
                version: deleting.version,
              }))
            )
              setDeleting(null);
          }}
        >
          {t("Kommentar endgültig löschen", "Delete comment permanently")}
        </button>
      </Modal>
    </>
  );
}
