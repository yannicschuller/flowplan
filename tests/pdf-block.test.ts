import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanHtml, htmlState, stateHtml } from "../lib/document-server";
import * as Y from "yjs";

const id = "0f5c6a1e-2b3c-4d5e-8f90-123456789abc";
const block = `<div data-pdf="/api/files/${id}" data-title="Vertrag.pdf" class="pdf-block"><a href="/api/files/${id}">Vertrag.pdf</a></div>`;

test("a PDF block survives cleaning and saving as a document", () => {
  const clean = cleanHtml(`<p>Vorher</p>${block}<p>Nachher</p>`);
  assert.match(clean, new RegExp(`data-pdf="/api/files/${id}"`));
  assert.match(clean, /data-title="Vertrag.pdf"/);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(clean));
  const html = stateHtml(doc);
  assert.match(html, new RegExp(`<div data-pdf="/api/files/${id}" data-title="Vertrag.pdf" class="pdf-block"><a href="/api/files/${id}"[^>]*>Vertrag.pdf</a></div>`));
  // Only Flowplan files: other addresses do not become PDF blocks.
  const foreign = new Y.Doc();
  Y.applyUpdate(foreign, htmlState(`<div data-pdf="https://example.com/x.pdf" data-title="x.pdf"></div>`));
  assert.doesNotMatch(stateHtml(foreign), /data-pdf="https:/);
});
