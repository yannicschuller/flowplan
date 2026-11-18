"use client";
// "Lernkarten mit KI erstellen" (docs/specs/flashcards.md §9): the source
// (this page or record, the selected text, a PDF or other attachment, pasted
// text), the deck (an existing one or a new flashcards database), how many
// cards of which types and an optional focus – with an estimate of the
// tokens before anything is sent. The AI's suggestions come back checked by
// the server (lib/ai/flashcards.ts) and are reviewed here: each with a
// checkbox (duplicates of the deck and yes/no questions start unticked),
// editable in place, "Neu erzeugen" for different ones, tags for all – and
// only "Hinzufügen" creates records, checked again on the server.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, PencilSimple, Sparkle, Warning } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal, api, needsConnection } from "../ui";
import { Select } from "../select";
import { AiProviderFooter } from "../ai-context";
import { studyZoneNow } from "./focus";
import { browserZone } from "@/lib/date-values";
import { addAiFlashcards, proposeAiFlashcards } from "@/lib/ai/client";
import { AI_CARDS_MAX, AI_CARD_TYPES, type AiCardType, type CardSuggestion, type FlashcardSourceInput, type ProposeCardsResult } from "@/lib/ai/flashcards-shared";
import { parseClozeText } from "@/lib/study-cloze";
import type { Space } from "@/lib/types";
import { isPdfName, pdfPageCount, pdfPagesText } from "../pdf-viewer";

// Where the dialog was opened from. `file`: a PDF or other attachment (the
// PDF viewer's "Lernkarten erstellen", with the pages to take).
export type AiCardsStart = {
  pageId?: string | null;
  rowId?: string | null;
  pageTitle?: string;
  text?: string;
  deckId?: string | null;
  file?: { id: string; name: string; pages?: { from: number; to: number } };
};
type SourceKind = FlashcardSourceInput["kind"];
type Deck = { pageId: string; title: string };
type FileItem = { id: string; name: string; pageTitle: string; pageId: string };
type Range = { from: number; to: number };
const NEW_DECK = "new";
// Pages read in the browser at most (a longer part goes by the whole file).
const MAX_RANGE = 300;

