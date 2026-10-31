"use client";
// "KI fragen": questions about the workspace, answered with numbered sources
// (lib/ai/ask.ts). A panel docked on the right of the workspace (from 768 px,
// components/workspace-app.tsx puts it into the app shell's grid, so the page
// narrows instead of being covered) or a bottom sheet on phones that is
// swiped down to a small pill. It is no dialog: the page stays usable, the
// answer keeps streaming while the person scrolls, writes or opens other
// pages, and closing only hides it. The conversation is kept in this browser
// tab only (sessionStorage) – the server stores none of it.
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CaretDown, ChatCircleDots, Check, Copy, Lifebuoy, Lightning, MagnifyingGlass, PaperPlaneRight, Sparkle, Stop, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { PageIcon } from "./ui";
import { Select } from "./select";
import { AiActionsPanel, type AiActionsRequest } from "./ai-actions";
import { AiMarkdown } from "./ai-markdown";
import { SidebarResize } from "./sidebar-resize";
import { SHEET_HANDLE, useSheetDrag } from "./sheet-drag";
import { addBackCloser } from "@/lib/app-back";
import { askAi, aiProviderLabel, aiUsable, citationParts, helpSourceUrl, type AskScope, type AskSource } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/features";
import type { Space } from "@/lib/types";

type Message = { role: "user" | "assistant"; content: string; sources?: AskSource[]; error?: boolean; streaming?: boolean };
type Stored = { messages: Message[]; scope: string; across?: boolean };
const storageKey = (workspaceId: string) => `flowplan-ask:${workspaceId}`;
const MAX_TURNS = 20;

// The panel's width on wide screens (dragged at its left edge, kept per
// browser; null: the default from the stylesheet).
export const ASK_WIDTH_KEY = "flowplan-ask-width";
export const ASK_MIN = 300;
export const ASK_MAX = 640;
export const clampAsk = (value: number) => Math.round(Math.min(ASK_MAX, Math.max(ASK_MIN, value)));
// Up to this width the panel is a bottom sheet (the phone layout of
// app/globals.css).
export const ASK_SHEET_MEDIA = "(max-width: 767px)";
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

