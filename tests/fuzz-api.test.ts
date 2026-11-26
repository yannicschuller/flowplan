// API fuzzing, a short seeded round (tests/helpers/fuzz.ts): every
// /api/command action gets random and malformed payloads as an editor, a
// viewer, a guest and an outsider of a seeded workspace; uploads (also as
// pages, #569), the phone's capture save and a public form get malformed
// JSON and multipart bodies.
// Every answer must be a deliberate one (2xx/4xx), no write the role
// forbids, nothing left behind by a refused upload. Locally only, never the
// network. The long round on demand: `npm run fuzz` (scripts/fuzz-api.ts),
// e.g. `npm run fuzz -- --seed 42 --per-action 50`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-fuzz-api-"));
process.env.APP_URL = "https://flowplan.example.test";
const fuzz = await import("./helpers/fuzz");

// Fixed, so CI is reproducible; FUZZ_SEED tries another one.
const SEED = Number(process.env.FUZZ_SEED || 20261126);
const world = await fuzz.createWorld(join(import.meta.dirname, ".."));
const failures = (seed: number, findings: { kind: string }[]) =>
  `seed ${seed} (FUZZ_SEED=${seed} to rerun), ${findings.length} finding(s):\n\n${(findings as Parameters<typeof fuzz.formatFinding>[0][]).map(fuzz.formatFinding).join("\n\n")}`;

test("the actions are read from lib/api.ts, with the fields they take", () => {
  const specs = fuzz.commandActions(join(import.meta.dirname, ".."));
  const names = new Set(specs.map((s) => s.action));
  assert.ok(specs.length > 300, `${specs.length} actions`);
  for (const action of ["page.create", "row.update", "database.update", "member.role", "admin.user", "e2ee.append", "notebook.sheet.add"]) assert.ok(names.has(action), action);
  assert.deepEqual(specs.find((s) => s.action === "page.create")?.fields.includes("spaceId"), true);
  // Handed on whole (manageWorkspace(user, b)): the called function's fields.
  assert.deepEqual(specs.find((s) => s.action === "workspace.leave")?.fields.includes("workspaceId"), true);
});

test("the seeded generator is deterministic", () => {
  const a = new fuzz.Gen(new fuzz.Rng(7), () => ({ own: ["a"], other: ["b"], all: ["a", "b"] }));
  const b = new fuzz.Gen(new fuzz.Rng(7), () => ({ own: ["a"], other: ["b"], all: ["a", "b"] }));
  const draws = (g: InstanceType<typeof fuzz.Gen>) => Array.from({ length: 50 }, () => g.any(3));
  assert.deepEqual(draws(a), draws(b));
  // What it makes is JSON a request body can carry (1e400 is Infinity).
  for (const text of draws(new fuzz.Gen(new fuzz.Rng(8), () => ({ own: ["a"], other: ["b"], all: ["a", "b"] })))) JSON.parse(text);
  assert.equal(JSON.parse(fuzz.objectText([["__proto__", "1"]])).__proto__, 1);
});

test("/api/command: every action, every role – only deliberate answers", { timeout: 120_000 }, async () => {
  const result = await fuzz.fuzzCommands(world, { seed: SEED, perAction: 1 });
  console.log(`fuzz commands: seed ${SEED}, ${result.calls} calls in ${(result.ms / 1000).toFixed(1)} s ${JSON.stringify(result.statuses)}`);
  if (result.network.length) console.log(`  refused network requests: ${[...new Set(result.network)].join(", ")}`);
  assert.ok(result.calls > 1000, `${result.calls} calls`);
  assert.ok((result.statuses["2xx"] || 0) > 50, "some payloads get through to the work behind the schemas");
  assert.equal(result.findings.length, 0, failures(SEED, result.findings));
});

test("/api/command: values nested thousands of levels deep overflow no stack", { timeout: 120_000 }, async () => {
  // JSON.parse reads them from a small body; JSON.stringify and recursive
  // walkers of the code behind z.unknown() fields would not.
  const result = await fuzz.depthSweep(world, { seed: SEED, depth: 5000, fieldsPerAction: 2 });
  console.log(`fuzz depth: seed ${SEED}, ${result.calls} calls in ${(result.ms / 1000).toFixed(1)} s ${JSON.stringify(result.statuses)}`);
  assert.equal(result.findings.length, 0, failures(SEED, result.findings));
});

test("uploads and the phone's capture save: only deliberate answers, nothing left behind", { timeout: 120_000 }, async () => {
  const result = await fuzz.fuzzUploads(world, { seed: SEED, count: 600 });
  console.log(`fuzz uploads: seed ${SEED}, ${result.calls} calls in ${(result.ms / 1000).toFixed(1)} s ${JSON.stringify(result.statuses)}`);
  assert.ok((result.statuses["2xx"] || 0) > 5, "some uploads are stored");
  assert.equal(result.findings.length, 0, failures(SEED, result.findings));
});

test("a public form: only deliberate answers, a record only for an accepted one", { timeout: 60_000 }, async () => {
  const result = await fuzz.fuzzForms(world, { seed: SEED, count: 300 });
  console.log(`fuzz forms: seed ${SEED}, ${result.calls} calls in ${(result.ms / 1000).toFixed(1)} s ${JSON.stringify(result.statuses)}`);
  assert.equal(result.findings.length, 0, failures(SEED, result.findings));
});

test("the network stays out of reach", async () => {
  await assert.rejects(fetch("https://example.com/"), /network blocked/);
});
