import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applyDocumentUpdate, htmlState, stateHtml } from "../lib/document-server";

// The blank page a new page starts with (htmlState("")), by a fixed client
// id: the lowest and the highest put the empty paragraph before and after
// content from any other client when Yjs merges both.
function blank(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  doc.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
  return doc;
}
const CLIENTS = [1, 2 ** 32 - 1];

test("content written from scratch replaces a blank page, without an empty line before or after it", () => {
  for (const client of CLIENTS) {
    const stored = blank(client);
    applyDocumentUpdate(stored, htmlState("<p>Oben</p><p>Unten</p>"));
    assert.equal(stateHtml(stored), "<p>Oben</p><p>Unten</p>");
    // The old blank paragraph coming back (an earlier copy) stays deleted.
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(blank(client)));
    assert.equal(stateHtml(stored), "<p>Oben</p><p>Unten</p>");
  }
  // Plain Yjs keeps both: this is what applyDocumentUpdate prevents.
  const merged = blank(2 ** 32 - 1);
  Y.applyUpdate(merged, htmlState("<p>Oben</p>"));
  assert.equal(stateHtml(merged), "<p>Oben</p><p></p>");
});

// D2 (tests/properties-yjs.test.ts): the content written from scratch
// reaches the server first and deletes the blank paragraph; the text an
// editor typed into it arrives afterwards and gets it back, where the
// paragraph stood.
test("text typed into a blank page that content from scratch replaced is kept", () => {
  for (const client of CLIENTS) {
    const stored = blank(client);
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(stored));
    const typed: Uint8Array[] = [];
    editor.on("update", (u: Uint8Array) => typed.push(u));
    (editor.getXmlFragment("default").get(0) as Y.XmlElement).insert(0, [new Y.XmlText("Getippt")]);
    const scratch = htmlState("<p>Neu</p>");
    // What the server notes of the replacement is nobody's writing ("who
    // wrote what" gets the update's sessions only).
    const written = Y.decodeStateVector(applyDocumentUpdate(stored, scratch));
    assert.equal(written.get(client), 1);
    assert.ok(Y.decodeStateVector(Y.encodeStateVector(stored)).get(client)! > 1);
    assert.equal(stateHtml(stored), "<p>Neu</p>");
    for (const u of typed) applyDocumentUpdate(stored, u);
    const html = stateHtml(stored);
    assert.ok(html === "<p>Neu</p><p>Getippt</p>" || html === "<p>Getippt</p><p>Neu</p>", html);
    // Delivered again (and the whole state of the editor): no second copy.
    for (const u of [...typed, Y.encodeStateAsUpdate(editor)]) applyDocumentUpdate(stored, u);
    assert.equal(stateHtml(stored), html);
    // Stored and loaded again, the next copy of the server keeps it.
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(stored));
    applyDocumentUpdate(reloaded, typed[0]);
    assert.equal(stateHtml(reloaded), html);
  }
});

test("an update from scratch without blocks keeps the blank paragraph", () => {
  const stored = blank(1);
  const other = new Y.Doc();
  other.getMap("other").set("a", 1);
  applyDocumentUpdate(stored, Y.encodeStateAsUpdate(other));
  assert.equal(stateHtml(stored), "<p></p>");
  assert.equal(stored.getXmlFragment("default").length, 1);
});

test("edits of an editor that loaded the blank page merge as usual", () => {
  for (const client of CLIENTS) {
    const stored = blank(client);
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(stored));
    const updates: Uint8Array[] = [];
    editor.on("update", (u: Uint8Array) => updates.push(u));
    const fragment = editor.getXmlFragment("default");
    // An empty first line kept, a paragraph below it.
    const below = new Y.XmlElement("paragraph");
    fragment.insert(1, [below]);
    below.insert(0, [new Y.XmlText("Zweite")]);
    for (const u of updates) applyDocumentUpdate(stored, u);
    assert.equal(stateHtml(stored), "<p></p><p>Zweite</p>");
    // Text typed into the blank paragraph itself (an incremental update).
    updates.length = 0;
    (fragment.get(0) as Y.XmlElement).insert(0, [new Y.XmlText("Erste")]);
    const other = blank(client);
    for (const u of [Y.encodeStateAsUpdate(stored), ...updates]) applyDocumentUpdate(other, u);
    assert.equal(stateHtml(other), "<p>Erste</p><p>Zweite</p>");
  }
});

test("a page with content merges independent updates unchanged", () => {
  const stored = new Y.Doc();
  Y.applyUpdate(stored, htmlState("<p>Alt</p>"));
  applyDocumentUpdate(stored, htmlState("<p>Neu</p>"));
  assert.match(stateHtml(stored), /<p>Alt<\/p>/);
  assert.match(stateHtml(stored), /<p>Neu<\/p>/);
});

test("an empty update leaves the blank page as it is", () => {
  const stored = blank(1);
  const before = Y.encodeStateAsUpdate(stored);
  applyDocumentUpdate(stored, Y.encodeStateAsUpdate(new Y.Doc()));
  assert.deepEqual(Y.encodeStateAsUpdate(stored), before);
});
