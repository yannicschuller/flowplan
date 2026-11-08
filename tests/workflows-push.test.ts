// "Approve" / "Reject" on the apps' push notifications of a workflow
// approval (#168, docs/specs/workflows.md §11.8): the push carries the
// category and the approval's id; the decision comes with the device token,
// only for the approvers, once, within the deadline; approving needs the
// confirmation secret the phone opens with biometrics, rejecting does not;
// revoked, idle or unknown devices and API tokens decide nothing. On SQLite
// and PostgreSQL.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-push-"));
const { run, one, id } = await import("../lib/db");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { flushPushQueue } = await import("../lib/push");
const { registerMobileDevice, deviceFromToken, unregisterMobileDevice } = await import("../lib/mobile-devices");
const { notificationAction } = await import("../lib/notification-actions");
const { decideApprovalOnDevice, DEVICE_APPROVAL_IDLE_MS } = await import("../lib/workflows/actions");
const { NOTIFICATION_CATEGORIES } = await import("../lib/notification-targets");
const S = await import("./helpers/workflow-setup");
const { act, owner, editor, viewer, node, edge, workflow, runsOf, outputOf, manual } = S;

// A phone of `who`: a session, the registration (Expo push, and with
// `confirm` a confirmation key), the device token.
async function phone(who: Identity, confirm = true) {
  const session = id();
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", session, who.id, "[]", Date.now() + 3600_000);
  const secret = randomBytes(32).toString("base64url");
  const installationId = randomUUID();
  const registered = await registerMobileDevice(who, session, {
    installationId,
    platform: "ios",
    pushToken: `ExponentPushToken[${randomUUID().replaceAll("-", "").slice(0, 22)}]`,
    ...(confirm ? { approvalKey: createHash("sha256").update(secret).digest("base64url") } : {}),
  });
  assert.equal(registered.approvals, confirm);
  const header = `Bearer ${registered.deviceToken}`;
  const found = (await deviceFromToken(header))!;
  return { secret, header, installationId, ...found };
}
const viewerPhone = await phone(viewer);
const editorPhone = await phone(editor, false);
const ownerPhone = await phone(owner);

type Sent = { data: { url: string; notificationId?: string; approvalId?: string }; categoryId?: string };
async function pushes(content = true) {
  const sent: Sent[] = [];
  if (content) process.env.MOBILE_PUSH_CONTENT = "on";
  try {
    await flushPushQueue(
      async () => assert.fail("No Web Push"),
      async (message) => {
        sent.push(message);
      },
    );
  } finally {
    delete process.env.MOBILE_PUSH_CONTENT;
  }
  return sent;
}
const t = node("trigger.manual", { inputs: [] }, "Start");
const lastRun = async (pageId: string) => (await runsOf(pageId)).at(-1)!;
// A waiting run with an approval for the editor and the viewer.
async function asking(title: string, deadline?: { amount: number; unit: string }) {
  const ask = node("logic.approval", { approvers: [editor.id, viewer.id], message: "Rechnung bezahlen?", ...(deadline ? { deadline, onTimeout: "timeout" } : {}) }, "Freigabe");
  const yes = node("logic.set", { values: [{ name: "x", value: "ja", type: "text" }] }, "Ja");
  const no = node("logic.set", { values: [{ name: "x", value: "nein", type: "text" }] }, "Nein");
  const { pageId } = await workflow(title, { nodes: [t, ask, yes, no], edges: [edge(t, ask), edge(ask, yes, "approved"), edge(ask, no, "rejected")] });
  await manual(pageId);
  await drainWorkflows();
  const r = await lastRun(pageId);
  assert.equal(r.status, "waiting");
  const approvalId = (await one<{ id: string }>("SELECT id FROM workflow_approvals WHERE run_id=?", r.id))!.id;
  const notice = async (who: Identity) => (await one<{ id: string; read_at: string | null }>("SELECT id,read_at FROM notifications WHERE user_id=? AND kind='workflow_ops' AND page_id=? ORDER BY seq DESC LIMIT 1", who.id, pageId))!;
  return { pageId, runId: r.id, approvalId, ask, yes, no, viewerNotice: await notice(viewer), editorNotice: await notice(editor) };
}
const approvalRow = async (approvalId: string) => (await one<{ decision: string | null; decided_by: string | null }>("SELECT decision,decided_by FROM workflow_approvals WHERE id=?", approvalId))!;

