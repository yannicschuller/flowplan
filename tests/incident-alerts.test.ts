// Incidents of the instance for administrators (notification kind
// "incident", lib/notification-kinds.ts): only administrators get them, each
// through the channels and from the severity they chose; the notification
// leads to the incident's page; earlier choices for "security" carry over.
import { sqliteOnly } from "./helpers/backend";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-incident-alerts-"));
process.env.APP_URL = "https://flow.example.test";
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_FROM = "flowplan@example.test";
delete process.env.FLOWPLAN_MESSENGER_ALLOW_PRIVATE;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { openIncident } = await import("../lib/security-detect");
const { queueNotificationDigests } = await import("../lib/mail");
const { notificationUrl, loginReturnPath } = await import("../lib/page-location");
const { englishMessage } = await import("../lib/i18n-errors");
const { securityOverview } = await import("../lib/security-admin");
const M = await import("../lib/messengers");

async function person(name: string, admin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,locale) VALUES(?,?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`, "de");
  if (admin)
    await run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)", uid, `${name.toLowerCase()}@example.test`, "x", 1, Date.now());
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: admin, disabled: 0, created_at: "" } as Identity;
}
const root = await person("Root", true),
  vera = await person("Vera", true),
  ada = await person("Ada");
const wid = await createWorkspace(ada.id, "Team");
for (const admin of [root, vera]) await run("INSERT INTO members VALUES(?,?,?)", wid, admin.id, "editor");
const as = (user: Identity) => async (b: Record<string, unknown>) => (await command(user, { workspaceId: wid, ...b })) as Record<string, unknown>;

// Chat apps through a mocked network.
const sent: string[] = [];
M.setMessengerHttp(async (request) => {
  sent.push(request.body);
  return { status: 200, body: '{"ok":true}' };
});
M.setMessengerResolver(async () => ["203.0.113.10"]);

// A push subscription per person: the queue shows what push would carry.
// The keys are not real, so nothing leaves the test.
async function subscribe(user: Identity) {
  const token = id();
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", token, user.id, "[]", Date.now() + 3600_000, Date.now());
  await run(
    "INSERT INTO push_subscriptions(id,user_id,session_token,endpoint,p256dh,auth) VALUES(?,?,?,?,?,?)",
    id(),
    user.id,
    token,
    `https://fcm.googleapis.com/fcm/send/${id()}`,
    "x",
    "y",
  );
}
await subscribe(root);
await subscribe(vera);
await subscribe(ada);
await M.connectMessenger(root, { service: "ntfy", topic: "root-alerts" });
await M.connectMessenger(vera, { service: "ntfy", topic: "vera-alerts" });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const at = () => ({ at: Date.now(), actorId: null, network: "203.0.113.0/24", addressKey: "" });
let n = 0;
// A new incident of a rule (a new key each time, so it is not merged).
// report() runs after openIncident returns (dynamic imports, push dispatch):
// wait until its notifications are written instead of a fixed pause, which
// was too short under the load of the full suite.
async function incident(rule: "brute_force_account" | "credential_stuffing") {
  const count = async () => (await all("SELECT 1 FROM notifications WHERE kind='incident'")).length;
  const before = await count();
  const incidentId = await openIncident(rule, `key-${++n}`, at(), `detail ${n}`);
  for (let waited = 0; (await count()) === before && waited < 5000; waited += 20) await settle();
  await settle();
  return incidentId;
}
const incidentsOf = async (user: Identity) =>
  await all<{ id: string; body: string; link: string | null; page_id: string | null }>(
    "SELECT id,body,link,page_id FROM notifications WHERE user_id=? AND kind='incident' ORDER BY created_at,seq",
    user.id,
  );
const pushQueued = async (notificationId: string) => (await all("SELECT 1 FROM push_deliveries WHERE notification_id=?", notificationId)).length;
const chatQueued = async (notificationId: string) => (await all("SELECT 1 FROM messenger_deliveries WHERE notification_id=?", notificationId)).length;

beforeEach(async () => {
  await run("DELETE FROM notifications");
  await run("DELETE FROM mail_queue");
  await run("DELETE FROM notification_prefs");
  (globalThis as { flowplanSecurityReports?: number[] }).flowplanSecurityReports = [];
});

