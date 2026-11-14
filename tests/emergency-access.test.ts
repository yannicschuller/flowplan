// Emergency access for trusted contacts (#281, lib/emergency-access.ts):
// designation, requests, the waiting period, read-only access to the
// holder's own private spaces, export, ending it, the administration's
// switch, API tokens, the log and security events, and the zero-knowledge
// path for encrypted spaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onPostgres } from "./helpers/backend";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-emergency-"));
const { id, run, one, all } = await import("../lib/db");
const { command, pageData, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const em = await import("../lib/emergency-access");
const { securityWritesSettled } = await import("../lib/security-events");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { readExportZip } = await import("./helpers/read-export-zip");
const { emergencyDenyPage, emergencyDenied } = await import("../lib/emergency-deny-page");
const e2ee = await import("../lib/e2ee");

const PRIVATE = "Privat-Marker-91ac";
const TEAM = "Team-Marker-55de";
const PIN = "Pin-Marker-c0ff";
const OTHER = "Fremd-Marker-3b2a";
const SECRET = "E2ee-Marker-77aa";
const DAY = 86_400_000;

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = async (who: Identity, input: Record<string, unknown>) => (await command(who, input)) as Record<string, unknown>;
const status = async (linkId: string) => (await one<{ status: string }>("SELECT status FROM emergency_contacts WHERE id=?", linkId))?.status;
const html = async (pageId: string, text: string) => await run("UPDATE documents SET html=? WHERE page_id=?", `<p>${text}</p>`, pageId);
// The waiting period is over: as if the days had passed.
const elapse = async (linkId: string) =>
  await run("UPDATE emergency_contacts SET requested_at=requested_at-?,grant_at=? WHERE id=?", 30 * DAY, Date.now() - 1000, linkId);
// audit has no seq column: insertion order is SQLite's rowid, or on
// PostgreSQL the inserting transaction and the row's place in the heap.
const INSERT_ORDER = onPostgres ? "xmin::text::bigint,ctid" : "rowid";
const notes = async (who: Identity) => (await all<{ body: string; link: string | null }>("SELECT body,link FROM notifications WHERE user_id=? ORDER BY seq", who.id));
const auditOf = async (linkId: string) => (await all<{ action: string }>(`SELECT action FROM audit WHERE resource_id=? ORDER BY created_at,${INSERT_ORDER}`, linkId)).map((a) => a.action);

// The holder's world: a team space, a private space with a page and a
// journal behind a PIN, and a private space of someone else shared with her.
async function world() {
  const alice = await user(`alice${id().slice(0, 6)}`),
    bob = await user(`bob${id().slice(0, 6)}`),
    dora = await user(`dora${id().slice(0, 6)}`);
  const wid = await createWorkspace(alice.id, "Familie");
  await run("INSERT INTO members VALUES(?,?,?)", wid, dora.id, "editor");
  const team = (await bootstrap(alice, wid)).spaces[0].id;
  const teamPage = String((await act(alice, { action: "page.create", workspaceId: wid, spaceId: team, title: "Teamseite" })).id);
  await html(teamPage, TEAM);
  const mine = String((await act(alice, { action: "space.create", workspaceId: wid, name: "Privat", private: true })).id);
  const privatePage = String((await act(alice, { action: "page.create", workspaceId: wid, spaceId: mine, title: "Testament" })).id);
  await html(privatePage, PRIVATE);
  const journal = String((await act(alice, { action: "page.create", workspaceId: wid, spaceId: mine, title: "Tagebuch", kind: "journal" })).id);
  const day = String((await act(alice, { action: "page.create", workspaceId: wid, spaceId: mine, parentId: journal, title: "2026-11-01" })).id);
  await html(day, PIN);
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET lock_hash=excluded.lock_hash", journal, "00:11");
  // Alice entered her PIN a moment ago: the contact still never sees it.
  await run("INSERT INTO journal_unlocks(user_id,page_id,until) VALUES(?,?,?)", alice.id, journal, Date.now() + DAY);
  // Dora's private space, shared with Alice: not Alice's to hand on.
  const doras = String((await act(dora, { action: "space.create", workspaceId: wid, name: "Doras", private: true })).id);
  const doraPage = String((await act(dora, { action: "page.create", workspaceId: wid, spaceId: doras, title: "Doras Seite" })).id);
  await html(doraPage, OTHER);
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,'','editor','space',?)", doras, alice.id, wid);
  return { alice, bob, dora, wid, team, teamPage, mine, privatePage, journal, day, doras, doraPage };
}
async function granted(w: Awaited<ReturnType<typeof world>>, waitDays = 7) {
  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email.toUpperCase(), waitDays })).id);
  await act(w.bob, { action: "emergency.accept", linkId });
  await act(w.bob, { action: "emergency.request", linkId });
  await elapse(linkId);
  return linkId;
}

