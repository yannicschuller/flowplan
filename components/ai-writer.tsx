"use client";
// The writing assistant's panel under the text it works on: actions for a
// selection (improve, rephrase, shorten, …, a free instruction), a free
// prompt at the caret (/ki, ⌘J on an empty line) or the summary of a voice
// note. The answer streams into a preview – never straight into the
// document – and is then inserted as blocks in one step: replacing the text,
// below it, or discarded.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { DOMParser as ProseMirrorDOMParser, type Schema } from "@tiptap/pm/model";
import { ArrowBendDownLeft, ArrowClockwise, ArrowsClockwise, Check, PaperPlaneRight, Sparkle, Stop, X } from "@phosphor-icons/react";
import { streamAiFrom } from "@/lib/ai/client";
import { aiInsertTransaction, aiMarkdownToHtml, selectionText, type AiInsertMode } from "@/lib/ai/insert";
import { defaultTranslateTarget, WRITE_ACTIONS, WRITE_LANGUAGES, WRITE_TONES, type WriteAction, type WriteLanguage, type WriteTone } from "@/lib/ai/prompts";
import { aiTarget, setAiTarget } from "@/lib/ai/target";
import { useLocale, useT } from "./i18n";
import { AiProviderFooter, useAi } from "./ai-context";
import { AiActionsPanel, type AiActionsRequest } from "./ai-actions";
import { aiUsable } from "@/lib/ai/client";
import { Lightning } from "@phosphor-icons/react";
import { Select } from "./select";

export type AiWriterRequest =
  // Actions on selected text (or the current line).
  | { kind: "selection"; from: number; to: number }
  // A free prompt at the caret.
  | { kind: "prompt"; from: number; to: number }
  // The summary of a voice note's transcript, inserted below it.
  | { kind: "transcript"; from: number; to: number; text: string };

type Job = { url: string; body: Record<string, unknown>; label: string };

// The answer's HTML as editor blocks, parsed in a document of its own (no
// resources load while parsing).
export function blocksFromHtml(schema: Schema, html: string) {
  const doc = document.implementation.createHTMLDocument("");
  const holder = doc.createElement("div");
  holder.innerHTML = html;
  return ProseMirrorDOMParser.fromSchema(schema).parse(holder).content;
}

