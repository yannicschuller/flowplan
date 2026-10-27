"use client";
// What the diagram features (shape library, imports, prototypes, timelines)
// need from the board. components/whiteboard/whiteboard.tsx provides it, so
// these features live in their own files and the board only wires them up.
import { createContext, useContext } from "react";
import type { Point, WhiteboardItem } from "@/lib/whiteboard-model";
import type { BoardDraft } from "@/lib/whiteboard-import";
import type { DiagramSource } from "@/lib/whiteboard-diagram-import";
import type { PageRef } from "./render";

export type DiagramPanel =
  | { kind: "library" }
  | { kind: "import"; text?: string; source?: DiagramSource; error?: string }
  | { kind: "player"; start?: string }
  | { kind: "timeline"; id: string };

export type BoardApi = {
  pageId: string;
  editable: boolean;
  zoom: number;
  // Phones and narrow panes (the board's compact layout).
  dock: boolean;
  items: WhiteboardItem[];
  byId: Map<string, WhiteboardItem>;
  // The item as it is in the shared document right now (the render state
  // may lag behind quick successive edits).
  live: (id: string) => WhiteboardItem | undefined;
  selection: ReadonlySet<string>;
  select: (ids: string[]) => void;
  // One undoable step (several calls within a moment merge).
  transact: (fn: () => void) => void;
  setProps: (id: string, props: Partial<WhiteboardItem>) => void;
  // Ends the current undo step, so the next change is a step of its own.
  stopCapturing: () => void;
  // Inserts drafts with local ids around a point (default: the view's middle).
  insertDrafts: (drafts: BoardDraft[], at?: Point) => WhiteboardItem[];
  fit: (items: WhiteboardItem[]) => void;
  center: () => Point;
  pages: PageRef[];
  onError: (message: string) => void;
  open: (panel: DiagramPanel) => void;
  close: () => void;
};
export const BoardContext = createContext<BoardApi | null>(null);
export const useBoard = () => useContext(BoardContext);