export function StudyAiCards({
  open,
  onClose,
  workspaceId,
  spaces,
  start,
  onOpenPage,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  spaces: Pick<Space, "id" | "name">[];
  start: AiCardsStart;
  onOpenPage?: (pageId: string) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<SourceKind>(start.file ? "file" : start.text ? "selection" : start.pageId ? "page" : "text"),
    [text, setText] = useState(""),
    [fileId, setFileId] = useState(start.file?.id || ""),
    // A PDF's pages: all (null) or a range, read in the browser.
    [range, setRange] = useState<Range | null>(start.file?.pages || null),
    [pageCount, setPageCount] = useState<number | null>(null),
    [rangeText, setRangeText] = useState<{ key: string; text: string } | null>(null),
    [files, setFiles] = useState<FileItem[] | null>(null),
    [decks, setDecks] = useState<Deck[] | null>(null),
    [deck, setDeck] = useState(start.deckId || ""),
    [newTitle, setNewTitle] = useState(start.pageTitle || t("Lernkarten", "Flashcards")),
    [space, setSpace] = useState(spaces[0]?.id || ""),
    [count, setCount] = useState(20),
    [types, setTypes] = useState<AiCardType[]>(["basic", "cloze"]),
    [focus, setFocus] = useState(""),
    [estimate, setEstimate] = useState<ProposeCardsResult | null>(null),
    [result, setResult] = useState<ProposeCardsResult | null>(null),
    [cards, setCards] = useState<(CardSuggestion & { picked: boolean })[]>([]),
    [editing, setEditing] = useState<string | null>(null),
    [tags, setTags] = useState(""),
    [busy, setBusy] = useState<"propose" | "add" | null>(null),
    [error, setError] = useState(""),
    [added, setAdded] = useState<{ deckId: string; title: string; added: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The decks the person may study (the server checks write access when adding).
  useEffect(() => {
    if (!open) return;
    void api<{ decks: Deck[] }>(`/api/study/due?${new URLSearchParams({ workspace: workspaceId, zone: studyZoneNow() })}`)
      .then((d) => {
        setDecks(d.decks);
        setDeck((current) => current || d.decks[0]?.pageId || NEW_DECK);
      })
      .catch(() => {
        setDecks([]);
        setDeck((current) => current || NEW_DECK);
      });
  }, [open, workspaceId]);
  // Attachments to choose from: PDFs and other files with text of this page
  // (else of the workspace).
  useEffect(() => {
    if (!open || kind !== "file" || files) return;
    const load = async (kindOf: string) => (await api<{ items: FileItem[] }>(`/api/media?${new URLSearchParams({ workspace: workspaceId, kind: kindOf })}`)).items;
    void Promise.all([load("pdf"), load("other")])
      .then(([pdfs, others]) => {
        const all = [...pdfs, ...others.filter((f) => /\.(docx?|pptx?|xlsx?|odt|txt|md)$/i.test(f.name))];
        const own = start.pageId ? all.filter((f) => f.pageId === start.pageId) : [];
        const found = own.length ? own : all;
        // The file the dialog was opened with comes first (also when the
        // list does not hold it, e.g. a PDF of a record).
        const given = start.file;
        const list = given ? [found.find((f) => f.id === given.id) || { id: given.id, name: given.name, pageTitle: "", pageId: "" }, ...found.filter((f) => f.id !== given.id)] : found;
        setFiles(list);
        setFileId((current) => current || list[0]?.id || "");
      })
      .catch(() => setFiles(start.file ? [{ id: start.file.id, name: start.file.name, pageTitle: "", pageId: "" }] : []));
  }, [open, kind, files, workspaceId, start.pageId, start.file]);
  const file = files?.find((f) => f.id === fileId);
  const pdf = kind === "file" && !!file && isPdfName(file.name);
  const fileSrc = `/api/files/${fileId}`;
  // A PDF's page count (for the range), once a PDF is chosen.
  useEffect(() => {
    setPageCount(null);
    if (!open || !pdf) return;
    let alive = true;
    void pdfPageCount(fileSrc)
      .then((n) => alive && setPageCount(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, pdf, fileSrc]);
  // The text of the chosen pages, read in the browser a moment after the
  // range settles.
  // Pages within the document and at most MAX_RANGE of them (the fields
  // keep what is typed).
  const pages = useMemo((): Range | null => {
    if (!range) return null;
    const last = pageCount || 100_000;
    const from = Math.max(1, Math.min(last, Math.round(range.from) || 1));
    return { from, to: Math.max(from, Math.min(last, from + MAX_RANGE - 1, Math.round(range.to) || from)) };
  }, [range, pageCount]);
  const rangeKey = pdf && pages ? `${fileId}:${pages.from}-${pages.to}` : "";
  useEffect(() => {
    if (!rangeKey || !pages) return;
    let alive = true;
    const timer = setTimeout(() => {
      void pdfPagesText(fileSrc, pages.from, pages.to)
        .then((read) => alive && setRangeText({ key: rangeKey, text: read.text }))
        .catch(() => alive && setRangeText({ key: rangeKey, text: "" }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);
  const pagesText = rangeKey && rangeText?.key === rangeKey ? rangeText.text : null;
  const source = useMemo((): FlashcardSourceInput | null => {
    if (kind === "page" && start.pageId) return { kind, pageId: start.pageId, rowId: start.rowId || null };
    if (kind === "selection" && start.pageId && start.text) return { kind, pageId: start.pageId, rowId: start.rowId || null, text: start.text };
    if (kind === "file" && fileId && rangeKey && pages) return pagesText?.trim() ? { kind, fileId, text: pagesText, pages } : null;
    if (kind === "file" && fileId) return { kind, fileId };
    if (kind === "text" && text.trim()) return { kind, text };
    return null;
  }, [kind, start.pageId, start.rowId, start.text, fileId, text, rangeKey, pages, pagesText]);
  const request = (extra: Record<string, unknown> = {}) => ({
    workspaceId,
    source,
    deckId: deck && deck !== NEW_DECK ? deck : null,
    count,
    types,
    focus,
    ...extra,
  });
  // The estimate, a moment after the choices settle.
  useEffect(() => {
    setEstimate(null);
    if (!open || !source || result) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void proposeAiFlashcards(request({ estimate: true }), controller.signal)
        .then(setEstimate)
        .catch(() => {});
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, deck, count, types.join(), result]);
  const propose = async (again = false) => {
    // The AI needs the server (lib/offline-actions.ts onlineOnlyRequests).
    if (!source || needsConnection()) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy("propose");
    setError("");
    try {
      const answer = await proposeAiFlashcards(request(again ? { avoid: cards.map((c) => c.front).slice(0, AI_CARDS_MAX) } : {}), controller.signal);
      setResult(answer);
      setCards(answer.cards.map((c) => ({ ...c, picked: !c.duplicate && !c.yesNo })));
      setEditing(null);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (abort.current === controller) setBusy(null);
    }
  };
  const add = async () => {
    const picked = cards.filter((c) => c.picked && c.front.trim());
    if (!picked.length || needsConnection()) return;
    setBusy("add");
    setError("");
    try {
      const done = await addAiFlashcards({
        workspaceId,
        ...(deck && deck !== NEW_DECK ? { deckId: deck } : { newDeck: { spaceId: space, title: newTitle.trim() || t("Lernkarten", "Flashcards") } }),
        cards: picked.map(({ type, front, back, hint, choices, tags: own }) => ({ type, front, back, ...(hint ? { hint } : {}), ...(choices?.length ? { choices } : {}), ...(own?.length ? { tags: own } : {}) })),
        tags: tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 5),
        timeZone: browserZone(),
      });
      setAdded(done);
      // An open study view of the deck counts again.
      window.dispatchEvent(new CustomEvent("flowplan:study-changed", { detail: done.deckId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const close = () => {
    abort.current?.abort();
    onClose();
  };
  const change = (id: string, patch: Partial<CardSuggestion & { picked: boolean }>) => setCards((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const typeNames: Record<AiCardType, string> = {
    basic: t("Vorder-/Rückseite", "Front/back"),
    cloze: t("Lückentext", "Cloze"),
    typed: t("Antwort eintippen", "Type the answer"),
    choice: t("Multiple Choice", "Multiple choice"),
  };
  const pickedCount = cards.filter((c) => c.picked).length;
  const deckTitle = (id: string) => decks?.find((d) => d.pageId === id)?.title || "";
  return (
    <Modal open={open} onClose={close} title={t("Lernkarten mit KI erstellen", "Create flashcards with AI")} wide sheet className="study-ai-cards">
      <div className="study-import-body">
        {added ? (
          <p role="status">
            {added.added === 1
              ? t(`1 Karte zu „${added.title}“ hinzugefügt.`, `1 card added to “${added.title}”.`)
              : t(`${added.added} Karten zu „${added.title}“ hinzugefügt.`, `${added.added} cards added to “${added.title}”.`)}
          </p>
        ) : !result ? (
          <>
            <fieldset className="study-ai-source">
              <legend>{t("Quelle", "Source")}</legend>
              {start.pageId && (
                <label className="checkbox-label">
                  <input type="radio" name="study-ai-source" checked={kind === "page"} onChange={() => setKind("page")} />
                  {start.pageTitle ? t(`Diese Seite („${start.pageTitle}“)`, `This page (“${start.pageTitle}”)`) : t("Diese Seite", "This page")}
                </label>
              )}
              {start.pageId && start.text && (
                <label className="checkbox-label">
                  <input type="radio" name="study-ai-source" checked={kind === "selection"} onChange={() => setKind("selection")} />
                  {t(`Markierter Text (${start.text.length} Zeichen)`, `Selected text (${start.text.length} characters)`)}
                </label>
              )}
              <label className="checkbox-label">
                <input type="radio" name="study-ai-source" checked={kind === "file"} onChange={() => setKind("file")} />
                {t("PDF oder Datei", "PDF or file")}
              </label>
              <label className="checkbox-label">
                <input type="radio" name="study-ai-source" checked={kind === "text"} onChange={() => setKind("text")} />
                {t("Text einfügen", "Paste text")}
              </label>
            </fieldset>
            {kind === "file" &&
              (files === null ? (
                <p className="muted">{t("Dateien werden geladen …", "Loading files …")}</p>
              ) : files.length ? (
                <label className="study-ai-field">
                  {t("Datei", "File")}
                  <Select value={fileId} onChange={(e) => setFileId(e.target.value)}>
                    {files.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                        {f.pageTitle ? ` (${f.pageTitle})` : ""}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : (
                <p className="muted">{t("Keine PDFs oder Dokumente gefunden.", "No PDFs or documents found.")}</p>
              ))}
            {pdf && (
              <fieldset className="study-ai-pages">
                <legend>{t("Seiten", "Pages")}</legend>
                <label className="checkbox-label">
                  <input type="radio" name="study-ai-pages" checked={!range} onChange={() => setRange(null)} />
                  {pageCount ? t(`Alle Seiten (${pageCount})`, `All pages (${pageCount})`) : t("Alle Seiten", "All pages")}
                </label>
                <span className="study-ai-range">
                  <label className="checkbox-label">
                    <input type="radio" name="study-ai-pages" checked={!!range} onChange={() => setRange(start.file?.pages || { from: 1, to: Math.min(pageCount || 1, 10) })} />
                    {t("Seiten von", "Pages from")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={pageCount || undefined}
                    value={range?.from ?? ""}
                    disabled={!range}
                    aria-label={t("Erste Seite", "First page")}
                    onChange={(e) => range && setRange({ ...range, from: Number(e.target.value) })}
                  />
                  <span>{t("bis", "to")}</span>
                  <input
                    type="number"
                    min={1}
                    max={pageCount || undefined}
                    value={range?.to ?? ""}
                    disabled={!range}
                    aria-label={t("Letzte Seite", "Last page")}
                    onChange={(e) => range && setRange({ ...range, to: Number(e.target.value) })}
                  />
                </span>
                {range && pages && (
                  <p className="muted" role="status">
                    {pagesText === null
                      ? t("Die Seiten werden gelesen …", "Reading the pages …")
                      : !pagesText.trim()
                        ? t("Auf diesen Seiten steht kein lesbarer Text (z. B. ein Scan). Mit „Alle Seiten“ nimmt Flowplan den erkannten Text der Datei.", "These pages have no readable text (a scan, for example). With “All pages” Flowplan takes the file’s recognised text.")
                        : t(`Seiten ${pages.from}–${pages.to}: ${pagesText.length.toLocaleString()} Zeichen`, `Pages ${pages.from}–${pages.to}: ${pagesText.length.toLocaleString()} characters`)}
                  </p>
                )}
              </fieldset>
            )}
            {kind === "text" && (
              <label className="study-import-text">
                {t("Text", "Text")}
                <textarea value={text} rows={7} onChange={(e) => setText(e.target.value)} placeholder={t("Lernstoff hier einfügen …", "Paste the material here …")} />
              </label>
            )}
            <div className="form-row study-ai-options">
              <label>
                {t("Stapel", "Deck")}
                <Select value={deck} onChange={(e) => setDeck(e.target.value)} disabled={decks === null}>
                  {(decks || []).map((d) => (
                    <option key={d.pageId} value={d.pageId}>
                      {d.title || t("Ohne Titel", "Untitled")}
                    </option>
                  ))}
                  <option value={NEW_DECK}>{t("Neuer Stapel …", "New deck …")}</option>
                </Select>
              </label>
              {deck === NEW_DECK && (
                <>
                  <label>
                    {t("Name des Stapels", "Name of the deck")}
                    <input value={newTitle} maxLength={200} onChange={(e) => setNewTitle(e.target.value)} />
                  </label>
                  {spaces.length > 1 && (
                    <label>
                      {t("Bereich", "Space")}
                      <Select value={space} onChange={(e) => setSpace(e.target.value)}>
                        {spaces.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                </>
              )}
              <label>
                {t("Höchstens", "At most")}
                <input type="number" min={1} max={AI_CARDS_MAX} value={count} onChange={(e) => setCount(Math.max(1, Math.min(AI_CARDS_MAX, Math.round(Number(e.target.value)) || 1)))} />
              </label>
            </div>
            <fieldset className="study-ai-types">
              <legend>{t("Kartentypen", "Card types")}</legend>
              {AI_CARD_TYPES.map((type) => (
                <label key={type} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={types.includes(type)}
                    onChange={(e) => setTypes((list) => (e.target.checked ? [...list, type] : list.length > 1 ? list.filter((x) => x !== type) : list))}
                  />
                  {typeNames[type]}
                </label>
              ))}
            </fieldset>
            <label className="study-ai-field">
              {t("Schwerpunkt (optional)", "Focus (optional)")}
              <input value={focus} maxLength={500} onChange={(e) => setFocus(e.target.value)} placeholder={t("z. B. nur Begriffe und Definitionen", "e.g. only terms and definitions")} />
            </label>
            {estimate && (
              <p className="muted study-ai-estimate">
                {estimate.parts > 1
                  ? t(`Etwa ${estimate.tokens.toLocaleString()} Tokens in ${estimate.parts} Teilen.`, `About ${estimate.tokens.toLocaleString()} tokens in ${estimate.parts} parts.`)
                  : t(`Etwa ${estimate.tokens.toLocaleString()} Tokens.`, `About ${estimate.tokens.toLocaleString()} tokens.`)}
              </p>
            )}
            <p className="muted">
              {t(
                "Die KI schlägt nur Karten aus der Quelle vor; du prüfst sie, bevor etwas angelegt wird.",
                "The AI only proposes cards from the source; you review them before anything is added.",
              )}
            </p>
          </>
        ) : (
          <>
            <p className="study-ai-head">
              {cards.length === 1 ? t("1 Karte vorgeschlagen", "1 card proposed") : t(`${cards.length} Karten vorgeschlagen`, `${cards.length} cards proposed`)}
              {result.title && ` · ${t(`Quelle: „${result.title}“`, `Source: “${result.title}”`)}`}
              {source?.kind === "file" && source.pages && ` · ${t(`Seiten ${source.pages.from}–${source.pages.to}`, `pages ${source.pages.from}–${source.pages.to}`)}`}
            </p>
            {!cards.length && <p className="muted">{t("In der Quelle fand die KI nichts für Karten.", "The AI found nothing for cards in the source.")}</p>}
            <ul className="study-ai-list" aria-label={t("Vorgeschlagene Karten", "Proposed cards")}>
              {cards.map((card) => (
                <li key={card.id} className={card.picked ? "picked" : ""}>
                  <input type="checkbox" checked={card.picked} onChange={(e) => change(card.id, { picked: e.target.checked })} aria-label={t(`Übernehmen: ${card.front}`, `Take: ${card.front}`)} />
                  <div className="study-ai-card">
                    {editing === card.id ? (
                      <div className="study-ai-edit">
                        <label>
                          {card.type === "cloze" ? t("Text mit Lücken", "Text with clozes") : t("Vorderseite", "Front")}
                          <textarea rows={2} value={card.front} onChange={(e) => change(card.id, { front: e.target.value })} />
                        </label>
                        <label>
                          {card.type === "cloze" ? t("Ergänzung (optional)", "Addition (optional)") : t("Rückseite", "Back")}
                          <textarea rows={2} value={card.back} onChange={(e) => change(card.id, { back: e.target.value })} />
                        </label>
                        {card.type === "choice" && (
                          <label>
                            {t("Falsche Antworten (eine je Zeile)", "Wrong answers (one per line)")}
                            <textarea
                              rows={3}
                              value={(card.choices || []).join("\n")}
                              onChange={(e) => change(card.id, { choices: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 4) })}
                            />
                          </label>
                        )}
                        <label>
                          {t("Hinweis (optional)", "Hint (optional)")}
                          <input value={card.hint || ""} maxLength={300} onChange={(e) => change(card.id, { hint: e.target.value })} />
                        </label>
                      </div>
                    ) : (
                      <p>
                        <span className="study-ai-type">{typeNames[card.type]}</span> <span>{card.type === "cloze" ? <ClozeText text={card.front} /> : card.front}</span>
                        {card.back && (
                          <>
                            <span aria-hidden> → </span>
                            <span>{card.back}</span>
                          </>
                        )}
                        {card.choices?.length ? <span className="muted"> · {t(`falsch: ${card.choices.join(", ")}`, `wrong: ${card.choices.join(", ")}`)}</span> : null}
                      </p>
                    )}
                    <p className="study-ai-meta">
                      {card.source && <span className="muted">{t(`Quelle: „${card.source}“`, `Source: “${card.source}”`)}</span>}
                      {card.duplicate && (
                        <span className="study-ai-warning">
                          <Warning aria-hidden /> {t("ähnlich zu einer vorhandenen Karte", "similar to an existing card")}
                        </span>
                      )}
                      {card.yesNo && (
                        <span className="study-ai-warning">
                          <Warning aria-hidden /> {t("Ja/Nein-Frage", "Yes/no question")}
                        </span>
                      )}
                      <button type="button" className="button compact" onClick={() => setEditing(editing === card.id ? null : card.id)} aria-expanded={editing === card.id}>
                        <PencilSimple aria-hidden /> {editing === card.id ? t("Fertig", "Done") : t("Bearbeiten", "Edit")}
                      </button>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="form-row study-ai-options">
              <label>
                {t("Tags für alle", "Tags for all")}
                <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("z. B. Kapitel 3", "e.g. Chapter 3")} />
              </label>
              <p className="muted">
                {t("Ziel:", "Target:")} {deck === NEW_DECK ? t(`neuer Stapel „${newTitle}“`, `new deck “${newTitle}”`) : `„${deckTitle(deck)}“`}
              </p>
            </div>
          </>
        )}
        {busy === "propose" && (
          <p className="muted" role="status" aria-live="polite">
            <Sparkle aria-hidden weight="fill" /> {t("Die KI schlägt Karten vor …", "The AI is proposing cards …")}
          </p>
        )}
        {error && (
          <p className="study-error" role="alert">
            {error}
          </p>
        )}
        {!added && <AiProviderFooter />}
      </div>
      <div className="modal-actions">
        {added ? (
          <>
            {onOpenPage && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  onClose();
                  onOpenPage(added.deckId);
                }}
              >
                {t("Stapel öffnen", "Open the deck")}
              </button>
            )}
            <button type="button" className="button primary" onClick={onClose}>
              {t("Fertig", "Done")}
            </button>
          </>
        ) : !result ? (
          <>
            <button type="button" className="button" onClick={close}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" disabled={!source || !!busy || (deck === NEW_DECK && !space)} onClick={() => void propose()}>
              <Sparkle aria-hidden weight="fill" /> {t("Karten vorschlagen", "Propose cards")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() => {
                setResult(null);
                setCards([]);
              }}
            >
              {t("Zurück", "Back")}
            </button>
            <button type="button" className="button" disabled={!!busy} onClick={() => void propose(true)}>
              <ArrowsClockwise aria-hidden /> {t("Neu erzeugen", "Regenerate")}
            </button>
            <button type="button" className="button primary" disabled={!!busy || !pickedCount} onClick={() => void add()}>
              {busy === "add"
                ? t("Wird hinzugefügt …", "Adding …")
                : pickedCount === 1
                  ? t("1 Karte hinzufügen", "Add 1 card")
                  : t(`${pickedCount} Karten hinzufügen`, `Add ${pickedCount} cards`)}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
// A cloze text with its gaps marked (as React text, never HTML).
function ClozeText({ text }: { text: string }) {
  return (
    <>
      {parseClozeText(text).map((s, i) =>
        s.type === "text" ? (
          <span key={i}>{s.text}</span>
        ) : (
          <mark key={i} className="study-ai-gap" title={s.hint ? `c${s.n} · ${s.hint}` : `c${s.n}`}>
            {s.answer}
          </mark>
        ),
      )}
    </>
  );
}
export default StudyAiCards;
