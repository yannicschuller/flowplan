"use client";
import { serverMessage } from "@/lib/server-message";
import { useT } from "../i18n";
import { lazy, Suspense, useEffect, useState } from "react";
import * as Y from "yjs";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useEditorEditable } from "../editor-editable";
import type { NodeViewProps } from "@tiptap/react";
import { ArrowSquareOut, PresentationChart } from "@phosphor-icons/react";
import { WhiteboardEmbed } from "@/lib/document-schema";
import type { PageRef } from "./render";
import { loadView } from "../view-fallback";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { PageIcon } from "../ui";
import { shownPageIcon } from "@/lib/page-link-icons";

// The board's renderer (shapes, racks, timelines … about 55 KB) loads with
// the first embedded board, not with every document.
const loadStatic = () => import("./render").then((m) => ({ default: m.WhiteboardStatic }));
const WhiteboardStatic = lazy(() => loadView(loadStatic));
type Board = { title: string; icon: string; items: WhiteboardItem[] };
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
  const t = useT();
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
              ? t("Nur für angemeldete Mitglieder sichtbar.", "Only visible to signed-in members.")
              : serverMessage(data.error) || t("Nicht verfügbar", "Not available"),
          );
        if (data.page?.kind !== "whiteboard" || !data.whiteboard)
          throw new Error(t("Diese Seite ist kein Whiteboard.", "This page is not a whiteboard."));
        if (alive)
          setBoard({
            title: data.page.title,
            icon: data.page.icon || "",
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
  const t = useT();
  const { board, error } = useBoard(pageId);
  // Fetched alongside the board's data.
  useEffect(() => void loadStatic().catch(() => {}), []);
  const loading = <div className="sk whiteboard-embed-loading" style={{ height }} />;
  return (
    <div className="whiteboard-embed" data-embedded-board={pageId}>
      <div className="whiteboard-embed-head">
        {/* The board's own icon (#96). */}
        {board ? <PageIcon name={shownPageIcon(board.icon, "whiteboard")} size={16} /> : <PresentationChart size={16} />}
        <strong>
          {board?.title || (error ? t("Whiteboard", "Whiteboard") : t("Whiteboard wird geladen …", "Loading whiteboard …"))}
        </strong>
        <a className="text-button" href={`/#page=${pageId}`}>
          <ArrowSquareOut size={14} /> {t("Öffnen", "Open")}
        </a>
      </div>
      {error ? (
        <p className="muted whiteboard-embed-error">{error}</p>
      ) : board ? (
        board.items.length ? (
          <Suspense fallback={loading}>
            <WhiteboardStatic items={board.items} pages={pages} height={height} />
          </Suspense>
        ) : (
          <p className="muted whiteboard-embed-error">
            {t("Dieses Whiteboard ist noch leer.", "This whiteboard is still empty.")}
          </p>
        )
      ) : (
        loading
      )}
    </div>
  );
}
function EmbedNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const t = useT();
  const pageId = String(node.attrs.pageId || ""),
    height = Number(node.attrs.height) || 360,
    editable = useEditorEditable(editor);
  return (
    <NodeViewWrapper className="whiteboard-embed-node" contentEditable={false}>
      <WhiteboardEmbedView pageId={pageId} height={height} />
      {editable && (
        <div
          className="whiteboard-embed-size"
          role="group"
          aria-label={t("Höhe des Whiteboards", "Whiteboard height")}
        >
          {[
            [240, t("Klein", "Small")],
            [360, t("Mittel", "Medium")],
            [560, t("Groß", "Large")],
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
