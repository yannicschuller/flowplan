import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPrintView, printSnapshot, storePrintSnapshot } from "../lib/print-snapshots";

test("print views are found by their secret address only, one per person", () => {
  const first = storePrintSnapshot("user-a", "<!doctype html><p>eins</p>");
  assert.match(first, /^[\w-]{32}$/);
  assert.equal(printSnapshot(first), "<!doctype html><p>eins</p>");
  assert.equal(printSnapshot("x".repeat(32)), null);
  const other = storePrintSnapshot("user-b", "<!doctype html><p>b</p>");
  const second = storePrintSnapshot("user-a", "<!doctype html><p>zwei</p>");
  assert.equal(printSnapshot(first), null);
  assert.equal(printSnapshot(second), "<!doctype html><p>zwei</p>");
  assert.equal(printSnapshot(other), "<!doctype html><p>b</p>");
});

// The print view for home screen apps comes from the browser and is served
// on Flowplan's address: nothing in it may redirect, run or submit.
test("print views keep their layout but lose scripts, redirects and forms", () => {
  const view = cleanPrintView(
    `<!doctype html><html><head><meta charset="utf-8"><META content="0;url=https://evil" HTTP-EQUIV=refresh><base href="https://evil/"><style>.a>b{color:red}</style></head>` +
      `<body><button class="print-view-print" onclick="steal()">Drucken</button><img src="data:image/png;base64,AA" onerror="x()">` +
      `<a href="javascript:alert(1)">x</a><a href="https://example.com">ok</a><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>` +
      `<iframe src="https://evil"></iframe><form action="https://evil"><input></form><script src="https://evil/x.js" a=</body></html>`,
  );
  assert.ok(view.startsWith("<!doctype html>"));
  for (const gone of ["http-equiv", "HTTP-EQUIV", "<base", "onclick", "onerror", "javascript:", "<iframe", "<form", "<script", "evil"])
    assert.ok(!view.includes(gone), gone);
  for (const kept of ['<meta charset="utf-8"', ".a>b{color:red}", 'class="print-view-print"', 'viewBox="0 0 1 1"', 'href="https://example.com"', "data:image/png"])
    assert.ok(view.includes(kept), kept);
});
