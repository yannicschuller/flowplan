// Backups of a PostgreSQL instance with pg_dump (custom format), restored
// with pg_restore (docs/architecture/database.md, §3 "Backups"). The
// scheduled backups and "Back up now" use them on PostgreSQL
// (lib/backup-copy.ts): flowplan-….dump[.enc], encrypted, kept and uploaded
// like the SQLite copies. The portable SQLite file (lib/db-snapshot.ts)
// stays the format of the instance backup (ZIP) and the instance move –
// it restores on either database.
//
// What a dump holds: the instance's schema (FLOWPLAN_PG_SCHEMA), without
// what is rebuilt from the data – the search index and pgvector's table
// and trigger (lib/search-store.ts, lib/ai/vector-store.ts). So a dump
// restores on a server without pg_trgm or pgvector, and it is smaller.
// Extensions live outside the schema (lib/pg-extensions.ts).
//
// The client tools must be at least the server's major version (pg_dump
// refuses newer servers): FLOWPLAN_PG_BIN names their folder; otherwise
// PATH and the usual Debian/Ubuntu folders (/usr/lib/postgresql/<n>/bin),
// the newest that fits. The Docker image brings them (Dockerfile).
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import { postgresSchema, postgresUrl } from "./db-driver/context";
import { quoteIdent } from "./db-driver/pg-ddl.mjs";
import { VECTOR_TABLE, VECTOR_TRIGGER } from "./ai/vector-store";

// The first bytes of a custom-format archive.
export const PGDUMP_MAGIC = Buffer.from("PGDMP");
export function isPgDump(path: string) {
  const buffer = Buffer.alloc(5);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, buffer, 0, 5, 0) === 5 && buffer.equals(PGDUMP_MAGIC);
  } finally {
    closeSync(fd);
  }
}
// Derived tables a dump leaves out.
const DERIVED_TABLES = ["search_index", VECTOR_TABLE];

// ---- The tools ----

type Tool = "pg_dump" | "pg_restore" | "psql";
const major = (versionText: string) => Number(/\(PostgreSQL\)\s+(\d+)/.exec(versionText)?.[1] || /\s(\d+)(?:\.\d+)?/.exec(versionText)?.[1] || 0);
function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdout?: (chunk: Buffer) => void } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c: Buffer) => (options.stdout ? options.stdout(c) : (stdout += c.toString("utf8"))));
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-20_000)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
async function versionOf(path: string) {
  try {
    const { code, stdout } = await run(path, ["--version"]);
    return code === 0 ? major(stdout) : 0;
  } catch {
    return 0;
  }
}
// Every pg_dump/pg_restore found, newest first.
function candidates(tool: Tool) {
  const dirs = [
    ...(process.env.FLOWPLAN_PG_BIN ? [process.env.FLOWPLAN_PG_BIN] : []),
    ...(process.env.PATH || "").split(delimiter).filter(Boolean),
  ];
  for (const base of ["/usr/lib/postgresql", "/usr/local/pgsql"])
    if (existsSync(base))
      for (const v of readdirSync(base).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a))) dirs.push(join(base, v, "bin"));
  return [...new Set(dirs.map((d) => resolve(d, tool)))].filter((p) => existsSync(p));
}
const found = new Map<string, { path: string; version: number } | null>();
// The tool for a server of this major version, or null.
export async function pgTool(tool: Tool, serverMajor: number) {
  const key = `${tool}:${serverMajor}`;
  if (found.has(key)) return found.get(key)!;
  let best: { path: string; version: number } | null = null;
  const own = process.env.FLOWPLAN_PG_BIN ? resolve(process.env.FLOWPLAN_PG_BIN, tool) : null;
  for (const path of candidates(tool)) {
    const version = await versionOf(path);
    if (version < serverMajor) continue;
    // FLOWPLAN_PG_BIN when it fits; else the newest.
    if (path === own) {
      best = { path, version };
      break;
    }
    if (!best || version > best.version) best = { path, version };
  }
  found.set(key, best);
  return best;
}

// ---- Connection ----

