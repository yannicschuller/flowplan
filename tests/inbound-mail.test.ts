// E-mail inbound capture (lib/inbound-mail.ts, app/api/inbound-mail): the
// provider formats, sender rules, deduplication, page and database
// targets, attachments, budgets, the hourly limit, token rotation, the
// signing key and the IMAP poller.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-inbound-mail-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.INBOUND_MAIL_DOMAIN = "mail.example.test";
delete process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const inbound = await import("../lib/inbound-mail");
const { POST } = await import("../app/api/inbound-mail/[token]/route");

const fixture = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url));
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b80000000049454e44ae426082",
  "hex",
);
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");

function person(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const ana = person("Ana"),
  ben = person("Ben");
const wid = createWorkspace(ana.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const inboxPage = createPage(wid, space, ana.id, "Posteingang");
const db = createPage(wid, space, ana.id, "Anfragen", "database", null, "empty");
run(
  "UPDATE databases SET fields=? WHERE page_id=?",
  JSON.stringify([
    { id: "title", name: "Betreff", type: "text" },
    { id: "sender", name: "Absender", type: "email" },
    { id: "files", name: "Anhänge", type: "files" },
  ]),
  db,
);

const save = (input: Record<string, unknown>, user = ana) =>
  command(user, { action: "inbound.save", workspaceId: wid, ...input }) as { id: string };
const tokenOf = (addressId: string) => one<{ token: string }>("SELECT token FROM inbound_addresses WHERE id=?", addressId)!.token;
const mail = (over: Partial<import("../lib/inbound-mail").InboundMail> = {}) => ({
  from: "ada@example.org",
  to: ["inbox@example.test"],
  subject: "Hallo",
  text: "Erste Zeile\n\nZweiter Absatz",
  html: "",
  messageId: `m-${randomBytes(6).toString("hex")}@example.org`,
  date: new Date("2026-10-20T08:00:00Z"),
  attachments: [],
  ...over,
});

after(() => {
  delete process.env.INBOUND_MAIL_DOMAIN;
});

test("owners create addresses with a 32-character token, allowed senders and a page or database target", () => {
  assert.throws(() => save({ pageId: inboxPage, senders: ["example.org"] }, ben), /Nur Eigentümer/);
  assert.throws(() => save({ pageId: inboxPage, senders: [] }), /mindestens einen erlaubten Absender/);
  assert.throws(() => save({ pageId: inboxPage, senders: ["not an address"] }), /Ungültiger Absender/);
  const board = createPage(wid, space, ana.id, "Tafel", "whiteboard");
  assert.throws(() => save({ pageId: board, senders: ["example.org"] }), /nur unter einer Seite oder in einer Datenbank/);
  const { id: addressId } = save({ pageId: inboxPage, label: "Team", senders: ["@Example.org", "boss@partner.test"] });
  const token = tokenOf(addressId);
  assert.match(token, /^[a-z2-7]{32}$/);
  const listed = inbound.listInboundAddresses(ana, wid).addresses.find((a) => a.id === addressId)!;
  assert.deepEqual(listed.senders, ["example.org", "boss@partner.test"]);
  assert.equal(listed.webhookUrl, `https://flowplan.example.test/api/inbound-mail/${token}`);
  assert.equal(listed.email, `inbox+${token}@mail.example.test`);
  assert.equal(listed.target.title, "Posteingang");
  assert.throws(() => inbound.listInboundAddresses(ben, wid), /Nur Eigentümer/);
  assert.ok(one("SELECT 1 FROM audit WHERE action='inbound.create' AND resource_id=?", addressId));
});

test("sender rules: addresses and domains on the list get in, everyone else is logged and dropped", () => {
  assert.equal(inbound.senderAllowed(["example.org"], "Ada@Example.org"), true);
  assert.equal(inbound.senderAllowed(["example.org"], "ada@evil-example.org"), false);
  assert.equal(inbound.senderAllowed(["example.org"], "ada@sub.example.org"), false);
  assert.equal(inbound.senderAllowed(["boss@partner.test"], "boss@partner.test"), true);
  assert.equal(inbound.senderAllowed(["boss@partner.test"], "other@partner.test"), false);
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.org"] });
  const pages = Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=?", inboxPage)!.n);
  const result = inbound.receiveInboundMail(tokenOf(addressId), mail({ from: "spam@elsewhere.test" }));
  assert.deepEqual(result, { status: "rejected", reason: "sender" });
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=?", inboxPage)!.n), pages);
  assert.ok(one("SELECT 1 FROM audit WHERE action='inbound.rejected' AND resource_id=? AND detail LIKE '%spam@elsewhere.test%'", addressId));
  assert.match(one<{ last_error: string }>("SELECT last_error FROM inbound_addresses WHERE id=?", addressId)!.last_error, /Absender abgelehnt/);
});

test("a page target: a new page per mail, cleaned HTML, inline images and attachments as files", () => {
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.org"] });
  const token = tokenOf(addressId);
  const result = inbound.receiveInboundMail(
    token,
    mail({
      subject: "Bericht",
      html: '<style>p{}</style><script>alert(1)</script><p onclick="x()">Hallo <b>Team</b></p><img src="cid:Logo@x"><img src="https://tracker.example/p.gif"><a href="javascript:alert(1)">böse</a><a href="https://example.org/">gut</a>',
      attachments: [
        { filename: "logo.png", contentType: "image/png", data: PNG, contentId: "logo@x", inline: true },
        { filename: "../bericht.pdf", contentType: "application/pdf", data: PDF, contentId: "", inline: false },
        // Claims to be HTML: never kept as such.
        { filename: "page.html", contentType: "text/html", data: Buffer.from("<script>1</script>"), contentId: "", inline: false },
      ],
    }),
  );
  assert.equal(result.status, "stored");
  if (result.status !== "stored") return;
  const page = one<{ title: string; parent_id: string; kind: string; created_by: string }>("SELECT * FROM pages WHERE id=?", result.pageId)!;
  assert.equal(page.title, "Bericht");
  assert.equal(page.parent_id, inboxPage);
  assert.equal(page.kind, "document");
  assert.equal(page.created_by, ana.id);
  const html = one<{ html: string; state: Uint8Array }>("SELECT html,state FROM documents WHERE page_id=?", result.pageId)!;
  assert.ok(html.state?.length, "the editor state is stored");
  assert.doesNotMatch(html.html, /script|alert|onclick|tracker\.example|p\{\}/);
  assert.match(html.html, /Hallo <(b|strong)>Team<\/(b|strong)>/);
  assert.match(html.html, /href="https:\/\/example.org\/"/);
  assert.match(html.html, /ada@example.org/);
  const files = all<{ id: string; name: string; mime: string; page_id: string }>("SELECT * FROM files WHERE page_id=? ORDER BY name", result.pageId);
  assert.deepEqual(
    files.map((f) => [f.name, f.mime]),
    [
      ["bericht.pdf", "application/pdf"],
      ["logo.png", "image/png"],
      ["page.html", "application/octet-stream"],
    ],
  );
  const logo = files.find((f) => f.name === "logo.png")!;
  assert.match(html.html, new RegExp(`<img src="/api/files/${logo.id}"`));
  for (const f of files) {
    assert.ok(existsSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "uploads", f.id)));
    assert.match(html.html, new RegExp(`/api/files/${f.id}`), `${f.name} is linked from the page`);
  }
  assert.equal(result.files, 3);
  // The same Message-ID again: nothing new.
  const again = inbound.receiveInboundMail(token, mail({ subject: "Bericht", messageId: one<{ message_id: string }>("SELECT message_id FROM inbound_messages WHERE page_id=?", result.pageId)!.message_id }));
  assert.deepEqual(again, { status: "duplicate" });
  // Without a Message-ID the content counts.
  const bare = mail({ messageId: "", subject: "Ohne ID" });
  assert.equal(inbound.receiveInboundMail(token, bare).status, "stored");
  assert.equal(inbound.receiveInboundMail(token, bare).status, "duplicate");
  const row = one<{ last_received_at: number; received: number }>("SELECT * FROM inbound_addresses WHERE id=?", addressId)!;
  assert.equal(row.received, 2);
  assert.ok(row.last_received_at);
});

