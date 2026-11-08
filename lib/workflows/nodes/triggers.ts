// Triggers (docs/specs/workflows.md §6.1): whether an event matches a
// trigger's configuration, and the trigger's output – built with the rights
// of the person the run runs as (hidden properties left out).
import { one } from "../../db";
import { cellText } from "../../cell-text";
import { hiddenFieldsFor } from "../../field-access";
import type { Identity, Page } from "../../types";
import type { WorkflowScope } from "../catalog";
import { databaseFields, pageValue, personValue, recordValue } from "./data";

export type WorkflowEvent = {
  id: string;
  workspace_id: string;
  kind: string;
  scope_id: string;
  page_id: string | null;
  row_id: string | null;
  payload: string;
  actor_id: string | null;
  origin_run_id: string | null;
  depth: number;
};
type Payload = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "boolean" ? String(v) : cellText(v));

// Whether a page lies in a trigger's scope.
export async function inScope(scope: WorkflowScope | undefined, pageId: string | null): Promise<boolean> {
  if (!scope || scope.kind === "workspace") return true;
  if (!pageId) return false;
  const page = await one<Page>("SELECT id,parent_id,space_id FROM pages WHERE id=?", pageId);
  if (!page) return false;
  if (scope.kind === "space") return page.space_id === scope.spaceId;
  if (scope.depth === "children") return page.parent_id === scope.pageId;
  const seen = new Set<string>();
  let parent = page.parent_id;
  while (parent && !seen.has(parent)) {
    if (parent === scope.pageId) return true;
    seen.add(parent);
    parent = (await one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", parent))?.parent_id ?? null;
  }
  return false;
}

// Whether the event matches the trigger's configuration (the database is
// matched by the lookup already: scope_id).
export async function triggerMatches(type: string, config: Payload, event: WorkflowEvent, payload: Payload, runner: Identity | null): Promise<boolean> {
  switch (type) {
    case "trigger.record.created":
      return config.includeForm !== false || payload.via !== "form";
    case "trigger.form.submitted":
    case "trigger.record.done":
      return true;
    case "trigger.record.changed": {
      const before = (payload.before || {}) as Payload,
        after = (payload.after || {}) as Payload;
      const fields = (config.fields as string[]) || [];
      const changed = ((payload.changed as string[]) || []).filter((f) => text(before[f]) !== text(after[f]));
      if (!changed.length) return false;
      const watched = fields.length ? fields.filter((f) => changed.includes(f)) : changed;
      if (!watched.length) return false;
      if (config.from === undefined && config.to === undefined) return true;
      return watched.some((f) => (config.from === undefined || text(before[f]) === config.from) && (config.to === undefined || !config.to || text(after[f]) === config.to));
    }
    case "trigger.record.date":
    case "trigger.schedule":
    case "trigger.manual":
    case "trigger.webhook":
      // Aimed at one trigger (payload.workflow/node), checked by the dispatcher.
      return true;
    case "trigger.journal.day":
      // The scope (one journal or all) is the lookup's; PIN journals never (mayObserve).
      return true;
    case "trigger.mail.received": {
      // Spoofing (§9.7): "verified" only with a passed check, "not_failed" not with a failed one.
      const verdict = String(payload.authenticated || "unknown");
      if (config.senders === "verified") return verdict === "pass";
      if (config.senders === "any") return true;
      return verdict !== "fail";
    }
    case "trigger.page.created": {
      const kinds = (config.kinds as string[]) || [];
      if (kinds.length && !kinds.includes(String(payload.kind || ""))) return false;
      return await inScope(config.scope as WorkflowScope, event.page_id);
    }
    case "trigger.page.changed": {
      const what = (config.what as string[]) || ["title", "content"];
      if (!((payload.changes as string[]) || []).some((c) => what.includes(c))) return false;
      return await inScope(config.scope as WorkflowScope, event.page_id);
    }
    case "trigger.page.moved":
      if (config.to && payload.to !== config.to) return false;
      return await inScope(config.scope as WorkflowScope, event.page_id);
    case "trigger.page.tagged": {
      const tags = (config.tags as string[]) || [];
      if (tags.length && !tags.includes(String(payload.tagId || ""))) return false;
      return await inScope(config.scope as WorkflowScope, event.page_id);
    }
    case "trigger.comment.created": {
      const on = (config.on as string[]) || ["pages", "records"];
      if (!on.includes(event.row_id ? "records" : "pages")) return false;
      if (config.inline === false && payload.inline) return false;
      return await inScope(config.scope as WorkflowScope, event.page_id);
    }
    case "trigger.mention": {
      const who = config.who || "any";
      if (who === "me" && payload.userId !== runner?.id) return false;
      if (who === "people" && !((config.people as string[]) || []).includes(String(payload.userId))) return false;
      return await inScope(config.scope as WorkflowScope, event.page_id);
    }
  }
  return false;
}

// The trigger's output for an event, as `who` may see it.
export async function triggerOutput(type: string, event: Pick<WorkflowEvent, "workspace_id" | "page_id" | "row_id" | "actor_id">, payload: Payload, who: Identity | null): Promise<Payload> {
  const actor = await personValue(event.actor_id, event.workspace_id);
  const record = async () => (event.row_id ? await recordValue(who, event.row_id) : null);
  switch (type) {
    case "trigger.record.created":
      return { record: await record(), actor, via: payload.via || "app" };
    case "trigger.record.done":
      return { record: await record(), actor };
    case "trigger.record.changed": {
      const page = event.page_id ? await one<Page>("SELECT * FROM pages WHERE id=?", event.page_id) : undefined;
      const fields = page ? await databaseFields(page.id) : [];
      const hidden = page && who ? await hiddenFieldsFor(who, page, fields) : new Set<string>();
      const before = Object.fromEntries(Object.entries((payload.before || {}) as Payload).filter(([k]) => !hidden.has(k)));
      const after = (payload.after || {}) as Payload;
      const changed = ((payload.changed as string[]) || []).filter((k) => !hidden.has(k) && text(before[k]) !== text(after[k]));
      return { record: await record(), before, changed, actor };
    }
    case "trigger.form.submitted": {
      const rec = await record();
      const fields = event.page_id ? await databaseFields(event.page_id) : [];
      const answers: Payload = {};
      for (const f of fields) if (rec && f.id in rec.fields && rec.fields[f.id] !== null && rec.fields[f.id] !== "") answers[f.name] = rec.fields[f.id];
      return { record: rec, answers, respondent: actor };
    }
    case "trigger.record.date":
      return { record: await record(), date: payload.date ?? null };
    case "trigger.schedule":
      return { slot: payload.slot ?? null };
    case "trigger.page.created":
    case "trigger.page.changed": {
      const page = event.page_id ? await pageValue(event.page_id) : null;
      return { page, actor, ...(type === "trigger.page.changed" ? { changes: payload.changes || [] } : {}) };
    }
    case "trigger.page.moved":
      return {
        page: event.page_id ? await pageValue(event.page_id) : null,
        from: typeof payload.from === "string" ? await pageValue(payload.from, { text: false }) : null,
        to: typeof payload.to === "string" ? await pageValue(payload.to, { text: false }) : null,
        actor,
      };
    case "trigger.page.tagged":
      return { page: event.page_id ? await pageValue(event.page_id) : null, tag: payload.tag ?? "", actor };
    case "trigger.comment.created":
      return {
        comment: { id: payload.commentId ?? null, text: String(payload.text || "").slice(0, 10_000), url: event.page_id ? (await pageValue(event.page_id, { text: false }))?.url : null },
        page: event.page_id ? await pageValue(event.page_id) : null,
        record: await record(),
        actor,
      };
    case "trigger.mention":
      return {
        page: event.page_id ? await pageValue(event.page_id) : null,
        record: await record(),
        mentioned: await personValue(String(payload.userId || ""), event.workspace_id),
        actor,
      };
    case "trigger.manual":
      return { inputs: payload.inputs || {}, startedBy: actor, source: payload.source || "workflow" };
    case "trigger.webhook":
      return { body: payload.body ?? null, query: payload.query || {}, headers: payload.headers || {}, receivedAt: payload.receivedAt || new Date().toISOString() };
    case "trigger.mail.received":
      return { mail: payload.mail || {}, authenticated: payload.authenticated || "unknown" };
    case "trigger.journal.day":
      return {
        day: event.page_id ? await pageValue(event.page_id) : null,
        date: payload.date ?? null,
        journal: typeof payload.journal === "string" ? await pageValue(payload.journal, { text: false }) : null,
      };
  }
  return {};
}

// An example output from the catalogue's shape, for a test run without data.
export function sampleOutput(outputs: { key: string; type: string; children?: { key: string; type: string }[] }[]): Payload {
  const value = (type: string, children?: { key: string; type: string }[]): unknown => {
    if (children?.length) return Object.fromEntries(children.map((c) => [c.key, value(c.type)]));
    switch (type) {
      case "number":
        return 1;
      case "boolean":
        return true;
      case "date":
        return new Date().toISOString().slice(0, 10);
      case "datetime":
        return new Date().toISOString();
      case "list":
        return [];
      case "object":
        return {};
      default:
        return "…";
    }
  };
  return Object.fromEntries(outputs.map((o) => [o.key, value(o.type, o.children)]));
}
