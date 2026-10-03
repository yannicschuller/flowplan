import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-integrations-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken, listApiTokens } = await import("../lib/api-tokens");
const { calendarFeed } = await import("../lib/calendar-feed");
const { createWebhook, flushWebhooks } = await import("../lib/webhooks");
const mail = await import("../lib/mail");
const { runScheduledBackup } = await import("../lib/scheduled-backup");
const { disableInactiveAccounts } = await import("../lib/inactive-accounts");
const { saveInstanceSettings } = await import("../lib/instance-settings");

function person(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const ana = person("Ana"),
  ben = person("Ben");
const wid = createWorkspace(ana.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const db = createPage(wid, space, ana.id, "Termine", "database");
// A calendar view on the due date.
const views = JSON.parse(one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", db)!.views);
views.push({ id: "cal", name: "Kalender", type: "calendar", filters: [], sorts: [], dateField: "date", calendar: { mode: "month", timeZone: "Europe/Berlin" } });
run("UPDATE databases SET views=? WHERE page_id=?", JSON.stringify(views), db);

test("API tokens act as their owner; read tokens only read; nothing administrative", () => {
  const read = command(ana, { action: "token.create", name: "Skript", scope: "read" }) as { token: string };
  const write = command(ana, { action: "token.create", name: "n8n", scope: "write" }) as { token: string; id: string };
  assert.match(write.token, /^fp_/);
  assert.equal(listApiTokens(ana).length, 2);
  assert.equal(JSON.stringify(listApiTokens(ana)).includes(write.token), false, "only a prefix is listed");
  const reader = identityFromApiToken(`Bearer ${read.token}`)!;
  const writer = identityFromApiToken(`Bearer ${write.token}`)!;
  assert.equal(writer.id, ana.id);
  assert.equal(writer.isAdmin, false);
  assert.throws(() => command(reader, { action: "row.create", pageId: db, cells: { title: "x" } }), /nur lesen/);
  const created = command(writer, { action: "row.create", pageId: db, cells: { title: "Per API" } }) as { id: string };
  assert.ok(one("SELECT 1 FROM rows WHERE id=?", created.id));
  assert.throws(() => command(writer, { action: "admin.settings", settings: {} }), /API-Token/);
  assert.throws(() => command(writer, { action: "token.create", name: "x", scope: "write" }), /API-Token/);
  command(ana, { action: "token.revoke", id: write.id });
  assert.equal(identityFromApiToken(`Bearer ${write.token}`), null);
  assert.equal(identityFromApiToken("Bearer fp_unknown_token_value_0000000000"), null);
});

test("calendar feeds list visible dated records with repeats and stop with access", () => {
  const rows = [
    { title: "Termin", date: "2026-10-05T09:00:00+02:00" },
    { title: "Ganztag; mit, Zeichen", date: "2026-10-07" },
    { title: "Ohne Datum" },
  ].map((cells) => (command(ana, { action: "row.create", pageId: db, cells }) as { id: string }).id);
  run("UPDATE rows SET recurrence=? WHERE id=?", JSON.stringify({ freq: "weekly", interval: 1, count: 4 }), rows[0]);
  // A private record of Ana stays out of Ben's feed.
  const secret = (command(ana, { action: "row.create", pageId: db, cells: { title: "Privat", date: "2026-10-09" } }) as { id: string }).id;
  run("UPDATE rows SET access='private' WHERE id=?", secret);
  const { url } = command(ben, { action: "calendar.feed", pageId: db, viewId: "cal" }) as { url: string };
  const token = url.split("/").pop()!.replace(/\.ics$/, "");
  const ics = calendarFeed(token);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Termin\r\n/);
  assert.match(ics, /DTSTART:20261005T070000Z/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4/);
  assert.ok(ics.includes("SUMMARY:Ganztag\\; mit\\, Zeichen"), "text is escaped");
  assert.match(ics, /DTSTART;VALUE=DATE:20261007\r\nDTEND;VALUE=DATE:20261008/);
  assert.doesNotMatch(ics, /Ohne Datum|Privat/);
  // A new link replaces the old one; leaving the workspace ends the feed.
  const again = command(ben, { action: "calendar.feed", pageId: db, viewId: "cal" }) as { url: string };
  assert.throws(() => calendarFeed(token), /Unbekannter Kalender/);
  const token2 = again.url.split("/").pop()!.replace(/\.ics$/, "");
  run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, ben.id);
  assert.throws(() => calendarFeed(token2), /Unbekannter Kalender/);
  run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
});

test("webhooks are signed, refuse internal addresses and retry failures", async () => {
  const received: { body: string; signature: string }[] = [];
  let fail = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (fail) {
        fail = false;
        res.writeHead(500).end();
        return;
      }
      received.push({ body, signature: String(req.headers["x-flowplan-signature"]) });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  after(() => server.close());
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  await assert.rejects(createWebhook(ana, { workspaceId: wid, url: target, events: ["row.created"] }), /HTTPS|Interne/);
  await assert.rejects(createWebhook(ben, { workspaceId: wid, url: "https://example.com", events: ["row.created"] }), /Eigentümer/);
  process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
  const hook = await createWebhook(ana, { workspaceId: wid, url: target, events: ["row.created", "row.updated"] });
  const row = (command(ben, { action: "row.create", pageId: db, cells: { title: "Neu" } }) as { id: string }).id;
  // The first attempt goes out right away and fails; the retry delivers.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 0, "first attempt failed");
  await flushWebhooks(Date.now() + 3600_000);
  assert.equal(received.length, 1, "retried");
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.event, "row.created");
  assert.equal(payload.data.rowId, row);
  assert.equal(payload.data.cells.title, "Neu");
  assert.equal(received[0].signature, `sha256=${createHmac("sha256", hook.secret).update(received[0].body).digest("hex")}`);
  delete process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE;
});

