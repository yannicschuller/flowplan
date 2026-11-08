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
import { headerSafe, isEmpty, renderText, renderValue } from "../placeholders";
import { mailConfig, mailEscape, mailLayout, queueMail } from "../../mail";
import { queueWorkflowMessage } from "../../webhooks";
import { recordUrl } from "../../notification-events";
import { workflowLimits } from "../limits";
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

/* ---------- Wave 2: e-mail and chat ---------- */

const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/;
const day = () => new Date().toISOString().slice(0, 10);
// Recipients of an e-mail: people (their address, only members) and
// addresses (also from placeholders: a person value, a text with "@").
export async function mailRecipients(ctx: NodeRun, to: string[]) {
  const trigger = ctx.scope.values[ctx.run.triggerNodeId] as { record?: { fields?: Record<string, unknown>; createdBy?: { id: string } } } | undefined;
  const people = new Set<string>();
  const addresses = new Set<string>();
  const take = (v: unknown) => {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x === "string" && x.includes("@")) addresses.add(x.trim().toLowerCase());
      else if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") people.add((x as { id: string }).id);
      else if (typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x.trim())) people.add(x.trim());
    }
  };
  for (const entry of to) {
    if (entry === "@runner") ctx.runner && people.add(ctx.runner.id);
    else if (entry === "@actor") ctx.actor && people.add(ctx.actor.id);
    else if (entry === "@creator") trigger?.record?.createdBy?.id && people.add(trigger.record.createdBy.id);
    else if (entry.startsWith("field:")) take(trigger?.record?.fields?.[entry.slice(6)]);
    else if (entry.includes("{{")) take(renderValue(entry, ctx.scope));
    else take(entry.trim());
  }
  const members = new Map<string, string>();
  for (const uid of people) {
    const u = await one<{ email: string }>("SELECT u.email FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=? AND u.disabled=0", ctx.run.workspaceId, uid);
    if (u?.email) members.set(u.email.toLowerCase(), uid);
  }
  const list = [...new Set([...members.keys(), ...addresses])];
  for (const a of list) if (a.length > 254 || !ADDRESS.test(a)) throw new StepError(`„${a.slice(0, 80)}“ ist keine E-Mail-Adresse.`, "validation");
  // External: an address no member of the workspace has.
  const external: string[] = [];
  for (const a of list)
    if (!members.has(a) && !(await one("SELECT 1 FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=? WHERE lower(u.email)=?", ctx.run.workspaceId, a))) external.push(a);
  return { list, external };
}

export const notifyEmail: NodeImpl = async (ctx) => {
  const c = ctx.config as { to: string[]; subject: string; message: string };
  const limits = await workflowLimits();
  const { list, external } = await mailRecipients(ctx, c.to || []);
  if (!list.length) throw new StepError("Keine Empfänger.", "validation");
  if (list.length > MAX_RECIPIENTS) throw new StepError(`Höchstens ${MAX_RECIPIENTS} Empfänger je Schritt.`, "limit");
  if (external.length && !limits.externalMail) throw new StepError("E-Mails an Adressen außerhalb der Mitglieder sind auf dieser Instanz abgeschaltet.", "permission");
  const subject = headerSafe(renderText(c.subject || "", ctx.scope)).trim().slice(0, 200) || ctx.workflowPage?.title || "Workflow";
  const text = renderText(c.message || "", ctx.scope).slice(0, 20_000);
  if (dryRun(ctx)) return { port: "out", output: { wouldSend: list, subject } };
  if (!mailConfig()) throw new StepError("Auf dieser Instanz ist kein E-Mail-Versand eingerichtet.", "permission");
  // At most FLOWPLAN_WORKFLOW_MAILS_PER_DAY per workflow (counted in this
  // step's transaction, so a retry never counts twice).
  await run("INSERT INTO workflow_mail_usage(page_id,day,mails) VALUES(?,?,0) ON CONFLICT(page_id,day) DO NOTHING", ctx.run.pageId, day());
  const taken = await run("UPDATE workflow_mail_usage SET mails=mails+? WHERE page_id=? AND day=? AND mails+?<=?", list.length, ctx.run.pageId, day(), list.length, limits.mailsPerDay);
  if (!taken.changes) throw new StepError(`Höchstens ${limits.mailsPerDay} E-Mails je Workflow und Tag.`, "limit");
  // The text becomes escaped HTML (§7.4): a value is never markup.
  const paragraphs = text.split(/\n{2,}/).map((p) => mailEscape(p.trim()).replace(/\n/g, "<br>")).filter(Boolean);
  const html = await mailLayout(subject, paragraphs.length ? paragraphs : [""]);
  let sent = 0;
  for (const to of list) if (await queueMail(to, subject, text, html)) sent++;
  return { port: "out", output: { sent } };
};

export const notifyChat: NodeImpl = async (ctx) => {
  const c = ctx.config as { webhook: string; title: string; message: string };
  const text = renderText(c.message || "", ctx.scope).trim().slice(0, 2000);
  const title = renderText(c.title || "", ctx.scope).trim().slice(0, 200);
  if (!text && !title) throw new StepError("Keine Nachricht.", "validation");
  if (dryRun(ctx)) return { port: "out", output: { wouldSend: { webhook: c.webhook, title, text } } };
  const page = ctx.workflowPage;
  const id = await queueWorkflowMessage({
    hookId: c.webhook,
    workspaceId: ctx.run.workspaceId,
    pageId: page?.id || ctx.run.pageId,
    page: page?.title || "Workflow",
    title,
    text,
    url: recordUrl(page?.id || ctx.run.pageId),
    actor: ctx.runner?.name || "Flowplan",
    runId: ctx.run.id,
  });
  if (!id) throw new StepError("Der Chat-Webhook gibt es nicht oder er ist nicht für Workflows freigegeben.", "validation");
  return { port: "out", output: { sent: 1 } };
};
