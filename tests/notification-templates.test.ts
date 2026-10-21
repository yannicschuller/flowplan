import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-chat-notifications-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, all, id, transaction } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const templates = await import("../lib/notification-templates");
const { createWebhook, updateWebhook, listWebhooks, flushWebhooks, processDigests, testWebhook } = await import("../lib/webhooks");
const { receiveSlackEvent, verifySlackSignature, slackToPlain } = await import("../lib/slack-replies");
const { localClock } = await import("../lib/notification-events");

type Notice = import("../lib/notification-templates").Notice;
const { renderSlack, renderMatrix, renderTeams, renderDiscord, fillTemplate, toSlack, toMatrixHtml, toPlain, toTeams, toDiscord, sampleNotice } = templates;

const notice: Notice = {
  event: "row.updated",
  title: "Launch *beta* <now>",
  page: "Projekte",
  url: "https://flowplan.example.test/#page=p&row=r",
  actor: "Ana",
  at: "2026-10-21T08:30:00.000Z",
  changes: [
    { name: "Status", value: "In Arbeit" },
    { name: "Fällig am", value: "2026-10-22" },
  ],
};

/* ---------- Markdown conversion ---------- */

test("the Markdown subset converts to Slack, Matrix HTML, plain text, Teams and Discord", () => {
  const md = "**Bold** and _italic_ with `code` and [a link](https://x.test/?a=1&b=2)\n- one\n> quoted <b>";
  assert.equal(toSlack(md), "*Bold* and _italic_ with `code` and <https://x.test/?a=1&amp;b=2|a link>\n• one\n> quoted &lt;b&gt;");
  assert.equal(
    toMatrixHtml(md),
    '<strong>Bold</strong> and <em>italic</em> with <code>code</code> and <a href="https://x.test/?a=1&amp;b=2">a link</a><ul><li>one</li></ul><blockquote>quoted &lt;b&gt;</blockquote>',
  );
  assert.equal(toPlain(md), "Bold and italic with code and a link (https://x.test/?a=1&b=2)\n- one\n> quoted <b>");
  assert.equal(toTeams(md), "**Bold** and _italic_ with code and [a link](https://x.test/?a=1&b=2)\n\n- one\n\nquoted <b>");
  assert.equal(toDiscord(md), "**Bold** and *italic* with `code` and [a link](https://x.test/?a=1&b=2)\n- one\n> quoted <b>");
});

test("links other than http(s) and mailto lose their link; unclosed markup stays text", () => {
  assert.equal(toMatrixHtml("[click](javascript:alert(1))"), "click");
  assert.equal(toMatrixHtml("[Wiki](https://w.test/a_(b))"), '<a href="https://w.test/a_(b)">Wiki</a>');
  assert.equal(toSlack("**open and [half"), "**open and [half");
  assert.equal(toMatrixHtml("a < b & \"c\""), "a &lt; b &amp; &quot;c&quot;");
});

/* ---------- Templates ---------- */

test("placeholders are filled with escaped values; unknown ones stay", () => {
  const text = fillTemplate("{actor}: [{title}]({url}) in {page} {unknown}\n{changes}", notice, "en");
  // The title's * and < are literal, never markup.
  assert.equal(
    toSlack(text),
    "Ana: <https://flowplan.example.test/#page=p&amp;row=r|Launch *beta* &lt;now&gt;> in Projekte {unknown}\n• *Status:* In Arbeit\n• *Fällig am:* 2026-10-22",
  );
  assert.match(toMatrixHtml(text), /<a href="https:\/\/flowplan\.example\.test\/#page=p&amp;row=r">Launch \*beta\* &lt;now&gt;<\/a>/);
  // {date}, {count} and {text}
  const comment = fillTemplate("{count}|{text}|{date}", { ...notice, event: "comment.created", text: "line\nbreak _x_" }, "de");
  assert.match(toPlain(comment), /^2\|line break _x_\|21\.10\.2026, \d\d:30$/);
});