function useMedia(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

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
  currentPage: { id: string; title: string } | null;
  onOpenSource: (pageId: string, rowId?: string) => void;
  width: number | null;
  onWidth: (width: number | null) => void;
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
  const sheet = useMedia(ASK_SHEET_MEDIA);
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

  const scopeValue = (): AskScope =>
    across
      ? { kind: "all" }
      : scope === "help"
        ? { kind: "help" }
        : scope.startsWith("page:") ? { kind: "page", pageId: scope.slice(5) } : scope.startsWith("space:") ? { kind: "space", spaceId: scope.slice(6) } : { kind: "workspace" };

  // `before`: the conversation to continue (a retry leaves out the failed turn).
  async function send(text = question.trim(), before = messages) {
    if (!text || busy) return;
    const history = before.filter((m) => !m.error && !m.streaming).map((m) => ({ role: m.role, content: m.content }));
    if (text === question.trim()) setQuestion("");
    setBusy(true);
    stick.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const mine = generation.current;
    setMessages([...before.slice(-(MAX_TURNS * 2 - 2)), { role: "user", content: text }, { role: "assistant", content: "", streaming: true }]);
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
        scope: scopeValue(),
        signal: abort.signal,
        onSources: (sources) => update({ sources }),
        onText: (_piece, all) => update({ content: all }),
      });
      update({ content: result.text, sources: result.sources, streaming: false });
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
  // The last question once more, without the failed answer.
  const retry = () => {
    const asked = messages[messages.length - 2];
    if (busy || asked?.role !== "user") return;
    void send(asked.content, messages.slice(0, -2));
  };

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
          width={width}
          onWidth={onWidth}
          min={ASK_MIN}
          max={ASK_MAX}
          fallback={380}
          label={t("Breite von „KI fragen“", "Width of “Ask AI”")}
          hint={t("Ziehen zum Ändern, Doppelklick setzt zurück", "Drag to resize, double-click to reset")}
        />
        <header className="ask-panel-head">
          <Sparkle size={17} aria-hidden="true" className="ask-panel-icon" />
          <h2 id={headingId}>{t("KI fragen", "Ask AI")}</h2>
          {sheet && (
            <button type="button" className="icon-button" aria-label={t("Verkleinern", "Minimise")} title={t("Verkleinern – die Antwort läuft weiter", "Minimise – the answer keeps going")} onClick={() => setMinimised(true)}>
              <CaretDown size={18} />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("„KI fragen“ schließen", "Close “Ask AI”")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="ai-ask-bar">
          <div className="ai-ask-scope">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <Select
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
          </div>
          <span
            className={`ai-provider-chip${provider?.local ? " local" : ""}`}
            title={provider?.local ? t("Texte bleiben auf diesem Server.", "Text stays on this server.") : t("Texte gehen an diesen Anbieter.", "Text goes to this provider.")}
          >
            <Sparkle size={13} aria-hidden="true" /> <span>{aiProviderLabel(provider ?? null, t)}</span>
          </span>
          <button
            type="button"
            className="button compact ai-ask-new"
            disabled={busy || !messages.length}
            onClick={() => {
              setMessages([]);
              setQuestion("");
              field.current?.focus();
            }}
          >
            <ChatCircleDots size={15} aria-hidden="true" /> {t("Neues Gespräch", "New conversation")}
          </button>
        </div>
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
              <Sparkle size={26} />
              <p>{t("Frag nach Inhalten deiner Seiten und Datenbanken – oder wie etwas in Flowplan geht. Antworten nennen ihre Quellen – findet die KI nichts, sagt sie das.", "Ask about the content of your pages and databases – or how something works in Flowplan. Answers name their sources – if the AI finds nothing, it says so.")}</p>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ai-ask-question">
                {m.content}
              </div>
            ) : (
              <div key={i} className={`ai-ask-answer${m.streaming ? " streaming" : ""}${m.error ? " error" : ""}`}>
                {m.streaming && !m.content ? (
                  <p className="ai-ask-thinking">{t("Sucht im Arbeitsbereich …", "Searching the workspace …")}</p>
                ) : (
                  <AnswerText text={m.content} sources={m.sources || []} onOpen={openSource} streaming={!!m.streaming} />
                )}
                {!!m.sources?.length && !m.error && (
                  <ol className="ai-ask-sources" aria-label={t("Quellen", "Sources")}>
                    {m.sources.map((s, n) => (
                      <li key={s.n} style={{ animationDelay: `${n * 40}ms` }}>
                        <button type="button" className={`ai-source-chip${s.kind === "help" ? " help" : ""}`} onClick={() => openSource(s)} title={s.pageTitle ? t(`Eintrag in ${s.pageTitle}`, `Record in ${s.pageTitle}`) : s.kind === "help" ? t("In der Flowplan-Hilfe öffnen", "Open in the Flowplan help") : undefined}>
                          <span className="ai-cite-number">{s.n}</span>
                          {s.kind === "help" ? <Lifebuoy size={14} aria-hidden="true" /> : <PageIcon name={s.kind === "row" ? "file" : s.kind === "database" ? "table" : "file"} />}
                          <span className="ai-source-title">{s.title}</span>
                          {s.pageTitle && <small>{s.pageTitle}</small>}
                          {s.workspaceName && s.workspaceId !== workspaceId && <small className="ai-source-workspace">{s.workspaceName}</small>}
                          {s.kind === "help" && <small className="ai-source-workspace">{t("Flowplan-Hilfe", "Flowplan help")}</small>}
                          <ArrowSquareOut size={13} />
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {!m.streaming && (
                  <div className="ai-ask-answer-tools">
                    {m.error && i === messages.length - 1 && !busy && (
                      <button type="button" className="button compact" onClick={retry}>
                        <ArrowClockwise size={14} aria-hidden="true" /> {t("Erneut versuchen", "Try again")}
                      </button>
                    )}
                    {!m.error && m.content && (
                      <button
                        type="button"
                        className="button compact"
                        onClick={() => {
                          void navigator.clipboard?.writeText(m.content).then(
                            () => setCopied(i),
                            () => {},
                          );
                        }}
                      >
                        {copied === i ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied === i ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
                      </button>
                    )}
                    {!m.error && m.content && aiUsable(ai, "actions") && (
                      <button
                        type="button"
                        className="button compact ai-ask-actions"
                        onClick={() =>
                          setActions({
                            instruction: messages[i - 1]?.content || t("Was lässt sich aus dieser Antwort anlegen?", "What can be created from this answer?"),
                            context: m.content,
                            pageId: currentPage?.id || null,
                            sources: (m.sources || []).filter((s) => s.pageId && (!s.workspaceId || s.workspaceId === workspaceId)).map((s) => ({ pageId: s.pageId, rowId: s.rowId || null })),
                          })
                        }
                      >
                        <Lightning size={14} /> {t("Aktionen vorschlagen", "Propose actions")}
                      </button>
                    )}
                  </div>
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
          <textarea
            ref={field}
            rows={2}
            maxLength={2000}
            aria-label={t("Deine Frage", "Your question")}
            placeholder={t("Was möchtest du wissen?", "What would you like to know?")}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button type="button" className="button" onClick={() => controller.current?.abort()}>
              <Stop size={15} /> {t("Stopp", "Stop")}
            </button>
          ) : (
            <button className="button primary" disabled={!question.trim()}>
              <PaperPlaneRight size={15} /> {t("Fragen", "Ask")}
            </button>
          )}
        </form>
        <p className="muted ai-ask-note">
          {t(
            "Die KI liest nur, was du lesen darfst und für die KI freigegeben ist. Das Gespräch bleibt nur in diesem Browser-Tab und wird nicht auf dem Server gespeichert.",
            "The AI only reads what you may read and what is open to the AI. The conversation stays in this browser tab only and is not stored on the server.",
          )}
        </p>
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