test("a database target: subject, sender e-mail, date as created, attachments in the files property", () => {
  const { id: addressId } = save({ pageId: db, senders: ["example.org"] });
  const result = inbound.receiveInboundMail(
    tokenOf(addressId),
    mail({
      subject: "  Angebot\n anfordern ",
      text: "Bitte ein Angebot.",
      date: new Date("2026-10-19T07:15:00Z"),
      attachments: [{ filename: "plan.pdf", contentType: "application/pdf", data: PDF, contentId: "", inline: false }],
    }),
  );
  assert.equal(result.status, "stored");
  if (result.status !== "stored") return;
  assert.equal(result.pageId, db);
  const row = one<{ cells: string; created_at: string; content: string }>("SELECT * FROM rows WHERE id=?", result.rowId!)!;
  const cells = JSON.parse(row.cells);
  assert.equal(cells.title, "Angebot anfordern");
  assert.equal(cells.sender, "ada@example.org");
  assert.equal(cells.files.length, 1);
  const file = one<{ page_id: string; name: string }>("SELECT * FROM files WHERE id=?", cells.files[0].split("/").pop())!;
  assert.deepEqual([file.page_id, file.name], [db, "plan.pdf"]);
  assert.equal(row.created_at, "2026-10-19 07:15:00");
  assert.match(row.content, /Bitte ein Angebot\./);
  assert.ok(one("SELECT 1 FROM row_documents WHERE row_id=?", result.rowId!));
  // A date in the future is not believed.
  const future = inbound.receiveInboundMail(tokenOf(addressId), mail({ date: new Date(Date.now() + 86_400_000 * 30) }));
  if (future.status === "stored") assert.ok(new Date(one<{ created_at: string }>("SELECT created_at FROM rows WHERE id=?", future.rowId!)!.created_at + "Z").getTime() <= Date.now() + 1000);
});

