import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPrintView, printSnapshot, storePrintSnapshot } from "../lib/print-snapshots";

test("print views are found by their secret address only, one per person", () => {
  const first = storePrintSnapshot("user-a", "Ada", "<!doctype html><p>eins</p>");
  assert.match(first, /^[\w-]{32}$/);
  assert.match(printSnapshot(first)!, /<p>eins<\/p>$/);
  assert.equal(printSnapshot("x".repeat(32)), null);
  const other = storePrintSnapshot("user-b", "Ben", "<!doctype html><p>b</p>");
  const second = storePrintSnapshot("user-a", "Ada", "<!doctype html><p>zwei</p>");
  assert.equal(printSnapshot(first), null);
  assert.match(printSnapshot(second)!, /<p>zwei<\/p>$/);
  assert.match(printSnapshot(other)!, /<p>b<\/p>$/);
});

// The bar with the print button is Flowplan's own: it names who made the
// view, sits right at the start of the real body and cannot be faked or
// buried in text that only looks like a body tag.
test("the print bar names its author and cannot be moved or imitated", () => {
  const token = storePrintSnapshot(
    "user-c",
    "Cleo <x>",
    `<!doctype html><html lang="en"><head><style>/* <body data-print-bar="x"> */</style></head>` +
      `<body class="print-view" data-print-bar="guess"><button class="print-view-print">Log in</button><input name="password"><p>Inhalt</p></body></html>`,
  );
  const view = printSnapshot(token)!;
  assert.match(view, /<body class="print-view"><div class="print-view-bar"[^>]*><button type="button" class="print-view-print">Print \/ PDF<\/button><span>Print view by Cleo &lt;x&gt;\./);
  assert.equal(view.match(/print-view-print/g)!.length, 1, "only the bar's own button");
  assert.ok(!view.includes("<input") && !view.includes("Log in") && !view.includes("guess"));
  assert.ok(!/data-print-bar="[0-9a-f]/.test(view), "the mark is gone");
});

// The print view for home screen apps comes from the browser and is served
// on Flowplan's address: nothing in it may redirect, run or submit.
test("print views keep their layout but lose scripts, redirects and forms", () => {
  const view = cleanPrintView(
    `<!doctype html><html><head><meta charset="utf-8"><META content="0;url=https://evil" HTTP-EQUIV=refresh><base href="https://evil/"><style>.a>b{color:red}</style></head>` +
      `<body><button class="print-view-print" onclick="steal()">Drucken</button><img src="data:image/png;base64,AA" onerror="x()">` +
      `<a href="javascript:alert(1)">x</a><a href="https://example.com">ok</a><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>` +
      `<iframe src="https://evil"></iframe><form action="https://evil"><input></form><textarea>t</textarea><select><option>o</option></select><script src="https://evil/x.js" a=</body></html>`,
  );
  assert.ok(view.startsWith("<!doctype html>"));
  for (const gone of ["http-equiv", "HTTP-EQUIV", "<base", "onclick", "onerror", "javascript:", "<iframe", "<form", "<script", "evil", "<button", "<input", "<textarea", "<select", "<option"])
    assert.ok(!view.includes(gone), gone);
  for (const kept of ['<meta charset="utf-8"', ".a>b{color:red}", 'viewBox="0 0 1 1"', 'href="https://example.com"', "data:image/png"])
    assert.ok(view.includes(kept), kept);
});