test("the push of an approval carries its category and approval id – only with content", async () => {
  await pushes(); // what came before
  const a = await asking("Push");
  const sent = await pushes();
  const mine = sent.filter((m) => m.data.approvalId === a.approvalId);
  assert.equal(mine.length, 2, "editor and viewer");
  for (const m of mine) assert.equal(m.categoryId, NOTIFICATION_CATEGORIES.workflowApproval);
  assert.ok(mine.some((m) => m.data.notificationId === a.viewerNotice.id));
  // Without the text on the lock screen nobody knows what "Approve" approves.
  const b = await asking("Push ohne Inhalt");
  const plain = (await pushes(false)).filter((m) => m.data.url.includes(b.pageId));
  assert.equal(plain.length, 2);
  for (const m of plain) {
    assert.equal(m.categoryId, NOTIFICATION_CATEGORIES.read);
    assert.equal(m.data.approvalId, undefined);
  }
});

test("approve with the confirmation: decided as the viewer, the run goes on, audit, notification read; twice is done, the other way 409", async () => {
  const a = await asking("Genehmigen");
  const body = { action: "approve", notificationId: a.viewerNotice.id, approvalId: a.approvalId, confirmation: viewerPhone.secret };
  const result = await notificationAction(viewerPhone.user, body, viewerPhone.device);
  assert.equal(result.decision, "approved");
  assert.deepEqual(await approvalRow(a.approvalId), { decision: "approved", decided_by: viewer.id });
  assert.ok((await one<{ read_at: string | null }>("SELECT read_at FROM notifications WHERE id=?", a.viewerNotice.id))!.read_at);
  const audit = await one<{ detail: string }>("SELECT detail FROM audit WHERE action='workflow.approved' AND resource_id=?", a.pageId);
  assert.equal(audit?.detail, `${a.approvalId} app:${viewerPhone.device.id}`);
  await drainWorkflows();
  assert.equal((await lastRun(a.pageId)).status, "succeeded");
  assert.equal((await outputOf(a.runId, a.yes.id)).x, "ja");
  // The same button again (a retry without its key): done, nothing changes.
  const again = await notificationAction(viewerPhone.user, body, viewerPhone.device);
  assert.equal(again.already, true);
  // Rejecting what is decided: refused.
  await assert.rejects(notificationAction(editorPhone.user, { action: "reject", notificationId: a.editorNotice.id }, editorPhone.device), /schon entschieden/);
});

test("reject needs no confirmation: the run takes the rejected branch", async () => {
  const a = await asking("Ablehnen");
  const result = await notificationAction(editorPhone.user, { action: "reject", notificationId: a.editorNotice.id, approvalId: a.approvalId }, editorPhone.device);
  assert.equal(result.decision, "rejected");
  assert.deepEqual(await approvalRow(a.approvalId), { decision: "rejected", decided_by: editor.id });
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.rejected' AND detail=?", `${a.approvalId} app:${editorPhone.device.id}`));
  await drainWorkflows();
  assert.equal((await outputOf(a.runId, a.no.id)).x, "nein");
});

test("approving without the confirmation is refused: missing, wrong, or no key on the device", async () => {
  const a = await asking("Ohne Bestätigung");
  const base = { action: "approve", notificationId: a.viewerNotice.id, approvalId: a.approvalId };
  await assert.rejects(notificationAction(viewerPhone.user, base, viewerPhone.device), (e: { status?: number; message: string }) => e.status === 403 && /Bestätigung/.test(e.message));
  await assert.rejects(notificationAction(viewerPhone.user, { ...base, confirmation: randomBytes(32).toString("base64url") }, viewerPhone.device), /Bestätigung/);
  // The editor's phone registered no confirmation key: approving is not set up there.
  await assert.rejects(
    notificationAction(editorPhone.user, { action: "approve", notificationId: a.editorNotice.id, approvalId: a.approvalId, confirmation: viewerPhone.secret }, editorPhone.device),
    /nicht eingerichtet/,
  );
  // Without the device (the action reached some other way): never.
  await assert.rejects(notificationAction(viewerPhone.user, { ...base, confirmation: viewerPhone.secret }), /nur mit dem Gerät/);
  assert.equal((await approvalRow(a.approvalId)).decision, null);
  // The approval id must be the notification's own.
  await assert.rejects(notificationAction(viewerPhone.user, { ...base, approvalId: randomUUID(), confirmation: viewerPhone.secret }, viewerPhone.device), /keiner Freigabe/);
  assert.equal((await approvalRow(a.approvalId)).decision, null);
});

