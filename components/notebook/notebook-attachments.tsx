"use client";
// PDFs attached to a notebook without becoming sheets (#392, lib/notebook.ts
// notebooks.attachments): a strip above the sheets; a tap opens one in the
// side panel beside the sheets (components/pdf-panel.tsx), where it is read,
// annotated and cut from while writing. And the captions of pictures taken
// from a PDF page (InkImage.source): a chip below the picture that opens
// the panel at that page.
import { FilePdf, SidebarSimple, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { openPdfPanel } from "../pdf-viewer";
import { clipHref } from "@/lib/pdf-clip";
import type { PageSize } from "@/lib/ink/coords";
import type { InkItem } from "@/lib/ink/model";
import type { NotebookAttachment } from "@/lib/notebook";

export function NotebookAttachments({
  attachments,
  fileUrl,
  canEdit,
  onDetach,
}: {
  attachments: NotebookAttachment[];
  fileUrl: (file: string) => string;
  canEdit: boolean;
  onDetach: (fileId: string) => void;
}) {
  const t = useT();
  if (!attachments.length) return null;
  return (
    <div className="notebook-attachments" role="group" aria-label={t("Anhänge", "Attachments")}>
      <span className="notebook-attachments-label">{t("Anhänge", "Attachments")}</span>
      {attachments.map((a) => (
        <span key={a.id} className="notebook-attachment" data-pdf-src={fileUrl(a.id)} data-pdf={a.name}>
          <button
            type="button"
            onClick={() => openPdfPanel(fileUrl(a.id), a.name)}
            title={t("Im Seitenfenster öffnen", "Open in side panel")}
            aria-label={t(`„${a.name}“ im Seitenfenster öffnen`, `Open “${a.name}” in the side panel`)}
          >
            <FilePdf size={16} aria-hidden="true" />
            <span>{a.name}</span>
            <SidebarSimple size={14} aria-hidden="true" />
          </button>
          {canEdit && (
            <button
              type="button"
              className="icon-button"
              aria-label={t(`Anhang „${a.name}“ entfernen`, `Remove attachment “${a.name}”`)}
              title={t("Anhang entfernen (die Datei bleibt auf der Seite)", "Remove attachment (the file stays on the page)")}
              onClick={() => onDetach(a.id)}
            >
              <X size={13} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

// Below every picture with a source: "Name.pdf, S. 3" – the PDF page it
// was taken from (the link opens the side panel there).
export function SheetSources({ items, size, fileUrl }: { items: InkItem[] | undefined; size: PageSize; fileUrl: (file: string) => string }) {
  const t = useT();
  const sourced = (items || []).flatMap((item) => (item.type === "image" && item.source ? [item] : []));
  if (!sourced.length) return null;
  const pct = (v: number, of: number) => `${(v / (of || 1)) * 100}%`;
  return (
    <div className="notebook-links ink-ui">
      {sourced.map((item) => {
        const { file, page, title } = item.source!;
        const caption = t(`${title}, S. ${page}`, `${title}, p. ${page}`);
        return (
          <a
            key={item.id}
            className="notebook-source-chip"
            href={clipHref(fileUrl(file), page)}
            data-pdf={title}
            style={{ left: pct(item.x, size.width), top: pct(item.y + item.h, size.height) }}
            title={t("Im Seitenfenster an dieser Seite öffnen", "Open in the side panel at this page")}
            draggable={false}
          >
            <FilePdf size={12} aria-hidden="true" />
            {caption}
          </a>
        );
      })}
    </div>
  );
}