test("designate, accept, remove: each step logged, notified and a security event", async () => {
  const w = await world();
  // Only accounts of this instance, not oneself, no unknown addresses.
  await assert.rejects(act(w.alice, { action: "emergency.designate", email: "niemand@example.com" }), /kein Konto/);
  await assert.rejects(act(w.alice, { action: "emergency.designate", email: w.alice.email }), /nicht selbst/);
  await assert.rejects(act(w.alice, { action: "emergency.designate", email: w.bob.email, waitDays: 3 }));
  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email, waitDays: 14 })).id);
  await assert.rejects(act(w.alice, { action: "emergency.designate", email: w.bob.email }), /bereits/);
  assert.equal(await status(linkId), "invited");
  assert.match((await notes(w.bob)).at(-1)!.body, /als Vertrauensperson für den Notfallzugriff eingetragen/);
  assert.equal((await notes(w.bob)).at(-1)!.link, "#settings/account/emergency");
  // An invited contact cannot ask yet; the holder cannot accept for them.
  await assert.rejects(act(w.bob, { action: "emergency.request", linkId }), /zuerst an/);
  await assert.rejects(act(w.alice, { action: "emergency.accept", linkId }));
  // Someone else sees nothing of it.
  await assert.rejects(act(w.dora, { action: "emergency.accept", linkId }), /Nicht gefunden/);
  await act(w.bob, { action: "emergency.accept", linkId });
  assert.equal(await status(linkId), "accepted");
  assert.match((await notes(w.alice)).at(-1)!.body, /ist jetzt deine Vertrauensperson/);
  const overview = await em.emergencyOverview(w.alice);
  assert.equal(overview.enabled, true);
  assert.equal(overview.mine.length, 1);
  assert.equal(overview.mine[0].waitDays, 14);
  assert.equal(overview.mine[0].contact.hasKeys, false);
  assert.equal((await em.emergencyOverview(w.bob)).forMe[0].holder.id, w.alice.id);
  await act(w.alice, { action: "emergency.remove", linkId });
  assert.equal(await status(linkId), undefined);
  assert.match((await notes(w.bob)).at(-1)!.body, /als Vertrauensperson entfernt/);
  // A removed contact cannot ask for access.
  await assert.rejects(act(w.bob, { action: "emergency.request", linkId }), /Nicht gefunden/);
  assert.deepEqual(await auditOf(linkId), ["emergency.designate", "emergency.accept", "emergency.remove"]);
  await securityWritesSettled();
  const kinds = (await all<{ kind: string; detail: string }>("SELECT kind,detail FROM security_events WHERE detail LIKE ?", `holder:${w.alice.id} contact:${w.bob.id}%`)).map((e) => e.kind);
  assert.deepEqual(kinds, ["emergency.designated", "emergency.accepted", "emergency.removed"]);
});

