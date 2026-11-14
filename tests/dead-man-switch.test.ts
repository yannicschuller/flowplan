// Inactivity message per workspace ("dead man's switch", #282,
// lib/dead-man-switch.ts): arming and its limits, what counts as a sign of
// life (account-wide or one workspace), the warnings 7/3/1 days before, the
// "Ich bin da" link, sending once per arming, re-arming, the coupling to
// emergency access (#281), the instance's switch and mail delivery, API
// tokens, the holder's e-mail on changes, the log and security events.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-deadman-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_FROM = "Flowplan <noreply@flowplan.example.test>";
const { id, run, one, all } = await import("../lib/db");
const { command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const dm = await import("../lib/dead-man-switch");
const { deadmanHerePage, deadmanHere } = await import("../lib/dead-man-page");
const { recordWorkspaceActivity, recordActivity } = await import("../lib/user-activity");
const { securityWritesSettled } = await import("../lib/security-events");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { setMailSender, flushMailQueue } = await import("../lib/mail");

const DAY = 86_400_000;
const NOTE = "Die Zugangsdaten liegen im Ordner „Haus“. Ruft bitte Tante Inge an.";

async function user(name: string): Promise<Identity> {
  const uid = id();
  const unique = `${name}${uid.slice(0, 6)}`;
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, unique, `${unique}@example.com`);
  return { id: uid, name: unique, email: `${unique}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = async (who: Identity, input: Record<string, unknown>) => (await command(who, input)) as Record<string, unknown>;
const arm = async (who: Identity, workspaceId: string, extra: Record<string, unknown> = {}) =>
  await act(who, { action: "deadman.save", workspaceId, enabled: true, periodDays: 90, note: NOTE, recipients: ["kim@family.example", "Lou@Family.example"], ...extra });
const row = async (switchId: string) => (await one<import("../lib/dead-man-switch").SwitchRow>("SELECT * FROM deadman_switches WHERE id=?", switchId))!;
const mailsTo = async (to: string) =>
  await all<{ subject: string; text: string; html: string; from_name: string | null }>("SELECT subject,text,html,from_name FROM mail_queue WHERE recipient=? ORDER BY seq", to);
const notes = async (who: Identity) => (await all<{ body: string; link: string | null }>("SELECT body,link FROM notifications WHERE user_id=? ORDER BY created_at,rowid", who.id));
const auditOf = async (switchId: string) => (await all<{ action: string; detail: string }>("SELECT action,detail FROM audit WHERE resource_id=? ORDER BY created_at,rowid", switchId)).map((a) => a.action);
const tokenOf = (text: string) => decodeURIComponent(/\/api\/deadman\/here\?token=([^\s]+)/.exec(text)![1]);

// Every test starts without switches and mail: the worker looks at all of them.
beforeEach(async () => {
  await run("DELETE FROM deadman_switches");
  await run("DELETE FROM mail_queue");
});

// A holder in a workspace of her own, armed; returns the switch and its start.
async function armed(extra: Record<string, unknown> = {}) {
  const alice = await user("alice");
  const wid = await createWorkspace(alice.id, "Zuhause");
  const switchId = String((await arm(alice, wid, extra)).id);
  return { alice, wid, switchId, start: (await row(switchId)).checkin_at };
}

test("arming: validated, limited, listed back; guests, tokens and demos refused", async () => {
  const alice = await user("alice");
  const wid = await createWorkspace(alice.id, "Zuhause");
  await assert.rejects(arm(alice, wid, { periodDays: 45 }));
  await assert.rejects(arm(alice, wid, { recipients: ["kein-at"] }), /Ungültige E-Mail-Adresse: kein-at/);
  await assert.rejects(arm(alice, wid, { recipients: Array.from({ length: 11 }, (_, i) => `p${i}@example.org`) }), /Höchstens 10 Empfänger/);
  await assert.rejects(arm(alice, wid, { note: "x".repeat(5001) }), /höchstens 5000 Zeichen/);
  await assert.rejects(arm(alice, wid, { note: "  " }), /Notiz und mindestens einen Empfänger/);
  await assert.rejects(arm(alice, wid, { recipients: [] }), /Notiz und mindestens einen Empfänger/);
  // Ten (after removing duplicates in any case) are fine.
  const ten = Array.from({ length: 10 }, (_, i) => `p${i}@example.org`);
  const switchId = String((await arm(alice, wid, { recipients: [...ten, "P0@example.org"] })).id);
  assert.deepEqual(JSON.parse((await row(switchId)).recipients), ten);
  const overview = await dm.deadmanOverview(alice);
  assert.equal(overview.available, true);
  const mine = overview.workspaces.find((w) => w.workspaceId === wid)!.switch!;
  assert.equal(mine.state, "armed");
  assert.deepEqual(mine.recipients, ten);
  assert.equal(mine.periodDays, 90);
  assert.equal(mine.source, "account");
  assert.ok(mine.fireAt! >= mine.lastCheckin + 90 * DAY);
  assert.equal(mine.nextWarningAt, mine.lastCheckin + 83 * DAY);
  // Disarm and remove.
  await act(alice, { action: "deadman.save", workspaceId: wid, enabled: false, note: NOTE, recipients: ten });
  assert.equal((await dm.deadmanOverview(alice)).workspaces.find((w) => w.workspaceId === wid)!.switch!.state, "off");
  // At most three per person.
  for (const name of ["Arbeit", "Verein"]) await arm(alice, await createWorkspace(alice.id, name));
  await assert.rejects(arm(alice, await createWorkspace(alice.id, "Viertes")), /Höchstens 3 Nachrichten/);
  await act(alice, { action: "deadman.remove", workspaceId: wid });
  assert.equal(await one("SELECT 1 FROM deadman_switches WHERE id=?", switchId), undefined);
  assert.deepEqual(await auditOf(switchId), ["deadman.arm", "deadman.recipients", "deadman.disarm", "deadman.disarm"]);
  // Guests and outsiders cannot; API tokens and demos never.
  const guest = await user("gast");
  await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
  await assert.rejects(arm(guest, wid), /keine Gäste/);
  await assert.rejects(arm(await user("fremd"), wid), /keine Gäste/);
  assert.equal((await dm.deadmanOverview(guest)).workspaces.some((w) => w.workspaceId === wid), false);
  for (const scope of ["read", "write", "clipper"] as const) {
    await assert.rejects(arm({ ...alice, apiScope: scope }, wid), /API-Token|nur lesen/);
    await assert.rejects(dm.deadmanOverview({ ...alice, apiScope: scope }), /API-Token/);
  }
  await assert.rejects(act({ ...alice, apiScope: "write" }, { action: "deadman.checkin" }), /API-Token/);
  await assert.rejects(dm.deadmanCommand({ ...alice, demo: true }, "deadman.save", {}), /Demo/);
  const { tokenRefusedActionPrefixes } = await import("../lib/openapi");
  assert.ok((tokenRefusedActionPrefixes as readonly string[]).includes("deadman."));
});

test("warnings 7, 3 and 1 day before, once each, with an “Ich bin da” link; then sent once to each recipient", async () => {
  const { alice, wid, switchId, start } = await armed();
  assert.equal(await dm.processDeadman(start + 82 * DAY), 0);
  assert.equal(await dm.processDeadman(start + 83 * DAY), 1);
  assert.equal(await dm.processDeadman(start + 83 * DAY + 60_000), 0);
  assert.equal(await dm.processDeadman(start + 87 * DAY), 1);
  assert.equal(await dm.processDeadman(start + 88 * DAY), 0);
  assert.equal(await dm.processDeadman(start + 89 * DAY), 1);
  assert.equal(await dm.processDeadman(start + 89 * DAY + 3600_000), 0);
  const warnings = (await mailsTo(alice.email)).filter((m) => /Erinnerung/.test(m.subject));
  assert.deepEqual(
    warnings.map((m) => m.subject),
    [
      "Erinnerung: Deine Nachricht bei Inaktivität wird in 7 Tagen verschickt",
      "Erinnerung: Deine Nachricht bei Inaktivität wird in 3 Tagen verschickt",
      "Letzte Erinnerung: Deine Nachricht bei Inaktivität wird morgen verschickt",
    ],
  );
  for (const m of warnings) {
    assert.match(m.text, /Ich bin da: https:\/\/flowplan\.example\.test\/api\/deadman\/here\?token=/);
    assert.match(m.text, /kim@family\.example, lou@family\.example/);
  }
  const inApp = (await notes(alice)).filter((n) => /^Erinnerung: Deine Nachricht bei Inaktivität für „Zuhause“/.test(n.body));
  assert.equal(inApp.length, 3);
  assert.equal(inApp[0].link, "#settings/account/deadman");
  // Nobody heard anything yet.
  assert.equal((await mailsTo("kim@family.example")).length, 0);
  // The period ends: sent, in the same step as marking it.
  assert.equal(await dm.processDeadman(start + 90 * DAY + 60_000), 1);
  assert.equal((await row(switchId)).state, "fired");
  for (const to of ["kim@family.example", "lou@family.example"]) {
    const mails = await mailsTo(to);
    assert.equal(mails.length, 1, to);
    const [m] = mails;
    assert.equal(m.from_name, `${alice.name} via Flowplan (flowplan.example.test)`);
    assert.equal(m.subject, `Eine Nachricht von ${alice.name}`);
    assert.ok(m.text.startsWith(NOTE));
    assert.match(m.text, /90 Tage lang nicht genutzt/);
    assert.match(m.text, /nur einmal verschickt/);
    // No workspace content but the note, no tracking, no links or images.
    assert.doesNotMatch(m.text + m.html, /Zuhause|<img|https?:\/\/|token=/);
    assert.match(m.html, /Tante Inge/);
  }
  // Never twice for one arming, also when the worker runs again.
  assert.equal(await dm.processDeadman(start + 91 * DAY), 0);
  assert.equal(await dm.processDeadman(start + 200 * DAY), 0);
  assert.equal((await mailsTo("kim@family.example")).length, 1);
  // The holder hears of it.
  assert.ok((await mailsTo(alice.email)).some((m) => m.subject === "Deine Nachricht bei Inaktivität wurde verschickt"));
  assert.match((await notes(alice)).at(-1)!.body, /für „Zuhause“ wurde an kim@family\.example, lou@family\.example verschickt/);
  assert.equal((await dm.deadmanOverview(alice)).workspaces.find((w) => w.workspaceId === wid)!.switch!.state, "fired");
  assert.deepEqual(await auditOf(switchId), ["deadman.arm", "deadman.recipients", "deadman.warn", "deadman.warn", "deadman.warn", "deadman.fire"]);
  // The sender's name reaches the SMTP envelope (the address stays the instance's).
  const sent: { to: string; from?: unknown }[] = [];
  setMailSender(async (m) => void sent.push(m));
  try {
    await flushMailQueue();
  } finally {
    setMailSender(undefined);
  }
  assert.deepEqual(sent.find((m) => m.to === "kim@family.example")!.from, { name: `${alice.name} via Flowplan (flowplan.example.test)`, address: "noreply@flowplan.example.test" });
  await securityWritesSettled();
  const fired = await one<{ severity: string; actor_id: string }>("SELECT severity,actor_id FROM security_events WHERE kind='deadman.fired' AND detail LIKE ?", `${switchId}%`);
  assert.equal(fired?.severity, "warn");
  assert.equal(fired?.actor_id, alice.id);
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='deadman.warning' AND detail LIKE ?", `${switchId}%`));
  assert.equal((await one<{ severity: string }>("SELECT severity FROM security_events WHERE kind='deadman.armed' AND detail LIKE ?", `${switchId}%`))?.severity, "info");
});

test("never sent without a last warning a day before (after a pause of the worker)", async () => {
  const { alice, switchId, start } = await armed();
  // The worker was away for the whole period: one warning, not three.
  assert.equal(await dm.processDeadman(start + 120 * DAY), 1);
  const warnings = (await mailsTo(alice.email)).filter((m) => /Erinnerung/.test(m.subject));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].subject, /morgen/);
  assert.equal(await dm.processDeadman(start + 120 * DAY + 23 * 3600_000), 0);
  assert.equal((await row(switchId)).state, "armed");
  assert.equal(await dm.processDeadman(start + 121 * DAY + 60_000), 1);
  assert.equal((await row(switchId)).state, "fired");
});

test("an account disabled by the administration keeps its switch: it still goes off", async () => {
  const { alice, switchId, start } = await armed();
  const { setUserDisabled } = await import("../lib/account-deletion");
  await setUserDisabled(alice.id, true);
  for (const d of [83, 87, 89]) await dm.processDeadman(start + d * DAY);
  await dm.processDeadman(start + 90 * DAY + 60_000);
  assert.equal((await row(switchId)).state, "fired");
  assert.equal((await mailsTo("kim@family.example")).length, 1);
});

test("a sign of life resets it: any use of the account by default, only the workspace if chosen", async () => {
  const { alice, switchId, start } = await armed();
  await dm.processDeadman(start + 83 * DAY);
  assert.equal((await row(switchId)).warned, 1);
  // Using the app (account-wide): the warnings are void, the period starts again.
  await run("UPDATE users SET last_active_at=? WHERE id=?", start + 84 * DAY, alice.id);
  assert.equal(await dm.processDeadman(start + 84 * DAY), 1);
  assert.equal((await row(switchId)).warned, 0);
  assert.equal(await dm.processDeadman(start + 100 * DAY), 0);
  assert.equal(await dm.processDeadman(start + 167 * DAY), 1);
  assert.ok((await auditOf(switchId)).includes("deadman.checkin"));
  // A sign-in counts too.
  await run("UPDATE users SET last_login_at=? WHERE id=?", start + 168 * DAY, alice.id);
  await dm.processDeadman(start + 168 * DAY);
  assert.equal((await row(switchId)).warned, 0);

  // Only this workspace: use elsewhere does not count.
  const bob = await user("bob");
  const home = await createWorkspace(bob.id, "Zuhause");
  const work = await createWorkspace(bob.id, "Arbeit");
  const ws = String((await arm(bob, home, { source: "workspace" })).id);
  const t0 = (await row(ws)).checkin_at;
  await run("UPDATE users SET last_active_at=?,last_login_at=? WHERE id=?", t0 + 85 * DAY, t0 + 85 * DAY, bob.id);
  await recordWorkspaceActivity(bob.id, work, t0 + 85 * DAY);
  await dm.processDeadman(t0 + 85 * DAY);
  assert.equal((await row(ws)).warned, 1);
  // Use of the workspace itself does.
  await recordWorkspaceActivity(bob.id, home, t0 + 86 * DAY);
  await dm.processDeadman(t0 + 86 * DAY);
  assert.equal((await row(ws)).warned, 0);
  assert.equal(await dm.processDeadman(t0 + 170 * DAY), 1);
  // Written at most once an hour; only for full members.
  assert.equal(await recordWorkspaceActivity(bob.id, home, t0 + 86 * DAY + 60_000), false);
  assert.equal(await recordWorkspaceActivity(bob.id, home, t0 + 87 * DAY), true);
  const guest = await user("gast");
  await run("INSERT INTO members VALUES(?,?,?)", home, guest.id, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", home, guest.id);
  await recordWorkspaceActivity(guest.id, home, Date.now());
  assert.equal(await one("SELECT 1 FROM workspace_activity WHERE user_id=?", guest.id), undefined);
  // The open app's ping names the workspace; an idle or foreign one does not count.
  const carol = await user("carol");
  const cw = await createWorkspace(carol.id, "Verein");
  await recordActivity(carol, { idleMs: 10 * 60_000, workspaceId: cw });
  assert.equal(await one("SELECT 1 FROM workspace_activity WHERE user_id=?", carol.id), undefined);
  await recordActivity(carol, { idleMs: 1000, workspaceId: cw });
  assert.ok(await one("SELECT 1 FROM workspace_activity WHERE user_id=? AND workspace_id=?", carol.id, cw));
  await recordActivity(carol, { idleMs: 1000, workspaceId: home });
  assert.equal(await one("SELECT 1 FROM workspace_activity WHERE user_id=? AND workspace_id=?", carol.id, home), undefined);
});

test("the “Ich bin da” link: the page only asks, the button checks in once; it expires", async () => {
  const { alice, switchId, start } = await armed();
  const now = start + 83 * DAY;
  await dm.processDeadman(now);
  const token = tokenOf((await mailsTo(alice.email)).find((m) => /Erinnerung/.test(m.subject))!.text);
  // Opening it (a mail scanner) changes nothing.
  const page = await deadmanHerePage(token);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post" action="\/api\/deadman\/here">/);
  assert.equal((await row(switchId)).checkin_at, start);
  // Forged or expired: nothing.
  assert.equal((await deadmanHerePage(token.slice(0, -2) + "xx")).status, 410);
  assert.equal(await dm.hereWithToken(token, now + 11 * DAY), null);
  // The button: checked in, the warnings are void.
  const done = await deadmanHere(token);
  assert.equal(done.status, 200);
  assert.ok((await row(switchId)).checkin_at > start);
  assert.equal((await row(switchId)).warned, 0);
  assert.deepEqual((await auditOf(switchId)).slice(-1), ["deadman.checkin"]);
  assert.match((await one<{ detail: string }>("SELECT detail FROM audit WHERE resource_id=? AND action='deadman.checkin'", switchId))!.detail, /e-mail link/);
  // Single use.
  assert.equal((await deadmanHere(token)).status, 410);
  assert.equal((await deadmanHerePage(token)).status, 410);
});

test("after sending, the next sign of life arms it again and tells the holder when and to whom", async () => {
  const { alice, wid, switchId, start } = await armed();
  for (const d of [83, 87, 89]) await dm.processDeadman(start + d * DAY);
  await dm.processDeadman(start + 90 * DAY + 60_000);
  const firedAt = (await row(switchId)).fired_at!;
  // No use yet: stays as it is.
  assert.equal(await dm.processDeadman(firedAt + DAY), 0);
  await run("UPDATE users SET last_active_at=? WHERE id=?", firedAt + 2 * DAY, alice.id);
  assert.equal(await dm.processDeadman(firedAt + 2 * DAY), 1);
  const r = await row(switchId);
  assert.equal(r.state, "armed");
  assert.equal(r.warned, 0);
  assert.match((await notes(alice)).at(-1)!.body, /wurde am .+ an kim@family\.example, lou@family\.example verschickt\. Sie ist jetzt wieder eingeschaltet\./);
  assert.ok((await auditOf(switchId)).includes("deadman.rearm"));
  // A new period: nothing goes out again before it ends and is warned about.
  assert.equal(await dm.processDeadman(firedAt + 30 * DAY), 0);
  assert.equal((await mailsTo("kim@family.example")).length, 1);
  // The button in the settings re-arms as well.
  await run("UPDATE deadman_switches SET state='fired',fired_at=?,fired_to=? WHERE id=?", Date.now() - DAY, JSON.stringify(["kim@family.example"]), switchId);
  await act(alice, { action: "deadman.checkin", workspaceId: wid });
  assert.equal((await row(switchId)).state, "armed");
});

test("#281: “grant emergency access” lets accepted trusted contacts in at once – only then and only while it is on", async () => {
  const { alice, switchId, start } = await armed({ grantEmergency: true });
  const bob = await user("bob"),
    dora = await user("dora"),
    erik = await user("erik");
  const link = async (c: Identity) => {
    const linkId = String((await act(alice, { action: "emergency.designate", email: c.email, waitDays: 7 })).id);
    await act(c, { action: "emergency.accept", linkId });
    return linkId;
  };
  const [lb, ld, le] = [await link(bob), await link(dora), await link(erik)];
  // Bob and Dora accepted long ago; Erik just now (after a takeover, say).
  await run("UPDATE emergency_contacts SET accepted_at=? WHERE id IN (?,?)", start - 30 * DAY, lb, ld);
  // Dora's request is still waiting: granted as well.
  await act(dora, { action: "emergency.request", linkId: ld });
  for (const d of [83, 87, 89]) await dm.processDeadman(start + d * DAY);
  const at = start + 90 * DAY + 60_000;
  // Erik's acceptance counts from the moment of the sending.
  await run("UPDATE emergency_contacts SET accepted_at=? WHERE id=?", at - DAY, le);
  await dm.processDeadman(at);
  const status = async (l: string) => (await one<{ status: string }>("SELECT status FROM emergency_contacts WHERE id=?", l))!.status;
  assert.equal(await status(lb), "granted");
  assert.equal(await status(ld), "granted");
  assert.equal(await status(le), "accepted");
  const grant = await one<{ actor_id: string; detail: string }>("SELECT actor_id,detail FROM audit WHERE resource_id=? AND action='emergency.grant'", lb);
  assert.equal(grant?.actor_id, alice.id);
  assert.match(grant!.detail, new RegExp(`deadman:${switchId}`));
  assert.match((await notes(bob)).at(-1)!.body, /ist freigegeben/);
  assert.match((await mailsTo(alice.email)).at(-1)!.text, /Notfallzugriff bekommen haben: /);
  assert.match((await one<{ detail: string }>("SELECT detail FROM audit WHERE resource_id=? AND action='deadman.fire'", switchId))!.detail, /emergency:2/);
  // Bob can read now, without waiting.
  const em = await import("../lib/emergency-access");
  assert.ok(await em.emergencyContent(bob, lb));

  // Without the option nobody gets access.
  const b = await armed();
  const l2 = String((await act(b.alice, { action: "emergency.designate", email: bob.email, waitDays: 7 })).id);
  await act(bob, { action: "emergency.accept", linkId: l2 });
  await run("UPDATE emergency_contacts SET accepted_at=? WHERE id=?", b.start - 30 * DAY, l2);
  for (const d of [83, 87, 89]) await dm.processDeadman(b.start + d * DAY);
  await dm.processDeadman(b.start + 90 * DAY + 60_000);
  assert.equal((await row(b.switchId)).state, "fired");
  assert.equal(await status(l2), "accepted");

  // With emergency access switched off for the instance: sent, nobody let in.
  const c = await armed({ grantEmergency: true });
  const l3 = String((await act(c.alice, { action: "emergency.designate", email: bob.email, waitDays: 7 })).id);
  await act(bob, { action: "emergency.accept", linkId: l3 });
  await run("UPDATE emergency_contacts SET accepted_at=? WHERE id=?", c.start - 30 * DAY, l3);
  for (const d of [83, 87, 89]) await dm.processDeadman(c.start + d * DAY);
  await saveInstanceSettings({ emergencyAccess: false });
  try {
    await dm.processDeadman(c.start + 90 * DAY + 60_000);
  } finally {
    await saveInstanceSettings({ emergencyAccess: true });
  }
  assert.equal((await row(c.switchId)).state, "fired");
  assert.equal(await status(l3), "accepted");
});

test("without mail delivery, or switched off by the administration, it is unavailable and nothing goes out", async () => {
  const { alice, wid, switchId, start } = await armed();
  delete process.env.SMTP_HOST;
  try {
    const overview = await dm.deadmanOverview(alice);
    assert.equal(overview.available, false);
    assert.equal(overview.mail, false);
    await assert.rejects(arm(alice, wid), /E-Mail-Versand/);
    assert.equal(await dm.processDeadman(start + 200 * DAY), 0);
    // Switching off stays possible.
    await act(alice, { action: "deadman.save", workspaceId: wid, enabled: false, note: NOTE, recipients: ["kim@family.example"] });
  } finally {
    process.env.SMTP_HOST = "smtp.example.test";
  }
  await arm(alice, wid);
  const s0 = (await row(switchId)).checkin_at;
  await saveInstanceSettings({ deadManSwitch: false });
  try {
    assert.equal((await dm.deadmanOverview(alice)).enabled, false);
    await assert.rejects(arm(alice, wid), /ausgeschaltet/);
    assert.equal(await dm.processDeadman(s0 + 200 * DAY), 0);
  } finally {
    await saveInstanceSettings({ deadManSwitch: true });
  }
  process.env.FLOWPLAN_DEAD_MAN_SWITCH = "off";
  try {
    assert.equal((await dm.deadmanOverview(alice)).forcedOff, true);
    assert.equal(await dm.processDeadman(s0 + 200 * DAY), 0);
  } finally {
    delete process.env.FLOWPLAN_DEAD_MAN_SWITCH;
  }
  assert.equal((await row(switchId)).state, "armed");
  assert.equal((await mailsTo("kim@family.example")).length, 0);
  // Back on: still a warning and a day first.
  assert.equal(await dm.processDeadman(s0 + 200 * DAY), 1);
  assert.equal((await row(switchId)).state, "armed");
});

test("sending is limited per round of the worker", async () => {
  const holders = [await armed(), await armed(), await armed()];
  const base = Math.max(...holders.map((h) => h.start));
  for (const d of [83, 87, 89]) await dm.processDeadman(base + d * DAY);
  assert.equal(await dm.processDeadman(base + 90 * DAY + 60_000, { maxFires: 2 }), 2);
  assert.equal((await all("SELECT 1 FROM deadman_switches WHERE id IN (?,?,?) AND state='fired'", ...holders.map((h) => h.switchId))).length, 2);
  assert.equal(await dm.processDeadman(base + 90 * DAY + 120_000, { maxFires: 2 }), 1);
  assert.equal((await all("SELECT 1 FROM deadman_switches WHERE id IN (?,?,?) AND state='fired'", ...holders.map((h) => h.switchId))).length, 3);
});

test("changing recipients or note mails the holder at once; a recipients change is a warning-level event", async () => {
  const { alice, wid, switchId } = await armed();
  const first = (await mailsTo(alice.email)).filter((m) => /Empfänger/.test(m.subject));
  // Already the first arming is reported: a takeover would show here.
  assert.equal(first.length, 1);
  await arm(alice, wid, { recipients: ["kim@family.example", "mallory@evil.example"] });
  const changed = (await mailsTo(alice.email)).filter((m) => /Empfänger/.test(m.subject));
  assert.equal(changed.length, 2);
  assert.equal(changed[1].subject, "Die Empfänger deiner Nachricht bei Inaktivität wurden geändert");
  assert.match(changed[1].text, /Jetzt: kim@family\.example, mallory@evil\.example\. Vorher: kim@family\.example, lou@family\.example\./);
  assert.match(changed[1].text, /Warst du das nicht\?/);
  assert.match((await notes(alice)).at(-1)!.body, /Die Empfänger deiner Nachricht bei Inaktivität für „Zuhause“ wurden geändert: kim@family\.example, mallory@evil\.example\./);
  // Only the note: mailed as well.
  await arm(alice, wid, { recipients: ["kim@family.example", "mallory@evil.example"], note: "Anders." });
  assert.ok((await mailsTo(alice.email)).some((m) => m.subject === "Deine Nachricht bei Inaktivität wurde geändert"));
  // Same again: nothing to report.
  const count = (await mailsTo(alice.email)).length;
  await arm(alice, wid, { recipients: ["kim@family.example", "mallory@evil.example"], note: "Anders.", periodDays: 180 });
  assert.equal((await mailsTo(alice.email)).length, count);
  assert.deepEqual((await auditOf(switchId)).slice(1), ["deadman.recipients", "deadman.recipients", "deadman.change", "deadman.change"]);
  await securityWritesSettled();
  const events = await all<{ kind: string; severity: string }>("SELECT kind,severity FROM security_events WHERE detail LIKE ? ORDER BY id", `${switchId}%`);
  assert.deepEqual(events.filter((e) => e.kind === "deadman.recipients").map((e) => e.severity), ["warn", "warn"]);
  assert.ok(events.some((e) => e.kind === "deadman.changed" && e.severity === "info"));
  // Saving more than 20 times an hour is refused.
  for (let i = 0; i < 16; i++) await arm(alice, wid, { recipients: ["kim@family.example", "mallory@evil.example"], note: "Anders.", periodDays: 180 });
  await assert.rejects(arm(alice, wid), /Zu viele Anfragen/);
});

test("the preview renders the e-mail without sending anything", async () => {
  const alice = await user("alice");
  const wid = await createWorkspace(alice.id, "Zuhause");
  const before = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM mail_queue"))!.n);
  const preview = (await act(alice, { action: "deadman.preview", workspaceId: wid, periodDays: 60, note: NOTE, recipients: ["kim@family.example"] })) as unknown as import("../lib/dead-man-kinds").DeadmanPreview;
  assert.equal(preview.from, `${alice.name} via Flowplan (flowplan.example.test)`);
  assert.deepEqual(preview.to, ["kim@family.example"]);
  assert.equal(preview.subject, `Eine Nachricht von ${alice.name}`);
  assert.ok(preview.text.startsWith(NOTE));
  assert.match(preview.text, /60 Tage lang/);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM mail_queue"))!.n), before);
  assert.equal(await one("SELECT 1 FROM deadman_switches WHERE user_id=?", alice.id), undefined);
  await assert.rejects(act({ ...alice, apiScope: "write" }, { action: "deadman.preview", workspaceId: wid }), /API-Token/);
});

test("leaving the workspace removes the switch; an account deleted for inactivity sends first", async () => {
  const { alice, wid, switchId } = await armed();
  const other = await user("bob");
  await run("INSERT INTO members VALUES(?,?,?)", wid, other.id, "editor");
  const theirs = String((await arm(other, wid)).id);
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, other.id);
  assert.equal(await one("SELECT 1 FROM deadman_switches WHERE id=?", theirs), undefined);
  assert.ok(await one("SELECT 1 FROM deadman_switches WHERE id=?", switchId));
  // Deleted for inactivity: armed messages go out right before.
  const { saveInstanceSettings: save } = await import("../lib/instance-settings");
  const { deleteInactiveAccounts } = await import("../lib/inactive-accounts");
  await save({ deleteInactiveDays: 90 });
  try {
    const T = Date.now() + 400 * DAY;
    await run("UPDATE users SET deletion_notice_at=?,deletion_due_at=? WHERE id=?", T - 14 * DAY, T - 1, alice.id);
    const r = await deleteInactiveAccounts(T);
    assert.ok(r.deleted.includes(alice.id));
  } finally {
    await save({ deleteInactiveDays: null });
  }
  const mails = await mailsTo("kim@family.example");
  assert.ok(mails.some((m) => /wegen Inaktivität gelöscht/.test(m.text)));
  assert.equal(await one("SELECT 1 FROM deadman_switches WHERE id=?", switchId), undefined);
});
