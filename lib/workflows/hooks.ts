// Where the rest of Flowplan tells workflows that something happened
// (docs/specs/workflows.md §8.2): one call per place, next to the webhook
// events. Each costs one indexed lookup when no workflow listens.
import { one } from "../db";
import { cellText } from "../cell-text";
import { isEncryptedPage } from "../e2ee-server";
import type { Identity, Page } from "../types";
import { emitWorkflowEvent, PAGE_CHANGED_DEBOUNCE_MS, workflowListeners } from "./events";

type Cells = Record<string, unknown>;
export type RecordEventKind = "created" | "form" | "updated" | "overdue";
// The event kinds of a record write (the immediate part asks for the same,
// so both share one lookup).
export function recordEventKinds(event: RecordEventKind, done = false): string[] {
  const base = event === "created" ? ["record.created"] : event === "form" ? ["record.created", "form.submitted"] : event === "updated" ? ["record.changed"] : [];
  return done ? [...base, "record.done"] : base;
}
const text = (v: unknown) => (typeof v === "boolean" ? String(v) : cellText(v));

// A record was created or changed: events for the workflows whose trigger
// has no immediate part (those run in lib/workflows/inline.ts).
export async function recordWorkflowEvents(input: { page: Page; rowId: string; actor: Identity | null; event: RecordEventKind; before?: Cells | null; after?: Cells; done?: boolean }) {
  const kinds = recordEventKinds(input.event, input.done);
  if (!kinds.length) return;
  const { queued } = await workflowListeners(input.page.workspace_id, kinds, input.page.id);
  if (!queued.size) return;
  const before = input.before || {},
    after = input.after || {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => text(before[k]) !== text(after[k]));
  for (const kind of kinds) {
    if (!queued.has(kind)) continue;
    const payload =
      kind === "record.changed" ? { before, after, changed } : kind === "record.created" ? { via: input.event === "form" ? "form" : "app" } : {};
    await emitWorkflowEvent(kind, { workspaceId: input.page.workspace_id, scopeId: input.page.id, pageId: input.page.id, rowId: input.rowId, payload, actorId: input.actor?.id ?? null, checked: true });
  }
}

async function pageRow(pageId: string) {
  return await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
}
async function pageEvent(kind: string, pageId: string, actorId: string | null | undefined, payload: Record<string, unknown> = {}, extra: { rowId?: string | null; dedupeKey?: string; dueAt?: number; debounce?: boolean } = {}) {
  const page = await pageRow(pageId);
  if (!page) return;
  if (!(await workflowListeners(page.workspace_id, [kind], "")).queued.has(kind)) return;
  // End-to-end encrypted pages: ids only (no workflow may act on them anyway).
  const encrypted = await isEncryptedPage(page);
  await emitWorkflowEvent(kind, {
    workspaceId: page.workspace_id,
    pageId,
    rowId: extra.rowId ?? null,
    actorId: actorId ?? null,
    payload: encrypted ? Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "text")) : payload,
    dedupeKey: extra.dedupeKey,
    dueAt: extra.dueAt,
    debounce: extra.debounce,
    checked: true,
  });
}
export const pageCreatedEvent = async (pageId: string, actorId: string | null | undefined) => {
  const page = await pageRow(pageId);
  if (page) await pageEvent("page.created", pageId, actorId, { kind: page.kind, parentId: page.parent_id, spaceId: page.space_id });
};
// Typing gives one event 2 minutes after the last change (§8.2).
export const pageChangedEvent = async (pageId: string, actorId: string | null | undefined, changes: ("title" | "content")[]) =>
  await pageEvent("page.changed", pageId, actorId, { changes }, { dedupeKey: `page.changed:${pageId}`, dueAt: Date.now() + PAGE_CHANGED_DEBOUNCE_MS, debounce: true });
export const pageMovedEvent = async (pageId: string, actorId: string | null | undefined, from: string | null, to: string | null) =>
  from !== to ? await pageEvent("page.moved", pageId, actorId, { from, to }) : undefined;
export const pageTaggedEvent = async (pageId: string, actorId: string | null | undefined, tags: { id: string; name: string }[]) => {
  for (const tag of tags) await pageEvent("page.tagged", pageId, actorId, { tagId: tag.id, tag: tag.name });
};
export const commentEvent = async (pageId: string, rowId: string | null, actorId: string | null | undefined, comment: { id: string | null; text: string; inline?: boolean }) =>
  await pageEvent("comment.created", pageId, actorId, { commentId: comment.id, text: comment.text.slice(0, 10_000), inline: !!comment.inline }, { rowId });
export const mentionEvent = async (pageId: string, rowId: string | null, userId: string, actorId: string | null | undefined) =>
  await pageEvent("mention", pageId, actorId, { userId }, { rowId });