test("request → deny: no access, the contact is told, a new request waits a day", async () => {
  const w = await world();
  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email })).id);
  await act(w.bob, { action: "emergency.accept", linkId });
  const asked = await act(w.bob, { action: "emergency.request", linkId });
  assert.ok(Number(asked.grantAt) > Date.now() + 6 * DAY);
  assert.match((await notes(w.alice)).at(-1)!.body, /hat Notfallzugriff auf deine Inhalte angefragt/);
  await assert.rejects(act(w.bob, { action: "emergency.request", linkId }), /bereits eine Anfrage/);
  // Waiting: nothing to read yet.
  await assert.rejects(em.emergencyContent(w.bob, linkId), /nicht freigegeben/);
  await assert.rejects(act(w.bob, { action: "emergency.deny", linkId }));
  await act(w.alice, { action: "emergency.deny", linkId });
  assert.equal(await status(linkId), "accepted");
  assert.match((await notes(w.bob)).at(-1)!.body, /Anfrage auf Notfallzugriff abgelehnt/);
  // Even when the waiting period would have passed, nothing is granted.
  await run("UPDATE emergency_contacts SET grant_at=? WHERE id=?", Date.now() - 1000, linkId);
  await assert.rejects(em.emergencyContent(w.bob, linkId), /nicht freigegeben/);
  await assert.rejects(act(w.bob, { action: "emergency.request", linkId }), /24 Stunden/);
  assert.ok((await em.emergencyOverview(w.bob)).forMe[0].requestAfter! > Date.now());
  // A day later the contact may ask again – and withdraw it.
  await run("UPDATE emergency_contacts SET denied_at=? WHERE id=?", Date.now() - 2 * DAY, linkId);
  await act(w.bob, { action: "emergency.request", linkId });
  await act(w.bob, { action: "emergency.cancel", linkId });
  assert.equal(await status(linkId), "accepted");
  assert.deepEqual(await auditOf(linkId), [
    "emergency.designate",
    "emergency.accept",
    "emergency.request",
    "emergency.deny",
    "emergency.request",
    "emergency.cancel",
  ]);
});

test("request → waiting period over: read access to the holder's own private content only", async () => {
  const w = await world();
  const linkId = await granted(w);
  // Granted on reading, without the worker.
  const content = await em.emergencyContent(w.bob, linkId);
  assert.equal(await status(linkId), "granted");
  assert.deepEqual(content.spaces.map((s) => s.id), [w.mine]);
  const pages = content.pages.map((p) => p.id);
  assert.ok(pages.includes(w.privatePage));
  // Team space, the journal behind a PIN (though Alice unlocked it), its
  // days, and Dora's space shared with Alice stay out.
  for (const hidden of [w.teamPage, w.journal, w.day, w.doraPage]) assert.ok(!pages.includes(hidden), hidden);
  const page = await em.emergencyPage(w.bob, linkId, w.privatePage);
  assert.match(page.markdown, new RegExp(PRIVATE));
  for (const hidden of [w.teamPage, w.journal, w.day, w.doraPage]) await assert.rejects(em.emergencyPage(w.bob, linkId, hidden), /nicht gefunden/);
  // Both were told; the grant is a warning-level security event.
  assert.match((await notes(w.alice)).at(-1)!.body, /hat jetzt Lesezugriff/);
  assert.match((await notes(w.bob)).at(-1)!.body, /ist freigegeben/);
  await securityWritesSettled();
  const grant = await one<{ severity: string; actor_id: string }>("SELECT severity,actor_id FROM security_events WHERE kind='emergency.granted' AND detail LIKE ?", `holder:${w.alice.id} %`);
  assert.equal(grant?.severity, "warn");
  assert.equal(grant?.actor_id, w.bob.id);
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='emergency.viewed' AND actor_id=? AND detail LIKE ?", w.bob.id, `%page:${w.privatePage}%`));
  // Someone else cannot use Bob's link.
  await assert.rejects(em.emergencyContent(w.dora, linkId), /Nicht gefunden/);
});

