"use client";
// Embeds on the board (lib/whiteboard-embeds.ts): videos and pages of the
// allowlist and PDFs. A player shows a preview card first – nothing of the
// provider loads until someone clicks "Laden" – and then a sandboxed frame
// below a grip bar (the bar moves the element; the frame takes the
// pointer). PDFs show one page drawn with pdf.js, sharp at any zoom and
// with their annotations (pdf-board-page.tsx, #455), with page buttons; a
// double click opens the viewer.
import { useSyncExternalStore } from "react";
import { Play, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { PdfBoardPage } from "./pdf-board-page";
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
export { pdfPageCount } from "./pdf-board-page";

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
          <PdfBoardPage item={item} src={embed.src} interactive={interactive} />
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
