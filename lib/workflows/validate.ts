// The check before activating (docs/specs/workflows.md §5.2): the
// structural check of lib/workflows/graph.ts plus the references – the
// databases, properties, pages, templates and people a graph names must
// exist, belong to the workspace and be readable (writable for write
// actions) by the person who will run it. Errors keep a graph from being
// activated, warnings not.
import { one } from "../db";
import { pageRole } from "../permissions";
import { isEncryptedPage } from "../e2ee-server";
import type { Field, Identity, Page } from "../types";
import { nodeSpec, RECORD_TRIGGERS } from "./catalog";
import { checkGraph, type GraphIssue, type WorkflowGraph } from "./graph";
import { conditionField } from "./legacy";
import { hasPlaceholders } from "./placeholders";
import { databaseFields } from "./nodes/data";
import { behindJournalPin } from "./runner";

const WRITE_TYPES = new Set(["action.record.create", "action.record.update", "action.record.template", "action.page.create", "action.page.append", "action.page.tag", "action.page.move"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function validateGraph(graph: WorkflowGraph, ctx: { workspaceId: string; runner: Identity | null }): Promise<GraphIssue[]> {
  const issues = checkGraph(graph);
  const pages = new Map<string, Page | null>();
  const pageOf = async (id: string) => {
    if (!pages.has(id)) pages.set(id, (await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", id)) ?? null);
    return pages.get(id)!;
  };
  // A page (or database) named by id: exists here, readable/writable by the runner.
  const checkPage = async (nodeId: string, pageId: unknown, write: boolean, database = false) => {
    if (typeof pageId !== "string" || !pageId || hasPlaceholders(pageId)) return null;
    if (!UUID.test(pageId)) return null;
    const page = await pageOf(pageId);
    if (!page || page.workspace_id !== ctx.workspaceId || (database && page.kind !== "database")) {
      issues.push({ level: "error", code: database ? "unknown_database" : "unknown_page", nodeId });
      return null;
    }
    if ((await isEncryptedPage(page)) || (await behindJournalPin(page))) {
      issues.push({ level: "error", code: "encrypted", nodeId });
      return null;
    }
    if (ctx.runner) {
      const role = await pageRole(ctx.runner, page);
      if (!role) issues.push({ level: "error", code: "page_not_readable", nodeId });
      else if (write && role === "viewer") issues.push({ level: "error", code: "page_not_writable", nodeId });
    }
    return page;
  };
  const fieldsOf = new Map<string, Field[]>();
  const fields = async (dbId: string) => {
    if (!fieldsOf.has(dbId)) fieldsOf.set(dbId, await databaseFields(dbId));
    return fieldsOf.get(dbId)!;
  };
  const checkField = async (nodeId: string, dbId: string | undefined, fieldId: string) => {
    if (!dbId || !UUID.test(dbId)) return;
    if (!(await fields(dbId)).some((f) => f.id === fieldId)) issues.push({ level: "error", code: "unknown_field", nodeId, params: { field: fieldId } });
  };
  const triggerDatabase = new Map<string, string>();
  for (const n of graph.nodes) if (RECORD_TRIGGERS.has(n.type) && typeof n.config.database === "string") triggerDatabase.set(n.id, n.config.database);
  for (const n of graph.nodes) {
    if (!nodeSpec(n.type)) continue;
    const c = n.config as Record<string, unknown>;
    const write = WRITE_TYPES.has(n.type);
    if (typeof c.database === "string") await checkPage(n.id, c.database, write, true);
    for (const key of ["page", "parent"] as const) if (typeof c[key] === "string") await checkPage(n.id, c[key], write);
    const db = typeof c.database === "string" ? c.database : undefined;
    if (n.type === "trigger.record.changed") for (const f of (c.fields as string[]) || []) await checkField(n.id, db, f);
    if (n.type === "trigger.record.date") await checkField(n.id, db, String(c.field || ""));
    if (n.type === "action.record.create" || n.type === "action.record.update") {
      // Without a database of its own, an update on the triggering record uses the trigger's.
      const target = db ?? [...triggerDatabase.values()][0];
      for (const f of Object.keys((c.values as Record<string, unknown>) || {})) await checkField(n.id, target, f);
      if (n.type === "action.record.update" && !String(c.record || "").trim() && !triggerDatabase.size) issues.push({ level: "error", code: "no_record_trigger", nodeId: n.id });
    }
    if (n.type === "action.record.template") {
      const target = db ?? [...triggerDatabase.values()][0];
      if (target && UUID.test(target) && !(await one("SELECT 1 FROM row_templates WHERE id=? AND page_id=?", String(c.template), target)))
        issues.push({ level: "error", code: "unknown_template", nodeId: n.id });
      if (!String(c.record || "").trim() && !triggerDatabase.size) issues.push({ level: "error", code: "no_record_trigger", nodeId: n.id });
    }
    if (n.type === "action.record.create" && c.template && db && UUID.test(db) && !(await one("SELECT 1 FROM row_templates WHERE id=? AND page_id=?", String(c.template), db)))
      issues.push({ level: "error", code: "unknown_template", nodeId: n.id });
    if (n.type === "action.record.find" && db) {
      const walk = async (g: { rules?: { kind: string; left?: string; rules?: unknown[] }[] } | undefined): Promise<void> => {
        for (const r of g?.rules || []) {
          if (r.kind === "group") await walk(r as never);
          else await checkField(n.id, db, String(r.left || "").trim());
        }
      };
      await walk(c.filter as never);
    }
    if (n.type === "logic.if") {
      const walk = async (g: { rules?: { kind: string; left?: string }[] } | undefined): Promise<void> => {
        for (const r of g?.rules || []) {
          if (r.kind === "group") await walk(r as never);
          else {
            const target = conditionField(String(r.left || ""));
            if (target && triggerDatabase.has(target.node)) await checkField(n.id, triggerDatabase.get(target.node), target.field);
          }
        }
      };
      await walk(c.condition as never);
    }
    if (n.type === "notify.person")
      for (const to of (c.to as string[]) || [])
        if (UUID.test(to) && !(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", ctx.workspaceId, to)))
          issues.push({ level: "error", code: "unknown_person", nodeId: n.id });
    if (n.type === "trigger.mention")
      for (const p of (c.people as string[]) || [])
        if (!(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", ctx.workspaceId, p))) issues.push({ level: "error", code: "unknown_person", nodeId: n.id });
  }
  return issues;
}
export const hasErrors = (issues: GraphIssue[]) => issues.some((i) => i.level === "error");