test("the access is read-only: every write on the holder's content is refused", async () => {
  const w = await world();
  const linkId = await granted(w);
  await em.emergencyContent(w.bob, linkId);
  const p = w.privatePage;
  const attempts: Record<string, unknown>[] = [
    { action: "page.update", pageId: p, patch: { title: "Gehackt" } },
    { action: "page.delete", pageId: p },
    { action: "page.move", pageId: p, spaceId: w.team },
    { action: "page.duplicate", pageId: p },
    { action: "page.create", workspaceId: w.wid, spaceId: w.mine, title: "Neu" },
    { action: "page.create", workspaceId: w.wid, spaceId: w.mine, parentId: p, title: "Neu" },
    { action: "page.share", pageId: p, email: w.dora.email, role: "editor" },
    { action: "share.create", pageId: p, role: "viewer" },
    { action: "page.publish", pageId: p, enabled: true },
    { action: "comment.create", pageId: p, body: "Hallo" },
    { action: "document.markdown.apply", pageId: p, markdown: "# Neu" },
    { action: "grant.set", workspaceId: w.wid, resourceId: w.mine, userId: w.bob.id, role: "editor" },
    { action: "space.update", spaceId: w.mine, name: "Meins", private: true },
    { action: "space.delete", spaceId: w.mine },
    { action: "favorite", pageId: p },
    { action: "journal.lock", pageId: w.journal, pin: null },
  ];
  for (const input of attempts) await assert.rejects(act(w.bob, input), Error, String(input.action));
  // Reading through the normal routes is refused as well.
  await assert.rejects(pageData(w.bob, p));
  // Nothing changed.
  assert.equal((await one<{ title: string; deleted_at: string | null }>("SELECT title,deleted_at FROM pages WHERE id=?", p))!.title, "Testament");
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", p))!.html, new RegExp(PRIVATE));
  assert.equal(await one("SELECT 1 FROM grants WHERE user_id=?", w.bob.id), undefined);
  assert.equal(await one("SELECT 1 FROM members WHERE user_id=?", w.bob.id), undefined);
});

test("export: a ZIP of the private space without workspace-only or PIN content; the holder is told", async () => {
  const w = await world();
  const linkId = await granted(w);
  const zip = await em.emergencyExport(w.bob, linkId, w.mine);
  assert.equal(zip.mime, "application/zip");
  const all = [...(await readExportZip(zip.bytes)).values()].map((b) => b.toString("utf8")).join("\n");
  assert.match(all, new RegExp(PRIVATE));
  for (const hidden of [TEAM, PIN, OTHER]) assert.doesNotMatch(all, new RegExp(hidden));
  await assert.rejects(em.emergencyExport(w.bob, linkId, w.team), /nicht gefunden/);
  await assert.rejects(em.emergencyExport(w.bob, linkId, w.doras), /nicht gefunden/);
  assert.match((await notes(w.alice)).at(-1)!.body, /über den Notfallzugriff exportiert/);
  // Logged as Bob's export, not as an export of Alice's.
  assert.ok((await auditOf(linkId)).includes("emergency.export"));
  assert.equal(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='space.markdown.export'", w.alice.id), undefined);
  await securityWritesSettled();
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='emergency.exported' AND actor_id=?", w.bob.id));
});

test("revoking ends the access at once; an expiry ends it too", async () => {
  const w = await world();
  const linkId = await granted(w);
  await em.emergencyContent(w.bob, linkId);
  await act(w.alice, { action: "emergency.revoke", linkId });
  assert.equal(await status(linkId), "accepted");
  await assert.rejects(em.emergencyContent(w.bob, linkId), /nicht freigegeben/);
  await assert.rejects(em.emergencyPage(w.bob, linkId, w.privatePage), /nicht freigegeben/);
  assert.match((await notes(w.bob)).at(-1)!.body, /Notfallzugriff beendet/);
  // Access for 7 days only: over after that, without the worker.
  await run("UPDATE emergency_contacts SET access_days=7 WHERE id=?", linkId);
  await act(w.bob, { action: "emergency.request", linkId });
  await elapse(linkId);
  const content = await em.emergencyContent(w.bob, linkId);
  assert.ok(content.expiresAt! > Date.now());
  await run("UPDATE emergency_contacts SET expires_at=? WHERE id=?", Date.now() - 1000, linkId);
  await assert.rejects(em.emergencyContent(w.bob, linkId), /nicht freigegeben/);
  assert.ok((await auditOf(linkId)).includes("emergency.expire"));
});

test("the administration's switch suspends granted access; FLOWPLAN_EMERGENCY_ACCESS=off wins", async () => {
  const w = await world();
  const linkId = await granted(w);
  await em.emergencyContent(w.bob, linkId);
  await saveInstanceSettings({ emergencyAccess: false });
  try {
    await assert.rejects(em.emergencyContent(w.bob, linkId), /ausgeschaltet/);
    await assert.rejects(em.emergencyExport(w.bob, linkId, w.mine), /ausgeschaltet/);
    await assert.rejects(act(w.alice, { action: "emergency.designate", email: w.dora.email }), /ausgeschaltet/);
    assert.equal((await em.emergencyOverview(w.alice)).enabled, false);
  } finally {
    await saveInstanceSettings({ emergencyAccess: true });
  }
  assert.ok((await em.emergencyContent(w.bob, linkId)).pages.length);
  process.env.FLOWPLAN_EMERGENCY_ACCESS = "off";
  try {
    await assert.rejects(em.emergencyContent(w.bob, linkId), /ausgeschaltet/);
    assert.equal((await em.emergencyOverview(w.bob)).forcedOff, true);
    await act(w.alice, { action: "emergency.revoke", linkId });
  } finally {
    delete process.env.FLOWPLAN_EMERGENCY_ACCESS;
  }
  assert.equal(await status(linkId), "accepted");
});

test("API tokens (and MCP through them) can neither request nor use emergency access", async () => {
  const w = await world();
  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email })).id);
  await act(w.bob, { action: "emergency.accept", linkId });
  for (const scope of ["write", "read"] as const) {
    const token = { ...w.bob, apiScope: scope };
    await assert.rejects(act(token, { action: "emergency.request", linkId }), /API-Token/);
    await assert.rejects(act({ ...w.alice, apiScope: scope }, { action: "emergency.designate", email: w.dora.email }), /API-Token/);
    await assert.rejects(em.emergencyOverview(token), /API-Token/);
  }
  await act(w.bob, { action: "emergency.request", linkId });
  await elapse(linkId);
  const token = { ...w.bob, apiScope: "write" as const };
  await assert.rejects(em.emergencyContent(token, linkId), /API-Token/);
  await assert.rejects(em.emergencyPage(token, linkId, w.privatePage), /API-Token/);
  await assert.rejects(em.emergencyExport(token, linkId, w.mine), /API-Token/);
  await assert.rejects(em.emergencyKeys(token, linkId), /API-Token/);
  await assert.rejects(em.emergencyLog(token, linkId, w.privatePage, 0), /API-Token/);
  // The documented command list leaves them out like admin.* and ai.*.
  const { tokenRefusedActionPrefixes } = await import("../lib/openapi");
  assert.ok((tokenRefusedActionPrefixes as readonly string[]).includes("emergency."));
});

