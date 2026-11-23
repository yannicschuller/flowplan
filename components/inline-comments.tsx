"use client";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { serverMessage } from "@/lib/server-message";
import { useT } from "./i18n";
import { Select } from "./select";
import type { CommentNode } from "@/lib/comment-content";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ChatCircle, X, Plus } from "@phosphor-icons/react";
import { parsePageLocation, pageLocationHash } from "@/lib/page-location";
import { leaveTo } from "@/lib/history-nav";
import { api, Modal } from "./ui";
import EmojiPicker from "./emoji-picker";
import { readCommentDrafts, saveCommentDrafts } from "@/lib/comment-drafts";
import { flushOpenDocuments } from "@/lib/document-flush";
import { CommentQuote } from "./comment-quote";
import { BLOCK_MOVE_META } from "@/lib/document-blocks";
import { prefersReducedMotion } from "@/lib/motion";
import {
  editorCommentBinding,
  relocatedCommentAnchors,
  selectedCommentAnchor,
  setCommentHighlights,
} from "@/lib/inline-comment-plugin";
import { commentRange } from "@/lib/comment-positions";
import { liveOpenFor, THREADS_EVENT, threadsKey } from "@/lib/live-state";
import { useCommentMargin } from "@/lib/comment-margin-pref-client";
import { COMMENT_MARGIN_MIN_ROOM } from "@/lib/comment-margin-pref";
import { loadView } from "./view-fallback";
import type { ThreadEditing, ThreadReply } from "./inline-comment-thread";
import type {
  InlineThread,
  CommentAnchor,
  InlineMessage,
} from "@/lib/inline-comment-types";

// A thread, the new comment's form and the margin load with the first one
// shown, not with the document (#387).
const InlineCommentThread = dynamic(() => loadView(() => import("./inline-comment-thread")), { ssr: false });
const InlineCommentDraft = dynamic(
  () => loadView(() => import("./inline-comment-thread").then((m) => ({ default: m.InlineCommentDraft }))),
  { ssr: false },
);
const CommentMargin = dynamic(() => loadView(() => import("./comment-margin")), { ssr: false });

