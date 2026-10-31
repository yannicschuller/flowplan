"use client";
// The writing assistant's panel under the text it works on: actions for a
// selection (improve, rephrase, shorten, …, a free instruction), a free
// prompt at the caret (/ki, ⌘J on an empty line) or the summary of a voice
// note. The answer streams into a preview – never straight into the
// document – and is then inserted as blocks in one step: replacing the text,
// below it, or discarded. In the Flowplan apps on Apple devices it runs on
// the device where it can (lib/ai/device.ts), with the server as fallback
// where the person may use it – in end-to-end encrypted spaces only there.
// With "Mit bestehenden Seiten verlinken" (on unless switched off, remembered
// in this browser) the server offers the model relevant existing pages and
// the answer links them (lib/ai/links.ts): visible in the preview, listed
// under it ("Verlinkt: …") and inserted as real page links.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { DOMParser as ProseMirrorDOMParser, type Schema } from "@tiptap/pm/model";
import { ArrowBendDownLeft, ArrowClockwise, ArrowsClockwise, Check, Link as LinkIcon, PaperPlaneRight, Sparkle, Stop, X } from "@phosphor-icons/react";
import { streamAiFrom } from "@/lib/ai/client";
import { aiInsertTransaction, aiMarkdownToHtml, selectionText, type AiInsertMode } from "@/lib/ai/insert";
import { decodeLinkTargets, linkedTargets, LINKS_HEADER, LINKS_STORAGE_KEY, type LinkTarget } from "@/lib/ai/links";
import { defaultTranslateTarget, WRITE_ACTIONS, WRITE_LANGUAGES, WRITE_TONES, type WriteAction, type WriteLanguage, type WriteTone } from "@/lib/ai/prompts";
import { aiTarget, setAiTarget } from "@/lib/ai/target";
import { useLocale, useT } from "./i18n";
import { AiProviderFooter, DeviceAiChip, useAi, useAiRoute } from "./ai-context";
import { AiActionsPanel, type AiActionsRequest } from "./ai-actions";
import { aiPageReadable, aiUsable } from "@/lib/ai/client";
import { DeviceAiError, deviceErrorText, deviceSummary, deviceSummaryFits, runOnDevice, runRouted } from "@/lib/ai/device";
import { DEVICE_LIMITS, deviceWriteFits, deviceWritePrompt } from "@/lib/ai/device-prompts";
import type { WriteRequest } from "@/lib/ai/prompts";
import { Lightning } from "@phosphor-icons/react";
import { Select } from "./select";

export type AiWriterRequest =
  // Actions on selected text (or the current line).
  | { kind: "selection"; from: number; to: number }
  // A free prompt at the caret.
  | { kind: "prompt"; from: number; to: number }
  // The summary of a voice note's transcript, inserted below it.
  | { kind: "transcript"; from: number; to: number; text: string };

// The same request for the server (url, body) and for the device.
type Job = { url: string; body: Record<string, unknown>; label: string; device: { kind: "write"; request: WriteRequest } | { kind: "summary"; text: string } };

