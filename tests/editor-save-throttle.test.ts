// #515: alone in a document, the editor saves at most once a second; with
// others in it, at once – and right away when someone joins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/editor.tsx", import.meta.url), "utf8");

test("saves are throttled when nobody else has the document open (#515)", () => {
  assert.match(source, /const SAVE_SOON_MS = 80;/);
  assert.match(source, /const SAVE_ALONE_MS = 1000;/);
  assert.match(source, /audienceOthers\(liveKey\) \? SAVE_SOON_MS : SAVE_ALONE_MS/);
});

test("a waiting save goes out when someone else joins (#515)", () => {
  assert.match(source, /window\.addEventListener\(AUDIENCE_EVENT, joined\)/);
  assert.match(source, /if \(key !== liveKey \|\| !open \|\| !saveTimer\.current\) return;/);
});

test("a change beyond typing sends what was typed first, in a save of its own (#515)", () => {
  assert.match(source, /editor\.on\("beforeTransaction", before\)/);
  assert.match(source, /transaction\.steps\.every\(\(step\) => step instanceof ReplaceStep\)/);
});