// Whether the page has room for the margin beside its text (#387): the
// page layout's width without side panels (the page comments, the AI
// summary), measured again when the window or a panel changes. Never in a
// dialog (a record opened as a dialog) – there the panel stays.
function useMarginRoom(editor: Editor | null) {
  const [room, setRoom] = useState(false);
  useLayoutEffect(() => {
    const dom = editor && !editor.isDestroyed ? editor.view.dom : null;
    const layout = dom?.closest<HTMLElement>(".page-layout");
    if (!dom || !layout || dom.closest(".modal") || typeof ResizeObserver === "undefined") {
      setRoom(false);
      return;
    }
    const measure = () => {
      let width = layout.clientWidth;
      for (const child of layout.children) if (!child.contains(dom)) width -= (child as HTMLElement).offsetWidth;
      setRoom(width >= COMMENT_MARGIN_MIN_ROOM);
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(layout);
    // A side panel opening or closing beside the page.
    const panels = new MutationObserver(measure);
    panels.observe(layout, { childList: true });
    return () => {
      resized.disconnect();
      panels.disconnect();
    };
  }, [editor]);
  return room;
}

export function InlineComments({
  editor,
  pageId,
  rowId,
  generation,
  userId,
  onMargin,
}: {
  editor: Editor | null;
  pageId: string;
  rowId?: string;
  generation: string;
  userId: string;
  // Whether the margin with open text comments is shown beside the text
  // (the editor makes room for it and the table of contents gives way).
  onMargin?: (shown: boolean) => void;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const panel = useRef<HTMLElement | null>(null);
  const linkedThread = useRef<string | null>(null);
  const scrolledThread = useRef<string | null>(null);
  // A highlight clicked while the panel is used: the panel's thread comes
  // into view (it opens below the document, often out of sight).
  const panelReveal = useRef<string | null>(null);
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
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
  const [replyDrafts, setReplyDrafts] = useState<Record<string, ThreadReply>>(
    () => readCommentDrafts(draftKey).replies,
  );
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  useEffect(() => {
    setDraftStorageFailed(
      !saveCommentDrafts(draftKey, body, replyDrafts, bodyContent),
    );
  }, [draftKey, body, replyDrafts, bodyContent]);
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
  const [editing, setEditing] = useState<ThreadEditing | null>(null),
    [reaction, setReaction] = useState<string | null>(null),
    [deleting, setDeleting] = useState<InlineMessage | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hint, setHint] = useState(false),
    [revision, setRevision] = useState(0);
  // Text comments in the margin (#387): the person's setting and the room.
  const marginPref = useCommentMargin();
  const room = useMarginRoom(editor);
  const marginMode = marginPref && room;
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
            serverMessage(data.error) || t("Kommentare konnten nicht geladen werden.", "Comments could not be loaded."),
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
    // With the document's live channel open, a written thread arrives as a
    // signal; then only a full check every minute, else every 5 s.
    let last = Date.now();
    const interval = setInterval(() => {
      if (!navigator.onLine || document.hidden) return;
      if (liveOpenFor(pageId, rowId) && Date.now() - last < 60_000) return;
      last = Date.now();
      void refresh();
    }, 5000);
    const signal = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== threadsKey(pageId, rowId)) return;
      last = Date.now();
      void refresh(true);
    };
    window.addEventListener(THREADS_EVENT, signal);
    return () => {
      mounted.current = false;
      inflight.current?.abort();
      clearInterval(interval);
      window.removeEventListener(THREADS_EVENT, signal);
    };
  }, [refresh, pageId, rowId]);
  // The passages: in the margin the active one (or the new comment's
  // passage) is highlighted more strongly while its card is open; in the
  // panel while the panel shows its thread.
  useEffect(() => {
    if (!editor) return;
    if (marginMode && draft)
      setCommentHighlights(
        editor,
        [...threads, { id: draft.threadId, anchor: draft.anchor, resolved: 0 } as InlineThread],
        draft.threadId,
      );
    else setCommentHighlights(editor, threads, marginMode || open ? active : null);
  }, [editor, threads, active, open, marginMode, draft]);
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
  function range(t: InlineThread) {
    const binding = editor && editorCommentBinding(editor);
    return binding ? commentRange(binding, t.anchor, generation) : null;
  }
  // The open threads beside the text, in the order of their passages.
  const marginThreads: InlineThread[] = [];
  const positions = new Map<string, number>();
  if (marginMode)
    for (const thread of threads) {
      if (thread.resolved) continue;
      const r = range(thread);
      if (!r) continue;
      positions.set(thread.id, r.from);
      marginThreads.push(thread);
    }
  marginThreads.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  const inMargin = (id: string | null) => !!id && positions.has(id);
  const marginDraft = (() => {
    if (!marginMode || !draft) return null;
    const binding = editor && editorCommentBinding(editor);
    const from = binding ? commentRange(binding, draft.anchor, generation)?.from : undefined;
    // A passage that cannot be placed: the form stays in the panel.
    if (from === undefined) return null;
    return { id: draft.threadId, index: marginThreads.filter((t) => positions.get(t.id)! < from).length };
  })();
  const draftInPanel = !!draft && !marginDraft;
  useEffect(() => {
    if (draftInPanel) setOpen(true);
  }, [draftInPanel]);
  const marginShown = marginThreads.length > 0 || !!marginDraft;
  const onMarginRef = useRef(onMargin);
  onMarginRef.current = onMargin;
  useEffect(() => {
    onMarginRef.current?.(marginShown);
  }, [marginShown]);
  useEffect(() => () => onMarginRef.current?.(false), []);
  const marginIds = marginThreads.map((thread) => thread.id).join(",");
  // A link to a thread (notifications, "Copy comment link"): its card in
  // the margin, or the panel scrolled to it.
  useEffect(() => {
    if (
      !active ||
      linkedThread.current !== active ||
      loadedActive !== active ||
      scrolledThread.current === active
    )
      return;
    if (marginMode && marginIds.split(",").includes(active)) {
      scrolledThread.current = active;
      setOpen(false);
      setReveal((r) => ({ id: active, n: (r?.n || 0) + 1 }));
    } else if (!open) setOpen(true);
    else if (panel.current) {
      panel.current.scrollIntoView({ block: "start" });
      scrolledThread.current = active;
    }
  }, [open, active, loadedActive, marginMode, marginIds]);
  // A highlight clicked while the panel is used: its thread into view.
  useEffect(() => {
    if (!open || !active || panelReveal.current !== active || !panel.current) return;
    panelReveal.current = null;
    const box = panel.current.getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight - 160)
      panel.current.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [open, active]);
  // The X and the panel button close the whole panel: list, thread and
  // new comment (its text stays as a draft, lib/comment-drafts.ts).
  function close() {
    setOpen(false);
    setDraft(null);
    setActive(null);
    setEditing(null);
    setHint(false);
    setError("");
    const target = parsePageLocation(location.hash);
    if (
      target?.pageId === pageId &&
      (target.rowId || undefined) === rowId &&
      target.threadId
    ) {
      linkedThread.current = null;
      // Back to the entry the thread was opened from, or in place (lib/history-nav.ts).
      leaveTo(pageLocationHash({ pageId, rowId }), "replace");
    }
  }
  // A new comment on the selection; `blockFallback` (shortcut, toolbar and
  // text menu) takes the current block when nothing is selected, the
  // panel's "New" asks for a selection instead. With the margin the form
  // opens beside the passage.
  function begin(blockFallback = true) {
    if (!editor) return;
    setHint(false);
    if (!blockFallback && editor.state.selection.empty) {
      setDraft(null);
      setActive(null);
      setError("");
      setHint(true);
      setOpen(true);
      return;
    }
    try {
      const anchor = selectedCommentAnchor(editor, generation);
      setDraft({
        anchor,
        threadId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
      });
      if (!marginMode) setOpen(true);
      setActive(null);
      setEditing(null);
      setError("");
    } catch (e) {
      // The anchor is checked in the browser, with the server's German texts.
      setError(serverMessage((e as Error).message));
      setOpen(true);
    }
  }
  // Blocks moved up, down or by dragging take their comments along (#314):
  // Yjs inserts a moved block anew, so the passage gets a fresh anchor,
  // here at once and on the server (thread.reanchor).
  function relocate(transaction: Transaction) {
    if (!editor) return;
    let moved = relocatedCommentAnchors(editor, transaction, generation);
    // The new comment's passage (highlighted in the margin) moves along
    // with its form; it has no thread on the server yet.
    const own = draft && moved.find((m) => m.id === draft.threadId);
    if (own && draft) {
      setDraft({ ...draft, anchor: { ...own.anchor, quote: draft.anchor.quote } });
      moved = moved.filter((m) => m !== own);
    }
    if (!moved.length) {
      // Highlights left by the structural change come back.
      if (transaction.docChanged && transaction.getMeta(BLOCK_MOVE_META))
        setThreads((prev) => [...prev]);
      return;
    }
    const anchors = new Map(moved.map((m) => [m.id, m.anchor]));
    setThreads((prev) =>
      prev.map((t) => {
        const anchor = anchors.get(t.id);
        // The list shows a shortened quote; the stored one stays whole.
        return anchor ? { ...t, anchor: { ...anchor, quote: t.anchor.quote } } : t;
      }),
    );
    void (async () => {
      try {
        await flushOpenDocuments();
        for (const m of moved)
          await api("/api/command", {
            action: "thread.reanchor",
            pageId,
            rowId,
            threadId: m.id,
            anchor: m.anchor,
          });
      } catch {
        // The next refresh shows what the server kept.
      }
      void refresh(true);
    })();
  }
  const relocateRef = useRef(relocate);
  relocateRef.current = relocate;
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const showRef = useRef((id: string) => void id);
  showRef.current = (id: string) => {
    // The new comment's own highlight.
    if (draft && id === draft.threadId) return;
    setActive(id);
    setDraft(null);
    setHint(false);
    setEditing(null);
    if (marginMode && inMargin(id)) return;
    setOpen(true);
    panelReveal.current = id;
  };
  useEffect(() => {
    if (!editor) return;
    const create = () => beginRef.current(true),
      show = (event: Event) => showRef.current((event as CustomEvent<string>).detail),
      update = ({ transaction }: { transaction: Transaction }) => {
        setRevision((n) => n + 1);
        relocateRef.current(transaction);
      };
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
  // From the panel's list: a thread with a card in the margin opens there.
  function navigate(id: string) {
    setActive(id);
    setDraft(null);
    setEditing(null);
    setError("");
    if (inMargin(id)) setReveal((r) => ({ id, n: (r?.n || 0) + 1 }));
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
  async function submitDraft() {
    if (!draft || busy || !body.trim()) return;
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
  }
  const errorLine = error && (
    <p className="inline-comment-error" role="alert">
      {error}
    </p>
  );
  const renderDraft = (compact: boolean) =>
    draft && (
      <InlineCommentDraft
        quote={draft.anchor.quote}
        pageId={pageId}
        rowId={rowId}
        body={body}
        content={bodyContent}
        busy={busy}
        compact={compact}
        onChange={(text, content) => {
          setBody(text);
          setBodyContent(content);
        }}
        onSubmit={() => void submitDraft()}
        onCancel={() => setDraft(null)}
      />
    );
  const renderThread = (shown: InlineThread, compact: boolean) => (
    <InlineCommentThread
      thread={shown}
      pageId={pageId}
      rowId={rowId}
      userId={userId}
      busy={busy}
      act={async (action, data) => {
        const ok = await act(action, data);
        // A resolved thread leaves the margin; its card closes.
        if (ok && compact && action === "thread.resolve" && data.resolved) setActive(null);
        return ok;
      }}
      editing={editing}
      setEditing={setEditing}
      reply={replyDrafts[shown.id]}
      onReply={setReply}
      onReplySent={() =>
        setReplyDrafts((prev) => ({
          ...prev,
          [shown.id]: { id: crypto.randomUUID(), body: "" },
        }))
      }
      onReact={setReaction}
      onDelete={setDeleting}
      onError={setError}
      passage={!!range(shown)}
      onGoToText={() => goToText(shown)}
      onBack={
        compact
          ? undefined
          : () => {
              setActive(null);
              setEditing(null);
            }
      }
      compact={compact}
    />
  );
  // The panel shows the threads without a card: resolved ones, those whose
  // passage is gone, all of them below the document.
  const panelThread = thread && !inMargin(thread.id) ? thread : undefined;
  const marginActive = inMargin(active);
  // revision updates the availability of anchors when remote text changes.
  void revision;
  return (
    <>
      {/* One button, one panel (#314): the threads, and "New" in the
          panel for a comment on the selection. */}
      <div className="inline-comment-tools">
        <button
          className="button compact"
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <ChatCircle /> {t("Textkommentare (", "Text comments (")}{threads.filter((t) => !t.resolved).length})
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
            <span className="inline-comment-header-actions">
              <button
                className="button compact"
                aria-label={t("Neuer Textkommentar", "New text comment")}
                aria-expanded={!!draft}
                title={t("Markierte Textstelle oder markierten Block kommentieren", "Comment on the selected passage or block") + keyHints.suffix("Mod+Alt+M")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => begin(false)}
              >
                <Plus /> {t("Neu", "New")}
              </button>
              <button
                className="icon-button"
                aria-label={t("Textkommentare schließen", "Close text comments")}
                onClick={close}
              >
                <X />
              </button>
            </span>
          </header>
          {hint && (
            <p className="inline-comment-hint" role="status">
              {t("Markiere zuerst im Text die Stelle oder den Block, den du kommentieren willst, und klicke dann auf „Neu“.", "First select the passage or block you want to comment on, then click “New”.")}
            </p>
          )}
          {draftStorageFailed && (
            <p role="status">
              {t("Dein Entwurf bleibt im geöffneten Editor. Der Browser konnte ihn für einen Seitenwechsel nicht sichern.", "Your draft stays in the open editor. The browser could not keep it for a page change.")}
            </p>
          )}
          {/* With the margin, the open card shows its own errors. */}
          {!(marginMode && (marginDraft || marginActive)) && errorLine}
          {draftInPanel && renderDraft(false)}
          {active && !thread ? (
            <p role="status">
              {loadedActive === active
                ? t("Dieser Kommentar ist nicht mehr verfügbar oder gehört zu einer anderen Seite.", "This comment is no longer available or belongs to another page.")
                : t("Thread wird geladen …", "Loading thread …")}
            </p>
          ) : panelThread && !panelThread.complete ? (
            <p role="status">{t("Thread wird geladen …", "Loading thread …")}</p>
          ) : panelThread ? (
            renderThread(panelThread, false)
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
                    aria-current={thread.id === active ? "true" : undefined}
                    onClick={() => navigate(thread.id)}
                  >
                    <blockquote>
                      <CommentQuote quote={thread.anchor.quote} />
                    </blockquote>
                    <span>
                      {thread.messages.find((m) => !m.deleted)?.body ||
                        t("Kommentar gelöscht", "Comment deleted")}
                    </span>
                    <small>
                      {thread.messageCount === 1 ? t("1 Beitrag", "1 post") : t(`${thread.messageCount} Beiträge`, `${thread.messageCount} posts`)}
                      {!range(thread) ? t(" · Textstelle nicht mehr verfügbar", " · passage no longer available") : ""}
                    </small>
                  </button>
                ))}
              {!threads.length && !draft && !hint && (
                <p className="muted">
                  {t("Noch keine Textkommentare. Markiere Text oder einen Block und klicke auf „Neu“.", "No text comments yet. Select text or a block and click “New”.")}
                </p>
              )}
            </>
          )}
        </section>
      )}
      {editor && marginShown && (
        <CommentMargin
          editor={editor}
          threads={marginThreads}
          active={marginActive ? active : null}
          draft={marginDraft}
          reveal={reveal}
          onActivate={(id) => {
            setActive(id);
            setEditing(null);
            setError("");
            if (id) setDraft(null);
          }}
          renderDraft={() => (
            <>
              {errorLine}
              {renderDraft(true)}
            </>
          )}
          renderThread={(shown) =>
            shown.complete ? (
              <>
                {errorLine}
                {renderThread(shown, true)}
              </>
            ) : (
              <p role="status">{t("Thread wird geladen …", "Loading thread …")}</p>
            )
          }
        />
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
