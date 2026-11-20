"use client";
// "KI fragen": questions about the workspace, answered with numbered sources
// (lib/ai/ask.ts). A panel docked on the right of the workspace (from 1100 px,
// components/workspace-app.tsx puts it into the app shell's grid, so the page
// narrows instead of being covered; the page's layout follows the room it
// has left, app/globals.css "@container main"), lying over the page on
// narrower windows until it is pinned ("Anheften", lib/ask-panel.ts), or a
// bottom sheet on phones that is swiped down to a small pill. It is no
// dialog: the page stays usable, the answer keeps streaming while the
// person scrolls, writes or opens other pages, and closing only hides it. The conversation is kept in this browser
// tab only (sessionStorage) – the server stores none of it.
// "Diese Seite" (#135): with a page open, the chip above the question is on
// and the page goes along in full (the server checks that the person and the
// AI may read it). Under such an answer, people who may edit the page can
// put it in as suggested changes ("Als Änderungsvorschlag einfügen",
// lib/ai/page-edit.ts) – accepted or rejected one by one in the document.
// The layout ("Chat mit Vorschlägen"): a quiet header, before the first
// question a greeting with a few questions that fit what is open
// (lib/ai/ask-suggestions.ts), the conversation as chat, and at the bottom
// one composer box with the question, where to look, the model and send.
import { AiQuotaNote } from "./ai-quota";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowClockwise, ArrowSquareOut, ArrowUp, CalendarCheck, CaretDown, Check, Copy, FileText, Info, Lifebuoy, ListBullets, ListChecks, MagnifyingGlass, PencilLine, Plus, PushPin, PushPinSlash, Sparkle, Stop, Warning, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { PageIcon } from "./ui";
import { Select } from "./select";
import { AiActionsPanel, type AiActionsRequest } from "./ai-actions";
import { AiMarkdown } from "./ai-markdown";
import { SidebarResize } from "./sidebar-resize";
import { SHEET_HANDLE, useSheetDrag } from "./sheet-drag";
import { useMedia } from "./use-media";
import { addBackCloser } from "@/lib/app-back";
import { ASK_DEFAULT, ASK_MIN, ASK_OVERLAY_MEDIA, ASK_SHEET_BELOW, askMax, clampAsk } from "@/lib/ask-panel";
import { askAi, aiPageReadable, aiUsable, citationParts, helpSourceUrl, splitSources, suggestPageChanges, type AskScope, type AskSource } from "@/lib/ai/client";
import { AI_PROVIDER_NAMES, AI_PROVIDER_NAMES_EN, type AiStatus } from "@/lib/ai/features";
import { askSuggestions, firstName, modelDisplayName, recentAskPages, type AskSuggestion } from "@/lib/ai/ask-suggestions";
import type { Page, Space } from "@/lib/types";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: AskSource[];
  error?: boolean;
  streaming?: boolean;
  // "Diese Seite": the page that went along with the question (cut to fit: truncated).
  page?: { id: string; title: string; truncated?: boolean };
  // "Als Änderungsvorschlag einfügen": running, or what came of it.
  suggest?: { busy?: boolean; text?: string; error?: boolean };
};
// The open page as the panel knows it.
export type AskCurrentPage = { id: string; title: string; kind?: string; editable?: boolean; encrypted?: boolean; hasDate?: boolean };
type Stored = { messages: Message[]; scope: string; across?: boolean };
const storageKey = (workspaceId: string) => `flowplan-ask:${workspaceId}`;
const MAX_TURNS = 20;

// Up to this width the panel is a bottom sheet (the phone layout of
// app/globals.css). Its width on wider screens: lib/ask-panel.ts.
export const ASK_SHEET_MEDIA = `(max-width: ${ASK_SHEET_BELOW - 1}px)`;
// A request to open: `n` changes with every request, `question` fills the
// field when it is not empty.
export type AskRequest = { question: string; n: number };

function load(workspaceId: string): Stored {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(workspaceId)) || "null");
    if (raw && Array.isArray(raw.messages))
      return { messages: raw.messages.filter((m: Message) => !m.streaming), scope: String(raw.scope || "workspace"), across: !!raw.across };
  } catch {}
  return { messages: [], scope: "workspace", across: false };
}
function save(workspaceId: string, stored: Stored) {
  try {
    sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(stored));
  } catch {}
}

