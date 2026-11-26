"use client";
// The content preview of presentations and text documents (#562), opened
// by openOffice() through OfficeViewerHost (components/office-viewer.tsx)
// and loaded on first use. Read-only: the content comes as plain text and
// picture names from the preview route (lib/office-preview.ts) and is
// shown as React text, never as HTML. A presentation shows one slide at a
// time – title, paragraphs with their list levels, tables, pictures and
// the speaker notes (folded) – with buttons, arrow keys and, on touch
// screens, a swipe to the next or previous one; on wide screens a list of
// the slides beside it. A text document is one scrolling page of headings,
// paragraphs, lists, tables and pictures. Neither keeps the layout, which
// the note under the bar says. Indents are classes (no style attributes,
// proxy.ts).
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CaretLeft, CaretRight, DownloadSimple, FileDoc, FilePpt, ImageBroken, Info, X } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { localeTag } from "@/lib/i18n";
import { isPresentationKind, listNumbers, officeImageUrl, officeKindOf, officePreviewUrl, type OfficeBlock, type OfficePreview } from "@/lib/office-files";
import "@/app/viewer3d.css";
import "@/app/office-viewer.css";

type State = { status: "loading" } | { status: "ready"; data: OfficePreview } | { status: "large" | "missing" | "unreadable" | "failed" };

const BULLETS = ["•", "◦", "▪"];

