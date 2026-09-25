import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { cleanHtml, htmlState, stateHtml } from "../lib/document-server";

const roundTrip = (html: string) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, htmlState(cleanHtml(html)));
    return stateHtml(doc);
  } finally {
    doc.destroy();
  }
};

test("text colours, highlight colours, superscript and subscript survive storage", () => {
  const html = roundTrip(
    '<p><span style="color: #d44c47">rot</span> <mark data-color="#e7f3f8" style="background-color: #e7f3f8">blau hinterlegt</mark> E=mc<sup>2</sup> H<sub>2</sub>O</p>',
  );
  assert.match(html, /<span style="color: ?#d44c47">rot<\/span>/);
  assert.match(html, /background-color: ?#e7f3f8/);
  assert.match(html, /<sup>2<\/sup>/);
  assert.match(html, /<sub>2<\/sub>/);
});

test("only hexadecimal colours are kept", () => {
  const html = roundTrip(
    '<p><span style="color: red">a</span><span style="color: url(javascript:alert(1))">b</span><span style="color: #33">c</span></p>',
  );
  assert.doesNotMatch(html, /style=/);
  assert.match(html, /abc/);
});