test("the worker grants, reminds halfway and a day before, and survives a restart", async () => {
  const w = await world();
  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email, waitDays: 7 })).id);
  await act(w.bob, { action: "emergency.accept", linkId });
  await act(w.bob, { action: "emergency.request", linkId });
  const link = (await one<{ requested_at: number; grant_at: number }>("SELECT requested_at,grant_at FROM emergency_contacts WHERE id=?", linkId))!;
  const before = (await notes(w.alice)).length;
  // (Other tests' links are processed too; only this one is checked.)
  await em.processEmergency(link.requested_at + DAY);
  assert.equal((await notes(w.alice)).length, before);
  await em.processEmergency(link.requested_at + 3.6 * DAY);
  await em.processEmergency(link.requested_at + 3.7 * DAY);
  await em.processEmergency(link.grant_at - 0.5 * DAY);
  const reminders = (await notes(w.alice)).slice(before).filter((n) => /^Erinnerung:/.test(n.body));
  assert.equal(reminders.length, 2);
  assert.equal(await status(linkId), "requested");
  await em.processEmergency(link.grant_at + 1);
  assert.equal(await status(linkId), "granted");
  // Once only: a second run changes nothing.
  const after = (await notes(w.alice)).length;
  await em.processEmergency(link.grant_at + 2);
  assert.equal((await notes(w.alice)).length, after);
  assert.deepEqual((await auditOf(linkId)).filter((a) => a === "emergency.grant" || a === "emergency.remind"), ["emergency.remind", "emergency.remind", "emergency.grant"]);
});

