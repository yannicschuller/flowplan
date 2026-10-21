// The dependency-free MIME parser for incoming e-mail (lib/mime-parse.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addresses, decodeQuotedPrintable, decodeWords, parseMime, parseParams } from "../lib/mime-parse";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url));

test("multipart/mixed: alternative bodies, encoded headers and an RFC 2231 file name", () => {
  const mail = parseMime(fixture("multipart-attachment.eml"));
  assert.equal(mail.from, "ada@example.org");
  assert.deepEqual(mail.to, ["team@example.test", "bob@example.test"]);
  assert.deepEqual(mail.cc, ["carol@example.test"]);
  // Two encoded words across a folded line join without the space.
  assert.equal(mail.subject, "Quartalsbericht Übersicht Q3");
  assert.equal(mail.messageId, "report-1@example.org");
  assert.equal(mail.date?.toISOString(), "2026-10-20T07:30:00.000Z");
  // Quoted-printable with a soft line break and UTF-8.
  assert.equal(mail.text.trim(), "Hallo Team, siehe Anhang. Grüße aus Berlin.");
  assert.match(mail.html, /<p>Hallo <b>Team<\/b>, siehe Anhang\.<\/p>/);
  assert.equal(mail.attachments.length, 1);
  const [pdf] = mail.attachments;
  assert.equal(pdf.filename, "Bericht Übersicht.pdf");
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(pdf.inline, false);
  assert.ok(pdf.data.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.deepEqual(mail.headers.get("delivered-to"), ["inbox+abcdefghijklmnopqrstuvwxyz234567@mail.example.test"]);
});

test("multipart/related: ISO-8859-1 HTML and an inline image by Content-ID", () => {
  const mail = parseMime(fixture("related-inline.eml"));
  assert.equal(mail.from, "juergen@example.com");
  assert.equal(mail.subject, "Foto vom Büro");
  assert.equal(mail.text, "");
  assert.match(mail.html, /Schöne Grüße/);
  assert.match(mail.html, /src="cid:logo@example.com"/);
  const [logo] = mail.attachments;
  assert.equal(logo.contentId, "logo@example.com");
  assert.equal(logo.inline, true);
  assert.equal(logo.contentType, "image/png");
  assert.ok(logo.data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
});

test("a single 8-bit Latin-1 part with folded headers", () => {
  const mail = parseMime(fixture("plain-latin1.eml"));
  assert.equal(mail.subject, "Nur Text");
  assert.equal(mail.text.trim(), "Grüße aus Köln");
  assert.equal(mail.html, "");
  assert.equal(mail.attachments.length, 0);
  assert.equal(mail.messageId, "");
  assert.equal(mail.date, null);
});

test("building blocks: encoded words, quoted-printable, parameters, address lists", () => {
  assert.equal(decodeWords("=?iso-8859-1?q?K=F6ln?= und =?utf-8?b?TcO8bmNoZW4=?="), "Köln und München");
  assert.equal(decodeQuotedPrintable("a=3Db=\r\nc =C3=A4").toString("utf8"), "a=bc ä");
  const p = parseParams('attachment; filename="a;b.txt"; size=3');
  assert.equal(p.value, "attachment");
  assert.equal(p.params.get("filename"), "a;b.txt");
  assert.deepEqual(addresses('"Doe, Jane" <JANE@x.org>, bob@y.org (Bob); <c@z.org>'), ["jane@x.org", "bob@y.org", "c@z.org"]);
  // Unknown charsets fall back instead of failing.
  const odd = parseMime("Content-Type: text/plain; charset=x-unknown\r\n\r\nabc");
  assert.equal(odd.text, "abc");
});

test("deep nesting and part floods stop instead of exhausting memory", () => {
  let body = "leaf";
  for (let i = 0; i < 40; i++) body = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
  assert.doesNotThrow(() => parseMime(body));
  const many = ["Content-Type: multipart/mixed; boundary=x", "", ...Array.from({ length: 1000 }, () => "--x\r\nContent-Type: text/plain\r\n\r\nhi"), "--x--"].join("\r\n");
  const mail = parseMime(many);
  assert.ok(mail.text.split("hi").length - 1 <= 300);
});
