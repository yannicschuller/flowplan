"use client";
// The PDF block in the editor: a card with the first page and the file name;
// a click opens the viewer. Video, audio and embeds keep their normal output.
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import type { Node as TiptapNode } from "@tiptap/core";
import { FilePdf } from "@phosphor-icons/react";
import { PdfThumbnail, openPdf } from "./pdf-viewer";
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

export function withPdfView<T extends TiptapNode>(media: T): T {
  return media.extend({
    addNodeView() {
      const pdf = ReactNodeViewRenderer(PdfCard);
      return (props) => {
        if (props.node.attrs.kind === "pdf") return pdf(props);
        // Everything else exactly as the schema renders it.
        const spec = props.node.type.spec.toDOM!(props.node);
        const { dom } = DOMSerializer.renderSpec(document, spec);
        return { dom };
      };
    },
  }) as T;
}
