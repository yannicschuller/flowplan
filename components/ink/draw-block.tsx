"use client";
// The drawing block of documents ("/draw", lib/draw-block-node.ts). This
// part comes with the editor and stays small; the ink engine loads with the
// first drawing block shown (draw-block-editor.tsx).
import { lazy, Suspense } from "react";
import { loadView } from "@/components/view-fallback";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { DrawBlock, DRAW_BLOCK_WIDTH, drawBlockHeight } from "@/lib/draw-block-node";
import { useT } from "../i18n";

const DrawBlockEditor = lazy(() => loadView(() => import("./draw-block-editor")));

function DrawBlockView(props: NodeViewProps) {
  const t = useT();
  const height = drawBlockHeight(props.node.attrs.height);
  return (
    <NodeViewWrapper className="ink-block-node" contentEditable={false} data-ink-block={String(props.node.attrs.id || "")}>
      <Suspense
        fallback={
          <div className="ink-block ink-block-loading" style={{ aspectRatio: `${DRAW_BLOCK_WIDTH} / ${height}` }} role="status">
            {t("Zeichnung wird geladen …", "Loading drawing …")}
          </div>
        }
      >
        <DrawBlockEditor {...props} />
      </Suspense>
    </NodeViewWrapper>
  );
}

export type DrawBlockOptions = { pageId: string; enabled: boolean };
export const drawBlockNode = (options: DrawBlockOptions) =>
  DrawBlock.extend<DrawBlockOptions>({
    addOptions: () => options,
    addNodeView() {
      // Pointer and key events inside belong to the drawing, not the text.
      return ReactNodeViewRenderer(DrawBlockView, { stopEvent: () => true });
    },
  });
