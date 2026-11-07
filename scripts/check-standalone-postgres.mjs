// The standalone build on PostgreSQL: starts .next/standalone/server.js
// against a fresh schema (created from lib/db-driver/postgres-schema.json)
// and checks that the bundle works on the asynchronous pool (pg) alone –
// health, the first sign-up, bootstrap – with no trace of the blocking
// bridge of phase 1 (#127) in the output, then drops the schema.
//
//   npm run build && DATABASE_URL=postgres://… node scripts/check-standalone-postgres.mjs
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ensurePostgresSchema, quoteIdent } from "../lib/db-driver/pg-ddl.mjs";

const url = process.env.DATABASE_URL;
if (!/^postgres(ql)?:\/\//.test(url || "")) {
  console.error("DATABASE_URL=postgres://… is needed.");
  process.exit(2);
}
const root = process.cwd();
if (!existsSync(join(root, ".next/standalone/server.js"))) {
  console.error("No standalone build: run `npm run build` first.");
  process.exit(2);
}
const schemaName = `flowplan_standalone_${process.pid}`;
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schemaName}` });
await client.connect();
await client.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);
const numbered = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const schema = JSON.parse(readFileSync(join(root, "lib/db-driver/postgres-schema.json"), "utf8"));
await ensurePostgresSchema(
  {
    exec: (sql) => client.query(sql).then(() => {}),
    all: (sql, ...p) => client.query(numbered(sql), p).then((r) => r.rows),
    run: (sql, ...p) => client.query(numbered(sql), p),
    columns: async (t) => (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [t])).rows.map((r) => r.column_name),
  },
  schema,
);

const work = mkdtempSync(join(tmpdir(), "flowplan-standalone-pg-"));
const app = join(work, "app");
cpSync(join(root, ".next/standalone"), app, { recursive: true });
cpSync(join(root, ".next/static"), join(app, ".next/static"), { recursive: true });
cpSync(join(root, "public"), join(app, "public"), { recursive: true });
const port = 3700 + Math.floor(Math.random() * 200);
const origin = `http://127.0.0.1:${port}`;
const metricsToken = "standalone-check-token-0123456789";
const server = spawn(process.execPath, ["server.js"], {
  cwd: app,
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    APP_URL: origin,
    FLOWPLAN_DATA_DIR: join(work, "data"),
    FLOWPLAN_PG_SCHEMA: schemaName,
    FLOWPLAN_METRICS_TOKEN: metricsToken,
    FLOWPLAN_LOCAL_LOGIN: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (c) => (output += c));
server.stderr.on("data", (c) => (output += c));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` – ${detail}`}`);
  if (!ok) failures++;
};
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`${origin}/api/health`)).status < 600;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("the server starts", up, output.slice(-2000));
  const health = await (await fetch(`${origin}/api/health`, { headers: { authorization: `Bearer ${metricsToken}` } })).json();
  check("health", health.status === "ok", JSON.stringify(health));
  // Sign-up: the first account, through the pool.
  const register = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "Ada", email: "ada@example.test", password: "a long passphrase 4 checks" }),
  });
  check("the first account signs up", register.ok, `${register.status} ${await register.clone().text()}`);
  const users = (await client.query("SELECT count(*)::int n FROM users")).rows[0].n;
  check("the account is in Postgres", users === 1, String(users));
  const cookie = register.headers.get("set-cookie")?.split(";")[0] || "";
  const boot = await fetch(`${origin}/api/bootstrap`, { headers: { cookie } });
  check("bootstrap for the new account", boot.ok, String(boot.status));
} finally {
  server.kill();
  await client.query(`DROP SCHEMA ${quoteIdent(schemaName)} CASCADE`);
  await client.end();
  rmSync(work, { recursive: true, force: true });
}
// The blocking bridge is gone: neither its worker in the bundle nor
// SQLite-only SQL at runtime.
for (const file of ["lib/db-driver/pg-sync-worker.mjs", "lib/db-driver/pg-sync.ts"])
  check(`no ${file} in the standalone output`, !existsSync(join(root, ".next/standalone", file)));
if (/SQLite-only SQL|Postgres bridge|Cannot find module|pg-sync|Atomics\.wait/.test(output)) {
  console.log(output.slice(-3000));
  failures++;
}
console.log(failures ? `${failures} failed` : "standalone build on Postgres: ok");
process.exit(failures ? 1 : 0);