test("values and lists are capped", () => {
  const long: Notice = {
    ...notice,
    title: "x".repeat(500),
    changes: Array.from({ length: 14 }, (_, i) => ({ name: `Feld ${i}`, value: "y".repeat(400) })),
  };
  const text = toPlain(fillTemplate("{title}\n{changes}", long, "de"));
  const lines = text.split("\n");
  assert.equal(Array.from(lines[0]).length, 200);
  assert.ok(lines[0].endsWith("…"));
  assert.equal(lines.length, 1 + 10 + 1, "ten changes and a 'more' line");
  assert.match(lines.at(-1)!, /… und 4 weitere/);
  assert.ok(lines[1].length < 320);
  assert.equal(templates.cap("abcdef", 4), "abc…");
  const slack = renderSlack(long, { config: { language: "de" } });
  const header = (slack.blocks[0] as { text: { text: string } }).text.text;
  assert.ok(Array.from(header).length <= 150);
  const embed = renderDiscord({ ...long, title: "t".repeat(9000) }, {}).embeds[0] as { description: string; fields: unknown[] };
  assert.ok(embed.description.length <= 2500);
  assert.equal(embed.fields.length, 10);
});

/* ---------- Renderers ---------- */

test("Slack: header, section with the record as link, fields for the changes, context", () => {
  const payload = renderSlack(notice, { config: { language: "de", timeZone: "Europe/Berlin" } });
  const [header, section, fields, context] = payload.blocks as Record<string, unknown>[];
  assert.deepEqual(header, { type: "header", text: { type: "plain_text", text: "Eintrag geändert · Projekte", emoji: true } });
  assert.equal((section.text as { text: string }).text, "Ana hat <https://flowplan.example.test/#page=p&amp;row=r|Launch *beta* &lt;now&gt;> in *Projekte* geändert.");
  assert.deepEqual(
    (fields.fields as { text: string }[]).map((f) => f.text),
    ["*Status*\nIn Arbeit", "*Fällig am*\n2026-10-22"],
  );
  const contextText = (context.elements as { text: string }[])[0].text;
  assert.match(contextText, /^Ana · <!date\^1792571400\^\{date_short_pretty\} \{time\}\|21\.10\.2026, 10:30>$/);
  assert.match(payload.text, /^Ana hat Launch \*beta\* <now> \(https:/);
  // With {changes} in the template there are no extra fields.
  const custom = renderSlack(notice, { templates: { "row.updated": "{title}\n{changes}" } });
  assert.equal(custom.blocks.length, 3);
});

test("Matrix: HTML subset and plain body; Teams: Adaptive Card; Discord: embed", () => {
  const matrix = renderMatrix(notice, { config: { language: "en", timeZone: "UTC" } });
  assert.equal(matrix.format, "org.matrix.custom.html");
  assert.equal(matrix.msgtype, "m.notice");
  assert.match(matrix.formatted_body, /^<strong>Record changed · Projekte<\/strong><br>Ana changed <a href="[^"]+">Launch \*beta\* &lt;now&gt;<\/a> in <strong>Projekte<\/strong>\.<ul><li><strong>Status:<\/strong> In Arbeit<\/li>/);
  assert.match(matrix.formatted_body, /<sub>Ana · 21 Oct 2026, 08:30<\/sub>$/);
  assert.match(matrix.body, /^Record changed · Projekte\nAna changed Launch \*beta\* <now> \(https:[^)]+\) in Projekte\.\n- Status: In Arbeit\n- Fällig am: 2026-10-22\nAna · /);
  assert.deepEqual(Object.keys(templates.matrixWebhookBody(matrix)).slice(0, 2), ["text", "html"]);
  assert.equal(
    templates.matrixSendUrl("https://matrix.example.org/", "!room:example.org", "txn/1"),
    "https://matrix.example.org/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/txn%2F1",
  );

  const teams = renderTeams(notice, { config: { language: "en" } });
  const attachment = teams.attachments[0];
  assert.equal(teams.type, "message");
  assert.equal(attachment.contentType, "application/vnd.microsoft.card.adaptive");
  const card = attachment.content as { type: string; version: string; body: Record<string, unknown>[]; actions: { url: string }[] };
  assert.equal(card.type, "AdaptiveCard");
  assert.deepEqual(card.body.map((b) => b.type), ["TextBlock", "TextBlock", "FactSet", "TextBlock"]);
  assert.equal(card.body[1].text, "Ana changed [Launch \\*beta\\* <now>](https://flowplan.example.test/#page=p&row=r) in **Projekte**.");
  assert.deepEqual(card.body[2].facts, [
    { title: "Status", value: "In Arbeit" },
    { title: "Fällig am", value: "2026-10-22" },
  ]);
  assert.equal(card.actions[0].url, notice.url);

  const discord = renderDiscord(notice, { config: { language: "en" } });
  const embed = discord.embeds[0] as Record<string, unknown>;
  assert.equal(embed.title, "Record changed · Projekte");
  assert.equal(embed.url, notice.url);
  assert.equal(embed.description, "Ana changed [Launch \\*beta\\* <now>](https://flowplan.example.test/#page=p&row=r) in **Projekte**.");
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  assert.equal((embed.fields as unknown[]).length, 2);
});