test("the e-mail's signed link denies without sign-in, once", async () => {
  const w = await world();
  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email })).id);
  await act(w.bob, { action: "emergency.accept", linkId });
  await act(w.bob, { action: "emergency.request", linkId });
  const link = (await one<{ id: string; requested_at: number }>("SELECT id,requested_at FROM emergency_contacts WHERE id=?", linkId))!;
  const token = em.denyToken(link);
  // Forged or for another request: nothing.
  assert.equal((await emergencyDenyPage(token.slice(0, -2) + "xx")).status, 410);
  assert.equal((await emergencyDenyPage(em.denyToken({ ...link, requested_at: link.requested_at - 1 }))).status, 410);
  // Opening the page changes nothing.
  const pageHtml = await (await emergencyDenyPage(token)).text();
  assert.match(pageHtml, /method="post"/);
  assert.doesNotMatch(pageHtml, /<script|style=/);
  assert.equal(await status(linkId), "requested");
  assert.equal((await emergencyDenied(token)).status, 200);
  assert.equal(await status(linkId), "accepted");
  assert.equal((await emergencyDenied(token)).status, 410);
  assert.ok((await auditOf(linkId)).includes("emergency.deny"));
});

test("several requests for one account in a day open an incident", async () => {
  const w = await world();
  const contacts = [w.bob, w.dora, await user(`erik${id().slice(0, 6)}`)];
  for (const c of contacts) {
    const linkId = String((await act(w.alice, { action: "emergency.designate", email: c.email })).id);
    await act(c, { action: "emergency.accept", linkId });
    await act(c, { action: "emergency.request", linkId });
  }
  await securityWritesSettled();
  const incident = await one<{ rule: string; severity: string }>("SELECT rule,severity FROM security_incidents WHERE rule='emergency_requests' AND key=?", `holder:${w.alice.id}`);
  assert.equal(incident?.severity, "warn");
});