test("wrong person: another's notification is not found; someone not among the approvers is refused", async () => {
  const a = await asking("Falsche Person");
  await assert.rejects(
    notificationAction(ownerPhone.user, { action: "approve", notificationId: a.viewerNotice.id, approvalId: a.approvalId, confirmation: ownerPhone.secret }, ownerPhone.device),
    (e: { status?: number }) => e.status === 404,
  );
  await assert.rejects(decideApprovalOnDevice(ownerPhone.user, ownerPhone.device, { approvalId: a.approvalId, decision: "rejected" }), /nicht eingetragen/);
  assert.equal((await approvalRow(a.approvalId)).decision, null);
});

test("expired: neither approve nor reject after the deadline", async () => {
  const a = await asking("Frist", { amount: 1, unit: "hours" });
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 3600_000 + 5000 });
  try {
    await assert.rejects(
      notificationAction(viewerPhone.user, { action: "approve", notificationId: a.viewerNotice.id, approvalId: a.approvalId, confirmation: viewerPhone.secret }, viewerPhone.device),
      (e: { status?: number; message: string }) => e.status === 409 && /Frist/.test(e.message),
    );
    await assert.rejects(notificationAction(editorPhone.user, { action: "reject", notificationId: a.editorNotice.id }, editorPhone.device), /Frist/);
  } finally {
    mock.timers.reset();
  }
  assert.equal((await approvalRow(a.approvalId)).decision, null);
});

test("revoked, signed-out and idle devices decide nothing; API tokens never", async () => {
  const a = await asking("Geräte");
  const body = { action: "approve", notificationId: a.viewerNotice.id, approvalId: a.approvalId };
  // Idle longer than allowed (lastSeenAt is the time before this request).
  const idle = { ...viewerPhone.device, lastSeenAt: Date.now() - DEVICE_APPROVAL_IDLE_MS - 1000 };
  await assert.rejects(notificationAction(viewerPhone.user, { ...body, confirmation: viewerPhone.secret }, idle), /zu lange nicht aktiv/);
  // A second phone of the viewer: removed in the settings, its token opens nothing.
  const second = await phone(viewer);
  await unregisterMobileDevice(viewer, second.installationId);
  assert.equal(await deviceFromToken(second.header), null);
  // A third: its session ended (signed out elsewhere).
  const third = await phone(viewer);
  await run("UPDATE sessions SET expires=? WHERE token=(SELECT session_token FROM mobile_devices WHERE id=?)", Date.now() - 1000, third.device.id);
  assert.equal(await deviceFromToken(third.header), null);
  // An API token is no device token; workflow.approve refuses it as before.
  const apiToken = `fp_${randomBytes(30).toString("base64url")}`;
  await run("INSERT INTO api_tokens(id,user_id,name,token_hash,scope,prefix,created_at) VALUES(?,?,?,?,?,?,?)", id(), viewer.id, "t", createHash("sha256").update(apiToken).digest("hex"), "write", apiToken.slice(0, 8), Date.now());
  assert.equal(await deviceFromToken(`Bearer ${apiToken}`), null);
  await assert.rejects(act({ action: "workflow.approve", approvalId: a.approvalId, decision: "approved" }, { ...viewer, apiScope: "write" }), /angemeldet/);
  assert.equal((await approvalRow(a.approvalId)).decision, null);
  // The registered, recently seen phone with its confirmation: decides.
  assert.equal((await notificationAction(viewerPhone.user, { ...body, confirmation: viewerPhone.secret }, viewerPhone.device)).decision, "approved");
});
