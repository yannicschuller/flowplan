// Messages of the kind "workflow_ops" (docs/specs/workflows.md §6.4, §8.6,
// §8.8): failed runs to the person a workflow runs as (the first failure
// after a success at once, then at most once an hour as a summary), pauses
// to the people responsible, cascade and rate limits hourly, an exhausted
// AI budget once a day. Throttled per workflow and kind in
// workflow_notices, so a cluster sends each message once; in the language
// of each recipient (lib/user-locale.ts).
import { all, id, one, run } from "../db";
import { translate, type Locale } from "../i18n";
import { pageRole } from "../permissions";
import { rememberApprovalTarget } from "../notification-targets";
import { securityEvent } from "../security-events";
import { userLocale } from "../user-locale";
import type { Identity, Page } from "../types";

const HOUR = 3_600_000;
type Text = (tr: (de: string, en: string) => string) => string;

// Inserts one notification per member (never a guest of the workspace).
// `approvalId`: the notification asks for that approval – the apps show
// "Approve" / "Reject" on its push (lib/notification-targets.ts, §11.8).
export async function opsNotify(userIds: (string | null | undefined)[], pageId: string, text: Text, rowId: string | null = null, approvalId: string | null = null) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page) return 0;
  let sent = 0;
  for (const uid of [...new Set(userIds.filter((u): u is string => !!u))]) {
    const member = await one("SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND u.disabled=0 AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id)", page.workspace_id, uid);
    if (!member) continue;
    const tr = translate((await userLocale(uid)) as Locale);
    const notificationId = id();
    await run("INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,?)", notificationId, uid, text(tr).slice(0, 500), page.id, rowId, "workflow_ops");
    if (approvalId) await rememberApprovalTarget(notificationId, approvalId);
    sent++;
  }
  return sent;
}

// Once per `everyMs` per workflow and kind; otherwise counted as pending.
async function throttled(pageId: string, kind: string, everyMs: number, detail: string, now = Date.now()): Promise<{ send: boolean; pending: number }> {
  await run("INSERT INTO workflow_notices(page_id,kind,sent_at,pending,detail) VALUES(?,?,0,0,'') ON CONFLICT(page_id,kind) DO NOTHING", pageId, kind);
  const due = await run("UPDATE workflow_notices SET sent_at=?,pending=0,detail=? WHERE page_id=? AND kind=? AND sent_at<=?", now, detail.slice(0, 500), pageId, kind, now - everyMs);
  if (due.changes) {
    return { send: true, pending: 0 };
  }
  await run("UPDATE workflow_notices SET pending=pending+1,detail=? WHERE page_id=? AND kind=?", detail.slice(0, 500), pageId, kind);
  return { send: false, pending: 0 };
}
const workflowInfo = async (pageId: string) => await one<{ title: string; runner_id: string | null; created_by: string | null; workspace_id: string }>("SELECT p.title,w.runner_id,p.created_by,p.workspace_id FROM workflows w JOIN pages p ON p.id=w.page_id WHERE w.page_id=?", pageId);

// A live run failed (§8.6).
export async function noteRunFailed(pageId: string, message: string, firstAfterSuccess: boolean, now = Date.now()) {
  const wf = await workflowInfo(pageId);
  if (!wf?.runner_id) return;
  const title = wf.title || "Workflow";
  if (firstAfterSuccess) {
    await run("INSERT INTO workflow_notices(page_id,kind,sent_at,pending,detail) VALUES(?,'failed',?,0,?) ON CONFLICT(page_id,kind) DO UPDATE SET sent_at=excluded.sent_at,pending=0,detail=excluded.detail", pageId, now, message.slice(0, 500));
    await opsNotify([wf.runner_id], pageId, (tr) => tr(`Workflow „${title}“: Ein Lauf ist fehlgeschlagen – ${message}`, `Workflow “${title}”: a run failed – ${message}`));
    return;
  }
  const t = await throttled(pageId, "failed", HOUR, message, now);
  if (t.send) await opsNotify([wf.runner_id], pageId, (tr) => tr(`Workflow „${title}“: Ein Lauf ist fehlgeschlagen – ${message}`, `Workflow “${title}”: a run failed – ${message}`));
}

// Pending summaries whose hour is over (the leader's tick).
export async function flushNotices(now = Date.now()) {
  const due = await all<{ page_id: string; kind: string; pending: number; detail: string }>("SELECT page_id,kind,pending,detail FROM workflow_notices WHERE pending>0 AND sent_at<=? LIMIT 200", now - HOUR);
  for (const n of due) {
    const taken = await run("UPDATE workflow_notices SET sent_at=?,pending=0 WHERE page_id=? AND kind=? AND pending=?", now, n.page_id, n.kind, n.pending);
    if (!taken.changes) continue;
    const wf = await workflowInfo(n.page_id);
    if (!wf?.runner_id) continue;
    const title = wf.title || "Workflow";
    const count = n.pending;
    if (n.kind === "failed")
      await opsNotify([wf.runner_id], n.page_id, (tr) => tr(`Workflow „${title}“: ${count} Läufe fehlgeschlagen, zuletzt: ${n.detail}`, `Workflow “${title}”: ${count} runs failed, last: ${n.detail}`));
    else if (n.kind === "cascade" || n.kind === "throttled")
      await opsNotify([wf.runner_id], n.page_id, (tr) => limitText(tr, n.kind, title, count));
  }
}