test("encrypted spaces: keys sealed in the holder's browser, released to the contact only once granted", async () => {
  const w = await world();
  const a = await e2ee.createIdentity("alice passphrase 1", 600_000);
  await act(w.alice, { action: "e2ee.identity.setup", ...a.identity });
  const spaceId = id();
  const v1 = await e2ee.newSpaceKey(1);
  await act(w.alice, {
    action: "space.create",
    workspaceId: w.wid,
    id: spaceId,
    name: "Geheim",
    private: true,
    encrypted: { key: await e2ee.sealKey(v1.raw, a.identity.publicKey, e2ee.spaceKeyContext(spaceId, 1, w.alice.id)), encryptTitles: false },
  });
  const pageId = String((await act(w.alice, { action: "page.create", workspaceId: w.wid, spaceId, title: "Zugänge" })).id);
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  doc.getText("t").insert(0, SECRET);
  await act(w.alice, { action: "e2ee.append", pageId, version: 1, data: e2ee.toBase64(await e2ee.encryptContent(v1, updates[0], e2ee.contentContext("update", pageId, 1))) });

  const linkId = String((await act(w.alice, { action: "emergency.designate", email: w.bob.email })).id);
  await act(w.bob, { action: "emergency.accept", linkId });
  // Bob has no key pair yet: nothing to seal, the settings say so.
  let overview = await em.emergencyOverview(w.alice);
  assert.equal(overview.encryptedSpaces, 1);
  assert.equal(overview.mine[0].contact.hasKeys, false);
  assert.deepEqual(overview.rewrap, []);
  const b = await e2ee.createIdentity("bob passphrase 22", 600_000);
  await act(w.bob, { action: "e2ee.identity.setup", ...b.identity });
  overview = await em.emergencyOverview(w.alice);
  assert.deepEqual(overview.rewrap, [{ linkId, contactId: w.bob.id, publicKey: b.identity.publicKey, spaceId, versions: [1] }]);
  assert.equal(overview.mine[0].keysMissing, 1);

  // Alice's browser seals – the server gets an opaque, validated blob.
  const sealed = await e2ee.sealKey(v1.raw, b.identity.publicKey, e2ee.emergencyKeyContext(spaceId, 1, w.alice.id, w.bob.id));
  await assert.rejects(act(w.bob, { action: "emergency.keys", linkId, publicKey: b.identity.publicKey, keys: [{ spaceId, version: 1, sealed }] }), /Nicht erlaubt/);
  await assert.rejects(act(w.alice, { action: "emergency.keys", linkId, publicKey: a.identity.publicKey, keys: [{ spaceId, version: 1, sealed }] }), /geändert/);
  await assert.rejects(act(w.alice, { action: "emergency.keys", linkId, publicKey: b.identity.publicKey, keys: [{ spaceId, version: 2, sealed }] }), /geändert/);
  await assert.rejects(act(w.alice, { action: "emergency.keys", linkId, publicKey: b.identity.publicKey, keys: [{ spaceId: w.mine, version: 1, sealed }] }), /Kein Zugriff/);
  await assert.rejects(act(w.alice, { action: "emergency.keys", linkId, publicKey: b.identity.publicKey, keys: [{ spaceId, version: 1, sealed: { ...sealed, raw: e2ee.toBase64(v1.raw) } }] }));
  await act(w.alice, { action: "emergency.keys", linkId, publicKey: b.identity.publicKey, keys: [{ spaceId, version: 1, sealed }] });
  assert.deepEqual((await em.emergencyOverview(w.alice)).rewrap, []);
  const stored = (await all<{ sealed: string }>("SELECT sealed FROM emergency_keys WHERE link_id=?", linkId)).map((k) => k.sealed).join();
  assert.ok(!stored.includes(e2ee.toBase64(v1.raw)));
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["alg", "ct", "epk", "iv", "salt", "v"]);

  // Not released while not granted.
  await assert.rejects(em.emergencyKeys(w.bob, linkId), /nicht freigegeben/);
  await act(w.bob, { action: "emergency.request", linkId });
  await assert.rejects(em.emergencyKeys(w.bob, linkId), /nicht freigegeben/);
  await assert.rejects(em.emergencyLog(w.bob, linkId, pageId, 0), /nicht freigegeben/);
  await elapse(linkId);

  // Granted: Bob's browser opens the key and the ciphertext.
  const content = await em.emergencyContent(w.bob, linkId);
  assert.ok(content.spaces.some((s) => s.id === spaceId && s.encrypted));
  await assert.rejects(em.emergencyPage(w.bob, linkId, pageId), /verschlüsselte/);
  const released = await em.emergencyKeys(w.bob, linkId);
  assert.equal(released.keys.length, 1);
  const raw = await e2ee.openKey(released.keys[0].sealed, b.privateKey, e2ee.emergencyKeyContext(spaceId, 1, w.alice.id, w.bob.id));
  // Bound to its purpose: it opens neither as a member's key nor for another holder.
  await assert.rejects(e2ee.openKey(released.keys[0].sealed, b.privateKey, e2ee.spaceKeyContext(spaceId, 1, w.bob.id)));
  await assert.rejects(e2ee.openKey(released.keys[0].sealed, b.privateKey, e2ee.emergencyKeyContext(spaceId, 1, w.dora.id, w.bob.id)));
  const key = await e2ee.spaceKeyFromRaw(1, raw);
  const log = await em.emergencyLog(w.bob, linkId, pageId, 0);
  assert.ok(!JSON.stringify(log).includes(SECRET));
  const read = new Y.Doc();
  for (const u of log.updates) Y.applyUpdate(read, await e2ee.decryptContent(key, e2ee.fromBase64(u.data), e2ee.contentContext("update", pageId, u.version)));
  assert.equal(read.getText("t").toString(), SECRET);
  // Still no membership: the space's own routes stay closed to Bob.
  const { spaceKeys } = await import("../lib/e2ee-server");
  await assert.rejects(spaceKeys(w.bob, spaceId));
  // Ending the access after the keys went out: the space gets a new key.
  await act(w.alice, { action: "emergency.revoke", linkId });
  assert.equal((await one<{ rotate_pending: number }>("SELECT rotate_pending FROM spaces WHERE id=?", spaceId))!.rotate_pending, 1);
  await assert.rejects(em.emergencyKeys(w.bob, linkId), /nicht freigegeben/);
});
