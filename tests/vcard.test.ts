// vCard 3.0/4.0 reading and writing (lib/vcard.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyContact, escapeText, foldLine, parseVCards, serializeVCard, serializeVCards, unescapeText } from "../lib/vcard";

const sample = (over: Partial<ReturnType<typeof emptyContact>> = {}) => ({
  ...emptyContact(),
  uid: "3f1c7a52-6b9e-4c55-9d3e-2a6f0c1d8e77",
  firstName: "Zoë",
  lastName: "Müller-Lüdenscheidt",
  fn: "Zoë Müller-Lüdenscheidt",
  org: "Acme; Söhne, GmbH",
  title: "Leitung \\ Einkauf",
  emails: [{ value: "zoe@example.org", type: "work" }],
  phones: [
    { value: "+49 30 1234567", type: "work" },
    { value: "+49 171 7654321", type: "cell" },
  ],
  addresses: [{ street: "Hauptstraße 1\nHinterhaus", city: "Berlin", region: "", postalCode: "10115", country: "Deutschland", type: "work" }],
  birthday: "1980-02-29",
  note: "Mag Kaffee, keinen Tee;\nzweite Zeile – mit Ümläuten und 😀 Emoji.",
  categories: ["Kunde", "VIP, wichtig"],
  ...over,
});

test("round trip in 3.0 and 4.0 keeps every value, also with escapes and UTF-8", () => {
  for (const version of ["3.0", "4.0"] as const) {
    const text = serializeVCard(sample(), version);
    assert.match(text, new RegExp(`^BEGIN:VCARD\\r\\nVERSION:${version.replace(".", "\\.")}\\r\\n`));
    assert.ok(text.endsWith("END:VCARD\r\n"));
    const [back] = parseVCards(text);
    const expected = sample();
    assert.equal(back.uid, expected.uid);
    assert.equal(back.firstName, expected.firstName);
    assert.equal(back.lastName, expected.lastName);
    assert.equal(back.org, expected.org);
    assert.equal(back.title, expected.title);
    assert.deepEqual(back.emails.map((e) => e.value), ["zoe@example.org"]);
    assert.deepEqual(back.phones.map((p) => p.value), ["+49 30 1234567", "+49 171 7654321"]);
    assert.match(back.phones[1].type, /cell/);
    assert.deepEqual(back.addresses[0], expected.addresses[0]);
    assert.equal(back.birthday, "1980-02-29");
    assert.equal(back.note, expected.note);
    assert.deepEqual(back.categories, expected.categories);
  }
});

test("escaping follows RFC 6350 3.4", () => {
  assert.equal(escapeText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  assert.equal(unescapeText("a\\,b\\;c\\\\d\\ne\\Nf"), "a,b;c\\d\ne\nf");
  const text = serializeVCard(sample());
  assert.ok(text.includes("ORG:Acme\\; Söhne\\, GmbH"));
  assert.ok(text.includes("CATEGORIES:Kunde,VIP\\, wichtig"));
});

test("long lines fold at 75 octets without splitting UTF-8 characters", () => {
  const long = "NOTE:" + "äöü😀".repeat(40);
  const folded = foldLine(long);
  for (const line of folded.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.equal(folded.replace(/\r\n /g, ""), long);
  const text = serializeVCard(sample({ note: "x".repeat(500) }));
  for (const line of text.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(parseVCards(text)[0].note, "x".repeat(500));
});

test("several cards per file, folding with tabs, groups, 2.1 quoted-printable and inline photos", () => {
  const file = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Doe;John;;;",
    "FN:John Doe",
    "item1.EMAIL;type=INTERNET;type=pref:john@",
    "\texample.com",
    "item1.X-ABLABEL:_$!<Work>!$_",
    "TEL;TYPE=CELL:0171 1",
    "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:2.1",
    "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen",
    "TEL;WORK;VOICE:030 2",
    "BDAY:19700101",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:Erika Mustermann",
    "BDAY:--0412",
    "PHOTO:data:image/png;base64,iVBORw0KGgo=",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:4.0",
    "NOTE:nothing to identify",
    "END:VCARD",
  ].join("\n");
  const cards = parseVCards(file);
  assert.equal(cards.length, 3, "a card without name, address or number is left out");
  assert.equal(cards[0].emails[0].value, "john@example.com");
  assert.match(cards[0].emails[0].type, /work/);
  assert.deepEqual(cards[0].photo, { mime: "image/jpeg", base64: "/9j/4AAQ" });
  assert.equal(cards[1].lastName, "Müller");
  assert.equal(cards[1].firstName, "Jürgen");
  assert.equal(cards[1].phones[0].value, "030 2");
  assert.equal(cards[1].birthday, "1970-01-01");
  assert.equal(cards[2].firstName, "Erika");
  assert.equal(cards[2].lastName, "Mustermann");
  assert.equal(cards[2].birthday, "--04-12");
  assert.deepEqual(cards[2].photo, { mime: "image/png", base64: "iVBORw0KGgo=" });
});

test("photo URLs are never fetched and a serialized list holds every card", () => {
  const [card] = parseVCards("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:A B\r\nPHOTO:https://evil.example/p.jpg\r\nEND:VCARD\r\n");
  assert.equal(card.photo, null);
  const text = serializeVCards([sample(), sample({ uid: "x-2", firstName: "Max" })]);
  assert.equal(parseVCards(text).length, 2);
  assert.throws(() => parseVCards("x".repeat(6 * 1024 * 1024)), /too large/);
});