// The window's width (0 before the first measurement), for the panel's
// limits: at most 45 % of it.
function useViewportWidth() {
  // The panel mounts in the browser only (with the first opening).
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : document.documentElement.clientWidth || window.innerWidth));
  useEffect(() => {
    const update = () => setWidth(document.documentElement.clientWidth || window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

export { useMedia };

export function AskPanel({
  open,
  hidden = false,
  request,
  onClose,
  workspaceId,
  ai,
  spaces,
  currentPage,
  onOpenSource,
  width,
  onWidth,
  pinned,
  onPinned,
  userName = "",
  pages = [],
  recentVisits = [],
}: {
  // Shown: the person opened it and has not closed it.
  open: boolean;
  // Out of sight for a while (focus mode); the conversation goes on.
  hidden?: boolean;
  request: AskRequest | null;
  onClose: () => void;
  workspaceId: string;
  ai: AiStatus | undefined;
  spaces: Space[];
  currentPage: AskCurrentPage | null;
  onOpenSource: (pageId: string, rowId?: string) => void;
  // The dragged width (null: the default); shown within the limits of the
  // window (lib/ask-panel.ts).
  width: number | null;
  onWidth: (width: number | null) => void;
  // Narrow windows: docked beside the page instead of over it.
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  // For the greeting and the suggestions before the first question.
  userName?: string;
  pages?: Page[];
  recentVisits?: { pageId: string; seenAt: number }[];
}) {
  const t = useT();
  const headingId = useId();
  const [messages, setMessages] = useState<Message[]>([]);
  const [scope, setScope] = useState("workspace");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  // "Alle Arbeitsbereiche": the question goes to every workspace of the person.
  const [across, setAcross] = useState(false);
  const [actions, setActions] = useState<AiActionsRequest | null>(null);
  // The workspace whose conversation is loaded (nothing is saved before).
  const [loaded, setLoaded] = useState<string | null>(null);
  // Phones: the sheet swiped down to a pill; the answer goes on.
  const [minimised, setMinimised] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  // "Diese Seite": on whenever a page is opened.
  const [withPage, setWithPage] = useState(true);
  useEffect(() => setWithPage(true), [currentPage?.id]);
  const sheet = useMedia(ASK_SHEET_MEDIA);
  // Narrow windows: over the page unless pinned – the pin is offered there.
  const narrowWindow = useMedia(ASK_OVERLAY_MEDIA);
  const viewport = useViewportWidth();
  const shown = open && !hidden;
  const visible = shown && !(sheet && minimised);
  const controller = useRef<AbortController | null>(null);
  // Answers for a conversation that was replaced (another workspace) are dropped.
  const generation = useRef(0);
  const panel = useRef<HTMLElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const panelRef = useCallback((node: HTMLElement | null) => {
    panel.current = node;
    setPanelElement(node);
  }, []);
  const log = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  // Follows the newest text unless the person scrolled up to read.
  const stick = useRef(true);
  // Where focus was before the panel took it, for when it closes.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    controller.current?.abort();
    generation.current++;
    const stored = load(workspaceId);
    setMessages(stored.messages);
    setAcross(!!stored.across);
    setScope(stored.scope.startsWith("page:") && stored.scope !== `page:${currentPage?.id}` ? "workspace" : stored.scope);
    setLoaded(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  useEffect(() => {
    if (loaded === workspaceId) save(workspaceId, { messages: messages.filter((m) => !m.streaming), scope, across });
  }, [messages, scope, across, loaded, workspaceId]);
  // A page scope only makes sense while that page is open.
  useEffect(() => {
    setScope((s) => (s.startsWith("page:") && s !== `page:${currentPage?.id}` ? "workspace" : s));
  }, [currentPage?.id]);
  useEffect(() => () => controller.current?.abort(), []);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && visible && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, visible]);
  // Every request to open: the sheet comes up, the question (if any) is in
  // the field and focus moves into the panel.
  useEffect(() => {
    if (!request) return;
    setMinimised(false);
    if (request.question) setQuestion(request.question);
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !panel.current?.contains(active)) returnTo.current = active;
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n]);
  // Closed or hidden with focus inside: focus goes back where it came from.
  useLayoutEffect(() => {
    if (visible || !panel.current) return;
    const active = document.activeElement;
    if (!(active === document.body || panel.current.contains(active))) return;
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected && back.getClientRects().length) back.focus({ preventScroll: true });
    else document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [visible]);
  // Phones: the sheet follows the finger down and becomes the pill; "back"
  // does the same.
  useSheetDrag(panelElement, sheet && visible, { onDismiss: () => setMinimised(true), media: ASK_SHEET_MEDIA });
  useEffect(() => (sheet && visible ? addBackCloser(() => setMinimised(true)) : undefined), [sheet, visible]);
  // Phones: the sheet fills what the on-screen keyboard leaves visible, so
  // the question field stays right above the keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!sheet || !visible || !vv) return;
    const root = document.documentElement;
    let tallest = vv.height;
    const update = () => {
      tallest = Math.max(tallest, vv.height);
      root.style.setProperty("--ask-vv-top", `${vv.offsetTop}px`);
      root.style.setProperty("--ask-vv-height", `${vv.height}px`);
      root.classList.toggle("ask-keyboard", vv.height < tallest * 0.8);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--ask-vv-top");
      root.style.removeProperty("--ask-vv-height");
      root.classList.remove("ask-keyboard");
    };
  }, [sheet, visible]);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  // Where to look and whether the open page goes along – the state, or what
  // a suggestion asks for (it sets both before it sends).
  type Target = { scope: string; across: boolean; withPage: boolean };
  const scopeOf = ({ scope, across }: Target): AskScope =>
    across
      ? { kind: "all" }
      : scope === "help"
        ? { kind: "help" }
        : scope.startsWith("page:") ? { kind: "page", pageId: scope.slice(5) } : scope.startsWith("space:") ? { kind: "space", spaceId: scope.slice(6) } : { kind: "workspace" };

  // The open page can go along: a document or database the AI may read,
  // not in an end-to-end encrypted space, not for help-only or every workspace.
  const pageReadable = !!currentPage && !currentPage.encrypted && ["document", "database", undefined].includes(currentPage.kind) && aiPageReadable(ai, currentPage.id);
  const offeredFor = (target: Target) => pageReadable && !target.across && target.scope !== "help";
  const pageOffered = offeredFor({ scope, across, withPage });
  const attached = pageOffered && withPage ? currentPage : null;

  // `before`: the conversation to continue (a retry leaves out the failed turn).
  async function send(text = question.trim(), before = messages, target: Target = { scope, across, withPage }) {
    if (!text || busy) return;
    const going = offeredFor(target) && target.withPage ? currentPage : null;
    const page = going ? { id: going.id, title: going.title } : undefined;
    const history = before.filter((m) => !m.error && !m.streaming).map((m) => ({ role: m.role, content: m.content }));
    if (text === question.trim()) setQuestion("");
    setBusy(true);
    stick.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const mine = generation.current;
    setMessages([...before.slice(-(MAX_TURNS * 2 - 2)), { role: "user", content: text }, { role: "assistant", content: "", streaming: true, ...(page ? { page } : {}) }]);
    const update = (patch: Partial<Message>) => {
      if (generation.current !== mine) return;
      setMessages((list) => {
        const next = [...list];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });
    };
    try {
      const result = await askAi({
        workspaceId,
        question: text,
        history,
        scope: scopeOf(target),
        ...(page ? { page: { pageId: page.id } } : {}),
        signal: abort.signal,
        onSources: (sources) => update({ sources }),
        onText: (_piece, all) => update({ content: all }),
      });
      update({ content: result.text, sources: result.sources, streaming: false, ...(page ? { page: { ...page, truncated: result.page === "truncated" } } : {}) });
    } catch (error) {
      if ((error as Error).name === "AbortError") update({ streaming: false, content: t("Abgebrochen.", "Stopped."), error: true });
      else update({ streaming: false, content: (error as Error).message, error: true });
    } finally {
      if (controller.current === abort) {
        setBusy(false);
        controller.current = null;
      }
    }
  }
  // The conversation up to answer `i` as suggested changes in its page.
  async function suggest(i: number) {
    const answer = messages[i];
    if (!answer?.page || answer.suggest?.busy) return;
    const patch = (value: Message["suggest"]) => setMessages((list) => list.map((m, j) => (j === i ? { ...m, suggest: value } : m)));
    patch({ busy: true });
    try {
      const history = messages
        .slice(0, i + 1)
        .filter((m) => !m.error && !m.streaming && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));
      const result = await suggestPageChanges({ workspaceId, pageId: answer.page.id, history });
      const notApplied = result.failed
        ? result.failed === 1
          ? t(" 1 Änderung ließ sich nicht anwenden.", " 1 change could not be applied.")
          : t(` ${result.failed} Änderungen ließen sich nicht anwenden.`, ` ${result.failed} changes could not be applied.`)
        : "";
      const text = !result.proposed
        ? t("Die KI hat keine Änderung an dieser Seite vorgeschlagen.", "The AI did not propose any change to this page.")
        : !result.applied
          ? t(
              "Die Änderungen ließen sich nicht anwenden – die Seite hat sich inzwischen geändert oder die Stellen gibt es nicht mehr. Bitte erneut versuchen.",
              "The changes could not be applied – the page has changed in the meantime or those parts no longer exist. Please try again.",
            )
          : (result.applied === 1
              ? t("1 Änderungsvorschlag ist in der Seite – dort annehmen oder ablehnen.", "1 suggested change is in the page – accept or reject it there.")
              : t(`${result.applied} Änderungsvorschläge sind in der Seite – dort einzeln annehmen oder ablehnen.`, `${result.applied} suggested changes are in the page – accept or reject each there.`)) + notApplied;
      patch({ text, error: !result.applied });
    } catch (error) {
      patch({ text: (error as Error).message, error: true });
    }
  }
  // The last question once more, without the failed answer.
  const retry = () => {
    const asked = messages[messages.length - 2];
    if (busy || asked?.role !== "user") return;
    void send(asked.content, messages.slice(0, -2));
  };

  // Before the first question: a few that fit what is open and what the
  // person looked at last (no request, lib/ai/ask-suggestions.ts).
  const recent = useMemo(
    () => (messages.length ? [] : recentAskPages(pages, recentVisits, { exclude: currentPage?.id, readable: (id) => aiPageReadable(ai, id) })),
    [messages.length, pages, recentVisits, currentPage?.id, ai],
  );
  const suggestions = messages.length
    ? []
    : askSuggestions({
        page: pageReadable && currentPage ? { id: currentPage.id, title: currentPage.title, kind: currentPage.kind, hasDate: currentPage.hasDate } : null,
        recent,
        help: true,
      });
  const suggestionText = (s: AskSuggestion) =>
    s.kind === "summarize"
      ? t(`Fasse „${s.title}“ zusammen`, `Summarise “${s.title}”`)
      : s.kind === "due"
        ? t("Was ist diese Woche fällig?", "What is due this week?")
        : s.kind === "recent"
          ? t(`Was steht in „${s.title}“?`, `What is in “${s.title}”?`)
          : t("Wie teile ich eine Seite öffentlich?", "How do I share a page publicly?");
  // A suggestion is sent right away, looking where it belongs: the open page
  // (and it goes along) for summaries and due dates, the help for the help
  // question, the whole workspace for a page looked at recently.
  const sendSuggestion = (s: AskSuggestion) => {
    const target: Target =
      s.kind === "help"
        ? { scope: "help", across: false, withPage }
        : s.kind === "recent"
          ? { scope: "workspace", across: false, withPage: false }
          : { scope: `page:${s.pageId}`, across: false, withPage: true };
    setScope(target.scope);
    setAcross(false);
    setWithPage(target.withPage);
    void send(suggestionText(s), messages, target);
    field.current?.focus({ preventScroll: true });
  };

  // The question field grows with its text up to a limit (CSS), then scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.removeProperty("--ask-field-height");
    el.style.setProperty("--ask-field-height", `${el.scrollHeight}px`);
  }, [question, visible]);

  // Pages and records open in the main area – the panel stays (on phones the
  // sheet makes room); help sections on docs.flowplan.org.
  const openPage = (pageId: string, rowId?: string) => {
    if (sheet) setMinimised(true);
    onOpenSource(pageId, rowId);
  };
  const openSource = (s: AskSource) => {
    const url = helpSourceUrl(s);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else if (s.pageId) openPage(s.pageId, s.rowId);
  };
  const provider = ai?.provider;
  const last = messages[messages.length - 1];
  const name = firstName(userName);
  return (
    <>
      <aside
        ref={panelRef}
        className="ai-ask ask-panel"
        aria-labelledby={headingId}
        hidden={!visible}
        onKeyDown={(e) => {
          // Escape closes – only for keys pressed in the panel itself (not in
          // a dialog it opened, whose events also come through React).
          if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing || !e.currentTarget.contains(e.target as Node)) return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <div className={SHEET_HANDLE} aria-hidden />
        <SidebarResize
          edge="start"
          width={clampAsk(width, viewport)}
          onWidth={onWidth}
          min={ASK_MIN}
          max={askMax(viewport)}
          fallback={ASK_DEFAULT}
          label={t("Breite von „KI fragen“", "Width of “Ask AI”")}
          hint={t("Ziehen zum Ändern, Doppelklick setzt zurück", "Drag to resize, double-click to reset")}
        />
        <header className="ask-panel-head">
          <Sparkle size={16} weight="fill" aria-hidden="true" className="ask-panel-icon" />
          <h2 id={headingId}>{t("KI fragen", "Ask AI")}</h2>
          {!!messages.length && (
            <button
              type="button"
              className="ask-panel-new"
              aria-label={t("Neues Gespräch", "New conversation")}
              title={t("Neues Gespräch", "New conversation")}
              disabled={busy}
              onClick={() => {
                setMessages([]);
                setQuestion("");
                field.current?.focus();
              }}
            >
              <Plus size={14} weight="bold" aria-hidden="true" />
              <span>{t("Neu", "New")}</span>
            </button>
          )}
          {narrowWindow && (
            <button
              type="button"
              className={`icon-button ask-panel-pin${pinned ? " active" : ""}`}
              aria-label={t("Anheften", "Pin")}
              aria-pressed={pinned}
              title={
                pinned
                  ? t("Lösen – wieder über der Seite zeigen", "Unpin – show over the page again")
                  : t("Anheften – neben der Seite zeigen", "Pin – show beside the page")
              }
              onClick={() => onPinned(!pinned)}
            >
              {pinned ? <PushPinSlash size={16} /> : <PushPin size={16} />}
            </button>
          )}
          {sheet && (
            <button type="button" className="icon-button" aria-label={t("Verkleinern", "Minimise")} title={t("Verkleinern – die Antwort läuft weiter", "Minimise – the answer keeps going")} onClick={() => setMinimised(true)}>
              <CaretDown size={17} />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("„KI fragen“ schließen", "Close “Ask AI”")} title={t("Schließen", "Close")} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        {provider?.source === "instance" && <AiQuotaNote />}
        <div
          className="ai-ask-log"
          aria-live="polite"
          aria-busy={busy}
          ref={log}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {!messages.length && (
            <div className="ai-ask-empty">
              <h3 className="ai-ask-greeting">{name ? t(`Hallo ${name}`, `Hi ${name}`) : t("Hallo", "Hi")}</h3>
              <p className="ai-ask-lead">{t("Was möchtest du wissen?", "What would you like to know?")}</p>
              <p className="ai-ask-hint">
                {t(
                  "Frag nach Inhalten deiner Seiten und Datenbanken – oder wie etwas in Flowplan geht. Antworten nennen ihre Quellen.",
                  "Ask about the content of your pages and databases – or how something works in Flowplan. Answers name their sources.",
                )}
              </p>
              {!!suggestions.length && (
                <ul className="ai-ask-suggestions" aria-label={t("Vorschläge", "Suggestions")}>
                  {suggestions.map((s) => (
                    <li key={`${s.kind}:${"pageId" in s ? s.pageId : ""}`}>
                      <button type="button" className="ai-ask-suggestion" disabled={busy} onClick={() => sendSuggestion(s)}>
                        <span className="ai-ask-suggestion-icon" aria-hidden="true">
                          {s.kind === "summarize" ? <ListBullets size={15} /> : s.kind === "due" ? <CalendarCheck size={15} /> : s.kind === "recent" ? <FileText size={15} /> : <Lifebuoy size={15} />}
                        </span>
                        <span className="ai-ask-suggestion-text">{suggestionText(s)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ai-ask-question">
                {m.content}
              </div>
            ) : (
              <div key={i} className={`ai-ask-answer${m.streaming ? " streaming" : ""}${m.error ? " failed" : ""}`}>
                {m.streaming && !m.content ? (
                  <p className="ai-ask-thinking">{t("Sucht im Arbeitsbereich …", "Searching the workspace …")}</p>
                ) : m.error ? (
                  <div className="ai-ask-error" role="alert">
                    <Warning size={16} aria-hidden="true" />
                    <p>{m.content}</p>
                    {i === messages.length - 1 && !busy && (
                      <button type="button" className="button compact" onClick={retry}>
                        <ArrowClockwise size={14} aria-hidden="true" /> {t("Erneut versuchen", "Try again")}
                      </button>
                    )}
                  </div>
                ) : (
                  <AnswerText text={m.content} sources={m.sources || []} onOpen={openSource} streaming={!!m.streaming} />
                )}
                {!!m.sources?.length && !m.error && (
                  <SourceList text={m.content} sources={m.sources} workspaceId={workspaceId} onOpen={openSource} />
                )}
                {!m.streaming && !m.error && m.page?.truncated && (
                  <p className="muted ai-ask-page-note">
                    {t(`„${m.page.title}“ war zu lang für die KI – nur der Anfang ging mit.`, `“${m.page.title}” was too long for the AI – only its beginning went along.`)}
                  </p>
                )}
                {!m.streaming && !m.error && !!m.content && (
                  <div className="ai-ask-answer-tools">
                    <button
                      type="button"
                      className="icon-button ai-ask-tool"
                      aria-label={copied === i ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
                      title={copied === i ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
                      onClick={() => {
                        void navigator.clipboard?.writeText(m.content).then(
                          () => setCopied(i),
                          () => {},
                        );
                      }}
                    >
                      {copied === i ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                    </button>
                    {m.page && currentPage?.id === m.page.id && currentPage.editable && (
                      <button
                        type="button"
                        className="icon-button ai-ask-tool ai-ask-suggest"
                        disabled={!!m.suggest?.busy}
                        aria-label={m.suggest?.busy ? t("Schlägt vor …", "Suggesting …") : t("Als Änderungsvorschlag einfügen", "Suggest as changes")}
                        title={t("Die Antwort als Änderungsvorschläge in die Seite einfügen – nichts wird überschrieben.", "Put the answer into the page as suggested changes – nothing is overwritten.")}
                        onClick={() => void suggest(i)}
                      >
                        <PencilLine size={15} aria-hidden="true" />
                      </button>
                    )}
                    {aiUsable(ai, "actions") && (
                      <button
                        type="button"
                        className="icon-button ai-ask-tool ai-ask-actions"
                        aria-label={t("Aktionen vorschlagen", "Propose actions")}
                        title={t("Aktionen vorschlagen – Aufgaben, Termine oder Seiten aus der Antwort", "Propose actions – tasks, events or pages from the answer")}
                        onClick={() =>
                          setActions({
                            instruction: messages[i - 1]?.content || t("Was lässt sich aus dieser Antwort anlegen?", "What can be created from this answer?"),
                            context: m.content,
                            pageId: currentPage?.id || null,
                            sources: (m.sources || []).filter((s) => s.pageId && (!s.workspaceId || s.workspaceId === workspaceId)).map((s) => ({ pageId: s.pageId, rowId: s.rowId || null })),
                          })
                        }
                      >
                        <ListChecks size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
                {m.suggest?.busy && (
                  <p className="ai-ask-suggest-result" role="status">
                    <PencilLine size={13} aria-hidden="true" /> {t("Schlägt Änderungen vor …", "Suggesting changes …")}
                  </p>
                )}
                {m.suggest?.text && !m.suggest.busy && (
                  <p className={`ai-ask-suggest-result${m.suggest.error ? " error" : ""}`} role="status">
                    {m.suggest.error ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} {m.suggest.text}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
        <form
          className="ai-ask-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="ai-ask-box" onClick={(e) => e.target === e.currentTarget && field.current?.focus()}>
            {pageOffered && currentPage && (
              <button
                type="button"
                className={`ai-ask-page-chip${withPage ? " active" : ""}`}
                aria-pressed={withPage}
                aria-label={t("Diese Seite", "This page")}
                disabled={busy}
                title={
                  withPage
                    ? t(`„${currentPage.title}“ geht vollständig mit an die KI. Klicken, um die Seite nicht mitzuschicken.`, `“${currentPage.title}” goes to the AI in full. Click to leave the page out.`)
                    : t(`„${currentPage.title}“ mitschicken`, `Include “${currentPage.title}”`)
                }
                onClick={() => setWithPage((on) => !on)}
              >
                {withPage ? <FileText size={13} weight="fill" aria-hidden="true" /> : <Plus size={12} weight="bold" aria-hidden="true" />}
                <span className="ai-ask-page-chip-label">{t("Diese Seite", "This page")}</span>
                {withPage && <span className="ai-ask-page-chip-title">{currentPage.title}</span>}
                {withPage && <X size={11} weight="bold" aria-hidden="true" className="ai-ask-page-chip-x" />}
              </button>
            )}
            <textarea
              ref={field}
              rows={1}
              maxLength={2000}
              aria-label={t("Deine Frage", "Your question")}
              placeholder={t("Frag etwas …", "Ask something …")}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="ai-ask-tools">
              <span className="ai-ask-scope" title={t("Wo soll gesucht werden?", "Where to look?")}>
                <MagnifyingGlass size={13} aria-hidden="true" />
                <Select
                  className="ai-ask-pill"
                  aria-label={t("Wo soll gesucht werden?", "Where to look?")}
                  value={across ? "all" : scope}
                  onChange={(e) => {
                    const value = e.target.value;
                    setAcross(value === "all");
                    if (value !== "all") setScope(value);
                  }}
                  disabled={busy}
                >
                  <option value="workspace">{t("Ganzer Arbeitsbereich", "Whole workspace")}</option>
                  {currentPage && <option value={`page:${currentPage.id}`}>{t(`„${currentPage.title}“ und Unterseiten`, `“${currentPage.title}” and sub-pages`)}</option>}
                  {spaces.map((s) => (
                    <option key={s.id} value={`space:${s.id}`}>
                      {t(`Bereich: ${s.name}`, `Space: ${s.name}`)}
                    </option>
                  ))}
                  <option value="all">{t("Alle meine Arbeitsbereiche", "All my workspaces")}</option>
                  <option value="help">{t("Nur Flowplan-Hilfe", "Only the Flowplan help")}</option>
                </Select>
              </span>
              {provider && (
                <Disclosure
                  className="ai-ask-model"
                  label={
                    <>
                      {provider.local && <span className="ai-ask-local-dot" aria-hidden="true" />}
                      <span>{modelDisplayName(provider.model) || t(AI_PROVIDER_NAMES[provider.kind], AI_PROVIDER_NAMES_EN[provider.kind])}</span>
                      <CaretDown size={11} aria-hidden="true" />
                    </>
                  }
                  buttonLabel={t(`Modell: ${modelDisplayName(provider.model) || provider.kind}`, `Model: ${modelDisplayName(provider.model) || provider.kind}`)}
                >
                  <dl className="ai-ask-model-facts">
                    <dt>{t("Anbieter", "Provider")}</dt>
                    <dd>{t(AI_PROVIDER_NAMES[provider.kind], AI_PROVIDER_NAMES_EN[provider.kind])}</dd>
                    {!!provider.model && (
                      <>
                        <dt>{t("Modell", "Model")}</dt>
                        <dd>
                          <code>{provider.model}</code>
                        </dd>
                      </>
                    )}
                    {!!provider.host && (
                      <>
                        <dt>{t("Adresse", "Address")}</dt>
                        <dd>{provider.host}</dd>
                      </>
                    )}
                  </dl>
                  <p className={`ai-ask-model-note${provider.local ? " local" : ""}`}>
                    {provider.local ? t("Texte bleiben auf diesem Server.", "Text stays on this server.") : t("Texte gehen an diesen Anbieter.", "Text goes to this provider.")}{" "}
                    {provider.source === "user" ? t("Dein eigener Anbieter (Einstellungen → KI).", "Your own provider (Settings → AI).") : t("Von der Administration eingerichtet.", "Set up by the administration.")}
                  </p>
                </Disclosure>
              )}
              {busy ? (
                <button type="button" className="ai-ask-send stop" aria-label={t("Stopp", "Stop")} title={t("Stopp", "Stop")} onClick={() => controller.current?.abort()}>
                  <Stop size={14} weight="fill" aria-hidden="true" />
                </button>
              ) : (
                <button className="ai-ask-send" aria-label={t("Fragen", "Ask")} title={t("Fragen (Enter) – neue Zeile mit Umschalt+Enter", "Ask (Enter) – new line with Shift+Enter")} disabled={!question.trim()}>
                  <ArrowUp size={16} weight="bold" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </form>
        <Disclosure
          className="ai-ask-note"
          label={
            <>
              <Info size={13} aria-hidden="true" />
              <span>{t("Liest nur, was du lesen darfst · bleibt in diesem Tab", "Reads only what you may read · stays in this tab")}</span>
            </>
          }
          buttonLabel={t("Datenschutz: Liest nur, was du lesen darfst · bleibt in diesem Tab", "Privacy: Reads only what you may read · stays in this tab")}
        >
          <p>
            {t(
              "Die KI liest nur, was du lesen darfst und für die KI freigegeben ist. Das Gespräch bleibt nur in diesem Browser-Tab und wird nicht auf dem Server gespeichert.",
              "The AI only reads what you may read and what is open to the AI. The conversation stays in this browser tab only and is not stored on the server.",
            )}
          </p>
        </Disclosure>
        <AiActionsPanel
          workspaceId={workspaceId}
          request={actions}
          onClose={() => setActions(null)}
          onOpen={(pageId, rowId) => {
            setActions(null);
            openPage(pageId, rowId);
          }}
        />
      </aside>
      {shown && sheet && minimised && (
        <button type="button" className={`ask-panel-pill${busy ? " busy" : ""}`} onClick={() => setMinimised(false)} aria-label={busy ? t("„KI fragen“ öffnen – die Antwort läuft", "Open “Ask AI” – the answer is coming in") : t("„KI fragen“ öffnen", "Open “Ask AI”")}>
          <Sparkle size={16} aria-hidden="true" />
          <span>{busy ? t("KI antwortet …", "AI is answering …") : last?.role === "assistant" && !last.error ? t("Antwort da", "Answer ready") : t("KI fragen", "Ask AI")}</span>
        </button>
      )}
    </>
  );
}

// A small button that shows more above it (the model's details, the full
// privacy note): a disclosure – aria-expanded and aria-controls – that closes
// with Escape (without closing the panel), a click elsewhere or a second click.
function Disclosure({ className, label, buttonLabel, children }: { className: string; label: ReactNode; buttonLabel: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div
      ref={wrap}
      className={`ask-disclosure ${className}${open ? " open" : ""}`}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        wrap.current?.querySelector("button")?.focus();
      }}
    >
      <button type="button" className="ask-disclosure-button" aria-expanded={open} aria-controls={id} aria-label={buttonLabel} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      <div id={id} className="ask-disclosure-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

// The sources under an answer: the ones the answer cites as chips, the
// others behind a toggle so a long list doesn't push the answer out of the
// panel (#180, lib/ai/client.ts splitSources). Expanded, all of them in
// their [n] order. A citation in the text opens its source directly either way.
function SourceList({ text, sources, workspaceId, onOpen }: { text: string; sources: AskSource[]; workspaceId: string; onOpen: (source: AskSource) => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { shown, hidden } = splitSources(text, sources);
  const list = expanded ? sources : shown;
  return (
    <div className="ai-ask-sources-wrap">
      <ol id={listId} className="ai-ask-sources" aria-label={t("Quellen", "Sources")}>
        {list.map((s, n) => (
          // Revealed chips stagger from the toggle on; the others as before.
          <li key={s.n} style={{ animationDelay: `${(hidden.includes(s) ? hidden.indexOf(s) : n) * 40}ms` }}>
            <button type="button" className={`ai-source-chip${s.kind === "help" ? " help" : ""}`} onClick={() => onOpen(s)} title={s.pageTitle ? t(`Eintrag in ${s.pageTitle}`, `Record in ${s.pageTitle}`) : s.kind === "help" ? t("In der Flowplan-Hilfe öffnen", "Open in the Flowplan help") : undefined}>
              <span className="ai-cite-number">{s.n}</span>
              <span className="ai-source-icon" aria-hidden="true">
                {s.kind === "help" ? <Lifebuoy size={14} /> : <PageIcon name={s.kind === "row" ? "file" : s.kind === "database" ? "table" : "file"} size={14} />}
              </span>
              <span className="ai-source-text">
                <span className="ai-source-title">{s.title}</span>
                {(s.pageTitle || (s.workspaceName && s.workspaceId !== workspaceId) || s.kind === "help" || s.kind === "page") && (
                  <span className="ai-source-meta">
                    {s.pageTitle && <small>{s.pageTitle}</small>}
                    {s.workspaceName && s.workspaceId !== workspaceId && <small className="ai-source-workspace">{s.workspaceName}</small>}
                    {s.kind === "help" && <small className="ai-source-workspace">{t("Flowplan-Hilfe", "Flowplan help")}</small>}
                    {s.kind === "page" && <small className="ai-source-workspace">{t("Diese Seite", "This page")}</small>}
                  </span>
                )}
              </span>
              <ArrowSquareOut size={13} className="ai-source-open" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      {hidden.length > 0 && (
        <button type="button" className="ai-ask-sources-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((v) => !v)}>
          {expanded
            ? t("Weniger Quellen", "Fewer sources")
            : hidden.length === 1
              ? t("1 weitere Quelle", "1 more source")
              : t(`${hidden.length} weitere Quellen`, `${hidden.length} more sources`)}
          <CaretDown size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// The answer as Markdown, with [n] as clickable chips (only for sources
// that exist).
function AnswerText({ text, sources, onOpen, streaming }: { text: string; sources: AskSource[]; onOpen: (source: AskSource) => void; streaming: boolean }) {
  const t = useT();
  const withCitations = (part: string, key: string) =>
    citationParts(part, sources).map((piece, j) => {
      if ("text" in piece) return <Fragment key={`${key}:${j}`}>{piece.text}</Fragment>;
      const source = sources.find((s) => s.n === piece.cite)!;
      return (
        <button key={`${key}:${j}`} type="button" className="ai-cite" title={source.title} aria-label={t(`Quelle ${piece.cite}: ${source.title}`, `Source ${piece.cite}: ${source.title}`)} onClick={() => onOpen(source)}>
          {piece.cite}
        </button>
      );
    });
  return (
    <div className="ai-ask-text">
      <AiMarkdown text={text} renderText={withCitations} after={streaming ? <span className="ai-ask-caret" aria-hidden /> : null} />
    </div>
  );
}
