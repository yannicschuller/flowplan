// Instance-wide alerts for critical security events (#321): admin rights
// removed (by an admin or through the SSO group at sign-in), an admin's
// two-factor sign-in turned off, emergency access granted or used for an
// export, SSO group mappings and settings that open access to the instance.
// Each opens an incident that reaches the administrators (notification kind
// "incident", from the severity each chose) and the operator's webhook
// (ops.security).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-instance-alerts-"));
process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
const { run, one, all, audit } = await import("../lib/db");
const { command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { adminGroup, createSession } = await import("../lib/auth");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const localAuth = await import("../lib/local-auth");
const tf = await import("../lib/two-factor");
const totp = await import("../lib/totp");
const events = await import("../lib/security-events");
const ops = await import("../lib/admin-ops");
const { securityIncident } = await import("../lib/security-admin");

await saveInstanceSettings({ allowSignup: true });
async function account(name: string, admin = false): Promise<Identity> {
  const { user } = await localAuth.register({ name, email: `${name.toLowerCase()}@example.test`, password: `${name}-passwort-123` }, "de");
  await run("UPDATE local_accounts SET is_admin=? WHERE user_id=?", admin ? 1 : 0, user.id);
  return { id: user.id, name, email: `${name.toLowerCase()}@example.test`, groups: admin ? [adminGroup()] : [], isAdmin: admin, disabled: 0, created_at: "" } as Identity;
}
const root = await account("Root", true),
  vera = await account("Vera", true),
  ada = await account("Ada"),
  ben = await account("Ben"),
  sso = await account("Sso");
const wid = await createWorkspace(root.id, "Team");
// Settings saved before the test starts are no incident of a test.
await saveInstanceSettings({ allowSignup: false });

// The operator's webhook, receiving "security".
const received: Record<string, string>[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push(JSON.parse(body));
    res.end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
await ops.saveAlertSettings(root.id, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/alerts`, events: ["security"] });

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
// The events are written after the command, the report after the incident.
async function settled(until: () => Promise<boolean> = async () => true) {
  await pause();
  await events.securityWritesSettled();
  for (let waited = 0; !(await until()) && waited < 5000; waited += 20) await pause();
  await pause();
}
const incidents = async (rule: string) => await all<{ id: string; severity: string; key: string; count: number; actor_id: string | null; detail: string }>("SELECT * FROM security_incidents WHERE rule=?", rule);
const noticesOf = async (user: Identity) => await all<{ body: string; link: string }>("SELECT body,link FROM notifications WHERE user_id=? AND kind='incident'", user.id);
const webhookFor = (rule: string) => received.filter((r) => r.rule === rule);
const reported = (rule: string) => async () => webhookFor(rule).length > 0;

beforeEach(async () => {
  await run("DELETE FROM security_events");
  await run("DELETE FROM security_incidents");
  await run("DELETE FROM notifications");
  await run("DELETE FROM notification_prefs");
  received.length = 0;
  (globalThis as { flowplanSecurityReports?: number[] }).flowplanSecurityReports = [];
});

test("removing admin rights is critical: incident, every admin notified, webhook payload", async () => {
  await command(root, { action: "admin.localAdmin", userId: vera.id, admin: true });
  await settled(reported("privilege_change"));
  received.length = 0;
  await run("DELETE FROM notifications");
  await command(root, { action: "admin.localAdmin", userId: ben.id, admin: false });
  await command(root, { action: "admin.localAdmin", userId: vera.id, admin: false });
  await settled(reported("privilege_change"));
  const revoked = (await incidents("privilege_change")).filter((i) => i.detail.startsWith("revoked:"));
  assert.equal(revoked.length, 2, "one incident per change");
  assert.ok(revoked.every((i) => i.severity === "critical"));
  assert.match(revoked[0].detail, /^revoked: local account /);
  // Root is still an admin and hears of it; Ada never.
  const [notice] = await noticesOf(root);
  assert.match(notice.body, /^Kritischer Sicherheitsvorfall: Rechte oder Anmeldung der Instanz geändert – revoked: local account /);
  assert.match(notice.link, /^#admin\/threats\/incident\//);
  assert.equal((await noticesOf(ada)).length, 0);
  const [hook] = webhookFor("privilege_change");
  assert.equal(hook.event, "ops.security");
  assert.equal(hook.severity, "critical");
  assert.match(hook.detail, /Rights or sign-in of the instance changed – revoked: local account|Rechte oder Anmeldung der Instanz geändert – revoked: local account/);
  await run("UPDATE local_accounts SET is_admin=1 WHERE user_id=?", vera.id);
});

test("admin rights that went with the SSO group at sign-in are an incident too", async () => {
  const headers = new Headers({ "user-agent": "Mozilla/5.0 Chrome/130.0" });
  await createSession(sso.id, [adminGroup()], undefined, { sso: true }, headers);
  await createSession(sso.id, [], undefined, { sso: true }, headers);
  await settled(async () => (await incidents("privilege_change")).length >= 1);
  const kinds = (await all<{ kind: string }>("SELECT kind FROM security_events WHERE kind LIKE 'admin.%'")).map((e) => e.kind);
  assert.deepEqual(kinds, ["admin.revoked"]);
  const [incident] = await incidents("privilege_change");
  assert.equal(incident.detail, "revoked: SSO group at sign-in");
  assert.equal(incident.actor_id, sso.id);
});

async function withApp(user: Identity) {
  const now = Date.now();
  const setup = await tf.startTotpSetup({ id: user.id }, "de");
  await tf.confirmTotpSetup(user.id, { code: totp.totpCode(setup.secret, now) }, "de", now);
}

test("an admin turning off two-factor is critical; a non-admin is no incident", async () => {
  await withApp(ada);
  await tf.disableTotp(ada.id, { password: "Ada-passwort-123" }, "", "de");
  await settled();
  assert.equal((await all("SELECT 1 FROM security_events WHERE kind='account.2fa_off'")).length, 1);
  assert.deepEqual(await incidents("admin_2fa_off"), [], "not for someone who is not an admin");
  assert.equal(received.length, 0);

  await withApp(vera);
  await tf.disableTotp(vera.id, { password: "Vera-passwort-123" }, "", "de");
  await settled(reported("admin_2fa_off"));
  const event = await one<{ severity: string; detail: string }>("SELECT severity,detail FROM security_events WHERE kind='account.2fa_off' AND actor_id=?", vera.id);
  assert.deepEqual({ ...event }, { severity: "critical", detail: "admin account" });
  const [incident] = await incidents("admin_2fa_off");
  assert.equal(incident.severity, "critical");
  assert.equal(incident.key, `account:${vera.id}`);
  for (const admin of [root, vera]) assert.match((await noticesOf(admin))[0]?.body ?? "", /^Kritischer Sicherheitsvorfall: Zwei-Faktor eines Admins ausgeschaltet/);
  assert.equal(webhookFor("admin_2fa_off")[0].severity, "critical");
  // Another admin resetting it counts on the same open incident.
  await withApp(vera);
  await command(root, { action: "admin.twoFactorReset", userId: vera.id });
  await settled();
  const [again] = await incidents("admin_2fa_off");
  assert.equal(again.count, 2);
  assert.match(again.detail, new RegExp(`^two-factor reset ${vera.id} by ${root.id}$`));
  assert.equal(webhookFor("admin_2fa_off").length, 1, "deduplicated: no second report");
  // The incident's page shows both steps.
  const page = await securityIncident(again.id);
  assert.ok(page.events.some((e: { kind: string }) => e.kind === "admin.user"), "the reset by Root");
  assert.ok(page.events.some((e: { kind: string }) => e.kind === "account.2fa_off"));
  // Resetting a non-admin's app is no incident.
  await withApp(ben);
  await run("DELETE FROM security_incidents");
  await command(root, { action: "admin.twoFactorReset", userId: ben.id });
  await settled();
  assert.deepEqual(await incidents("admin_2fa_off"), []);
});

test("emergency access granted or exported through is a warning, once a day per holder and contact", async () => {
  const detail = `holder:${ada.id} contact:${ben.id}`;
  await audit(ben.id, "emergency.request", "link-1", detail);
  await audit(ben.id, "emergency.view", "link-1", `${detail} overview`);
  await settled();
  assert.deepEqual(await incidents("emergency_access"), [], "requested and viewed: nothing yet");
  await audit(ben.id, "emergency.grant", "link-1", `${detail} waited 7d`);
  await settled(reported("emergency_access"));
  const [incident] = await incidents("emergency_access");
  assert.equal(incident.severity, "warn");
  assert.equal(incident.key, detail);
  assert.equal(incident.actor_id, ben.id, "the contact's incident");
  assert.match((await noticesOf(root))[0].body, /^Sicherheitsvorfall: Notfallzugriff freigegeben oder für einen Export genutzt – holder:/);
  assert.equal(webhookFor("emergency_access")[0].severity, "warn");
  // The inactivity message grants in the holder's name: still the contact's.
  await audit(ben.id, "emergency.export", "link-1", `${detail} space:s1`);
  await audit(ada.id, "emergency.grant", "link-1", `${detail} deadman:d1`);
  await settled();
  const [counted] = await incidents("emergency_access");
  assert.equal(counted.count, 3);
  assert.equal(counted.actor_id, ben.id);
  assert.equal(webhookFor("emergency_access").length, 1);
  // The existing rule for requests stays as it was.
  assert.deepEqual(await incidents("emergency_requests"), []);
});

test("SSO group mappings are an event and a warning; several count on one incident", async () => {
  const added = (await command(root, { action: "admin.ssoMapping.add", workspaceId: wid, ssoGroup: "staff", role: "owner" })) as { id: string };
  await command(root, { action: "admin.ssoMapping.add", workspaceId: wid, ssoGroup: "interns", role: "viewer" });
  await command(root, { action: "admin.ssoMapping.delete", workspaceId: wid, id: added.id });
  await settled(reported("instance_policy_change"));
  const details = (await all<{ detail: string; severity: string }>("SELECT detail,severity FROM security_events WHERE kind='admin.sso_mapping_changed' ORDER BY id")).map((e) => `${e.severity} ${e.detail}`);
  assert.deepEqual(details, [
    `warn added "staff" → role owner in workspace ${wid}`,
    `warn added "interns" → role viewer in workspace ${wid}`,
    `warn removed "staff" → role owner in workspace ${wid}`,
  ]);
  const [incident] = await incidents("instance_policy_change");
  assert.equal(incident.severity, "warn");
  assert.equal(incident.count, 3);
  assert.equal(webhookFor("instance_policy_change").length, 1);
  assert.match(webhookFor("instance_policy_change")[0].detail, /SSO/);
  // Deleting a mapping that is not there records nothing.
  await command(root, { action: "admin.ssoMapping.delete", workspaceId: wid, id: added.id });
  await settled();
  assert.equal((await all("SELECT 1 FROM security_events WHERE kind='admin.sso_mapping_changed'")).length, 3);
});

test("settings that open access are a warning; closing it again is only an event", async () => {
  await command(root, { action: "admin.settings", settings: { allowSignup: true, publicDemo: true, twoFactor: "all", inviteLinks: false } });
  await settled(reported("instance_policy_change"));
  const details = async () => (await all<{ detail: string }>("SELECT detail FROM security_events WHERE kind='admin.settings' ORDER BY id")).map((e) => e.detail);
  assert.deepEqual(await details(), ["allowSignup on", "publicDemo on", "inviteLinks off", "twoFactor off→all"]);
  assert.deepEqual((await incidents("instance_policy_change")).map((i) => i.key).sort(), ["setting:allowSignup", "setting:publicDemo"]);
  // Relaxing two-factor, links and emergency access back on: incidents.
  await command(root, { action: "admin.settings", settings: { allowSignup: false, publicDemo: false, twoFactor: "admins", inviteLinks: true, emergencyAccess: false } });
  await command(root, { action: "admin.settings", settings: { emergencyAccess: true } });
  await settled(async () => (await incidents("instance_policy_change")).length >= 5);
  assert.deepEqual((await incidents("instance_policy_change")).map((i) => i.key).sort(), [
    "setting:admin.emergency",
    "setting:allowSignup",
    "setting:inviteLinks",
    "setting:publicDemo",
    "setting:twoFactor",
  ]);
  assert.ok((await details()).includes("twoFactor all→admins"));
  // Sign-up switched on again within the day: the same incident, counted.
  await command(root, { action: "admin.settings", settings: { allowSignup: true } });
  await settled();
  assert.equal((await incidents("instance_policy_change")).find((i) => i.key === "setting:allowSignup")?.count, 2);
  await saveInstanceSettings({ allowSignup: false, publicDemo: false, twoFactor: "off" });
});

test("each admin's threshold: critical only gets the critical alerts", async () => {
  await command(vera, { workspaceId: wid, action: "notification.prefs", kind: "incident", inbox: true, push: true, email: true, messenger: true, threshold: "critical" });
  await command(root, { action: "admin.ssoMapping.add", workspaceId: wid, ssoGroup: "guests", role: "viewer" });
  await settled(reported("instance_policy_change"));
  assert.equal((await noticesOf(root)).length, 1, "Root: all");
  assert.equal((await noticesOf(vera)).length, 0, "Vera: no warning");
  await withApp(root);
  await tf.disableTotp(root.id, { password: "Root-passwort-123" }, "", "de");
  await settled(reported("admin_2fa_off"));
  assert.equal((await noticesOf(vera)).length, 1, "Vera: the critical one");
  assert.match((await noticesOf(vera))[0].body, /Zwei-Faktor eines Admins/);
});

test("the security log modes: the new events leave the address out when anonymous, none when off", async () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).includes('"flowplan.security"')) lines.push(String(chunk));
    else return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    return true;
  }) as typeof process.stdout.write;
  try {
    process.env.FLOWPLAN_SECURITY_LOG = "anonymous";
    events.securityEvent("admin.sso_mapping_changed", { actorId: root.id, address: "203.0.113.9", detail: "added x" });
    await settled(reported("instance_policy_change"));
    process.env.FLOWPLAN_SECURITY_LOG = "off";
    events.securityEvent("admin.revoked", { actorId: root.id, address: "203.0.113.9", detail: "local account x" });
    await settled(reported("privilege_change"));
  } finally {
    process.stdout.write = write;
    delete process.env.FLOWPLAN_SECURITY_LOG;
  }
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.event, "admin.sso_mapping_changed");
  assert.equal(line.ip, undefined);
  assert.equal(line.network, "203.0.113.0/24");
  // The alerts do not depend on the log line.
  assert.equal((await incidents("instance_policy_change")).length, 1);
  assert.equal((await incidents("privilege_change")).length, 1);
});
