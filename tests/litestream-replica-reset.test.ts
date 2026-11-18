// scripts/litestream-replica-reset.mjs, run by docker/entrypoint.sh before
// `litestream replicate` when the marker says "remote": deletes every object
// under <S3_PREFIX>/db/ and nothing else, page by page, and refuses
// prefixes that are not plainly <prefix>/db/. Against the in-process S3
// stand-in (tests/helpers/fake-s3.ts), never the network.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startFakeS3 } from "./helpers/fake-s3";

const s3 = await startFakeS3();
after(() => s3.close());
const { replicaPrefixFrom, resetReplica } = (await import("../scripts/litestream-replica-reset.mjs")) as {
  replicaPrefixFrom: (env: Record<string, string | undefined>) => { prefix?: string; error?: string };
  resetReplica: (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<{ deleted: number; prefix: string }>;
};

const env = (extra: Record<string, string | undefined> = {}) => ({
  S3_BUCKET: "bucket",
  S3_ENDPOINT: s3.endpoint,
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "test-key-id",
  S3_SECRET_ACCESS_KEY: "test-secret",
  S3_PREFIX: "flowplan",
  ...extra,
});
// The command as the entrypoint runs it: exit code and output.
function runScript(vars: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn(process.execPath, ["scripts/litestream-replica-reset.mjs"], { env: { ...vars, PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.on("exit", (code) => resolve({ code, text }));
  });
}
const put = (key: string) => s3.objects.set(`/bucket/${key}`, { body: Buffer.from("x"), at: Date.now() });
const keys = () => [...s3.objects.keys()].map((k) => k.slice("/bucket/".length)).sort();
const others = ["flowplan/uploads/abc", "flowplan/backups/flowplan-2026-11-18.sqlite.enc", "flowplan/.deleted/uploads/x", "flowplan/dbx/0000/a.ltx", "flowplan/db", "other/db/0000/a.ltx", "db/0000/top.ltx"];

beforeEach(() => {
  s3.objects.clear();
  s3.failing.clear();
  s3.noBatchDelete.value = false;
  for (const key of others) put(key);
});

test("deletes only <prefix>/db/ – uploads, backups, other prefixes and look-alikes stay", async () => {
  for (const key of ["flowplan/db/0000/0000000000000001-0000000000000001.ltx", "flowplan/db/0001/0000000000000001-0000000000000002.ltx", "flowplan/db/0009/0000000000000001-0000000000000009.ltx", "flowplan/db/a&b<c>.ltx"]) put(key);
  const lines: string[] = [];
  const result = await resetReplica(env(), (line) => lines.push(line));
  assert.equal(result.deleted, 4);
  assert.equal(result.prefix, "flowplan/db/");
  assert.deepEqual(keys(), [...others].sort());
  assert.deepEqual(lines, ["Litestream replica reset: deleted 4 objects under flowplan/db/ in the bucket."]);
  assert.ok(!lines.join("").includes("test-secret") && !lines.join("").includes("test-key-id"));
  // Batch delete, signed, with Content-MD5 (the stand-in insists).
  assert.ok(s3.requests.some((r) => r === "POST /bucket?delete"));
});

test("nothing to delete: done, no delete request", async () => {
  const lines: string[] = [];
  assert.equal((await resetReplica(env(), (l) => lines.push(l))).deleted, 0);
  assert.match(lines[0], /nothing under flowplan\/db\//);
  assert.ok(!s3.requests.slice(-1)[0].startsWith("POST"));
  assert.deepEqual(keys(), [...others].sort());
});

test("paginates: 2500 objects are listed over three pages and deleted in batches of 1000", async () => {
  for (let i = 0; i < 2500; i++) put(`flowplan/db/0000/${String(i).padStart(16, "0")}-${String(i).padStart(16, "0")}.ltx`);
  const start = s3.requests.length;
  const result = await resetReplica(env(), () => {});
  assert.equal(result.deleted, 2500);
  const sent = s3.requests.slice(start);
  assert.equal(sent.filter((r) => r.startsWith("GET /bucket?list-type=2")).length, 3);
  assert.equal(sent.filter((r) => r.includes("continuation-token=")).length, 2);
  assert.equal(sent.filter((r) => r === "POST /bucket?delete").length, 3);
  assert.deepEqual(keys(), [...others].sort());
});

test("a provider without DeleteObjects: one by one", async () => {
  s3.noBatchDelete.value = true;
  for (let i = 0; i < 3; i++) put(`flowplan/db/0000/${i}.ltx`);
  assert.equal((await resetReplica(env(), () => {})).deleted, 3);
  assert.equal(s3.requests.filter((r) => /^DELETE \/bucket\/flowplan\/db\/0000\/\d\.ltx$/.test(r)).length, 3);
  assert.deepEqual(keys(), [...others].sort());
});

test("without a prefix: db/ at the top of the bucket", async () => {
  assert.equal((await resetReplica(env({ S3_PREFIX: "" }), () => {})).deleted, 1);
  assert.deepEqual(keys(), others.filter((k) => k !== "db/0000/top.ltx").sort());
  // Unset means "flowplan", as in the app and the entrypoint.
  put("flowplan/db/0000/x.ltx");
  assert.equal((await resetReplica(env({ S3_PREFIX: undefined }), () => {})).prefix, "flowplan/db/");
  assert.equal(s3.objects.has("/bucket/flowplan/db/0000/x.ltx"), false);
});

test("odd prefixes are refused, slashes around it are trimmed like the app does", () => {
  assert.deepEqual(replicaPrefixFrom({ S3_PREFIX: "flowplan" }), { prefix: "flowplan/db/" });
  assert.deepEqual(replicaPrefixFrom({ S3_PREFIX: "/team/flowplan/" }), { prefix: "team/flowplan/db/" });
  assert.deepEqual(replicaPrefixFrom({ S3_PREFIX: "" }), { prefix: "db/" });
  for (const bad of ["a//b", "../flowplan", "flowplan/..", "a/./b", "fl\nowplan", "a\\b", "x\u0000"]) assert.ok(replicaPrefixFrom({ S3_PREFIX: bad }).error, bad);
});

test("a refused prefix or no bucket deletes nothing (exit code 2 from the command)", async () => {
  put("flowplan/db/0000/x.ltx");
  await assert.rejects(resetReplica(env({ S3_PREFIX: "../flowplan" }), () => {}), (e: Error & { code?: number }) => e.code === 2);
  await assert.rejects(resetReplica(env({ S3_BUCKET: "" }), () => {}), (e: Error & { code?: number }) => e.code === 2);
  assert.ok(s3.objects.has("/bucket/flowplan/db/0000/x.ltx"));
  assert.equal((await runScript(env({ S3_PREFIX: "a//b" }))).code, 2);
  assert.ok(s3.objects.has("/bucket/flowplan/db/0000/x.ltx"));
});

test("the bucket fails: exit code 1, nothing claimed", async () => {
  put("flowplan/db/0000/x.ltx");
  s3.failing.add("/bucket");
  await assert.rejects(resetReplica(env(), () => {}), /HTTP 500/);
  const out = await runScript(env());
  assert.equal(out.code, 1);
  assert.match(out.text, /Litestream replica reset failed: Listing the replica: HTTP 500/);
  assert.ok(!out.text.includes("test-secret"));
  s3.failing.clear();
  assert.ok(s3.objects.has("/bucket/flowplan/db/0000/x.ltx"));
});

test("the command deletes and says how many", async () => {
  put("flowplan/db/0000/x.ltx");
  put("flowplan/db/0009/y.ltx");
  const out = await runScript(env());
  assert.equal(out.code, 0, out.text);
  assert.match(out.text, /deleted 2 objects under flowplan\/db\//);
  assert.deepEqual(keys(), [...others].sort());
});
