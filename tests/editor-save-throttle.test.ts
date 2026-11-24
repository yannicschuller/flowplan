// #515: alone in a document, the editor saves at most once a second; with
// others in it, at once – and right away when someone joins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/editor.tsx", import.meta.url), "utf8");

test("alone in a document, a save waits for a pause in typing, at most 10 s (#515)", () => {
  assert.match(source, /const SAVE_SOON_MS = 80;/);
  assert.match(source, /const SAVE_ALONE_PAUSE_MS = 2000;/);
  assert.match(source, /const SAVE_ALONE_MAX_MS = 10_000;/);
  assert.match(source, /if \(audienceOthers\(liveKey\)\) \{/);
  assert.match(source, /Math\.min\(SAVE_ALONE_PAUSE_MS, firstUnsaved\.current \+ SAVE_ALONE_MAX_MS - now\)/);
  // The regular check does not send a waiting save early.
  assert.match(source, /if \(!saveTimer\.current\) void sync\(\);/);
});

test("a waiting save goes out when someone else joins (#515)", () => {
  assert.match(source, /window\.addEventListener\(AUDIENCE_EVENT, joined\)/);
  assert.match(source, /if \(key !== liveKey \|\| !open \|\| !saveTimer\.current\) return;/);
});

test("a change beyond typing sends what was typed first, in a save of its own (#515)", () => {
  assert.match(source, /editor\.on\("beforeTransaction", before\)/);
  assert.match(source, /transaction\.steps\.every\(\(step\) => step instanceof ReplaceStep\)/);
});