test("invitations and unread notifications go out by e-mail when SMTP is set", async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  mail.setMailSender(async (m) => void sent.push(m));
  // Without SMTP nothing is queued.
  command(ana, { action: "member.invite", workspaceId: wid, email: "neu@example.test", role: "editor" });
  await mail.flushMailQueue();
  assert.equal(sent.length, 0);
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "Flowplan <flowplan@example.test>";
  command(ana, { action: "member.invite", workspaceId: wid, email: "gast@example.test", role: "viewer", guest: true });
  // The invitation goes out right away; a parallel run does not send it twice.
  await Promise.all([mail.dispatchMail(), mail.flushMailQueue()]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "gast@example.test");
  assert.match(sent[0].subject, /Ana hat dich als Gast zu „Team“ eingeladen/);
  assert.match(sent[0].text, /https:\/\/flowplan\.example\.test/);
  // Two unread notifications for Ben become one summary; read ones do not.
  const old = "2020-01-01 00:00:00";
  for (const body of ["Ana hat dich erwähnt", "Neue Antwort"])
    run("INSERT INTO notifications(id,user_id,body,page_id,kind,created_at) VALUES(?,?,?,?,?,?)", id(), ben.id, body, db, "mention", old);
  run("INSERT INTO notifications(id,user_id,body,page_id,kind,created_at,read_at) VALUES(?,?,?,?,?,?,?)", id(), ben.id, "Gelesen", db, "mention", old, old);
  assert.equal(mail.queueNotificationDigests(), 1);
  assert.equal(mail.queueNotificationDigests(), 0, "each notification is sent once");
  await mail.flushMailQueue();
  const digest = sent.at(-1)!;
  assert.equal(digest.to, "ben@example.test");
  assert.match(digest.subject, /2 neue Benachrichtigungen/);
  assert.doesNotMatch(digest.text, /Gelesen/);
  // Someone who uses Flowplan in English gets the summary in English.
  run("UPDATE users SET locale='en' WHERE id=?", ben.id);
  run("INSERT INTO notifications(id,user_id,body,page_id,kind,created_at) VALUES(?,?,?,?,?,?)", id(), ben.id, "Ana hat dich in „Plan“ erwähnt", db, "mention", old);
  assert.equal(mail.queueNotificationDigests(), 1);
  await mail.flushMailQueue();
  assert.equal(sent.at(-1)!.subject, "Ana mentioned you in “Plan”");
  assert.match(sent.at(-1)!.text, /^Hello Ben,/);
  run("UPDATE users SET locale=NULL WHERE id=?", ben.id);
  // Switched off: no e-mail for that kind.
  command(ben, { action: "notification.prefs", kind: "comment", inbox: true, push: true, email: false });
  run("INSERT INTO notifications(id,user_id,body,page_id,kind,created_at) VALUES(?,?,?,?,?,?)", id(), ben.id, "Kommentar", db, "comment", old);
  assert.equal(mail.queueNotificationDigests(), 0);
  // A failing server is retried later, not lost.
  mail.setMailSender(async () => {
    throw new Error("451 try again");
  });
  mail.queueMail("x@example.test", "Test", "Text", "<p>Text</p>");
  await mail.flushMailQueue();
  assert.equal(mail.mailStatus().pending, 1);
  assert.match(String(mail.mailStatus().lastError), /451/);
  mail.setMailSender(undefined);
  delete process.env.SMTP_HOST;
});

test("scheduled backups keep the newest copies; inactive accounts are disabled", async () => {
  saveInstanceSettings({ backupKeep: 2 });
  for (const at of [1, 2, 3].map((d) => Date.UTC(2026, 8, d)))
    assert.equal((await runScheduledBackup(at)).error, null);
  const folder = join(process.env.FLOWPLAN_DATA_DIR!, "backups");
  assert.ok(existsSync(folder));
  assert.deepEqual(readdirSync(folder).sort(), ["flowplan-2026-09-02-00-00.sqlite", "flowplan-2026-09-03-00-00.sqlite"]);
  // Inactivity: off by default, then after the chosen days.
  run("UPDATE users SET last_login_at=? WHERE id=?", Date.now() - 400 * 86400_000, ben.id);
  assert.deepEqual(disableInactiveAccounts(), []);
  saveInstanceSettings({ inactiveDays: 365 });
  run("UPDATE users SET last_login_at=? WHERE id<>?", Date.now(), ben.id);
  assert.deepEqual(disableInactiveAccounts(), [ben.id]);
  assert.equal(one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", ben.id)!.disabled, 1);
  assert.equal(all("SELECT 1 FROM sessions WHERE user_id=?", ben.id).length, 0);
});