const limitText = (tr: (de: string, en: string) => string, kind: string, title: string, count: number) =>
  kind === "cascade"
    ? tr(`Workflow „${title}“: Kaskade gestoppt (Tiefe überschritten), ${count}× in der letzten Stunde.`, `Workflow “${title}”: cascade stopped (depth exceeded), ${count}× in the last hour.`)
    : tr(`Workflow „${title}“: Ereignisse verworfen (Läufe je Minute überschritten), ${count}× in der letzten Stunde.`, `Workflow “${title}”: events dropped (runs per minute exceeded), ${count}× in the last hour.`);

// Cascade stopped or events dropped (§8.8): a message at most hourly, and
// a security event while it keeps happening.
export async function noteLimit(pageId: string, kind: "cascade" | "throttled", now = Date.now()) {
  const t = await throttled(pageId, kind, HOUR, "", now);
  if (!t.send) return;
  const wf = await workflowInfo(pageId);
  if (!wf) return;
  await opsNotify([wf.runner_id], pageId, (tr) => limitText(tr, kind, wf.title || "Workflow", 1));
  securityEvent("workflow.limit", { actorId: wf.runner_id, detail: `${kind} ${pageId}` });
}

// The AI budget of the day is used up: one message a day.
export async function noteAiBudget(pageId: string, now = Date.now()) {
  const t = await throttled(pageId, "ai_budget", 20 * HOUR, "", now);
  if (!t.send) return;
  const wf = await workflowInfo(pageId);
  if (!wf) return;
  const title = wf.title || "Workflow";
  await opsNotify([wf.runner_id], pageId, (tr) => tr(`Workflow „${title}“: Das KI-Budget für heute ist aufgebraucht.`, `Workflow “${title}”: today’s AI budget is used up.`));
}

// The people responsible for a workflow page: who it runs as, who created
// it, the workspace's owners – and, when `editors`, everyone who may edit it.
async function responsible(pageId: string, editors: boolean) {
  const wf = await workflowInfo(pageId);
  if (!wf) return [];
  const people = [wf.runner_id, wf.created_by];
  const members = await all<{ user_id: string; role: string }>("SELECT user_id,role FROM members WHERE workspace_id=? LIMIT 500", wf.workspace_id);
  for (const m of members) if (m.role === "owner") people.push(m.user_id);
  if (editors) {
    const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
    for (const m of members) {
      if (m.role === "viewer" || !page) continue;
      const role = await pageRole({ id: m.user_id, groups: [], isAdmin: false } as unknown as Identity, page);
      if (role === "editor" || role === "owner") people.push(m.user_id);
    }
  }
  return people;
}

// A workflow paused by itself (§8.6, §8.10): its responsible people hear it.
export async function notePause(pageId: string, status: "paused" | "auto_paused", reason: string) {
  const wf = await workflowInfo(pageId);
  if (!wf) return;
  const title = wf.title || "Workflow";
  const people = await responsible(pageId, status === "paused");
  await opsNotify(people, pageId, (tr) =>
    status === "auto_paused"
      ? tr(`Workflow „${title}“ wurde automatisch pausiert: ${reason}`, `Workflow “${title}” was paused automatically: ${reason}`)
      : tr(`Workflow „${title}“ wurde pausiert: ${reason} Jemand mit Bearbeitungsrechten kann ihn neu aktivieren.`, `Workflow “${title}” was paused: ${reason} Someone with edit rights can activate it again.`),
  );
  if (status === "auto_paused") securityEvent("workflow.auto_paused", { actorId: wf.runner_id, detail: `${pageId}: ${reason}`.slice(0, 300) });
}

// The 50 % rule (§8.6): of the last 20 live runs within an hour, more than
// half failed (limit failures do not count) – judged once at least 10 ran.
export async function checkFailureRate(pageId: string, now = Date.now()) {
  const runs = await all<{ status: string }>(
    "SELECT status FROM workflow_runs WHERE page_id=? AND mode='live' AND finished_at>? AND status IN ('succeeded','failed') AND (error_kind IS NULL OR error_kind<>'limit') ORDER BY finished_at DESC LIMIT 20",
    pageId,
    now - HOUR,
  );
  if (runs.length < 10) return false;
  return runs.filter((r) => r.status === "failed").length * 2 > runs.length;
}
