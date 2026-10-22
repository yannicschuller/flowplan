import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as plan from "../lib/offline-plan";

const [a, b, c, d] = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const [r1, r2, r3] = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
];
const [f1, f2, f3] = [
  "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
  "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2",
  "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3",
];
const keys = [
  "/",
  `/api/bootstrap?workspace=${d}`,
  `/api/pages/${a}`,
  `/api/pages/${b}`,
  `/api/pages/${b}/preview`,
  `/api/pages/${c}`,
  `/api/pages/${c}/rows/${r1}`,
  `/api/pages/${c}/rows/${r2}`,
  `/api/pages/${c}/rows/${r2}/backlinks`,
  `/api/files/${f1}`,
  `/api/files/${f2}?download=1`,
];

const pageInput = { keys, readable: [a, c, d], changed: [c], full: false };
const recordInput = {
  keys,
  rows: { [a]: [], [c]: [r1, r3] },
  changedRows: { [c]: [r1] },
  full: false,
  includeRecords: true,
};
const fileInput = { keys, referenced: [f1, f3], includeRecords: true };

test("pages: new and changed are fetched, gone ones dropped with everything below", () => {
  const result = plan.planPages(pageInput);
  assert.deepEqual(result.fetch, [`/api/pages/${c}`, `/api/pages/${d}`]);
  assert.deepEqual(result.drop, [`/api/pages/${b}`, `/api/pages/${b}/preview`]);
  // Full: every readable page again.
  assert.deepEqual(plan.planPages({ ...pageInput, full: true }).fetch, [a, c, d].map(plan.pageUrl));
});

test("records: changed ones again, hidden or deleted dropped, others added on request", () => {
  const result = plan.planRecords(recordInput);
  assert.deepEqual(result.refresh, [`/api/pages/${c}/rows/${r1}`]);
  assert.deepEqual(result.add, [`/api/pages/${c}/rows/${r3}`]);
  assert.deepEqual(result.drop, [`/api/pages/${c}/rows/${r2}`, `/api/pages/${c}/rows/${r2}/backlinks`]);
  assert.deepEqual(plan.planRecords({ ...recordInput, includeRecords: false }).add, []);
});

test("files: unreferenced dropped, referenced added on request", () => {
  assert.deepEqual(plan.planFiles(fileInput), { add: [`/api/files/${f3}`], drop: [`/api/files/${f2}?download=1`] });
  assert.deepEqual(plan.planFiles({ ...fileInput, includeRecords: false }).add, []);
  assert.deepEqual(plan.fileRefs(`{"html":"<img src=\\"/api/files/${f1}\\">","cover":"/api/files/${f1}","x":"/api/files/${f2.toUpperCase()}"}`), [f1, f2]);
  assert.deepEqual(plan.pageRows({ rows: [{ id: r1 }, { id: r2 }] }), [r1, r2]);
  assert.deepEqual(plan.pageRows({ html: "" }), []);
});

test("the service worker plans the same way", () => {
  const context: Record<string, unknown> = {
    self: { addEventListener() {}, location: { origin: "https://example.test" } },
  };
  runInNewContext(`${readFileSync("public/sw.js", "utf8")}\nself.offlinePlan = offlinePlan;`, context);
  const worker = (context.self as { offlinePlan: typeof plan }).offlinePlan;
  const same = (x: unknown, y: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(x)), JSON.parse(JSON.stringify(y)));
  same(worker.planPages(pageInput), plan.planPages(pageInput));
  same(worker.planPages({ ...pageInput, full: true }), plan.planPages({ ...pageInput, full: true }));
  same(worker.planRecords(recordInput), plan.planRecords(recordInput));
  same(worker.planFiles(fileInput), plan.planFiles(fileInput));
  same(worker.fileRefs(`/api/files/${f1} /api/files/${f1}`), plan.fileRefs(`/api/files/${f1} /api/files/${f1}`));
});