export function AiWriter({
  editor,
  pageId,
  rowId,
  request,
  onClose,
}: {
  editor: Editor;
  pageId: string;
  rowId?: string;
  request: AiWriterRequest;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null);
  // The selected text as it was when the panel opened.
  const source = useMemo(
    () => (request.kind === "selection" ? selectionText(editor.state.doc, request.from, request.to) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [phase, setPhase] = useState<"choose" | "running" | "done" | "error">("choose");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [instruction, setInstruction] = useState("");
  const [context, setContext] = useState(true);
  const [toneOpen, setToneOpen] = useState(false);
  const [language, setLanguage] = useState<WriteLanguage>(() => defaultTranslateTarget(source, locale));
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  // A prompt's answer goes in at the caret ("Einfügen"; an empty line is
  // replaced); a selection is replaced ("Ersetzen").
  const atCaret = request.kind === "prompt";
  // AI actions from the answer (pages, tasks, records): a preview first.
  const ai = useAi();
  const actionsUsable = aiUsable(ai.status, "actions") && !!ai.workspaceId && !rowId;
  const [actions, setActions] = useState<AiActionsRequest | null>(null);

  // Mark the text in the editor while the panel is open.
  useEffect(() => {
    setAiTarget(editor.view, { from: request.from, to: request.to });
    return () => {
      controller.current?.abort();
      if (!editor.isDestroyed) setAiTarget(editor.view, null);
    };
  }, [editor, request]);

  // Under the text, on screen; above it when there is no room below.
  const position = useCallback(() => {
    if (editor.isDestroyed) return;
    const range = aiTarget(editor.state) || request;
    let start: { left: number; top: number; bottom: number }, end: { left: number; top: number; bottom: number };
    try {
      start = editor.view.coordsAtPos(range.from);
      end = editor.view.coordsAtPos(range.to);
    } catch {
      return;
    }
    const width = Math.min(500, window.innerWidth - 16);
    const left = Math.max(8, Math.min(start.left - 12, window.innerWidth - width - 8));
    const below = window.innerHeight - end.bottom - 16;
    if (below >= 260 || below >= start.top - 16) setPlace({ left, top: end.bottom + 8, maxHeight: Math.max(160, below) });
    else setPlace({ left, bottom: window.innerHeight - start.top + 8, maxHeight: Math.max(160, start.top - 16) });
  }, [editor, request]);
  useEffect(() => {
    position();
    const update = () => position();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    editor.on("transaction", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      editor.off("transaction", update);
    };
  }, [editor, position]);

  const run = useCallback(
    async (next: Job) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setJob(next);
      setAnswer("");
      setError("");
      setPhase("running");
      try {
        const text = await streamAiFrom(next.url, next.body, { signal: abort.signal, onText: (_piece, all) => setAnswer(all) });
        if (controller.current !== abort) return;
        setAnswer(text);
        setPhase(text.trim() ? "done" : "error");
        if (!text.trim()) setError(t("Die KI hat nichts geantwortet.", "The AI did not answer anything."));
      } catch (e) {
        if (controller.current !== abort) return;
        if ((e as Error).name === "AbortError") return setPhase("done");
        setError((e as Error).message);
        setPhase("error");
      }
    },
    [t],
  );
  const write = (action: WriteAction, extra: Record<string, unknown> = {}, label = "") =>
    void run({
      url: "/api/ai/write",
      label,
      body: { pageId, ...(rowId ? { rowId } : {}), action, text: source, locale, ...extra },
    });
  // The voice note's summary starts right away.
  useEffect(() => {
    if (request.kind === "transcript")
      void run({ url: "/api/ai/summarize", label: t("Sprachnotiz zusammenfassen", "Summarise voice note"), body: { pageId, ...(rowId ? { rowId } : {}), text: request.text, locale } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The prompt takes the focus once the panel is placed (hidden until then,
  // and a hidden field cannot be focused) – once per return to "choose", so
  // later repositioning (scrolling) leaves the focus alone.
  const wantsFocus = useRef(false);
  useEffect(() => {
    if (phase === "choose") wantsFocus.current = true;
  }, [phase]);
  useEffect(() => {
    if (phase !== "choose" || !place || !wantsFocus.current) return;
    wantsFocus.current = false;
    input.current?.focus();
  }, [phase, place]);

  const close = useCallback(() => {
    controller.current?.abort();
    onClose();
    if (!editor.isDestroyed) editor.commands.focus();
  }, [editor, onClose]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || actions) return;
      event.preventDefault();
      if (phase === "running") controller.current?.abort();
      else close();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [close, phase, actions]);

  function insert(mode: AiInsertMode) {
    if (editor.isDestroyed) return;
    const range = aiTarget(editor.state) || request;
    const tr = aiInsertTransaction(editor.state, blocksFromHtml(editor.schema, aiMarkdownToHtml(answer)), range, mode);
    if (tr) editor.view.dispatch(tr);
    close();
  }
  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    if (request.kind === "prompt") write("prompt", { instruction: text, context, text: undefined }, text);
    else write("custom", { instruction: text }, text);
  };
  const preview = useMemo(() => aiMarkdownToHtml(answer), [answer]);
  const style = place
    ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }
    : { visibility: "hidden" as const };

  return (
    <div
      ref={box}
      className="ai-writer"
      style={style}
      role="dialog"
      aria-label={t("KI-Schreibassistent", "AI writing assistant")}
      onMouseDown={(event) => {
        // Buttons keep the editor's state; fields take the focus.
        if (!(event.target as HTMLElement).closest("input, textarea, select, .fp-select")) event.preventDefault();
      }}
    >
      {phase === "choose" && request.kind !== "transcript" && (
        <>
          <form
            className="ai-writer-ask"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Sparkle size={17} weight="fill" aria-hidden />
            <textarea
              ref={input}
              rows={request.kind === "prompt" ? 2 : 1}
              value={instruction}
              aria-label={t("Was soll die KI tun?", "What should the AI do?")}
              placeholder={
                request.kind === "prompt"
                  ? t("Was soll die KI schreiben? z. B. „Schreib eine Einleitung über …“", "What should the AI write? E.g. “Write an introduction about …”")
                  : t("Was soll die KI tun?", "What should the AI do?")
              }
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button type="submit" className="icon-button" disabled={!instruction.trim()} aria-label={t("Senden", "Send")} title={t("Senden (Enter)", "Send (Enter)")}>
              <PaperPlaneRight size={17} />
            </button>
          </form>
          {request.kind === "prompt" ? (
            <label className="ai-writer-context">
              <input type="checkbox" checked={context} onChange={(event) => setContext(event.target.checked)} />
              {t("Seite als Kontext", "Page as context")}
              <small>{t("Der Inhalt dieser Seite geht mit an die KI.", "The content of this page is sent to the AI as well.")}</small>
            </label>
          ) : (
            <div className="ai-writer-actions" role="menu" aria-label={t("KI-Aktionen", "AI actions")}>
              {WRITE_ACTIONS.map(([id, de, en, hintDe, hintEn]) =>
                id === "tone" ? (
                  <div key={id} className="ai-writer-sub">
                    <button type="button" role="menuitem" aria-expanded={toneOpen} onClick={() => setToneOpen((v) => !v)}>
                      <strong>{t(de, en)}</strong>
                      <small>{t(hintDe, hintEn)}</small>
                    </button>
                    {toneOpen && (
                      <div className="ai-writer-chips" role="group" aria-label={t("Ton", "Tone")}>
                        {WRITE_TONES.map(([tone, toneDe, toneEn]) => (
                          <button key={tone} type="button" className="chip" onClick={() => write("tone", { tone: tone as WriteTone }, `${t(de, en)}: ${t(toneDe, toneEn)}`)}>
                            {t(toneDe, toneEn)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : id === "translate" ? (
                  <div key={id} className="ai-writer-sub ai-writer-translate">
                    <button type="button" role="menuitem" onClick={() => write("translate", { language }, `${t(de, en)}`)}>
                      <strong>{t(de, en)}</strong>
                      <small>{t(hintDe, hintEn)}</small>
                    </button>
                    <Select aria-label={t("Zielsprache", "Target language")} value={language} onChange={(event) => setLanguage(event.target.value as WriteLanguage)}>
                      {WRITE_LANGUAGES.map(([code, nameDe, nameEn]) => (
                        <option key={code} value={code}>
                          {t(nameDe, nameEn)}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <button key={id} type="button" role="menuitem" onClick={() => write(id, {}, t(de, en))}>
                    <strong>{t(de, en)}</strong>
                    <small>{t(hintDe, hintEn)}</small>
                  </button>
                ),
              )}
            </div>
          )}
        </>
      )}
      {phase !== "choose" && (
        <>
          {job?.label && (
            <p className="ai-writer-job">
              <Sparkle size={14} weight="fill" aria-hidden /> <span>{job.label}</span>
            </p>
          )}
          <div className={`ai-preview${phase === "running" ? " streaming" : ""}`} aria-live="polite" aria-busy={phase === "running"}>
            {answer ? (
              <div dangerouslySetInnerHTML={{ __html: preview }} />
            ) : phase === "running" ? (
              <p className="muted">{t("Die KI schreibt …", "The AI is writing …")}</p>
            ) : null}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="ai-writer-buttons">
            {phase === "running" ? (
              <button type="button" className="button compact" onClick={() => controller.current?.abort()}>
                <Stop size={14} weight="fill" /> {t("Stopp", "Stop")}
              </button>
            ) : (
              <>
                {answer.trim() && request.kind !== "transcript" && (
                  <button type="button" className="button primary compact" onClick={() => insert("replace")}>
                    <Check size={14} /> {atCaret ? t("Einfügen", "Insert") : t("Ersetzen", "Replace")}
                  </button>
                )}
                {answer.trim() && (
                  <button type="button" className={`button compact${request.kind === "transcript" ? " primary" : ""}`} onClick={() => insert("below")}>
                    <ArrowBendDownLeft size={14} /> {t("Darunter einfügen", "Insert below")}
                  </button>
                )}
                {job && (
                  <button type="button" className="button compact" onClick={() => void run(job)}>
                    <ArrowClockwise size={14} /> {t("Erneut", "Retry")}
                  </button>
                )}
                {answer.trim() && actionsUsable && (
                  <button
                    type="button"
                    className="button compact"
                    onClick={() =>
                      setActions({
                        instruction: job?.label || instruction || t("Was lässt sich aus diesem Text anlegen?", "What can be created from this text?"),
                        context: request.kind === "transcript" ? `${request.text}\n\n${answer}` : answer,
                        pageId,
                        mode: request.kind === "transcript" ? "transcript" : "general",
                      })
                    }
                  >
                    <Lightning size={14} /> {t("Aktionen vorschlagen", "Propose actions")}
                  </button>
                )}
                {request.kind !== "transcript" && (
                  <button type="button" className="button compact" onClick={() => setPhase("choose")}>
                    <ArrowsClockwise size={14} /> {t("Andere Aktion", "Other action")}
                  </button>
                )}
                <button type="button" className="button compact" onClick={close}>
                  <X size={14} /> {t("Verwerfen", "Discard")}
                </button>
              </>
            )}
          </div>
        </>
      )}
      <AiProviderFooter />
      {ai.workspaceId && <AiActionsPanel workspaceId={ai.workspaceId} request={actions} onClose={() => setActions(null)} />}
    </div>
  );
}
