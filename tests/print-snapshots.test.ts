// Print views for home screen apps (lib/print-snapshots.ts): stored in the
// database (large ones in the staging area) so that any instance shows them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-print-snapshots-"));
const { all, one, run } = await import("../lib/db");
const { cleanPrintView, printSnapshot, storePrintSnapshot, sweepPrintSnapshots, PRINT_SNAPSHOT_INLINE_BYTES } = await import("../lib/print-snapshots");
const { staging } = await import("../lib/staging");

for (const [uid, name] of [["user-a", "Ada"], ["user-b", "Ben"], ["user-c", "Cleo"], ["user-d", "Dora"]])
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);

test("print views are found by their secret address only, one per person", async () => {
  const first = await storePrintSnapshot("user-a", "Ada", "<!doctype html><p>eins</p>");
  assert.match(first, /^[\w-]{32}$/);
  assert.match((await printSnapshot(first))!, /<p>eins<\/p>$/);
  assert.equal(await printSnapshot("x".repeat(32)), null);
  const other = await storePrintSnapshot("user-b", "Ben", "<!doctype html><p>b</p>");
  const second = await storePrintSnapshot("user-a", "Ada", "<!doctype html><p>zwei</p>");
  assert.equal(await printSnapshot(first), null);
  assert.match((await printSnapshot(second))!, /<p>zwei<\/p>$/);
  assert.match((await printSnapshot(other))!, /<p>b<\/p>$/);
  // The token itself is never stored, only its hash.
  const rows = await all<{ token_hash: string }>("SELECT token_hash FROM print_snapshots");
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== second));
});

test("a print view expires after 15 minutes; large ones live in the staging area and go with it", async () => {
  const now = Date.now();
  const picture = `<img src="data:image/png;base64,${"A".repeat(PRINT_SNAPSHOT_INLINE_BYTES)}">`;
  const token = await storePrintSnapshot("user-d", "Dora", `<!doctype html><html><body>${picture}</body></html>`, now);
  const row = await one<{ html: string | null; bytes: number; token_hash: string }>("SELECT html,bytes,token_hash FROM print_snapshots WHERE user_id='user-d'");
  assert.equal(row?.html, null, "not in the row");
  assert.ok(Number(row?.bytes) > PRINT_SNAPSHOT_INLINE_BYTES);
  assert.ok(await staging("print").get(row!.token_hash), "in the staging area");
  assert.ok((await printSnapshot(token, now + 60_000))!.includes("A".repeat(PRINT_SNAPSHOT_INLINE_BYTES)));
  assert.equal(await printSnapshot(token, now + 15 * 60_000 + 1), null, "expired");
  await sweepPrintSnapshots(now + 15 * 60_000 + 1);
  assert.equal(await one("SELECT 1 AS ok FROM print_snapshots WHERE user_id='user-d'"), undefined);
  assert.equal(await staging("print").get(row!.token_hash), null, "its copy went too");
  // A copy left without its row (an instance stopped between the writes) goes once old.
  await staging("print").put("f".repeat(64), Buffer.from("orphan"));
  await sweepPrintSnapshots(Date.now() + 60 * 60_000, { orphans: true });
  assert.equal(await staging("print").get("f".repeat(64)), null);
});

// The bar with the print button is Flowplan's own: it names who made the
// view, sits right at the start of the real body and cannot be faked or
// buried in text that only looks like a body tag.
test("the print bar names its author and cannot be moved or imitated", async () => {
  const token = await storePrintSnapshot(
    "user-c",
    "Cleo <x>",
    `<!doctype html><html lang="en"><head><style>/* <body data-print-bar="x"> */</style></head>` +
      `<body class="print-view" data-print-bar="guess"><button class="print-view-print">Log in</button><input name="password"><p>Inhalt</p></body></html>`,
  );
  const view = (await printSnapshot(token))!;
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
