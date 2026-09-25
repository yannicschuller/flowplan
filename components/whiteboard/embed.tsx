"use client";
import { useEffect, useState } from "react";
import * as Y from "yjs";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { ArrowSquareOut, PresentationChart } from "@phosphor-icons/react";
import { WhiteboardEmbed } from "@/lib/document-schema";
import { WhiteboardStatic, type PageRef } from "./render";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

type Board = { title: string; items: WhiteboardItem[] };
function decode(state: string): WhiteboardItem[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(state), (c) => c.charCodeAt(0)),
    );
    const list: WhiteboardItem[] = [];
    doc.getMap<Y.Map<unknown>>("items").forEach((value, key) => {
      if (value instanceof Y.Map)
        list.push({ ...(value.toJSON() as WhiteboardItem), id: key });
    });
    return list.sort((a, b) => (a.z || 0) - (b.z || 0));
  } finally {
    doc.destroy();
  }
}
// The board as it is now; refreshed every few seconds while shown.
export function useBoard(pageId: string) {
  const [board, setBoard] = useState<Board | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!pageId) return;
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/pages/${pageId}`, {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Nur für angemeldete Mitglieder sichtbar."
              : data.error || "Nicht verfügbar",
          );
        if (data.page?.kind !== "whiteboard" || !data.whiteboard)
          throw new Error("Diese Seite ist kein Whiteboard.");
        if (alive)
          setBoard({
            title: data.page.title,
            items: decode(data.whiteboard.state),
          });
        setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pageId]);
  return { board, error };
}
export function WhiteboardEmbedView({
  pageId,
  height = 360,
  pages = [],
}: {
  pageId: string;
  height?: number;
  pages?: PageRef[];
}) {
  const { board, error } = useBoard(pageId);
  return (
    <div className="whiteboard-embed" data-embedded-board={pageId}>
      <div className="whiteboard-embed-head">
        <PresentationChart size={16} />
        <strong>
          {board?.title || (error ? "Whiteboard" : "Whiteboard wird geladen …")}
        </strong>
        <a className="text-button" href={`/#page=${pageId}`}>
          <ArrowSquareOut size={14} /> Öffnen
        </a>
      </div>
      {error ? (
        <p className="muted whiteboard-embed-error">{error}</p>
      ) : board ? (
        board.items.length ? (
          <WhiteboardStatic items={board.items} pages={pages} height={height} />
        ) : (
          <p className="muted whiteboard-embed-error">
            Dieses Whiteboard ist noch leer.
          </p>
        )
      ) : (
        <div className="sk whiteboard-embed-loading" style={{ height }} />
      )}
    </div>
  );
}
function EmbedNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const pageId = String(node.attrs.pageId || ""),
    height = Number(node.attrs.height) || 360;
  return (
    <NodeViewWrapper className="whiteboard-embed-node" contentEditable={false}>
      <WhiteboardEmbedView pageId={pageId} height={height} />
      {editor.isEditable && (
        <div
          className="whiteboard-embed-size"
          role="group"
          aria-label="Höhe des Whiteboards"
        >
          {[
            [240, "Klein"],
            [360, "Mittel"],
            [560, "Groß"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={height === value ? "active" : ""}
              aria-pressed={height === value}
              onClick={() => updateAttributes({ height: value })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </NodeViewWrapper>
  );
}
export const whiteboardEmbedNode = () =>
  WhiteboardEmbed.extend({
    addNodeView() {
      return ReactNodeViewRenderer(EmbedNodeView, { stopEvent: () => true });
    },
  });