test("attachments: size limits, the daily budget per address and the workspace quota", () => {
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.org"] });
  const token = tokenOf(addressId);
  const big = Buffer.alloc(inbound.INBOUND_FILE_BYTES + 1, 1);
  const result = inbound.receiveInboundMail(
    token,
    mail({ attachments: [{ filename: "riesig.bin", contentType: "application/octet-stream", data: big, contentId: "", inline: false }] }),
  );
  assert.equal(result.status, "stored");
  if (result.status === "stored") {
    assert.deepEqual(result.skipped, ["riesig.bin"]);
    assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", result.pageId)!.html, /riesig\.bin/);
  }
  // The instance-wide anonymous budget is shared with forms and links.
  process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB = "1";
  try {
    const before = Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=?", inboxPage)!.n);
    assert.throws(
      () =>
        inbound.receiveInboundMail(
          token,
          mail({ attachments: [{ filename: "a.bin", contentType: "application/octet-stream", data: Buffer.alloc(1_200_000, 2), contentId: "", inline: false }] }),
        ),
      (e: any) => e.status === 413,
    );
    assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=?", inboxPage)!.n), before, "nothing stored");
    assert.match(one<{ last_error: string }>("SELECT last_error FROM inbound_addresses WHERE id=?", addressId)!.last_error, /anonymen Uploads/);
  } finally {
    delete process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB;
  }
  run("UPDATE workspaces SET quota_mb=? WHERE id=?", 1, wid);
  try {
    assert.throws(
      () =>
        inbound.receiveInboundMail(
          token,
          mail({ attachments: [{ filename: "b.bin", contentType: "application/octet-stream", data: Buffer.alloc(1_100_000, 3), contentId: "", inline: false }] }),
        ),
      /Speicherkontingent/,
    );
  } finally {
    run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  }
});

test("each address takes 60 mails per hour; refused senders count too", () => {
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.org"] });
  const token = tokenOf(addressId);
  const now = Date.now();
  for (let i = 0; i < inbound.INBOUND_MAILS_PER_HOUR; i++) inbound.receiveInboundMail(token, mail({ from: "x@spam.test" }), now + i);
  assert.throws(() => inbound.receiveInboundMail(token, mail(), now + 100), (e: any) => e.status === 429);
  // An hour later the address takes mail again.
  assert.equal(inbound.receiveInboundMail(token, mail(), now + 3_600_001).status, "stored");
});