// libpq's own parameters of DATABASE_URL (node-postgres knows others, which
// libpq would refuse); the password goes through the environment, never on
// the command line.
const LIBPQ = new Set(["sslmode", "sslrootcert", "sslcert", "sslkey", "sslcrl", "application_name", "connect_timeout", "target_session_attrs", "gssencmode", "channel_binding", "host", "port"]);
export function libpqConnection(url = postgresUrl()!) {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = "";
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (LIBPQ.has(k)) params.set(k, v);
    else if (k === "ssl" && /^(1|true|require)$/i.test(v) && !u.searchParams.has("sslmode")) params.set("sslmode", "require");
  }
  u.search = params.toString();
  return { dbname: u.toString(), env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}), PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || "15" } };
}
async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgresUrl()!, options: `-c search_path=${postgresSchema()}` });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
async function serverMajor() {
  return await withClient(async (c) => Math.floor(Number((await c.query("SHOW server_version_num")).rows[0].server_version_num) / 10000));
}
export async function requireTool(tool: Tool) {
  const server = await serverMajor();
  const found = await pgTool(tool, server);
  if (!found)
    throw new Error(
      `${tool} for PostgreSQL ${server} or newer is missing (install the PostgreSQL client tools, or set FLOWPLAN_PG_BIN to their folder).`,
    );
  return found.path;
}
// Whether pg_dump backups can be made here (the scheduled backup falls back
// to the portable SQLite copy otherwise).
export async function pgDumpAvailable() {
  try {
    await requireTool("pg_dump");
    return true;
  } catch {
    return false;
  }
}

// ---- Dump ----

// A consistent copy of the instance's schema (pg_dump runs in one
// REPEATABLE READ transaction of its own).
export async function dumpDatabase(path: string) {
  const tool = await requireTool("pg_dump");
  const schema = postgresSchema();
  const { dbname, env } = libpqConnection();
  const { code, stderr } = await run(
    tool,
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--schema=${quoteIdent(schema)}`,
      ...DERIVED_TABLES.map((t) => `--exclude-table=${quoteIdent(schema)}.${quoteIdent(t)}`),
      `--file=${path}`,
      `--dbname=${dbname}`,
    ],
    { env },
  );
  if (code !== 0) {
    rmSync(path, { force: true });
    throw new Error(`pg_dump: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${code}`}`);
  }
}

// ---- Reading a dump ----