// The remembered choice whether to link existing pages (default: yes).
function storedLinkChoice() {
  try {
    return localStorage.getItem(LINKS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}
function storeLinkChoice(on: boolean) {
  try {
    localStorage.setItem(LINKS_STORAGE_KEY, on ? "on" : "off");
  } catch {}
}

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
  encrypted = false,
}: {
  editor: Editor;
  pageId: string;
  rowId?: string;
  request: AiWriterRequest;
  onClose: () => void;
  // A page of an end-to-end encrypted space: the device only.
  encrypted?: boolean;
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
  const actionsUsable = !encrypted && aiUsable(ai.status, "actions") && aiPageReadable(ai.status, pageId) && !!ai.workspaceId && !rowId;
  // Where it runs: on this device (Apple) or on the server.
  const writeRoute = useAiRoute("write", pageId, { encrypted });
  const summaryRoute = useAiRoute("summarize", pageId, { encrypted });
  const routes = useRef({ write: writeRoute, summary: summaryRoute });
  routes.current = { write: writeRoute, summary: summaryRoute };
  const [ranOn, setRanOn] = useState<"device" | "server" | null>(null);
  const [actions, setActions] = useState<AiActionsRequest | null>(null);
  // Linking existing pages: the person's choice, where the feature is usable
  // (never in end-to-end encrypted spaces – the server has no plaintext to
  // search with). The pages the server offered for the current answer.
  const linksUsable = !encrypted && aiUsable(ai.status, "links");
  const [linkPages, setLinkPages] = useState(storedLinkChoice);
  const [targets, setTargets] = useState<LinkTarget[]>([]);

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
      setRanOn(null);
      setTargets([]);
      setPhase("running");
      const onText = (all: string) => {
        if (controller.current === abort) setAnswer(all);
      };
      try {
        const route = next.device.kind === "summary" ? routes.current.summary : routes.current.write;
        const { result: text } = await runRouted(route, {
          // No page links on the device: finding candidates means searching
          // the workspace on the server with the text, which the device route
          // promises keeps on this device (and in encrypted spaces the server
          // cannot search at all) – and the model's context (about 4 000
          // tokens, DEVICE_LIMITS) has no room for a list of pages next to
          // the text and the answer. So the device writes without links.
          device: async () => {
            setRanOn("device");
            const work = next.device;
            if (work.kind === "summary") {
              if (!deviceSummaryFits(work.text)) throw new DeviceAiError("context-too-long");
              return (await deviceSummary(work.text, { locale, signal: abort.signal })).markdown;
            }
            if (!deviceWriteFits(work.request)) throw new DeviceAiError("context-too-long");
            return String(await runOnDevice(deviceWritePrompt(work.request), { signal: abort.signal, onText }));
          },
          server: () => {
            setRanOn("server");
            setAnswer("");
            return streamAiFrom(next.url, next.body, {
              signal: abort.signal,
              onText: (_piece, all) => onText(all),
              // The pages offered to the model, by handle (only those become links).
              onResponse: (response) => {
                if (controller.current === abort) setTargets(decodeLinkTargets(response.headers.get(LINKS_HEADER)));
              },
            });
          },
        });
        if (controller.current !== abort) return;
        setAnswer(text);
        setPhase(text.trim() ? "done" : "error");
        if (!text.trim()) setError(t("Die KI hat nichts geantwortet.", "The AI did not answer anything."));
      } catch (e) {
        if (controller.current !== abort) return;
        if ((e as Error).name === "AbortError") return setPhase("done");
        setError(e instanceof DeviceAiError ? deviceErrorText(e, t) : (e as Error).message);
        setPhase("error");
      }
    },
    [t, locale],
  );
  // The page as context of the free prompt on the device: from the open
  // editor, cut to what the model takes.
  const pageContext = () => {
    const markdown = selectionText(editor.state.doc, 0, editor.state.doc.content.size);
    return markdown.length > DEVICE_LIMITS.contextChars ? markdown.slice(0, DEVICE_LIMITS.contextChars) + "\n\n[…]" : markdown;
  };
  const write = (action: WriteAction, extra: Partial<Omit<WriteRequest, "action" | "locale">> & { context?: boolean } = {}, label = "") => {
    const { context: withPage, ...choices } = extra;
    const request: WriteRequest = { action, text: source, locale, ...choices };
    if (withPage && action === "prompt") request.page = { title: "", markdown: pageContext() };
    void run({
      url: "/api/ai/write",
      label,
      body: { pageId, ...(rowId ? { rowId } : {}), action, text: source, locale, ...extra, ...(linksUsable && linkPages ? { links: true } : {}) },
      device: { kind: "write", request },
    });
  };
  // The voice note's summary starts right away.
  useEffect(() => {
    if (request.kind === "transcript")
      void run({
        url: "/api/ai/summarize",
        label: t("Sprachnotiz zusammenfassen", "Summarise voice note"),
        body: { pageId, ...(rowId ? { rowId } : {}), text: request.text, locale, ...(linksUsable && linkPages ? { links: true } : {}) },
        device: { kind: "summary", text: request.text },
      });
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
    const tr = aiInsertTransaction(editor.state, blocksFromHtml(editor.schema, aiMarkdownToHtml(answer, targets.length ? targets : null)), range, mode);
    if (tr) editor.view.dispatch(tr);
    close();
  }
  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    if (request.kind === "prompt") write("prompt", { instruction: text, context, text: undefined }, text);
    else write("custom", { instruction: text }, text);
  };
  const preview = useMemo(() => aiMarkdownToHtml(answer, targets.length ? targets : null), [answer, targets]);
  const linked = useMemo(() => linkedTargets(answer, targets), [answer, targets]);
  const linkToggle = linksUsable && (
    <label className="ai-writer-context ai-writer-links-toggle">
      <input
        type="checkbox"
        checked={linkPages}
        onChange={(event) => {
          setLinkPages(event.target.checked);
          storeLinkChoice(event.target.checked);
        }}
      />
      {t("Mit bestehenden Seiten verlinken", "Link existing pages")}
      {writeRoute.primary === "device" && <small>{t("Nicht mit der KI auf diesem Gerät.", "Not with the on-device AI.")}</small>}
    </label>
  );
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
            <>
            <label className="ai-writer-context">
              <input type="checkbox" checked={context} onChange={(event) => setContext(event.target.checked)} />
              {t("Seite als Kontext", "Page as context")}
              <small>
                {writeRoute.primary === "device"
                  ? t("Der Inhalt dieser Seite bleibt auf diesem Gerät.", "The content of this page stays on this device.")
                  : t("Der Inhalt dieser Seite geht mit an die KI.", "The content of this page is sent to the AI as well.")}
              </small>
            </label>
            {linkToggle}
            </>
          ) : (
            <>
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
            {linkToggle}
            </>
          )}
        </>
      )}
      {phase !== "choose" && (
        <>
          {job?.label && (
            <p className="ai-writer-job">
              <Sparkle size={14} weight="fill" aria-hidden /> <span>{job.label}</span>
              {ranOn === "device" && <DeviceAiChip />}
            </p>
          )}
          <div className={`ai-preview${phase === "running" ? " streaming" : ""}`} aria-live="polite" aria-busy={phase === "running"}>
            {answer ? (
              <div dangerouslySetInnerHTML={{ __html: preview }} />
            ) : phase === "running" ? (
              <p className="muted">{ranOn === "device" ? t("Die KI auf diesem Gerät schreibt …", "The on-device AI is writing …") : t("Die KI schreibt …", "The AI is writing …")}</p>
            ) : null}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          {linked.length > 0 && (
            <p className="ai-writer-linked">
              <LinkIcon size={13} aria-hidden /> <span>{t("Verlinkt:", "Linked:")}</span>{" "}
              {linked.map((target, i) => (
                <span key={target.handle}>
                  {i > 0 && ", "}
                  <strong>{target.title}</strong>
                </span>
              ))}
            </p>
          )}
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
      <AiProviderFooter device={ranOn ? ranOn === "device" : (request.kind === "transcript" ? summaryRoute : writeRoute).primary === "device"} />
      {ai.workspaceId && <AiActionsPanel workspaceId={ai.workspaceId} request={actions} onClose={() => setActions(null)} />}
    </div>
  );
}
