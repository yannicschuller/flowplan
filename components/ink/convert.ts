"use client";
// "Convert to text" for a lasso selection: the device recognises the
// selected pen strokes (lib/ink/recognition.ts); the strokes make way for
// the text – as a text annotation in their place (notebooks, PDFs) or
// handed to `onText` (a drawing block puts a paragraph below itself). One
// undo step of the ink.
import type { PageSize } from "@/lib/ink/coords";
import { itemBounds, unionBox } from "@/lib/ink/geometry";
import { inkId, type InkText } from "@/lib/ink/model";
import { convertedTextPlacement, recognitionId, recognitionRequest, recognizeInk } from "@/lib/ink/recognition";
import type { InkEditor } from "./use-ink-editor";

export type ConvertResult = "done" | "empty" | "failed";

export async function convertSelection(editor: InkEditor, size: PageSize, onText?: (text: string) => void): Promise<ConvertResult> {
  const selection = editor.selection;
  if (!selection) return "empty";
  const pens = editor.selectedItems().filter((i) => i.type === "pen");
  const request = recognitionRequest(recognitionId("convert"), size, pens);
  if (!request) return "empty";
  const result = await recognizeInk(request);
  if (!result) return "failed";
  if (!result.text.trim()) return "empty";
  const ids = new Set(pens.map((p) => p.id));
  const box = unionBox(pens.map(itemBounds));
  if (onText) {
    editor.change(selection.page, (items) => items.filter((i) => !ids.has(i.id)));
    onText(result.text);
  } else {
    const at = convertedTextPlacement(result, box || { x: 0, y: 0, w: 0, h: 0 });
    const text: InkText = { id: inkId(), type: "text", color: pens[0]?.color || "#1f1f1f", size: at.size, x: at.x, y: at.y, text: result.text };
    editor.change(selection.page, (items) => [...items.filter((i) => !ids.has(i.id)), text]);
  }
  editor.setSelection(null);
  return "done";
}