type TocEntry = { line: string; type: string; schema: string; name: string };
async function toc(path: string): Promise<TocEntry[]> {
  const tool = await requireTool("pg_restore");
  const { code, stdout, stderr } = await run(tool, ["--list", path]);
  if (code !== 0) throw new Error(`pg_restore: ${stderr.trim().slice(0, 300) || "not a pg_dump archive"}`);
  return stdout
    .split("\n")
    .filter((l) => /^\d+;/.test(l))
    .map((line) => {
      // "1234; 1259 16390 TABLE public users owner" – the type can be two
      // words ("TABLE DATA", "SEQUENCE SET", "FK CONSTRAINT").
      const m = /^\d+;\s+\d+\s+\d+\s+(TABLE DATA|SEQUENCE SET|SEQUENCE OWNED BY|FK CONSTRAINT|DEFAULT ACL|[A-Z]+)\s+(\S+)\s+(\S+)/.exec(line);
      return { line, type: m?.[1] ?? "", schema: m?.[2] ?? "", name: m?.[3] ?? "" };
    });
}
// The COPY data of some tables, row by row (pg_restore writes them as SQL).
async function copyRows(path: string, schema: string, tables: string[], onRow: (table: string, columns: string[], fields: (string | null)[]) => void) {
  const tool = await requireTool("pg_restore");
  const args = ["--data-only", `--schema=${schema}`, ...tables.flatMap((t) => ["--table", t]), "--file=-", path];
  let current: { table: string; columns: string[] } | null = null;
  let buffer = "";
  const line = (text: string) => {
    if (current) {
      if (text === "\\.") current = null;
      else onRow(current.table, current.columns, text.split("\t").map(unescapeCopy));
      return;
    }
    const m = /^COPY\s+(?:"?[^".\s]+"?\.)?"?([^"\s(]+)"?\s*\(([^)]*)\)\s+FROM stdin;$/.exec(text);
    if (m) current = { table: m[1], columns: m[2].split(",").map((c) => c.trim().replace(/^"|"$/g, "")) };
  };
  const { code, stderr } = await run(tool, args, {
    stdout: (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    },
  });
  if (buffer) line(buffer);
  if (code !== 0) throw new Error(`pg_restore: ${stderr.trim().slice(0, 300)}`);
}
function unescapeCopy(field: string): string | null {
  if (field === "\\N") return null;
  return field.replace(/\\(.)/g, (_m, c: string) => ({ t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\" })[c] ?? c);
}

export type DumpSummary = { schema: string; version: number; users: number; workspaces: number; pages: number; fileIds: string[] };
// What a setup restore shows and checks before it stages a dump: its
// schema, the Flowplan schema version it was made with, a few counts and
// the files it refers to.
export async function dumpSummary(path: string): Promise<DumpSummary> {
  const entries = await toc(path);
  const schemas = new Set(entries.filter((e) => e.type === "TABLE").map((e) => e.schema));
  if (schemas.size !== 1 || !entries.some((e) => e.type === "TABLE" && e.name === "flowplan_meta")) throw new Error("not a Flowplan database dump");
  const schema = [...schemas][0];
  const summary: DumpSummary = { schema, version: 0, users: 0, workspaces: 0, pages: 0, fileIds: [] };
  await copyRows(path, schema, ["flowplan_meta", "users", "workspaces", "pages", "files"], (table, columns, fields) => {
    if (table === "flowplan_meta") {
      if (/^sqlite_schema$/.test(fields[columns.indexOf("key")] ?? "")) summary.version = Number(fields[columns.indexOf("value")]) || 0;
    } else if (table === "files") {
      const id = fields[columns.indexOf("id")];
      if (id) summary.fileIds.push(id);
    } else if (table === "users" || table === "workspaces" || table === "pages") summary[table]++;
  });
  return summary;
}

// ---- Restore ----

// Everything of the instance's schema that is not part of an extension:
// emptied before the dump is restored (the schema itself, its grants and
// the extensions in it stay).
async function emptySchema(client: pg.Client, schema: string) {
  const own = (catalog: string) => `NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='${catalog}'::regclass AND d.objid=o.oid AND d.deptype='e')`;
  const q = (sql: string) => client.query(sql, [schema]).then((r) => r.rows as { name: string }[]);
  for (const r of await q(`SELECT format('%I.%I',n.nspname,o.relname) AS name FROM pg_class o JOIN pg_namespace n ON n.oid=o.relnamespace WHERE n.nspname=$1 AND o.relkind IN ('v','m') AND ${own("pg_class")}`))
    await client.query(`DROP VIEW IF EXISTS ${r.name} CASCADE`).catch(() => client.query(`DROP MATERIALIZED VIEW IF EXISTS ${r.name} CASCADE`));
  for (const r of await q(`SELECT format('%I.%I',n.nspname,o.relname) AS name FROM pg_class o JOIN pg_namespace n ON n.oid=o.relnamespace WHERE n.nspname=$1 AND o.relkind IN ('r','p','f') AND ${own("pg_class")}`))
    await client.query(`DROP TABLE IF EXISTS ${r.name} CASCADE`);
  for (const r of await q(`SELECT format('%I.%I',n.nspname,o.relname) AS name FROM pg_class o JOIN pg_namespace n ON n.oid=o.relnamespace WHERE n.nspname=$1 AND o.relkind='S' AND ${own("pg_class")}`))
    await client.query(`DROP SEQUENCE IF EXISTS ${r.name} CASCADE`);
  for (const r of await q(`SELECT o.oid::regprocedure::text AS name FROM pg_proc o JOIN pg_namespace n ON n.oid=o.pronamespace WHERE n.nspname=$1 AND ${own("pg_proc")}`))
    await client.query(`DROP ROUTINE IF EXISTS ${r.name} CASCADE`);
  for (const r of await q(`SELECT format('%I.%I',n.nspname,o.typname) AS name FROM pg_type o JOIN pg_namespace n ON n.oid=o.typnamespace WHERE n.nspname=$1 AND o.typtype IN ('e','d','c','r') AND o.typrelid=0 AND ${own("pg_type")}`))
    await client.query(`DROP TYPE IF EXISTS ${r.name} CASCADE`);
}

// Replaces the instance's data with a dump: refuses a dump of a newer
// Flowplan version; empties the instance's schema and restores the dump
// into it in one transaction. A dump of a schema of the same name goes in
// with pg_restore --single-transaction; one of another name (an instance
// with FLOWPLAN_PG_SCHEMA restoring a backup of one in `public`, or the
// other way round) through psql, pg_restore's SQL with the schema's name
// replaced outside the data (sameSchema below). On a failure the
// schema is left empty: the caller restores the state it saved before
// (restorePendingIntoPostgres keeps it as a dump, as SQLite keeps the old
// file). Afterwards the caller brings the schema to this version and
// rebuilds the search index (lib/db-restore.ts).
export async function restoreDump(path: string, options: { newestVersion: number }) {
  const tool = await requireTool("pg_restore");
  const entries = await toc(path);
  const schemas = new Set(entries.filter((e) => e.type === "TABLE").map((e) => e.schema));
  if (schemas.size !== 1) throw new Error("not a dump of one Flowplan schema");
  const source = [...schemas][0];
  const target = postgresSchema();
  const { version } = await dumpSummary(path);
  if (version > options.newestVersion) throw new Error(`the dump comes from a newer Flowplan version (schema ${version}, this one ${options.newestVersion})`);
  // What is made anew rather than restored: the schema itself (it exists),
  // extensions (outside the schema), pgvector's trigger (needs the
  // extension; lib/ai/vector-store.ts makes it when it is there).
  const list = entries
    .filter((e) => !(e.type === "SCHEMA" || e.type === "EXTENSION" || (e.type === "COMMENT" && /\bSCHEMA\b|\bEXTENSION\b/.test(e.line))))
    .filter((e) => !(e.type === "TRIGGER" && e.line.includes(VECTOR_TRIGGER)))
    .map((e) => e.line);
  const listFile = `${path}.list`;
  writeFileSync(listFile, `${list.join("\n")}\n`);
  try {
    const psql = source === target ? null : await requireTool("psql");
    await withClient(async (client) => await emptySchema(client, target));
    const { dbname, env } = libpqConnection();
    if (!psql) {
      const { code, stderr } = await run(tool, ["--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", `--use-list=${listFile}`, `--dbname=${dbname}`, path], {
        env,
      });
      if (code !== 0) throw new Error(`pg_restore: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${code}`}`);
    } else await restoreRenamed(tool, psql, path, listFile, source, target, dbname, env);
  } finally {
    rmSync(listFile, { force: true });
  }
}
// pg_restore's SQL (names schema-qualified, search_path empty) into psql,
// the schema's name replaced in every statement but not in COPY data.
async function restoreRenamed(pgRestore: string, psql: string, path: string, listFile: string, source: string, target: string, dbname: string, env: NodeJS.ProcessEnv) {
  const rename = sameSchema(source, target);
  const reader = spawn(pgRestore, ["--no-owner", "--no-privileges", `--use-list=${listFile}`, "--file=-", path], { stdio: ["ignore", "pipe", "pipe"] });
  const writer = spawn(psql, ["--no-psqlrc", "--quiet", "--single-transaction", "--set=ON_ERROR_STOP=1", `--dbname=${dbname}`], { env, stdio: ["pipe", "ignore", "pipe"] });
  let errors = "";
  reader.stderr.on("data", (c: Buffer) => (errors = (errors + c.toString("utf8")).slice(-4000)));
  writer.stderr.on("data", (c: Buffer) => (errors = (errors + c.toString("utf8")).slice(-4000)));
  const lines = createInterface({ input: reader.stdout, crlfDelay: Infinity });
  let copying = false;
  writer.stdin.on("error", () => {});
  for await (const line of lines) {
    let out = line;
    if (copying) copying = line !== "\\.";
    else {
      out = rename(line);
      copying = /^COPY\s.*\sFROM stdin;$/.test(line);
    }
    if (!writer.stdin.write(`${out}\n`)) await new Promise((done) => writer.stdin.once("drain", done));
  }
  writer.stdin.end();
  const [readCode, writeCode] = await Promise.all([
    new Promise<number>((done) => (reader.exitCode !== null ? done(reader.exitCode) : reader.once("close", (c) => done(c ?? 1)))),
    new Promise<number>((done) => writer.once("close", (c) => done(c ?? 1))),
  ]);
  if (readCode !== 0 || writeCode !== 0) throw new Error(`pg_restore/psql: ${errors.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${readCode}/${writeCode}`}`);
}
// Replaces the schema in qualified names (source. or "source".; also in
// 'source.seq' literals of setval) – a name that is a part of another one
// is left alone.
export function sameSchema(source: string, target: string) {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plain = new RegExp(`(^|[^A-Za-z0-9_$"])${escaped}\\.`, "g");
  const quoted = new RegExp(`"${escaped.replace(/"/g, '""')}"\\.`, "g");
  const to = quoteIdent(target);
  return (line: string) => line.replace(quoted, `${to}.`).replace(plain, (_m, before: string) => `${before}${to}.`);
}
// (For tests: the TOC's lines.)
export async function dumpEntries(path: string) {
  return (await toc(path)).map(({ type, schema, name }) => ({ type, schema, name }));
}