test("administrators get incidents as their own kind, leading to the incident; others do not", async () => {
  const incidentId = await incident("credential_stuffing");
  for (const admin of [root, vera]) {
    const [notice] = await incidentsOf(admin);
    assert.ok(notice, admin.name);
    assert.match(notice.body, /^Kritischer Sicherheitsvorfall: Viele Konten von einer Adresse probiert – detail \d+\. Details unter Administration → Sicherheit\.$/);
    assert.equal(notice.link, `#admin/threats/incident/${incidentId}`);
    assert.equal(notificationUrl(notice), `/#admin/threats/incident/${incidentId}`);
  }
  assert.equal((await incidentsOf(ada)).length, 0);
  assert.equal((await all("SELECT 1 FROM notifications WHERE kind='security'")).length, 0, "no longer as account notices");
  // In English with the rule's own title.
  assert.equal(
    englishMessage((await incidentsOf(root))[0].body),
    `Critical security incident: Many accounts tried from one address – detail ${n}. Details under Administration → Security.`,
  );
  // Signing in from the push keeps the target.
  assert.equal(loginReturnPath(`/#admin/threats/incident/${incidentId}`), `/#admin/threats/incident/${incidentId}`);
  assert.equal(loginReturnPath("/#admin/threats?next=https://evil.example.test"), "/");
  assert.equal(notificationUrl({ page_id: null, link: "javascript:alert(1)" }), "/#inbox");
});

