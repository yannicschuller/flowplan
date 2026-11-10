"use client";
// For other parts of the notebook (e.g. the lasso's "Als Überschrift ins
// Inhaltsverzeichnis"): adds a heading to the table of contents of a
// notebook and lets the open notebook view take the new state.
//
//   await addOutlineHeading(pageId, { sheetId, title, y, level });
//
// `y`: where on the sheet (points from the top; the overview jumps there),
// `level`: 0 chapter, 1 sub-chapter, 2 section. The entry goes into the
// contents in sheet order (lib/notebook-organize-model.ts outlineInsert).
import { api } from "../ui";

export const NOTEBOOK_STRUCTURE_EVENT = "flowplan:notebook-structure";
export type NotebookStructureEvent = CustomEvent<{ pageId: string; answer: unknown }>;

export async function addOutlineHeading(pageId: string, heading: { sheetId: string; title: string; y?: number; level?: 0 | 1 | 2 }) {
  const answer = await api<{ entry: string }>("/api/command", { action: "notebook.outline.add", pageId, ...heading });
  window.dispatchEvent(new CustomEvent(NOTEBOOK_STRUCTURE_EVENT, { detail: { pageId, answer } }));
  return answer;
}
