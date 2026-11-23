"use client";
// "Seiten auswählen" (#455): before a PDF goes onto the whiteboard (upload,
// drop, paste), which of its pages – all, ranges like "1-3, 7", or ticked
// in the thumbnails – and whether they come as one element with page
// buttons (limited to those pages) or as one element per page, side by
// side. The PDF is read on this device; nothing is uploaded before "Add".
// Thumbnails are drawn only when they scroll into view (large PDFs).
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { loadPdfFile, renderPage, type PdfDocument } from "../pdf-viewer";
import { formatPageRanges, parsePageRanges } from "@/lib/whiteboard-pdf-pages";

// One element per page: at most this many at once.
export const MAX_SEPARATE_PAGES = 50;
export type PdfPagesChoice = { pages: number[]; separate: boolean; doc: PdfDocument };

function Thumbnail({ doc, number, checked, onToggle }: { doc: PdfDocument; number: number; checked: boolean; onToggle: () => void }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(number <= 12);
  useEffect(() => {
    const el = canvas.current;
    if (!el || near || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setNear(true), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near || !canvas.current) return;
    void renderPage(doc, number, canvas.current, 110).catch(() => {});
  }, [doc, number, near]);
  return (
    <label className={`wb-pdf-pick-page${checked ? " is-checked" : ""}`}>
      <canvas ref={canvas} aria-hidden="true" />
      <span>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={t(`Seite ${number}`, `Page ${number}`)} />
        {number}
      </span>
    </label>
  );
}

export function PdfPagesDialog({
  file,
  onClose,
  onAdd,
  onError,
}: {
  file: File;
  onClose: () => void;
  onAdd: (choice: PdfPagesChoice) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [ranges, setRanges] = useState("");
  const [rangeError, setRangeError] = useState(false);
  const [separate, setSeparate] = useState(false);
  const [busy, setBusy] = useState(false);
  // Handed over with "Add" (the board keeps it for the uploaded file);
  // otherwise freed on closing.
  const handed = useRef(false);
  useEffect(() => {
    if (!doc) return;
    return () => {
      if (!handed.current) void doc.loadingTask.destroy();
    };
  }, [doc]);
  useEffect(() => {
    let alive = true;
    loadPdfFile(file)
      .then((loaded) => {
        if (!alive) return;
        setDoc(loaded);
        const all = Array.from({ length: loaded.numPages }, (_, i) => i + 1);
        setPicked(new Set(all));
        setRanges(formatPageRanges(all));
      })
      .catch(() => {
        if (!alive) return;
        onError(t("Die PDF-Datei lässt sich nicht lesen.", "The PDF file cannot be read."));
        onClose();
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);
  const count = doc?.numPages || 0;
  const numbers = useMemo(() => Array.from({ length: count }, (_, i) => i + 1), [count]);
  const choose = (pages: Iterable<number>) => {
    const next = new Set(pages);
    setPicked(next);
    setRanges(formatPageRanges([...next]));
    setRangeError(false);
  };
  const list = [...picked].sort((a, b) => a - b);
  const tooMany = separate && list.length > MAX_SEPARATE_PAGES;
  return (
    <Modal
      open
      onClose={onClose}
      title={t("Seiten auswählen", "Choose pages")}
      subtitle={file.name}
      className="wb-pdf-pick"
      wide
      sheet
      actions={
        <>
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!doc || !list.length || rangeError || tooMany || busy}
            onClick={async () => {
              if (!doc) return;
              setBusy(true);
              handed.current = true;
              try {
                await onAdd({ pages: list, separate, doc });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? t("Wird hochgeladen …", "Uploading …")
              : list.length === 1
                ? t("1 Seite hinzufügen", "Add 1 page")
                : t(`${list.length} Seiten hinzufügen`, `Add ${list.length} pages`)}
          </button>
        </>
      }
    >
      {!doc ? (
        <p className="muted">{t("PDF wird gelesen …", "Reading PDF …")}</p>
      ) : (
        <>
          <div className="wb-pdf-pick-ranges">
            <label htmlFor="wb-pdf-pick-ranges">{t("Seiten", "Pages")}</label>
            <input
              id="wb-pdf-pick-ranges"
              value={ranges}
              placeholder={t("z. B. 1-3, 7", "e.g. 1-3, 7")}
              aria-invalid={rangeError}
              aria-describedby="wb-pdf-pick-help"
              onChange={(e) => {
                setRanges(e.target.value);
                const parsed = parsePageRanges(e.target.value, count);
                setRangeError(!parsed);
                if (parsed) setPicked(new Set(parsed));
              }}
            />
            <button type="button" className="button compact" onClick={() => choose(numbers)}>
              {t("Alle", "All")}
            </button>
            <button type="button" className="button compact" onClick={() => choose([])}>
              {t("Keine", "None")}
            </button>
          </div>
          <p id="wb-pdf-pick-help" className={rangeError ? "error" : "muted"}>
            {rangeError
              ? t(`Bitte Seiten von 1 bis ${count} angeben, z. B. 1-3, 7.`, `Please give pages from 1 to ${count}, e.g. 1-3, 7.`)
              : t(`${list.length} von ${count} Seiten ausgewählt.`, `${list.length} of ${count} pages selected.`)}
          </p>
          <div className="wb-pdf-pick-grid" role="group" aria-label={t("Seiten der PDF", "Pages of the PDF")}>
            {numbers.map((n) => (
              <Thumbnail
                key={n}
                doc={doc}
                number={n}
                checked={picked.has(n)}
                onToggle={() => {
                  const next = new Set(picked);
                  if (next.has(n)) next.delete(n);
                  else next.add(n);
                  choose(next);
                }}
              />
            ))}
          </div>
          <fieldset className="wb-pdf-pick-mode">
            <legend>{t("Auf dem Board", "On the board")}</legend>
            <label>
              <input type="radio" name="wb-pdf-mode" checked={!separate} onChange={() => setSeparate(false)} />
              {t("Ein Element mit Seitenwechsel", "One element with page buttons")}
            </label>
            <label>
              <input type="radio" name="wb-pdf-mode" checked={separate} onChange={() => setSeparate(true)} />
              {t("Jede Seite als eigenes Element", "Each page as its own element")}
            </label>
            {tooMany && (
              <p className="error" role="alert">
                {t(`Höchstens ${MAX_SEPARATE_PAGES} Seiten als eigene Elemente.`, `At most ${MAX_SEPARATE_PAGES} pages as separate elements.`)}
              </p>
            )}
          </fieldset>
        </>
      )}
    </Modal>
  );
}
