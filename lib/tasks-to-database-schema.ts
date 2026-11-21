// The input of "page.tasksToDatabase" and its undo (#420,
// lib/tasks-to-database.ts) – plain data and zod, for lib/openapi.ts and
// the browser.
import { z } from "zod";

export type JsonNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

// At most this many tasks per document and call.
export const TASKS_TO_DATABASE_MAX = 1000;

// Where a task list was, to put it back (page.tasksToDatabase.undo): in
// place of the block `replace` (the list of links that took its place, or
// the empty paragraph left in an otherwise empty container – then only
// while it is still empty), else after `after` or before `before`, else at
// the end of the document.
export type RestoreAnchor = { replace?: string; empty?: boolean; after?: string; before?: string };
export type RestoreEntry = RestoreAnchor & { nodes: JsonNode[] };

export type DocumentMode = "link" | "remove" | "keep";

const modeSchema = z.enum(["link", "remove", "keep"]);
const fieldId = z.string().max(200);
export const tasksToDatabaseInput = z.object({
  action: z.literal("page.tasksToDatabase"),
  pageId: z.uuid(),
  databaseId: z.uuid(),
  // done ← a select property (doneValue / openValue) or a checkbox; "": not mapped.
  statusField: fieldId.default(""),
  doneValue: z.string().max(10000).default(""),
  openValue: z.string().max(10000).default(""),
  dueField: fieldId.default(""),
  personField: fieldId.default(""),
  // The database's parent property (sub-tasks below their parent); "": flat.
  parentField: fieldId.default(""),
  document: modeSchema.default("link"),
});
const nodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z.object({
    type: z.string().max(100),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(nodeSchema).max(10_000).optional(),
    text: z.string().max(100_000).optional(),
    marks: z.array(z.object({ type: z.string().max(100), attrs: z.record(z.string(), z.unknown()).optional() })).max(50).optional(),
  }),
);
const anchor = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional();
export const tasksToDatabaseUndoInput = z.object({
  action: z.literal("page.tasksToDatabase.undo"),
  pageId: z.uuid(),
  databaseId: z.uuid(),
  rowIds: z.array(z.uuid()).max(TASKS_TO_DATABASE_MAX),
  restore: z.array(z.object({ replace: anchor, empty: z.boolean().optional(), after: anchor, before: anchor, nodes: z.array(nodeSchema).min(1).max(1000) })).max(TASKS_TO_DATABASE_MAX).default([]),
});