test("by default inbox, push, e-mail and chat apps; each channel follows the person's choice", async () => {
  const prefs = (await bootstrap(root, wid)).notificationPrefs!;
  assert.deepEqual(prefs.incident, { inbox: true, push: true, email: true, messenger: true });
  // Vera does not want e-mail and chat apps for incidents.
  await as(vera)({ action: "notification.prefs", kind: "incident", inbox: true, push: true, email: false, messenger: false });
  await incident("brute_force_account");
  const [r] = await incidentsOf(root),
    [v] = await incidentsOf(vera);
  assert.equal(await pushQueued(r.id), 1);
  assert.equal(await chatQueued(r.id), 1);
  assert.equal(await pushQueued(v.id), 1);
  assert.equal(await chatQueued(v.id), 0, "no chat app for Vera");
  await queueNotificationDigests(Date.now() + 30 * 60_000);
  const recipients = await all<{ recipient: string; text: string }>("SELECT recipient,text FROM mail_queue");
  assert.deepEqual(recipients.map((m) => m.recipient), [root.email]);
  assert.match(recipients[0].text, /https:\/\/flow\.example\.test\/#admin\/threats\/incident\/[0-9a-f-]{36}/);
  // The chat app's message: urgent, titled, linked to the incident.
  const message = await M.notificationMessage({ ...r, kind: "incident" }, "de", { preview: true, encrypted: false });
  assert.equal(message.urgent, true);
  assert.match(message.title, /Sicherheitsvorfall$/);
  assert.match(message.url, /\/#admin\/threats\/incident\//);
  // Inbox off: nothing at all.
  await as(vera)({ action: "notification.prefs", kind: "incident", inbox: false, push: true, email: true, messenger: true });
  await incident("brute_force_account");
  assert.equal((await incidentsOf(vera)).length, 1);
  assert.equal((await incidentsOf(root)).length, 2);
  // The own account notices stay apart.
  assert.deepEqual((await bootstrap(vera, wid)).notificationPrefs!.security, { inbox: true, push: true, email: true, messenger: true });
});

test("the severity threshold: all by default, critical only filters every channel", async () => {
  assert.equal((await bootstrap(root, wid)).incidentThreshold, "all");
  assert.equal("incidentThreshold" in (await bootstrap(ada, wid)), false, "not for others");
  await as(root)({ action: "notification.prefs", kind: "incident", inbox: true, push: true, email: true, messenger: true, threshold: "critical" });
  assert.equal((await bootstrap(root, wid)).incidentThreshold, "critical");
  await incident("brute_force_account");
  assert.equal((await incidentsOf(root)).length, 0, "a warning does not reach Root");
  assert.equal((await incidentsOf(vera)).length, 1);
  await incident("credential_stuffing");
  assert.equal((await incidentsOf(root)).length, 1, "a critical one does");
  // Switching channels keeps the threshold.
  await as(root)({ action: "notification.prefs", kind: "incident", inbox: true, push: false, email: true, messenger: true });
  assert.equal((await bootstrap(root, wid)).incidentThreshold, "critical");
  // The security page says how the administrator is notified.
  const alerts = (await securityOverview(Date.now(), root)).alerts!;
  assert.equal(alerts.threshold, "critical");
  assert.equal(alerts.push, false);
  assert.equal(alerts.reach.messenger, true);
  assert.equal((await securityOverview()).alerts, null);
  // Back to the defaults: all again.
  await as(root)({ action: "notification.reset" });
  assert.equal((await bootstrap(root, wid)).incidentThreshold, "all");
  // Only incidents have a threshold.
  await assert.rejects(async () => await as(root)({ action: "notification.prefs", kind: "mention", inbox: true, push: true, threshold: "critical" }), /Schwelle/);
});

test("people who are not administrators cannot set incidents", async () => {
  await assert.rejects(
    async () => await as(ada)({ action: "notification.prefs", kind: "incident", inbox: false, push: false }),
    (e: { status?: number }) => e.status === 403,
  );
  // The e-mail switch of the introduction covers incidents for admins.
  await as(root)({ action: "notification.email", email: false });
  assert.ok(await one("SELECT 1 FROM notification_prefs WHERE user_id=? AND kind='incident' AND email=0", root.id));
});

test("at most 30 reports an hour", async () => {
  for (let i = 0; i < 32; i++) await openIncident("brute_force_account", `flood-${i}`, at(), "");
  for (let i = 0; i < 20 && (await incidentsOf(root)).length < 30; i++) await settle();
  await settle();
  assert.equal((await incidentsOf(root)).length, 30);
});

test("upgrading: a channel switched off for security notices stays off for incidents", { skip: sqliteOnly }, async () => {
  // As before schema 81: Root turned push off for "security", Vera e-mail.
  await run("INSERT INTO notification_prefs(user_id,kind,inbox,push,email,messenger) VALUES(?,?,?,?,?,?)", root.id, "security", 1, 0, 1, 1);
  await run("INSERT INTO notification_prefs(user_id,kind,inbox,push,email,messenger) VALUES(?,?,?,?,?,?)", vera.id, "security", 1, 1, 0, null);
  await run("ALTER TABLE notification_prefs DROP COLUMN min_severity");
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  assert.deepEqual((await bootstrap(root, wid)).notificationPrefs!.incident, { inbox: true, push: false, email: true, messenger: true });
  assert.deepEqual((await bootstrap(vera, wid)).notificationPrefs!.incident, { inbox: true, push: true, email: false, messenger: true });
  assert.ok(await one("SELECT 1 FROM pragma_table_info('notification_prefs') WHERE name='min_severity'")); // sqlite-only
  // Only once: a later change of "security" does not touch incidents.
  await as(root)({ action: "notification.prefs", kind: "security", inbox: true, push: true, email: true, messenger: true });
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  assert.equal((await bootstrap(root, wid)).notificationPrefs!.incident.push, false);
  await incident("brute_force_account");
  const [r] = await incidentsOf(root);
  assert.equal(await pushQueued(r.id), 0, "no push for Root");
});

test("the inbox item leads to the incident; only in-app routes are honoured as targets", async () => {
  const incidentId = await incident("brute_force_account");
  // What the inbox gets (bootstrap) opens the incident's page.
  const item = ((await bootstrap(root, wid)).notifications as { kind?: string | null; page_id: string | null; link?: string | null }[]).find((x) => x.kind === "incident")!;
  assert.equal(notificationUrl(item), `/#admin/threats/incident/${incidentId}`);
  // The desktop app's feed and the push payload use the same target.
  const { notificationFeed } = await import("../lib/notification-feed");
  assert.equal((await notificationFeed(root, null)).notifications.find((x) => x.kind === "incident")?.url, `/#admin/threats/incident/${incidentId}`);
  for (const link of [
    "https://evil.example.test/#admin",
    "//evil.example.test",
    "javascript:alert(1)",
    "#admin/../../x",
    "#admin/threats?x=https://evil",
    "#page=abc",
    "#elsewhere/route",
    `#admin/${"a".repeat(65)}`,
  ])
    assert.equal(notificationUrl({ page_id: null, link }), "/#inbox", link);
  assert.equal(notificationUrl({ page_id: null, link: "#settings/notifications/messengers" }), "/#settings/notifications/messengers");
  // A page always wins over a link.
  assert.match(notificationUrl({ page_id: "00000000-0000-4000-8000-000000000000", link: "#admin/threats" }), /^\/#page=/);
  // Incidents from before (kind "security", "Sicherheit: …", no target): the security page.
  assert.equal(notificationUrl({ page_id: null, kind: "security", body: "Sicherheit: Abtasten von Adressen und IDs – 60 × 401/403/404. Details unter Administration → Sicherheit." }), "/#admin/threats");
  assert.equal(notificationUrl({ page_id: null, kind: "security", body: "Neue Anmeldung bei deinem Konto: x" }), "/#inbox");
});
