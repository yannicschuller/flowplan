"use client";
// Embeds on the board (lib/whiteboard-embeds.ts): videos and pages of the
// allowlist and PDFs. A player shows a preview card first – nothing of the
// provider loads until someone clicks "Laden" – and then a sandboxed frame
// below a grip bar (the bar moves the element; the frame takes the
// pointer). PDFs show one page drawn with pdf.js (components/pdf-viewer.tsx)
// with page buttons; a double click opens the viewer.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CaretLeft, CaretRight, FilePdf, Play, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { loadPdf, renderPage } from "../pdf-viewer";
import { EMBED_ALLOW, EMBED_SANDBOX, boardEmbed } from "@/lib/whiteboard-embeds";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

// Which players are loaded, on this device only (a click is consent for
// this view, not for everyone on the board).
const loaded = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};
export function setEmbedLoaded(id: string, on: boolean) {
  if (on === loaded.has(id)) return;
  if (on) loaded.add(id);
  else loaded.delete(id);
  notify();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function useLoaded(id: string) {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return loaded.has(id);
}
// Pages of the PDFs shown on the board (for the page buttons).
const pageCounts = new Map<string, number>();
export const pdfPageCount = (src: string) => pageCounts.get(src) || 0;

export const EMBED_BAR = 28;

export function EmbedShape({ item, transform, interactive = true }: { item: WhiteboardItem; transform: string; interactive?: boolean }) {
  const t = useT();
  const embed = boardEmbed(item);
  const on = useLoaded(item.id);
  if (!embed)
    return (
      <g transform={transform}>
        <rect width={item.w} height={item.h} rx={10} fill="#f1f3f5" stroke="#dee2e6" />
      </g>
    );
  const w = Math.max(1, item.w),
    h = Math.max(1, item.h);
  if (embed.kind === "pdf")
    return (
      <g transform={transform}>
        <rect width={w} height={h} rx={8} fill="#ffffff" stroke="#dee2e6" filter="url(#wb-shadow)" />
        <foreignObject width={w} height={h}>
          <PdfPage item={item} src={embed.src} interactive={interactive} />
        </foreignObject>
      </g>
    );
  return (
    <g transform={transform}>
      <rect width={w} height={h} rx={10} fill="#1f2937" filter="url(#wb-shadow)" />
      <foreignObject width={w} height={h}>
        {on && interactive ? (
          <div className="wb-embed wb-embed-live">
            <div className="wb-embed-bar">
              <span>{embed.provider}</span>
              <button type="button" data-wb-embed="unload" aria-label={t("Einbettung schließen", "Close embed")} title={t("Schließen", "Close")}>
                <X size={13} />
              </button>
            </div>
            <iframe
              src={embed.src}
              title={item.text || embed.provider}
              sandbox={EMBED_SANDBOX}
              allow={EMBED_ALLOW}
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
            />
          </div>
        ) : (
          <div className="wb-embed wb-embed-preview">
            <small>{embed.provider}</small>
            <strong>{item.text || embed.provider}</strong>
            {interactive && (
              <button type="button" className="wb-embed-load" data-wb-embed="load" aria-label={t(`${embed.provider} laden`, `Load ${embed.provider}`)}>
                <Play size={16} weight="fill" /> {t("Laden", "Load")}
              </button>
            )}
            <span className="wb-embed-note">
              {t(`Erst ein Klick lädt Inhalte von ${new URL(embed.src).hostname}.`, `Content from ${new URL(embed.src).hostname} loads only after a click.`)}
            </span>
          </div>
        )}
      </foreignObject>
    </g>
  );
}

function PdfPage({ item, src, interactive }: { item: WhiteboardItem; src: string; interactive: boolean }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [count, setCount] = useState(pageCounts.get(src) || 0);
  const [failed, setFailed] = useState(false);
  const page = Math.max(1, Math.min(count || 1, Math.round(item.page || 1)));
  // Drawn for the size on the board, at most 1200 px wide.
  const width = Math.round(Math.min(1200, Math.max(120, item.w)));
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      loadPdf(src)
        .then((doc) => {
          if (!alive) return;
          pageCounts.set(src, doc.numPages);
          setCount(doc.numPages);
          if (canvas.current) return renderPage(doc, Math.min(page, doc.numPages), canvas.current, width);
        })
        .catch(() => alive && setFailed(true));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [src, page, width]);
  return (
    <div className="wb-pdf">
      <div className="wb-embed-bar">
        <FilePdf size={14} />
        <span title={item.text || "PDF"}>{item.text || "PDF"}</span>
        {interactive && count > 1 && (
          <span className="wb-pdf-nav">
            <button type="button" data-wb-pdf="prev" disabled={page <= 1} aria-label={t("Vorherige Seite", "Previous page")}>
              <CaretLeft size={12} />
            </button>
            <span>
              {page}/{count}
            </span>
            <button type="button" data-wb-pdf="next" disabled={page >= count} aria-label={t("Nächste Seite", "Next page")}>
              <CaretRight size={12} />
            </button>
          </span>
        )}
      </div>
      {failed ? (
        <p className="wb-pdf-failed">{t("PDF nicht verfügbar", "PDF not available")}</p>
      ) : (
        <canvas ref={canvas} className="wb-pdf-page" aria-label={t(`Seite ${page} von ${item.text || "PDF"}`, `Page ${page} of ${item.text || "PDF"}`)} />
      )}
    </div>
  );
}
