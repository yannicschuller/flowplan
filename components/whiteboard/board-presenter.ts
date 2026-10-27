"use client";
// The presenter view for whiteboard presentations: the same second window
// as for documents (app/presenter, components/presenter-view.tsx), fed over
// its BroadcastChannel. Each slide is the frame drawn as SVG (lib/
// whiteboard-svg.ts – escaped text only, no scripts), the notes are the
// frame's speaker notes as escaped paragraphs.
import { useEffect, useRef } from "react";
import { presenterChannel, type Deck, type PresenterMessage } from "../presentation";
import { whiteboardSvg } from "@/lib/whiteboard-svg";
import { frameMembers } from "@/lib/whiteboard-frames";
import { connectorPoint, type WhiteboardItem } from "@/lib/whiteboard-model";
import type { PageRef, RowCard } from "./render";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function notesHtml(notes: string | undefined) {
  return (notes || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
export function boardDeck(
  title: string,
  slides: WhiteboardItem[],
  items: WhiteboardItem[],
  pages: PageRef[],
  cards: Map<string, RowCard>,
  label: (de: string, en: string) => string,
): Deck {
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    title,
    slides: slides.map((frame) => {
      const members = frameMembers(frame, items, (end) => connectorPoint(end, byId));
      const svg = whiteboardSvg(
        items.filter((i) => members.has(i.id)),
        {
          image: (src) => src,
          page: (id) => {
            const page = pages.find((p) => p.id === id);
            return page ? { title: page.title, kind: page.kind || "document" } : null;
          },
          record: (_db, rowId) => {
            const card = cards.get(rowId);
            return card ? { title: card.title, database: card.database } : null;
          },
          label,
        },
        frame.text || "",
      );
      return { html: `<div class="wb-presenter-slide">${svg || ""}</div>`, notes: notesHtml(frame.notes) };
    }),
  };
}

// Hosts the channel while the board presents; returns how to open the view.
export function useBoardPresenter(options: {
  active: boolean;
  index: number;
  deck: () => Deck;
  onGo: (index: number) => void;
}) {
  const id = useRef("");
  const channel = useRef<BroadcastChannel | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const startedAt = useRef(0);
  useEffect(() => {
    if (!options.active || typeof BroadcastChannel === "undefined") return;
    id.current = crypto.randomUUID();
    startedAt.current = Date.now();
    const bc = new BroadcastChannel(presenterChannel(id.current));
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<PresenterMessage>) => {
      const message = event.data;
      if (message?.type === "hello")
        bc.postMessage({ type: "deck", deck: latest.current.deck(), index: latest.current.index, startedAt: startedAt.current } satisfies PresenterMessage);
      else if (message?.type === "go" && Number.isInteger(message.index)) latest.current.onGo(message.index);
    };
    return () => {
      bc.postMessage({ type: "end" } satisfies PresenterMessage);
      bc.close();
      channel.current = null;
    };
  }, [options.active]);
  useEffect(() => {
    if (options.active) channel.current?.postMessage({ type: "index", index: options.index } satisfies PresenterMessage);
  }, [options.active, options.index]);
  return () => {
    if (!id.current) return;
    const url = `/presenter?deck=${encodeURIComponent(id.current)}`;
    const view = window.open(url, "flowplan-presenter", "popup,width=1100,height=720");
    if (!view) window.open(url, "_blank");
  };
}
