// What a node's execution gets and gives (lib/workflows/engine.ts and
// lib/workflows/inline.ts call the implementations in this folder).
import type { Field, Identity, Page } from "../../types";
import type { WorkflowGraph, WorkflowNode } from "../graph";
import type { RenderScope } from "../placeholders";

export type ErrorKind = "transient" | "permission" | "validation" | "limit" | "external";
export class StepError extends Error {
  constructor(message: string, readonly kind: ErrorKind = "validation", readonly retryAfterMs?: number) {
    super(message);
  }
}

// The immediate part (lib/workflows/inline.ts): writes on the triggering
// record are collected and made in one update at the end, as the
// database rules always did.
export type InlineBatch = {
  databasePage: Page;
  rowId: string;
  fields: Field[];
  // The record as stored when the event happened, and its computed cells.
  row: { id: string; created_by: string | null; cells: Record<string, unknown> };
  cells: Record<string, unknown>;
  patch: Record<string, unknown>;
  templates: { key: string; template: string; mode: "empty" | "append"; label: string }[];
};

export type NodeRun = {
  graph: WorkflowGraph;
  node: WorkflowNode;
  config: Record<string, unknown>;
  scope: RenderScope;
  // Who the run acts as; null only for database rules acting "for the database".
  runner: Identity | null;
  // Who caused the event (the person who changed the record …).
  actor: Identity | null;
  run: { id: string; pageId: string; workspaceId: string; mode: "live" | "test" | "dry"; depth: number; triggerNodeId: string };
  workflowPage: Page | null;
  // The triggering page and record, the default of "on the triggering record".
  trigger: { pageId: string | null; rowId: string | null };
  inline?: InlineBatch;
  // A database rule (not a workflow): its exact old behaviour; `created`
  // counts the records scheduled rules made in this round (their order).
  legacy?: { ruleId: string; ruleName: string; created: { n: number; ids: string[] } };
  warn: (message: string) => void;
  attempt: number;
  iteration: string;
};
export type NodeResult = { port: string; output: unknown } | { stop: "succeeded" | "failed"; message: string; output?: unknown };
export type NodeImpl = (ctx: NodeRun) => Promise<NodeResult>;
export const dryRun = (ctx: NodeRun) => ctx.run.mode === "dry";
