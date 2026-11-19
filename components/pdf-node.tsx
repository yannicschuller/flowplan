"use client";
// The PDF block in the editor: a card with the first page and the file name;
// a click opens the viewer. A 3D file (#384) gets a card that opens the 3D
// viewer (components/model-viewer.tsx); three.js loads only then. A DXF or
// DWG drawing gets the same card for the drawing viewer. Video,
// audio and embeds keep their normal output.
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import type { Node as TiptapNode } from "@tiptap/core";
import { Blueprint, Cube, FilePdf } from "@phosphor-icons/react";
import { PdfThumbnail, openPdf } from "./pdf-viewer";
import { openModel } from "./model-viewer";
import { MODEL_FORMAT_LABELS, isDrawingFormat, modelFormatOf } from "@/lib/model-formats";
import { useT } from "./i18n";

function PdfCard({ node, selected }: NodeViewProps) {
  const t = useT();
  const { src, title, width } = node.attrs as { src: string; title: string; width: number };
  return (
    <NodeViewWrapper
      className={`pdf-block${selected ? " is-selected" : ""}`}
      data-pdf={src}
      data-title={title}
      style={width && width !== 100 ? { width: `${width}%` } : undefined}
      contentEditable={false}
    >
      <button
        type="button"
        className="pdf-card"
        onClick={() => openPdf(src, title || "PDF")}
        aria-label={t(`PDF „${title || "PDF"}“ öffnen`, `Open PDF “${title || "PDF"}”`)}
      >
        <PdfThumbnail src={src} width={260} />
        <span className="pdf-card-name">
          <FilePdf size={16} /> {title || "PDF"}
        </span>
      </button>
    </NodeViewWrapper>
  );
}

function ModelCard({ node, selected }: NodeViewProps) {
  const t = useT();
  // A card of its own size: no width (and no style attribute).
  const { src, title } = node.attrs as { src: string; title: string };
  const name = title || "3D";
  const format = modelFormatOf(name);
  const drawing = isDrawingFormat(format);
  return (
    <NodeViewWrapper
      className={`model-block${selected ? " is-selected" : ""}`}
      data-model={src}
      data-title={title}
      contentEditable={false}
    >
      <button
        type="button"
        className="model-card"
        onClick={() => openModel(src, name)}
        aria-label={drawing ? t(`Zeichnung „${name}“ öffnen`, `Open drawing “${name}”`) : t(`3D-Modell „${name}“ öffnen`, `Open 3D model “${name}”`)}
      >
        <span className="model-card-icon" aria-hidden>
          {drawing ? <Blueprint size={30} weight="duotone" /> : <Cube size={30} weight="duotone" />}
        </span>
        <span className="model-card-text">
          <span className="model-card-name">{name}</span>
          <small>
            {format ? `${MODEL_FORMAT_LABELS[format]} · ` : ""}
            {drawing ? t("Im Zeichnungs-Viewer öffnen", "Open in drawing viewer") : t("Im 3D-Viewer öffnen", "Open in 3D viewer")}
          </small>
        </span>
      </button>
    </NodeViewWrapper>
  );
}

export function withPdfView<T extends TiptapNode>(media: T): T {
  return media.extend({
    addNodeView() {
      const pdf = ReactNodeViewRenderer(PdfCard);
      const model = ReactNodeViewRenderer(ModelCard);
      return (props) => {
        if (props.node.attrs.kind === "pdf") return pdf(props);
        if (props.node.attrs.kind === "model") return model(props);
        // Everything else exactly as the schema renders it.
        const spec = props.node.type.spec.toDOM!(props.node);
        const { dom } = DOMSerializer.renderSpec(document, spec);
        return { dom };
      };
    },
  }) as T;
}
