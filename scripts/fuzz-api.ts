// API fuzzing on demand, locally only (tests/helpers/fuzz.ts): many more
// payloads than the CI round of tests/fuzz-api.test.ts, in a temporary
// data folder of its own; the network is never reached.
//
//   npm run fuzz                                   seed from the clock, 20 payloads per action and role, 2000 uploads, 1000 form answers
//   npm run fuzz -- --seed 42 --per-action 100     reproducible, longer
//   npm run fuzz -- --only row. --roles editor     actions containing "row.", as the editor only
//   npm run fuzz -- --uploads 0 --forms 0          commands only
//   npm run fuzz -- --depth 20000                  also every action with a field nested 20000 levels deep
//   npm run fuzz -- --no-minimize                  report payloads as sent
//   npm run fuzz -- --trace                        every answer, one line each
//
// Prints every finding with seed, actor and payload; exits 1 if there was one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const seed = Number(option("seed", String(Date.now() % 2 ** 31)));
const perAction = Number(option("per-action", "20"));
const uploads = Number(option("uploads", "2000"));
const forms = Number(option("forms", "1000"));
const depth = Number(option("depth", "5000"));
const only = option("only", "");
const roles = option("roles", "editor,viewer,guest,outsider").split(",") as ("editor" | "viewer" | "guest" | "outsider")[];

const dir = mkdtempSync(join(tmpdir(), "flowplan-fuzz-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.APP_URL = "https://flowplan.example.test";

const fuzz = await import("../tests/helpers/fuzz");
const log = (line: string) => console.log(line);
// --trace: every answer, one line each.
const trace = flag("trace") ? (role: string, target: string, answer: { status: number; body: string }) => console.log(`trace ${role} ${target} ${answer.status} ${answer.body.slice(0, 160)}`) : undefined;
console.log(`fuzz: seed ${seed}, ${perAction} per action and role (${roles.join(", ")}), ${uploads} uploads, ${forms} form answers${only ? `, only "${only}"` : ""}`);
let found = 0;
try {
  const world = await fuzz.createWorld(resolve(import.meta.dirname, ".."));
  const commands = await fuzz.fuzzCommands(world, { seed, perAction, roles, only: only ? (a) => a.includes(only) : undefined, minimize: !flag("no-minimize"), log, trace });
  console.log(`commands: ${commands.calls} calls in ${(commands.ms / 1000).toFixed(1)} s ${JSON.stringify(commands.statuses)}, ${commands.findings.length} finding(s)`);
  if (commands.network.length) console.log(`  5xx after a refused network request (not counted): ${[...new Set(commands.network)].join(", ")}`);
  found += commands.findings.length;
  if (depth > 0) {
    const deep = await fuzz.depthSweep(world, { seed, depth, fieldsPerAction: 8, only: only ? (a) => a.includes(only) : undefined, log });
    console.log(`depth ${depth}: ${deep.calls} calls in ${(deep.ms / 1000).toFixed(1)} s ${JSON.stringify(deep.statuses)}, ${deep.findings.length} finding(s)`);
    found += deep.findings.length;
  }
  if (uploads > 0) {
    const files = await fuzz.fuzzUploads(world, { seed, count: uploads, roles, log, trace });
    console.log(`uploads: ${files.calls} calls in ${(files.ms / 1000).toFixed(1)} s ${JSON.stringify(files.statuses)}, ${files.findings.length} finding(s)`);
    found += files.findings.length;
  }
  if (forms > 0) {
    const answers = await fuzz.fuzzForms(world, { seed, count: forms, log, trace });
    console.log(`forms: ${answers.calls} calls in ${(answers.ms / 1000).toFixed(1)} s ${JSON.stringify(answers.statuses)}, ${answers.findings.length} finding(s)`);
    found += answers.findings.length;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(found ? `fuzz: ${found} finding(s) – rerun with --seed ${seed}` : "fuzz: no findings");
process.exit(found ? 1 : 0);
