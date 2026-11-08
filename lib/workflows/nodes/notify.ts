// notify.person (docs/specs/workflows.md §6.4): a notification of the kind
// "workflow" (or, for the database rules, "automation" with their old
// wording) – in the app and, as chosen per node, by push, e-mail and chat
// apps; the person's own settings per kind and channel always win. A link
// only goes to recipients who may see the page or record.
import { id, nowText, one, run } from "../../db";
import { pageRole } from "../../permissions";
import { hiddenRowIds } from "../../row-access";
import { cellText } from "../../cell-text";
import type { Identity, Page } from "../../types";
import { isEmpty, renderText, renderValue } from "../placeholders";
import { refId } from "./data";
import { dryRun, StepError, type NodeImpl, type NodeRun } from "./types";

const MAX_RECIPIENTS = 50;

// Recipients: ids, "@actor", "@creator", "@runner", "field:<id>" of the
// triggering record, or placeholders on people.
async function recipients(ctx: NodeRun, to: string[], cells: Record<string, unknown>, createdBy: string | null) {
  const out: string[] = [];
  for (const entry of to) {
    if (entry === "@creator") createdBy && out.push(createdBy);
    else if (entry === "@actor") ctx.actor && out.push(ctx.actor.id);
    else if (entry === "@runner") ctx.runner && out.push(ctx.runner.id);
    else if (entry.startsWith("field:")) {
      const value = cells[entry.slice(6)];
      out.push(...(Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && !!v));
    } else if (entry.includes("{{")) {
      const value = renderValue(entry, ctx.scope);
      for (const v of Array.isArray(value) ? value : [value]) {
        const uid = refId(v);
        if (uid) out.push(uid);
      }
    } else if (entry) out.push(entry);
  }
  return [...new Set(out)];
}

export const notifyPerson: NodeImpl = async (ctx) => {
  const c = ctx.config as { to: string[]; title: string; message: string; link: string; channels: string[]; kind: "workflow" | "automation"; ruleName?: string };
  const inline = ctx.inline;
  const triggerPageId = ctx.trigger.pageId;
  const triggerRowId = ctx.trigger.rowId;
  const cells = inline ? { ...inline.cells, ...inline.patch } : (((ctx.scope.values[ctx.run.triggerNodeId] as { record?: { fields?: Record<string, unknown> } })?.record?.fields || {}) as Record<string, unknown>);
  const createdBy = inline ? inline.row.created_by : ((ctx.scope.values[ctx.run.triggerNodeId] as { record?: { createdBy?: { id: string } } })?.record?.createdBy?.id ?? null);
  // The rules' wording (lib/automations.ts notify()).
  let body: string;
  if (c.kind === "automation" && inline) {
    const title = cellText(cells[inline.fields[0]?.id || "title"]) || "Ohne Titel";
    body = c.message ? `${c.message} – „${title}“` : `${c.ruleName || "Automation"}: „${title}“ in „${inline.databasePage.title}“`;
  } else {
    const title = renderText(c.title || "", ctx.scope).trim();
    const message = renderText(c.message || "", ctx.scope).trim();
    body = [title, message].filter(Boolean).join(" – ") || ctx.workflowPage?.title || "Workflow";
  }
  // Where the notification points: the trigger's page/record, none, or a placeholder.
  let pageId: string | null = null,
    rowId: string | null = null;
  if (c.link === "trigger" || c.link === undefined) {
    pageId = triggerPageId;
    rowId = triggerRowId;
  } else if (c.link && c.link !== "none") {
    const target = refId(renderValue(c.link, ctx.scope));
    if (target) {
      const row = await one<{ id: string; page_id: string }>("SELECT id,page_id FROM rows WHERE id=?", target);
      if (row) {
        pageId = row.page_id;
        rowId = row.id;
      } else if (await one("SELECT 1 FROM pages WHERE id=?", target)) pageId = target;
    }
  }
  const page = pageId ? await one<Page>("SELECT * FROM pages WHERE id=?", pageId) : undefined;
  const people = await recipients(ctx, c.to, cells, createdBy);
  if (people.length > MAX_RECIPIENTS) throw new StepError(`Höchstens ${MAX_RECIPIENTS} Empfänger je Schritt.`, "limit");
  if (dryRun(ctx)) return { port: "out", output: { wouldNotify: people, body: body.slice(0, 500) } };
  let notified = 0;
  for (const uid of people) {
    const member = await one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", uid);
    if (!member) continue;
    const who = { ...member, groups: [], isAdmin: false } as Identity;
    // Recipients are members; the link only for those who may see it.
    if (!(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", ctx.run.workspaceId, uid))) continue;
    let linkPage = page?.id ?? null,
      linkRow = rowId;
    if (page && (!(await pageRole(who, page)) || (linkRow && (await hiddenRowIds(who, page)).has(linkRow)))) {
      // The rules notify nobody who may not see the record; workflows send without the link.
      if (c.kind === "automation") continue;
      linkPage = linkRow = null;
    }
    const nid = id();
    const inserted = await run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,?)",
      nid,
      uid,
      body.slice(0, 500),
      linkPage,
      linkRow,
      c.kind === "automation" ? "automation" : "workflow",
    );
    if (!inserted.changes) continue;
    notified++;
    // Channels the node did not choose: their deliveries go again.
    if (c.kind !== "automation") {
      const channels = new Set(c.channels || []);
      if (!channels.has("push")) await run("DELETE FROM push_deliveries WHERE notification_id=?", nid);
      if (!channels.has("messenger")) await run("DELETE FROM messenger_deliveries WHERE notification_id=?", nid);
      if (!channels.has("email")) await run("UPDATE notifications SET emailed_at=? WHERE id=?", nowText(), nid);
    }
  }
  return { port: "out", output: { notified } };
};
export const hasRecipients = (to: unknown) => Array.isArray(to) && to.some((v) => !isEmpty(v));