test("rotating the token ends the old address at once; deleting removes it", () => {
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.org"] });
  const old = tokenOf(addressId);
  const message = mail();
  assert.equal(inbound.receiveInboundMail(old, message).status, "stored");
  assert.throws(() => command(ben, { action: "inbound.rotate", workspaceId: wid, id: addressId }), /Nur Eigentümer/);
  const { token } = command(ana, { action: "inbound.rotate", workspaceId: wid, id: addressId }) as { token: string };
  assert.notEqual(token, old);
  assert.throws(() => inbound.receiveInboundMail(old, mail()), (e: any) => e.status === 404);
  // Deduplication belongs to the address, not the token.
  assert.deepEqual(inbound.receiveInboundMail(token, message), { status: "duplicate" });
  command(ana, { action: "inbound.delete", workspaceId: wid, id: addressId });
  assert.throws(() => inbound.receiveInboundMail(token, mail()), (e: any) => e.status === 404);
  assert.equal(one("SELECT 1 FROM inbound_messages WHERE address_id=?", addressId), undefined);
});

test("the address stops when its creator loses access to the target", () => {
  const { id: addressId } = save({ pageId: db, senders: ["example.org"] });
  run("UPDATE pages SET locked=1 WHERE id=?", db);
  try {
    assert.throws(() => inbound.receiveInboundMail(tokenOf(addressId), mail()), (e: any) => e.status === 409);
  } finally {
    run("UPDATE pages SET locked=0 WHERE id=?", db);
  }
});

/* ---------- Provider formats ---------- */

async function encode(form: FormData) {
  const response = new Response(form);
  return { type: response.headers.get("content-type")!, body: Buffer.from(await response.arrayBuffer()) };
}

test("webhook adapters: generic JSON, Postmark, Mailgun, SendGrid, raw MIME and generic multipart", async () => {
  const generic = await inbound.parseInboundPayload(
    "application/json",
    Buffer.from(
      JSON.stringify({
        from: "Ada <ada@example.org>",
        to: ["x@y.test"],
        subject: "JSON",
        text: "t",
        html: "<p>h</p>",
        messageId: "<g1@example.org>",
        date: "2026-10-20T10:00:00Z",
        attachments: [{ filename: "a.png", contentType: "image/png", content: PNG.toString("base64"), contentId: "<img1>" }],
      }),
    ),
  );
  assert.equal(generic.provider, "generic");
  assert.equal(generic.mail.from, "ada@example.org");
  assert.equal(generic.mail.messageId, "g1@example.org");
  assert.equal(generic.mail.attachments[0].contentId, "img1");
  assert.ok(generic.mail.attachments[0].data.equals(PNG));

  const raw = await inbound.parseInboundPayload("application/json", Buffer.from(JSON.stringify({ raw: fixture("related-inline.eml").toString("latin1") })));
  assert.equal(raw.mail.subject, "Foto vom Büro");

  const postmark = await inbound.parseInboundPayload(
    "application/json; charset=utf-8",
    Buffer.from(
      JSON.stringify({
        From: "ada@example.org",
        FromFull: { Email: "Ada@Example.org", Name: "Ada" },
        ToFull: [{ Email: "inbox@example.test" }],
        Subject: "Postmark",
        TextBody: "text",
        HtmlBody: "<p>html</p>",
        MessageID: "pm-internal",
        Date: "Tue, 20 Oct 2026 10:00:00 +0000",
        Headers: [{ Name: "Message-ID", Value: "<pm-1@example.org>" }],
        Attachments: [{ Name: "doc.pdf", Content: PDF.toString("base64"), ContentType: "application/pdf", ContentID: "" }],
      }),
    ),
  );
  assert.equal(postmark.provider, "postmark");
  assert.equal(postmark.mail.from, "ada@example.org");
  assert.equal(postmark.mail.messageId, "pm-1@example.org");
  assert.equal(postmark.mail.attachments[0].filename, "doc.pdf");
  assert.equal(postmark.mail.date?.toISOString(), "2026-10-20T10:00:00.000Z");

  const mg = new FormData();
  mg.set("recipient", "inbox@example.test");
  mg.set("sender", "ada@example.org");
  mg.set("from", "Ada <ada@example.org>");
  mg.set("subject", "Mailgun");
  mg.set("body-plain", "plain");
  mg.set("body-html", '<p><img src="cid:ii_1"></p>');
  mg.set("Message-Id", "<mg-1@example.org>");
  mg.set("attachment-count", "1");
  mg.set("content-id-map", JSON.stringify({ "<ii_1>": "attachment-1" }));
  mg.set("attachment-1", new File([PNG], "bild.png", { type: "image/png" }));
  mg.set("timestamp", "1700000000");
  mg.set("token", "abc");
  mg.set("signature", "def");
  const mgBody = await encode(mg);
  const mailgun = await inbound.parseInboundPayload(mgBody.type, mgBody.body);
  assert.equal(mailgun.provider, "mailgun");
  assert.equal(mailgun.mail.messageId, "mg-1@example.org");
  assert.deepEqual(mailgun.signature, { timestamp: "1700000000", token: "abc", signature: "def" });
  assert.equal(mailgun.mail.attachments[0].contentId, "ii_1");
  assert.equal(mailgun.mail.attachments[0].filename, "bild.png");

  const sg = new FormData();
  sg.set("from", "Ada <ada@example.org>");
  sg.set("to", "inbox@example.test");
  sg.set("subject", "SendGrid");
  sg.set("text", "plain");
  sg.set("headers", "Message-ID: <sg-1@example.org>\nDate: Tue, 20 Oct 2026 10:00:00 +0000\n");
  sg.set("envelope", JSON.stringify({ to: ["inbox+tok@example.test"], from: "ada@example.org" }));
  sg.set("attachments", "1");
  sg.set("attachment-info", JSON.stringify({ attachment1: { filename: "s.pdf", type: "application/pdf" } }));
  sg.set("attachment1", new File([PDF], "s.pdf", { type: "application/pdf" }));
  const sgBody = await encode(sg);
  const sendgrid = await inbound.parseInboundPayload(sgBody.type, sgBody.body);
  assert.equal(sendgrid.provider, "sendgrid");
  assert.equal(sendgrid.mail.messageId, "sg-1@example.org");
  assert.ok(sendgrid.mail.to.includes("inbox+tok@example.test"));
  assert.equal(sendgrid.mail.attachments[0].filename, "s.pdf");

  const mime = await inbound.parseInboundPayload("message/rfc822", fixture("multipart-attachment.eml"));
  assert.equal(mime.provider, "mime");
  assert.equal(mime.mail.attachments[0].filename, "Bericht Übersicht.pdf");
  assert.ok(mime.mail.to.includes("inbox+abcdefghijklmnopqrstuvwxyz234567@mail.example.test"), "Delivered-To counts as recipient");

  const plain = new FormData();
  plain.set("from", "ada@example.org");
  plain.set("subject", "Formular");
  plain.set("text", "x");
  plain.set("attachments", new File([PDF], "f.pdf", { type: "application/pdf" }));
  const plainBody = await encode(plain);
  const multipart = await inbound.parseInboundPayload(plainBody.type, plainBody.body);
  assert.equal(multipart.provider, "generic");
  assert.equal(multipart.mail.attachments.length, 1);

  await assert.rejects(inbound.parseInboundPayload("application/xml", Buffer.from("<x/>")), (e: any) => e.status === 415);
  await assert.rejects(inbound.parseInboundPayload("application/json", Buffer.from("{")), (e: any) => e.status === 400);
});

