"use client";
// A presentation or text document in a document (#562): the card of the
// 3D, HTML and spreadsheet files (components/pdf-node.tsx) with a slide or
// page icon. A .pptx, .odp, .docx or .odt opens the read-only content
// preview (components/office-viewer.tsx); an old .ppt or .doc is only
// downloaded, which the card says.
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { FileDoc, FilePpt } from "@phosphor-icons/react";
import { isPresentationKind, officeKindOf } from "@/lib/office-files";
import { openOffice } from "./office-viewer";
import { useT } from "./i18n";

export function OfficeCard({ node, selected }: NodeViewProps) {
  const t = useT();
  const { src, title } = node.attrs as { src: string; title: string };
  const name = title || "Office";
  const kind = officeKindOf(name);
  const slides = isPresentationKind(kind);
  const icon = (
    <span className="model-card-icon" aria-hidden>
      {slides ? <FilePpt size={30} weight="duotone" /> : <FileDoc size={30} weight="duotone" />}
    </span>
  );
  return (
    <NodeViewWrapper className={`office-block${selected ? " is-selected" : ""}`} data-office-file="true" data-title={title} contentEditable={false}>
      {kind === "ppt" || kind === "doc" ? (
        <a className="model-card office-card" href={src} download={name} aria-label={t(`„${name}“ herunterladen`, `Download “${name}”`)}>
          {icon}
          <span className="model-card-text">
            <span className="model-card-name">{name}</span>
            <small>
              {kind === "ppt" ? "PowerPoint 97–2003" : "Word 97–2003"} · {t("nur Download", "download only")}
            </small>
          </span>
        </a>
      ) : (
        <button type="button" className="model-card office-card" onClick={() => openOffice(src, name)} aria-label={t(`Vorschau von „${name}“ öffnen`, `Open preview of “${name}”`)}>
          {icon}
          <span className="model-card-text">
            <span className="model-card-name">{name}</span>
            <small>
              {slides ? t("Präsentation", "Presentation") : t("Textdokument", "Text document")} · {t("Vorschau öffnen", "Open preview")}
            </small>
          </span>
        </button>
      )}
    </NodeViewWrapper>
  );
}
