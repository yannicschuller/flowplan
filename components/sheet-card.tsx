"use client";
// A spreadsheet in a document (#402): the card of the 3D and HTML files
// (components/pdf-node.tsx) with a table icon. A .csv or .xlsx opens the
// read-only viewer (components/sheet-viewer.tsx); an old .xls is only
// downloaded, which the card says.
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { FileCsv, FileXls } from "@phosphor-icons/react";
import { sheetKindOf } from "@/lib/sheet-files";
import { openSheet } from "./sheet-viewer";
import { useT } from "./i18n";

export function SheetCard({ node, selected }: NodeViewProps) {
  const t = useT();
  const { src, title } = node.attrs as { src: string; title: string };
  const name = title || "CSV";
  const kind = sheetKindOf(name);
  const icon = (
    <span className="model-card-icon" aria-hidden>
      {kind === "csv" ? <FileCsv size={30} weight="duotone" /> : <FileXls size={30} weight="duotone" />}
    </span>
  );
  return (
    <NodeViewWrapper className={`sheet-block${selected ? " is-selected" : ""}`} data-sheet-file="true" data-title={title} contentEditable={false}>
      {kind === "xls" ? (
        <a className="model-card sheet-card" href={src} download={name} aria-label={t(`„${name}“ herunterladen`, `Download “${name}”`)}>
          {icon}
          <span className="model-card-text">
            <span className="model-card-name">{name}</span>
            <small>Excel 97–2003 · {t("nur Download", "download only")}</small>
          </span>
        </a>
      ) : (
        <button type="button" className="model-card sheet-card" onClick={() => openSheet(src, name)} aria-label={t(`Vorschau von „${name}“ öffnen`, `Open preview of “${name}”`)}>
          {icon}
          <span className="model-card-text">
            <span className="model-card-name">{name}</span>
            <small>
              {t("Tabelle", "Spreadsheet")} · {t("Vorschau öffnen", "Open preview")}
            </small>
          </span>
        </button>
      )}
    </NodeViewWrapper>
  );
}