test("POST /api/inbound-mail/<token>: stores, checks the signing key, refuses unknown tokens", async () => {
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.org"], secret: "s3cret-key" });
  const token = tokenOf(addressId);
  assert.equal(inbound.listInboundAddresses(ana, wid).addresses.find((a) => a.id === addressId)!.signed, true);
  const body = JSON.stringify({ from: "ada@example.org", subject: "Per Webhook", text: "Hallo", messageId: "wh-1@example.org" });
  const post = (headers: Record<string, string>, data: string = body, t = token) =>
    POST(new Request(`https://flowplan.example.test/api/inbound-mail/${t}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: data }), {
      params: Promise.resolve({ token: t }),
    });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ "x-flowplan-signature": "sha256=" + "0".repeat(64) })).status, 401);
  const signature = "sha256=" + createHmac("sha256", "s3cret-key").update(body).digest("hex");
  const ok = await post({ "x-flowplan-signature": signature });
  assert.equal(ok.status, 200);
  const answer = await ok.json();
  assert.equal(answer.status, "stored");
  assert.equal(one<{ title: string }>("SELECT title FROM pages WHERE id=?", answer.pageId)!.title, "Per Webhook");
  assert.equal((await (await post({ "x-flowplan-signature": signature })).json()).status, "duplicate");
  // Mailgun's own signature (timestamp + token) also counts.
  const ts = String(Math.floor(Date.now() / 1000));
  const form = new FormData();
  form.set("recipient", "inbox@example.test");
  form.set("from", "ada@example.org");
  form.set("subject", "Mailgun signiert");
  form.set("body-plain", "x");
  form.set("timestamp", ts);
  form.set("token", "tok123");
  form.set("signature", createHmac("sha256", "s3cret-key").update(ts + "tok123").digest("hex"));
  const encoded = await encode(form);
  const signed = await POST(
    new Request(`https://flowplan.example.test/api/inbound-mail/${token}`, { method: "POST", headers: { "content-type": encoded.type }, body: encoded.body }),
    { params: Promise.resolve({ token }) },
  );
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).provider, "mailgun");
  assert.equal((await post({}, body, "a".repeat(32))).status, 404);
  assert.equal((await post({ "content-length": String(inbound.INBOUND_REQUEST_BYTES + 1) })).status, 413);
  // Removing the key: no signature needed any more.
  save({ id: addressId, pageId: inboxPage, senders: ["example.org"], secret: "" });
  const unsigned = JSON.stringify({ from: "ada@example.org", subject: "Ohne Signatur", text: "x" });
  assert.equal((await post({}, unsigned)).status, 200);
});

