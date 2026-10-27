"use client";
// "KI fragen": questions about the workspace, answered with numbered sources
// (lib/ai/ask.ts). The conversation is kept in this browser tab only
// (sessionStorage) – the server stores none of it.
import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ChatCircleDots, Lightning, MagnifyingGlass, PaperPlaneRight, Sparkle, Stop } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, PageIcon } from "./ui";
import { Select } from "./select";
import { AiActionsPanel, type AiActionsRequest } from "./ai-actions";
import { askAi, aiProviderLabel, aiUsable, citationParts, type AskScope, type AskSource } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/features";
import type { Space } from "@/lib/types";

type Message = { role: "user" | "assistant"; content: string; sources?: AskSource[]; error?: boolean; streaming?: boolean };
type Stored = { messages: Message[]; scope: string; across?: boolean };
const storageKey = (workspaceId: string) => `flowplan-ask:${workspaceId}`;
const MAX_TURNS = 20;

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

export function AskPanel({
  open,
  onClose,
  workspaceId,
  ai,
  spaces,
  currentPage,
  initialQuestion,
  onOpenSource,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  ai: AiStatus | undefined;
  spaces: Space[];
  currentPage: { id: string; title: string } | null;
  initialQuestion?: string;
  onOpenSource: (pageId: string, rowId?: string) => void;
}) {
  const t = useT();
  const [messages, setMessages] = useState<Message[]>([]);
  const [scope, setScope] = useState("workspace");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  // "Alle Arbeitsbereiche": the question goes to every workspace of the person.
  const [across, setAcross] = useState(false);
  const [actions, setActions] = useState<AiActionsRequest | null>(null);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const stored = load(workspaceId);
    setMessages(stored.messages);
    setAcross(!!stored.across);
    // A page scope only makes sense while that page is open.
    setScope(stored.scope.startsWith("page:") && stored.scope !== `page:${currentPage?.id}` ? "workspace" : stored.scope);
    if (initialQuestion) setQuestion(initialQuestion);
  }, [open, workspaceId]);
  useEffect(() => {
    if (open) save(workspaceId, { messages: messages.filter((m) => !m.streaming), scope, across });
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, scope, across]);
  useEffect(() => () => controller.current?.abort(), []);

  const scopeValue = (): AskScope =>
    across
      ? { kind: "all" }
      : scope.startsWith("page:") ? { kind: "page", pageId: scope.slice(5) } : scope.startsWith("space:") ? { kind: "space", spaceId: scope.slice(6) } : { kind: "workspace" };

  async function send() {
    const text = question.trim();
    if (!text || busy) return;
    const history = messages.filter((m) => !m.error && !m.streaming).map((m) => ({ role: m.role, content: m.content }));
    setQuestion("");
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    setMessages((list) => [...list.slice(-(MAX_TURNS * 2 - 2)), { role: "user", content: text }, { role: "assistant", content: "", streaming: true }]);
    const update = (patch: Partial<Message>) =>
      setMessages((list) => {
        const next = [...list];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });
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
      if ((error as Error).name === "AbortError") update({ streaming: false, content: t("Abgebrochen.", "Stopped.") , error: true });
      else update({ streaming: false, content: (error as Error).message, error: true });
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }

  const provider = ai?.provider;
  return (
    <Modal open={open} onClose={onClose} title={t("KI fragen", "Ask AI")} wide className="ai-ask">
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
          }}
        >
          <ChatCircleDots size={15} aria-hidden="true" /> {t("Neues Gespräch", "New conversation")}
        </button>
      </div>
      <div className="ai-ask-log" aria-live="polite" aria-busy={busy}>
        {!messages.length && (
          <div className="ai-ask-empty">
            <Sparkle size={26} />
            <p>{t("Frag nach Inhalten deiner Seiten und Datenbanken. Antworten nennen ihre Quellen – findet die KI nichts, sagt sie das.", "Ask about the content of your pages and databases. Answers name their sources – if the AI finds nothing, it says so.")}</p>
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
                <AnswerText text={m.content} sources={m.sources || []} onOpen={onOpenSource} streaming={!!m.streaming} />
              )}
              {!!m.sources?.length && !m.error && (
                <ol className="ai-ask-sources" aria-label={t("Quellen", "Sources")}>
                  {m.sources.map((s, n) => (
                    <li key={s.n} style={{ animationDelay: `${n * 40}ms` }}>
                      <button type="button" className="ai-source-chip" onClick={() => onOpenSource(s.pageId, s.rowId)} title={s.pageTitle ? t(`Eintrag in ${s.pageTitle}`, `Record in ${s.pageTitle}`) : undefined}>
                        <span className="ai-cite-number">{s.n}</span>
                        <PageIcon name={s.kind === "row" ? "file" : s.kind === "database" ? "table" : "file"} />
                        <span className="ai-source-title">{s.title}</span>
                        {s.pageTitle && <small>{s.pageTitle}</small>}
                        {s.workspaceName && s.workspaceId !== workspaceId && <small className="ai-source-workspace">{s.workspaceName}</small>}
                        <ArrowSquareOut size={13} />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {!m.streaming && !m.error && m.content && aiUsable(ai, "actions") && (
                <button
                  type="button"
                  className="button compact ai-ask-actions"
                  onClick={() =>
                    setActions({
                      instruction: messages[i - 1]?.content || t("Was lässt sich aus dieser Antwort anlegen?", "What can be created from this answer?"),
                      context: m.content,
                      pageId: currentPage?.id || null,
                      sources: (m.sources || []).filter((s) => !s.workspaceId || s.workspaceId === workspaceId).map((s) => ({ pageId: s.pageId, rowId: s.rowId || null })),
                    })
                  }
                >
                  <Lightning size={14} /> {t("Aktionen vorschlagen", "Propose actions")}
                </button>
              )}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form
        className="ai-ask-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          autoFocus
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
          onOpenSource(pageId, rowId);
        }}
      />
    </Modal>
  );
}

// The answer with [n] as clickable chips (only for sources that exist).
function AnswerText({ text, sources, onOpen, streaming }: { text: string; sources: AskSource[]; onOpen: (pageId: string, rowId?: string) => void; streaming: boolean }) {
  const t = useT();
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className="ai-ask-text">
      {paragraphs.map((p, i) => (
        <p key={i}>
          {citationParts(p, sources).map((part, j) => {
            if ("text" in part) return <Fragment key={j}>{part.text}</Fragment>;
            const source = sources.find((s) => s.n === part.cite)!;
            return (
              <button key={j} type="button" className="ai-cite" title={source.title} aria-label={t(`Quelle ${part.cite}: ${source.title}`, `Source ${part.cite}: ${source.title}`)} onClick={() => onOpen(source.pageId, source.rowId)}>
                {part.cite}
              </button>
            );
          })}
          {streaming && i === paragraphs.length - 1 && <span className="ai-ask-caret" aria-hidden />}
        </p>
      ))}
    </div>
  );
}