test("every event has a default template and a sample that renders in every format", () => {
  for (const event of [...templates.noticeEvents, "test" as const])
    for (const lang of ["de", "en", "fr"] as const) {
      const sample = sampleNotice(event, lang);
      for (const format of ["slack", "matrix", "teams", "discord"] as const) {
        const json = JSON.stringify(templates.renderPayload(format, sample, { config: { language: lang } }));
        assert.ok(!json.includes("{title}") && !json.includes("{url}"), `${event} ${format} ${lang}`);
      }
    }
  const digest = toPlain(templates.messageMarkdown(sampleNotice("digest.due", "de")).markdown);
  assert.match(digest, /^2 fällige oder überfällige Einträge am /);
  assert.match(digest, /- Rechnung prüfen \([^)]+\) · Buchhaltung · überfällig seit 02\.01\.2026/);
});

/* ---------- Server: events, delivery, digest, Slack replies ---------- */

function person(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const ana = person("Ana");
const wid = createWorkspace(ana.id, "Team");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const db = createPage(wid, space, ana.id, "Aufgaben", "database");

const received: { method: string; url: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method!, url: req.url!, body, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" }).end('{"event_id":"$1"}');
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
const settle = () => new Promise((r) => setTimeout(r, 150));
const lastBody = (hookId: string) =>
  JSON.parse(one<{ body: string }>("SELECT body FROM webhook_deliveries WHERE webhook_id=? ORDER BY rowid DESC LIMIT 1", hookId)!.body);

test("chat webhooks render at delivery; record done, comments and the test message", async () => {
  const slack = await createWebhook(ana, {
    workspaceId: wid,
    url: `${base}/slack`,
    events: ["row.updated", "row.done", "comment.created"],
    format: "slack",
    templates: { "comment.created": "{actor} sagt: {text}" },
  });
  const row = (command(ana, { action: "row.create", pageId: db, cells: { title: "Angebot", status: "In Arbeit" } }) as { id: string }).id;
  const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", row)!.version;
  command(ana, { action: "row.update", pageId: db, rowId: row, version, cells: { status: "Erledigt" } });
  await settle();
  await flushWebhooks(Date.now() + 3600_000);
  const slackPosts = received.filter((r) => r.url === "/slack").map((r) => JSON.parse(r.body));
  const headers = slackPosts.map((p) => p.blocks[0].text.text);
  assert.ok(headers.includes("Eintrag geändert · Aufgaben"), headers.join());
  assert.ok(headers.includes("Eintrag erledigt · Aufgaben"), headers.join());
  const changed = slackPosts.find((p) => p.blocks[0].text.text.startsWith("Eintrag geändert"));
  assert.match(changed.blocks[1].text.text, /^Ana hat <https:\/\/flowplan\.example\.test\/#page=[^|]+&amp;row=[^|]+\|Angebot> in \*Aufgaben\* geändert\.$/);
  assert.deepEqual(changed.blocks[2].fields, [{ type: "mrkdwn", text: "*Status*\nErledigt" }]);

  command(ana, { action: "comment.create", pageId: db, rowId: row, body: "Bitte *heute* prüfen" });
  await settle();
  const comment = JSON.parse(received.filter((r) => r.url === "/slack").at(-1)!.body);
  // The comment's own * stay literal (Slack shows them as typed).
  assert.equal(comment.blocks[1].text.text, "Ana sagt: Bitte *heute* prüfen");
  assert.equal(lastBody(slack.id).notice.text, "Bitte *heute* prüfen");

  // A changed template applies to queued messages too (rendered on delivery).
  await updateWebhook(ana, { workspaceId: wid, id: slack.id, events: ["row.updated"], format: "discord", templates: {} });
  const listed = listWebhooks(ana, wid).find((h) => h.id === slack.id)!;
  assert.equal(listed.format, "discord");
  assert.deepEqual(listed.events, ["row.updated"]);

  const result = await testWebhook(ana, { workspaceId: wid, id: slack.id });
  assert.deepEqual(result, { ok: true, status: 200, error: null });
  const test = JSON.parse(received.at(-1)!.body);
  assert.equal(test.embeds[0].title, "Testnachricht");
  assert.match(test.embeds[0].description, /^Flowplan ist verbunden: \[Team\]\(https:\/\/flowplan\.example\.test\)$/);
});

test("JSON webhooks keep the signed envelope; Matrix uses the client API with a sealed token", async () => {
  const json = await createWebhook(ana, { workspaceId: wid, url: `${base}/json`, events: ["row.done"] });
  const matrix = await createWebhook(ana, {
    workspaceId: wid,
    url: `${base}/`,
    events: ["row.created"],
    format: "matrix",
    config: { matrixRoom: "!abc:example.org", language: "en" },
    credentials: { token: "syt_secret_token" },
  });
  // The token is stored sealed and never listed.
  assert.ok(!one<{ credentials: string }>("SELECT credentials FROM webhooks WHERE id=?", matrix.id)!.credentials.includes("syt_secret_token"));
  assert.ok(!JSON.stringify(listWebhooks(ana, wid)).includes("syt_secret_token"));
  assert.deepEqual(listWebhooks(ana, wid).find((h) => h.id === matrix.id)!.credentials, { token: true, signingSecret: false });
  const row = (command(ana, { action: "row.create", pageId: db, cells: { title: "Neu", status: "Erledigt" } }) as { id: string }).id;
  const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", row)!.version;
  command(ana, { action: "row.update", pageId: db, rowId: row, version, cells: { status: "In Arbeit" } });
  command(ana, { action: "row.update", pageId: db, rowId: row, version: version + 1, cells: { status: "Erledigt" } });
  await settle();
  await flushWebhooks(Date.now() + 3600_000);
  const put = received.find((r) => r.method === "PUT")!;
  assert.match(put.url, /^\/_matrix\/client\/v3\/rooms\/!abc%3Aexample\.org\/send\/m\.room\.message\/[0-9a-f-]+$/);
  assert.equal(put.headers.authorization, "Bearer syt_secret_token");
  const content = JSON.parse(put.body);
  assert.equal(content.format, "org.matrix.custom.html");
  assert.match(content.formatted_body, /^<strong>New record · Aufgaben<\/strong><br>Ana created <a href=/);
  const done = received.filter((r) => r.url === "/json").map((r) => ({ body: r.body, signature: r.headers["x-flowplan-signature"] }));
  assert.equal(done.length, 1, "done once: it was done at creation, then open, then done");
  const envelope = JSON.parse(done[0].body);
  assert.equal(envelope.event, "row.done");
  assert.equal(envelope.notice, undefined, "the JSON envelope is unchanged");
  assert.equal(done[0].signature, `sha256=${createHmac("sha256", json.secret).update(done[0].body).digest("hex")}`);
  await assert.rejects(
    createWebhook(ana, { workspaceId: wid, url: `${base}/`, events: ["row.created"], format: "matrix", credentials: { token: "syt_secret_token" } }),
    /braucht Matrix einen Raum/,
  );
  await assert.rejects(
    createWebhook(ana, { workspaceId: wid, url: `${base}/`, events: ["row.created"], format: "slack", credentials: { token: "xoxb-12345678" } }),
    /Kanal-ID/,
  );
  run("DELETE FROM webhooks WHERE id IN (?,?)", json.id, matrix.id);
});

test("the daily digest lists due and overdue open records once per day after its time", async () => {
  const hook = await createWebhook(ana, {
    workspaceId: wid,
    url: `${base}/digest`,
    events: ["digest.due"],
    pageId: db,
    format: "teams",
    config: { digestTime: "08:00", timeZone: "Europe/Berlin" },
  });
  run("DELETE FROM rows WHERE page_id=?", db);
  const today = localClock(Date.parse("2026-10-21T07:00:00Z"), "Europe/Berlin").day;
  assert.equal(today, "2026-10-21");
  for (const [title, date, status] of [
    ["Heute", "2026-10-21", "In Arbeit"],
    ["Gestern", "2026-10-20T15:00:00+02:00", ""],
    ["Morgen", "2026-10-22", ""],
    ["Erledigt", "2026-10-19", "Erledigt"],
    ["Privat", "2026-10-18", ""],
  ])
    command(ana, { action: "row.create", pageId: db, cells: { title, date, ...(status ? { status } : {}) } });
  run("UPDATE rows SET access='private' WHERE page_id=? AND cells LIKE '%Privat%'", db);
  // 07:59 in Berlin: too early.
  assert.equal(transaction(() => processDigests(Date.parse("2026-10-21T05:59:00Z"))), 0);
  assert.equal(transaction(() => processDigests(Date.parse("2026-10-21T06:05:00Z"))), 1);
  assert.equal(transaction(() => processDigests(Date.parse("2026-10-21T09:00:00Z"))), 0, "once per day");
  const envelope = lastBody(hook.id);
  assert.equal(envelope.event, "digest.due");
  assert.deepEqual(envelope.data.items.map((i: { title: string }) => i.title), ["Gestern", "Heute"]);
  assert.deepEqual(envelope.notice.items.map((i: { overdue: boolean }) => i.overdue), [true, false]);
  await flushWebhooks(Date.now() + 3600_000);
  const card = JSON.parse(received.filter((r) => r.url === "/digest").at(-1)!.body).attachments[0].content;
  assert.equal(card.body[0].text, "Heute fällig");
  assert.match(card.body[1].text, /^\*\*2 fällige oder überfällige Einträge\*\* am 21\.10\.2026:\n\n- \[Gestern\]\(https:[^)]+\) · Aufgaben · \*\*überfällig seit 20\.10\.2026\*\*\n\n- \[Heute\]/);
  // The next day it comes again.
  assert.equal(transaction(() => processDigests(Date.parse("2026-10-22T06:05:00Z"))), 1);
  run("DELETE FROM webhooks WHERE id=?", hook.id);
});

test("Slack thread replies become comments when the signature is valid", async () => {
  // With a bot token the address is Slack's chat.postMessage, whatever was entered.
  const { id: hookId } = await createWebhook(ana, {
    workspaceId: wid,
    url: "https://hooks.slack.example/ignored",
    events: ["comment.created"],
    format: "slack",
    config: { slackChannel: "C0123456789" },
    credentials: { token: "xoxb-1234567890", signingSecret: "8f742231b10e8888abcd99yyyzzz85a5" },
  });
  const listed = listWebhooks(ana, wid).find((h) => h.id === hookId)!;
  assert.equal(listed.url, templates.SLACK_POST_MESSAGE);
  assert.equal(listed.repliesUrl, `https://flowplan.example.test/api/webhooks/slack/${hookId}`);
  const row = (command(ana, { action: "row.create", pageId: db, cells: { title: "Thread" } }) as { id: string }).id;
  run("INSERT INTO webhook_messages(webhook_id,ts,page_id,row_id,created_at) VALUES(?,?,?,?,?)", hookId, "1700000000.000100", db, row, Date.now());
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const signed = (body: string, ts = String(Math.floor(Date.now() / 1000))) =>
    new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex") });

  const challenge = JSON.stringify({ type: "url_verification", challenge: "abc" });
  assert.deepEqual(transaction(() => receiveSlackEvent(hookId, signed(challenge), challenge)), { challenge: "abc" });
  assert.throws(() => receiveSlackEvent(hookId, new Headers({ "x-slack-request-timestamp": "1", "x-slack-signature": "v0=00" }), challenge), /Signatur/);
  assert.throws(() => receiveSlackEvent(hookId, signed(challenge, String(Math.floor(Date.now() / 1000) - 600)), challenge), /Signatur/, "too old");
  assert.throws(() => receiveSlackEvent(id(), signed(challenge), challenge), /Unbekannter Webhook/);

  const reply = JSON.stringify({
    type: "event_callback",
    event: { type: "message", text: "Erledigt, siehe <https://x.test|Ticket> &amp; <@U123>", ts: "1700000001.000200", thread_ts: "1700000000.000100" },
  });
  const before = all("SELECT 1 FROM webhook_deliveries WHERE webhook_id=?", hookId).length;
  assert.deepEqual(transaction(() => receiveSlackEvent(hookId, signed(reply), reply)), { ok: true });
  const comment = one<{ body: string; author_id: string }>("SELECT body,author_id FROM comments WHERE row_id=?", row)!;
  assert.equal(comment.body, "Slack: Erledigt, siehe Ticket (https://x.test) & @U123");
  assert.equal(comment.author_id, ana.id);
  assert.equal(all("SELECT 1 FROM webhook_deliveries WHERE webhook_id=?", hookId).length, before, "no echo into its own channel");
  // Bot messages, other threads and retries are ignored.
  const bot = JSON.stringify({ type: "event_callback", event: { type: "message", bot_id: "B1", text: "x", ts: "2", thread_ts: "1700000000.000100" } });
  assert.equal((transaction(() => receiveSlackEvent(hookId, signed(bot), bot)) as { ignored?: string }).ignored, "event");
  const retry = signed(reply);
  retry.set("x-slack-retry-num", "1");
  assert.equal((transaction(() => receiveSlackEvent(hookId, retry, reply)) as { ignored?: string }).ignored, "retry");
  assert.equal(all("SELECT 1 FROM comments WHERE row_id=?", row).length, 1);
});

test("Slack signatures and mrkdwn are read correctly", () => {
  const body = "token=x&team_id=T1";
  const ts = "1531420618";
  // The example from Slack's documentation.
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  assert.equal(verifySlackSignature(secret, ts, signature, body, Number(ts) * 1000 + 60_000), true);
  assert.equal(verifySlackSignature(secret, ts, signature, body + "x", Number(ts) * 1000), false);
  assert.equal(verifySlackSignature(secret, ts, signature, body, Number(ts) * 1000 + 301_000), false);
  assert.equal(slackToPlain("<https://a.test>, <#C1|general> &lt;3"), "https://a.test, general <3");
});