/* ---------- IMAP ---------- */

test("the IMAP poller routes inbox+<token> mail, marks it seen and leaves the rest", async () => {
  const { id: addressId } = save({ pageId: inboxPage, senders: ["example.com"] });
  const token = tokenOf(addressId);
  const messages = new Map<number, Buffer>([
    [7, Buffer.from(fixture("related-inline.eml").toString("latin1").replaceAll("abcdefghijklmnopqrstuvwxyz234567", token), "latin1")],
    // No token: marked seen, nothing stored.
    [8, Buffer.from("From: x@example.com\r\nTo: other@example.test\r\nSubject: Fremd\r\n\r\nx")],
  ]);
  const seen: number[] = [];
  const commands: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.write("* OK fake IMAP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        commands.push(cmd.split(" ").slice(0, 2).join(" "));
        if (/^LOGIN/.test(cmd)) socket.write(cmd === 'LOGIN "inbox" "pa\\"ss"' ? `${tag} OK logged in\r\n` : `${tag} NO bad\r\n`);
        else if (/^SELECT/.test(cmd)) socket.write(`* 2 EXISTS\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (/^UID SEARCH UNSEEN/.test(cmd)) socket.write(`* SEARCH ${[...messages.keys()].filter((u) => !seen.includes(u)).join(" ")}\r\n${tag} OK done\r\n`);
        else if (/^UID FETCH/.test(cmd)) {
          const uid = Number(cmd.split(" ")[2]);
          const data = messages.get(uid)!;
          socket.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID ${uid} BODY[] {${data.length}}\r\n`), data, Buffer.from(`)\r\n${tag} OK fetched\r\n`)]));
        } else if (/^UID STORE/.test(cmd)) {
          seen.push(Number(cmd.split(" ")[2]));
          socket.write(`${tag} OK stored\r\n`);
        } else if (/^LOGOUT/.test(cmd)) {
          socket.write(`* BYE\r\n${tag} OK bye\r\n`);
          socket.end();
        } else socket.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const before = Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=?", inboxPage)!.n);
    const result = await inbound.pollInboundMailbox({ host: "127.0.0.1", port, user: "inbox", password: 'pa"ss', tls: false });
    assert.equal(result.processed, 1);
    assert.deepEqual(seen.sort(), [7, 8]);
    assert.ok(commands.includes("UID SEARCH") && commands.includes("LOGOUT"));
    const created = one<{ id: string; title: string }>("SELECT id,title FROM pages WHERE parent_id=? ORDER BY position DESC LIMIT 1", inboxPage)!;
    assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=?", inboxPage)!.n), before + 1);
    assert.equal(created.title, "Foto vom Büro");
    const logo = one<{ id: string }>("SELECT id FROM files WHERE page_id=?", created.id)!;
    assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", created.id)!.html, new RegExp(`/api/files/${logo.id}`));
    // A second round finds nothing unseen.
    assert.equal((await inbound.pollInboundMailbox({ host: "127.0.0.1", port, user: "inbox", password: 'pa"ss', tls: false })).processed, 0);
    await assert.rejects(inbound.pollInboundMailbox({ host: "127.0.0.1", port, user: "inbox", password: "wrong", tls: false }), /IMAP LOGIN/);
  } finally {
    server.close();
  }
});
