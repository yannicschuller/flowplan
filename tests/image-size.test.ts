import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { cleanHtml, htmlState, stateHtml } from "../lib/document-server";

test("image sizes survive storage and only numbers are kept", () => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(
      doc,
      htmlState(
        cleanHtml(
          '<p><img src="/api/files/00000000-0000-4000-8000-000000000000" alt="Plan" width="240" height="120"></p>',
        ),
      ),
    );
    const html = stateHtml(doc);
    assert.match(html, /width="240"/);
    assert.match(html, /height="120"/);
  } finally {
    doc.destroy();
  }
  assert.doesNotMatch(
    cleanHtml('<img src="/x.png" width="100" style="width: 100px; position: fixed">'),
    /position/,
  );
});
