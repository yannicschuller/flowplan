"use client";
// The colours a board is shown in (#399): on the dark canvas the stored
// colours are mapped for display (lib/whiteboard-display-colors.ts), on the
// light one they are shown as stored. The board, its static renderings and
// the frame thumbnails put the palette in context; render.tsx and the
// element views read it. The exports draw with the light palette.
import { createContext, useContext } from "react";
import { LIGHT_PALETTE, type BoardPalette } from "@/lib/whiteboard-display-colors";

export const BoardColors = createContext<BoardPalette>(LIGHT_PALETTE);
export const useBoardColors = () => useContext(BoardColors);
// The class that gives a board's container the dark canvas's styles
// (app/whiteboard-board.css).
export const DARK_CANVAS_CLASS = "wb-dark-canvas";