function Picture({ src }: { src: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p className="office-image-missing">
        <ImageBroken size={18} aria-hidden /> {t("Dieses Bild kann die Vorschau nicht zeigen.", "The preview cannot show this picture.")}
      </p>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="office-image" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function Blocks({ blocks, src }: { blocks: OfficeBlock[]; src: string }) {
  const numbers = useMemo(() => listNumbers(blocks), [blocks]);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          const Tag = (["h2", "h3", "h4", "h5", "h6", "h6"] as const)[Math.min(5, Math.max(0, block.level - 1))];
          return (
            <Tag key={i} className={`office-heading office-h${block.level}`}>
              {block.text}
            </Tag>
          );
        }
        if (block.type === "paragraph") {
          const level = `office-level-${Math.min(8, block.level)}`;
          if (!block.list)
            return (
              <p key={i} className={`office-paragraph ${level}`}>
                {block.text}
              </p>
            );
          return (
            <p key={i} className={`office-paragraph office-item ${level}`}>
              <span className="office-marker" aria-hidden>
                {block.list === "number" ? `${numbers[i] ?? 1}.` : BULLETS[block.level % BULLETS.length]}
              </span>
              <span className="office-item-text">{block.text}</span>
            </p>
          );
        }
        if (block.type === "table") {
          const columns = Math.max(...block.rows.map((row) => row.length));
          return (
            <div key={i} className="office-table-wrap">
              <table className="office-table">
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {Array.from({ length: columns }, (_, c) => (
                        <td key={c}>{row[c]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <Picture key={i} src={officeImageUrl(src, block.image)} />;
      })}
    </>
  );
}

export default function OfficeViewerDialog({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const t = useT();
  const locale = localeTag(useLocale());
  const name = title || "Office";
  const kind = officeKindOf(name);
  const presentation = isPresentationKind(kind);
  const [state, setState] = useState<State>({ status: "loading" });
  const [index, setIndex] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(officePreviewUrl(src), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const s = response.status;
          return setState({ status: s === 413 ? "large" : s === 422 ? "unreadable" : [403, 404, 410, 415].includes(s) ? "missing" : "failed" });
        }
        setState({ status: "ready", data: (await response.json()) as OfficePreview });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [src]);

  const data = state.status === "ready" ? state.data : null;
  const slides = data?.slides ?? null;
  const count = slides?.length ?? 0;
  const go = (to: number) => setIndex(Math.min(Math.max(0, count - 1), Math.max(0, to)));
  const goRef = useRef({ go, index, count });
  goRef.current = { go, index, count };

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") return closeRef.current();
      const { go, index, count } = goRef.current;
      if (!count) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true]")) return;
      const step = ({ ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 } as Record<string, number>)[event.key];
      if (event.key === "Home") go(0);
      else if (event.key === "End") go(count - 1);
      else if (step) go(index + step);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", key);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previous;
      opener?.focus?.();
    };
  }, []);
  // A new slide starts at its top, and its entry in the list stays in view.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    outline.current?.querySelector<HTMLElement>("[aria-current=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  // A swipe sideways on a touch screen: the next or previous slide.
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const down = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") return;
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const up = (event: ReactPointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(index + (dx < 0 ? 1 : -1));
  };

  const number = (n: number) => n.toLocaleString(locale);
  const slide = slides?.[Math.min(index, Math.max(0, count - 1))];
  const format = kind ? kind.toUpperCase() : "";

  return (
    <div className="viewer3d office-viewer" role="dialog" aria-modal="true" aria-label={name} ref={dialog} tabIndex={-1}>
      <header className="viewer3d-bar">
        {presentation ? <FilePpt size={20} aria-hidden /> : <FileDoc size={20} aria-hidden />}
        <strong title={name}>{name}</strong>
        <span className="viewer3d-format">{format}</span>
        <span className="viewer3d-actions">
          <a className="icon-button" href={src} download={name} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
            <DownloadSimple size={18} />
          </a>
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      {data && (
        <p className="office-viewer-note">
          <Info size={16} aria-hidden />
          <span>
            {t("Inhaltsvorschau – nicht das genaue Layout. Das Original bekommst du mit dem Download.", "Content preview – not the exact layout. Download the file for the original.")}
            {data.truncated &&
              ` ${t("Die Datei ist sehr umfangreich, gezeigt wird nur der Anfang.", "The file is very large; only its beginning is shown.")}`}
          </span>
        </p>
      )}
      <div className="viewer3d-stage office-viewer-stage">
        {slides && count > 0 && slide && (
          <div className="office-slides">
            <nav className="office-outline" aria-label={t("Folien", "Slides")} ref={outline}>
              <ol>
                {slides.map((s, i) => (
                  <li key={i}>
                    <button type="button" aria-current={i === index} onClick={() => go(i)}>
                      <span className="office-outline-number">{number(i + 1)}</span>
                      <span className="office-outline-title">{s.title || t(`Folie ${number(i + 1)}`, `Slide ${number(i + 1)}`)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="office-scroll" ref={scroller} tabIndex={0} onPointerDown={down} onPointerUp={up} onPointerCancel={() => (swipe.current = null)} aria-label={t("Folie", "Slide")}>
              <article className="office-slide" aria-roledescription={t("Folie", "Slide")} aria-label={t(`Folie ${number(index + 1)} von ${number(count)}`, `Slide ${number(index + 1)} of ${number(count)}`)}>
                {slide.title && <h2 className="office-slide-title">{slide.title}</h2>}
                <Blocks blocks={slide.blocks} src={src} />
                {!slide.title && !slide.blocks.length && <p className="office-empty">{t("Diese Folie enthält keinen Text.", "This slide has no text.")}</p>}
              </article>
              {slide.notes.length > 0 && (
                <details className="office-notes" open={notesOpen} onToggle={(e) => setNotesOpen(e.currentTarget.open)}>
                  <summary>{t("Notizen", "Notes")}</summary>
                  {slide.notes.map((note, i) => (
                    <p key={i}>{note}</p>
                  ))}
                </details>
              )}
            </div>
          </div>
        )}
        {slides && count === 0 && <p className="viewer3d-message">{t("Diese Präsentation hat keine Folien.", "This presentation has no slides.")}</p>}
        {data?.blocks && (
          <div className="office-scroll" ref={scroller} tabIndex={0} aria-label={t("Dokument", "Document")}>
            <article className="office-page">
              <Blocks blocks={data.blocks} src={src} />
              {!data.blocks.length && <p className="office-empty">{t("Dieses Dokument ist leer.", "This document is empty.")}</p>}
            </article>
          </div>
        )}
        {state.status === "loading" && (
          <p className="viewer3d-message" role="status">
            {t("Vorschau wird geladen …", "Loading preview …")}
          </p>
        )}
        {state.status !== "loading" && state.status !== "ready" && (
          <div className="viewer3d-message is-error office-viewer-problem" role="alert">
            <p>
              {state.status === "large"
                ? t("Die Datei ist zu groß für die Vorschau. Du kannst sie herunterladen.", "The file is too large for the preview. You can download it.")
                : state.status === "missing"
                  ? t("Diese Datei ist nicht (mehr) verfügbar.", "This file is not available (any more).")
                  : state.status === "unreadable"
                    ? t("Die Datei konnte nicht gelesen werden. Du kannst sie herunterladen.", "The file could not be read. You can download it.")
                    : t("Die Vorschau konnte nicht geladen werden.", "The preview could not be loaded.")}
            </p>
            {state.status !== "missing" && (
              <a className="button" href={src} download={name}>
                <DownloadSimple size={16} aria-hidden /> {t("Herunterladen", "Download")}
              </a>
            )}
          </div>
        )}
      </div>
      {slides && count > 0 && (
        <footer className="office-pager">
          <button type="button" className="viewer3d-tool" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t("Vorherige Folie", "Previous slide")} title={t("Vorherige Folie (←)", "Previous slide (←)")}>
            <CaretLeft size={18} aria-hidden />
          </button>
          <span className="office-pager-count" role="status" aria-label={t(`Folie ${number(index + 1)} von ${number(count)}`, `Slide ${number(index + 1)} of ${number(count)}`)}>
            {number(index + 1)} / {number(count)}
          </span>
          <button type="button" className="viewer3d-tool" onClick={() => go(index + 1)} disabled={index >= count - 1} aria-label={t("Nächste Folie", "Next slide")} title={t("Nächste Folie (→)", "Next slide (→)")}>
            <CaretRight size={18} aria-hidden />
          </button>
        </footer>
      )}
    </div>
  );
}
