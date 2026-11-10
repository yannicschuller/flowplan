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
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import { postgresSchema, postgresSessionUrl } from "./db-driver/context";
import { ensurePostgresSchema, foreignKeySql, quoteIdent } from "./db-driver/pg-ddl.mjs";
import type { PgSchema } from "./db-driver/pg-schema";
import schemaJson from "./db-driver/postgres-schema.json";
import { VECTOR_FUNCTIONS, VECTOR_TABLE, VECTOR_TRIGGER } from "./ai/vector-store";

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

// libpq's own parameters of DATABASE_URL – or DATABASE_SESSION_URL, as
// pg_dump and pg_restore need a session of their own (behind PgBouncer in
// transaction mode) – (node-postgres knows others, which libpq would
// refuse); the password goes through the environment, never on the
// command line.
const LIBPQ = new Set(["sslmode", "sslrootcert", "sslcert", "sslkey", "sslcrl", "application_name", "connect_timeout", "target_session_attrs", "gssencmode", "channel_binding", "host", "port"]);
export function libpqConnection(url = postgresSessionUrl()!) {
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
  const client = new pg.Client({ connectionString: postgresSessionUrl()!, options: `-c search_path=${postgresSchema()}` });
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

// pg_restore --list: "1234; 1259 16390 TABLE public users owner". The
// types of several words are named here, longest first, so that "TABLE
// ATTACH" is not taken for a TABLE in a schema "ATTACH"; the rest are one
// word.
const MULTI_WORD_TYPES = [
  "MATERIALIZED VIEW DATA",
  "PUBLICATION TABLES IN SCHEMA",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH TEMPLATE",
  "TEXT SEARCH PARSER",
  "FOREIGN DATA WRAPPER",
  "SEQUENCE OWNED BY",
  "MATERIALIZED VIEW",
  "PUBLICATION TABLE",
  "OPERATOR FAMILY",
  "OPERATOR CLASS",
  "STATISTICS DATA",
  "SECURITY LABEL",
  "ACCESS METHOD",
  "BLOB METADATA",
  "CHECK CONSTRAINT",
  "EVENT TRIGGER",
  "FK CONSTRAINT",
  "FOREIGN TABLE",
  "FOREIGN SERVER",
  "LARGE OBJECT",
  "ROW SECURITY",
  "SEQUENCE SET",
  "TABLE ATTACH",
  "INDEX ATTACH",
  "USER MAPPING",
  "DEFAULT ACL",
  "TABLE DATA",
];
const TOC_LINE = new RegExp(`^\\d+;\\s+\\d+\\s+\\d+\\s+(${MULTI_WORD_TYPES.join("|")}|[A-Z]+)\\s+(\\S+)\\s+(.*)$`);
// `words`: the entry's tag, word by word, and its owner (a TRIGGER's tag
// is "table trigger", a COMMENT's "TABLE users").
type TocEntry = { line: string; type: string; schema: string; name: string; words: string[] };
async function toc(path: string): Promise<TocEntry[]> {
  const tool = await requireTool("pg_restore");
  const { code, stdout, stderr } = await run(tool, ["--list", path]);
  if (code !== 0) throw new Error(`pg_restore: ${stderr.trim().slice(0, 300) || "not a pg_dump archive"}`);
  return parseToc(stdout);
}
function parseToc(list: string): TocEntry[] {
  return list
    .split("\n")
    .filter((l) => /^\d+;/.test(l))
    .map((line) => {
      const m = TOC_LINE.exec(line);
      const words = (m?.[3] ?? "").trim().split(/\s+/);
      return { line, type: m?.[1] ?? "", schema: m?.[2] ?? "", name: words[0] ?? "", words };
    });
}

// What a Flowplan dump may hold: the objects Flowplan makes itself – its
// tables (lib/db-driver/postgres-schema.json) with their data, keys,
// indexes and identity sequences; the trigger functions and triggers
// translated from SQLite (lib/db-driver/pg-triggers.ts), pgvector's
// (lib/ai/vector-store.ts) and the file queue's (lib/storage.ts) – all in
// the one schema of the instance; the schema itself and the extensions of
// lib/pg-extensions.ts when they are in it. Anything else (another
// function, a trigger, a rule, a view, an event trigger, a type, a policy,
// a default privilege …) refuses the dump: a restore loads the data only
// and makes the schema from this code (restoreDump), so such objects
// would not come back anyway – and an archive that carries them was not
// made by Flowplan.
const EXTENSIONS = new Set(["pg_trgm", "vector"]);
const STORAGE_FUNCTIONS = ["storage_queue_file()"];
const STORAGE_TRIGGERS = ["storage_file_insert", "storage_file_delete"];
const PLAIN_NAME = /^[a-z_][a-z0-9_$]*$/;
function ownObjects() {
  const schema = SCHEMA();
  const triggers = schema.triggers.map((t) => t.name);
  return {
    tables: new Set([...ownTables().map((t) => t.name), VECTOR_TABLE]),
    triggers: new Set([...triggers, VECTOR_TRIGGER, ...STORAGE_TRIGGERS]),
    functions: new Set([...triggers.map((t) => `trg_${t}()`), ...VECTOR_FUNCTIONS, ...STORAGE_FUNCTIONS]),
  };
}
function ownEntry(e: TocEntry, source: string, own: ReturnType<typeof ownObjects>) {
  const [first = "", second = ""] = e.words;
  if (e.schema === "-")
    switch (e.type) {
      case "SCHEMA":
        return first === source;
      case "EXTENSION":
        return EXTENSIONS.has(first);
      case "COMMENT":
        return (first === "SCHEMA" && second === source) || (first === "EXTENSION" && EXTENSIONS.has(second));
      default:
        return false;
    }
  if (e.schema !== source) return false;
  switch (e.type) {
    case "TABLE":
    case "TABLE DATA":
      return own.tables.has(first);
    case "CONSTRAINT":
    case "FK CONSTRAINT":
    case "DEFAULT":
      return own.tables.has(first) && PLAIN_NAME.test(second);
    case "INDEX":
    case "SEQUENCE":
    case "SEQUENCE SET":
    case "SEQUENCE OWNED BY":
      return PLAIN_NAME.test(first);
    case "FUNCTION":
      return own.functions.has(first);
    case "TRIGGER":
      return own.tables.has(first) && own.triggers.has(second);
    case "COMMENT":
      return (first === "TABLE" && own.tables.has(second)) || (first === "COLUMN" && own.tables.has(second.split(".")[0]));
    default:
      return false;
  }
}
// A dump with objects Flowplan does not make (above): refused.
export class ForeignObjectsError extends Error {}
// The schema of a Flowplan dump (one schema with flowplan_meta); with
// `strict`, every entry must be one of Flowplan's own.
function dumpSchema(entries: TocEntry[], strict: boolean) {
  const schemas = new Set(entries.filter((e) => e.type === "TABLE").map((e) => e.schema));
  if (schemas.size !== 1 || !entries.some((e) => e.type === "TABLE" && e.name === "flowplan_meta")) throw new Error("not a Flowplan database dump");
  const source = [...schemas][0];
  if (strict) {
    const own = ownObjects();
    const foreign = entries.filter((e) => !ownEntry(e, source, own));
    if (foreign.length)
      throw new ForeignObjectsError(
        `the dump holds objects Flowplan does not make: ${foreign
          .slice(0, 5)
          .map((e) => `${e.type} ${e.schema} ${e.words.slice(0, -1).join(" ")}`.slice(0, 120))
          .join("; ")}${foreign.length > 5 ? ` (+${foreign.length - 5})` : ""}`,
      );
  }
  return source;
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
// What a setup restore and Administration's restore show and check before
// they stage a dump: that it holds only Flowplan's own objects (else
// ForeignObjectsError), its schema, the Flowplan schema version it was made
// with, a few counts and the files it refers to.
export async function dumpSummary(path: string, options: { strict?: boolean } = {}): Promise<DumpSummary> {
  const schema = dumpSchema(await toc(path), options.strict !== false);
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

const SCHEMA = () => schemaJson as unknown as PgSchema;
// The version table ensurePostgresSchema makes besides the translated ones.
const META_TABLE: PgSchema["tables"][number] = {
  name: "flowplan_meta",
  columns: ["key", "value"].map((name) => ({ name, type: "text", notNull: true, default: null, identity: false })),
  primaryKey: ["key"],
  uniques: [],
  checks: [],
  foreignKeys: [],
};
const ownTables = () => [...SCHEMA().tables, META_TABLE];

// What emptying the instance's schema drops: everything in it that is not
// part of an extension (the schema itself, its grants and the extensions
// in it stay). Read here, dropped in the restore's transaction.
async function emptySchemaSql(client: pg.Client, schema: string) {
  const own = (catalog: string) => `NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='${catalog}'::regclass AND d.objid=o.oid AND d.deptype='e')`;
  const q = async (sql: string) => (await client.query(sql, [schema])).rows as { name: string; kind?: string }[];
  const rel = (kinds: string) =>
    `SELECT format('%I.%I',n.nspname,o.relname) AS name, o.relkind AS kind FROM pg_class o JOIN pg_namespace n ON n.oid=o.relnamespace WHERE n.nspname=$1 AND o.relkind IN (${kinds}) AND ${own("pg_class")}`;
  return [
    ...(await q(rel("'v','m'"))).map((r) => `DROP ${r.kind === "m" ? "MATERIALIZED VIEW" : "VIEW"} IF EXISTS ${r.name} CASCADE;`),
    ...(await q(rel("'r','p','f'"))).map((r) => `DROP ${r.kind === "f" ? "FOREIGN TABLE" : "TABLE"} IF EXISTS ${r.name} CASCADE;`),
    ...(await q(rel("'S'"))).map((r) => `DROP SEQUENCE IF EXISTS ${r.name} CASCADE;`),
    ...(await q(`SELECT o.oid::regprocedure::text AS name FROM pg_proc o JOIN pg_namespace n ON n.oid=o.pronamespace WHERE n.nspname=$1 AND ${own("pg_proc")}`)).map(
      (r) => `DROP ROUTINE IF EXISTS ${r.name} CASCADE;`,
    ),
    ...(
      await q(
        `SELECT format('%I.%I',n.nspname,o.typname) AS name FROM pg_type o JOIN pg_namespace n ON n.oid=o.typnamespace WHERE n.nspname=$1 AND o.typtype IN ('e','d','c','r','m') AND o.typrelid=0 AND ${own("pg_type")}`,
      )
    ).map((r) => `DROP TYPE IF EXISTS ${r.name} CASCADE;`),
  ];
}
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
// The SQL of ensurePostgresSchema for an empty schema, written down rather
// than run: it goes into the restore's transaction.
async function schemaSql(schema: PgSchema) {
  const out: string[] = [];
  const value = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : literal(String(v)));
  await ensurePostgresSchema(
    {
      exec: async (sql: string) => void out.push(`${sql.trim().replace(/;$/, "")};`),
      all: async () => [],
      run: async (sql: string, ...p: unknown[]) => {
        let i = 0;
        out.push(`${sql.replace(/\?/g, () => value(p[i++]))};`);
      },
      // Just made (CREATE TABLE): all its columns.
      columns: async (t: string) => [...schema.tables, META_TABLE].find((x) => x.name === t)?.columns.map((c) => c.name) ?? [],
    },
    schema,
    undefined,
    { triggers: false, seed: false },
  );
  return out;
}

// Replaces the instance's data with a dump. Nothing of the dump but its
// rows is run: no definition of a table, function, trigger or anything
// else – a dump is an upload (Administration, the setup screen) and its
// SQL would run as Flowplan's database role. So:
//  1. the dump is checked: a Flowplan dump (one schema with flowplan_meta)
//     of this or an older version, holding only Flowplan's own objects
//     (dumpSchema; not with `strict: false`, for the state saved before a
//     restore, which comes back only on a failure);
//  2. in one transaction (psql, loadData): the instance's schema is emptied
//     and made anew from this version's schema (postgres-schema.json:
//     tables, keys, indexes); the rows are loaded from pg_restore
//     --data-only of the dump's TABLE DATA and SEQUENCE SET entries – a COPY
//     only into a table of that schema and only its columns (others are
//     left out, a column the dump lacks gets its default), sequences from
//     their numbers; then the foreign keys (checked) and the triggers from
//     this code, so none fired while the rows came in. Anything else in
//     pg_restore's output refuses the dump and nothing changes.
// A dump of another schema's name (an instance with FLOWPLAN_PG_SCHEMA
// restoring a backup of one in `public`, or the other way round) loads the
// same way: the COPY statements name the instance's schema. Afterwards the
// caller brings the schema to this version's rows (seed, version) and
// rebuilds the search index (lib/db-restore.ts).
export async function restoreDump(path: string, options: { newestVersion: number; strict?: boolean }) {
  const pgRestore = await requireTool("pg_restore");
  const psql = await requireTool("psql");
  const strict = options.strict !== false;
  const entries = await toc(path);
  const source = dumpSchema(entries, strict);
  const target = postgresSchema();
  const { version } = await dumpSummary(path, { strict });
  if (version > options.newestVersion) throw new Error(`the dump comes from a newer Flowplan version (schema ${version}, this one ${options.newestVersion})`);
  const own = ownObjects();
  const list = entries
    .filter((e) => (e.type === "TABLE DATA" && own.tables.has(e.name) && !DERIVED_TABLES.includes(e.name)) || e.type === "SEQUENCE SET")
    .map((e) => e.line);
  const listFile = `${path}.list`;
  writeFileSync(listFile, `${list.join("\n")}\n`);
  try {
    const schema = SCHEMA();
    const before = [...(await withClient((client) => emptySchemaSql(client, target))), ...(await schemaSql({ ...schema, tables: schema.tables.map((t) => ({ ...t, foreignKeys: [] })) }))];
    const { dbname, env } = libpqConnection();
    await loadData({ pgRestore, psql, path, listFile, source, target, before, dbname, env });
  } finally {
    rmSync(listFile, { force: true });
  }
}

// What can stand in pg_restore's script around the rows: comments, the
// settings at its start, \restrict/\unrestrict (pg_dump 18). Read and left
// out – loadData writes settings of its own.
const SCRIPT_NOISE = [/^$/, /^--/, /^\\(un)?restrict [A-Za-z0-9]+$/, /^SET [a-z_]+ = [^;]*;$/, /^SELECT pg_catalog\.set_config\('search_path', '', false\);$/];
const IDENT = `(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")+")`;
const COPY_HEAD = new RegExp(`^COPY (${IDENT})\\.(${IDENT}) \\((${IDENT}(?:, ${IDENT})*)\\) FROM stdin;$`);
const SETVAL = /^SELECT pg_catalog\.setval\('((?:[^']|'')+)', (-?\d+), (true|false)\);$/;
const QUALIFIED = new RegExp(`^(${IDENT})\\.(${IDENT})$`);
const unquote = (id: string) => (id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id);

// The COPY being read: which of its fields go on (null: all), how many it has.
export type CopyState = { keep: number[] | null; fields: number; skip: boolean };
// One line of pg_restore's output inside a COPY: whether it ends the COPY
// and the line psql gets for it (null: none). Only the dump's own end
// marker may reach psql as one: a row psql would read as "\." (a filtered
// row whose first kept field is "\.", or one that starts with it) would end
// the COPY early and the lines after it would run as SQL – pg_dump writes a
// backslash in a value as "\\", so no row of a genuine dump starts so.
export function copyLine(copy: CopyState, line: string): { end: boolean; send: string | null } {
  if (line === "\\.") return { end: true, send: copy.skip ? null : line };
  if (copy.skip) return { end: false, send: null };
  let send = line;
  if (copy.keep) {
    const fields = line.split("\t");
    if (fields.length !== copy.fields) throw new ForeignObjectsError("a row of the dump does not match its COPY");
    send = copy.keep.map((i) => fields[i]).join("\t");
  }
  if (send.startsWith("\\.")) throw new ForeignObjectsError("a row of the dump reads as the end of its COPY");
  return { end: false, send };
}

// The restore's one transaction, through psql (not pg_restore straight
// into the database: pg_restore 17 and newer set transaction_timeout,
// which a PostgreSQL 16 server refuses – the image's client tools are 18).
// psql gets only what is written here: its settings, `before` (the schema
// emptied and made anew), for every COPY of pg_restore's output a COPY
// into the instance's schema, checked against the table's columns, with
// the rows as they come (only the known columns when the dump has more),
// sequence values as numbers, the foreign keys and triggers from this
// code. A line of pg_restore's output that is none of these (a statement
// of a crafted archive, text after a row block's end) stops the restore:
// psql is killed before it reaches the end of its input and commits, so
// nothing changes. psql 18 also runs under \restrict: no meta-command.
async function loadData(o: { pgRestore: string; psql: string; path: string; listFile: string; source: string; target: string; before: string[]; dbname: string; env: NodeJS.ProcessEnv }) {
  const schema = SCHEMA();
  const tables = new Map(ownTables().filter((t) => !DERIVED_TABLES.includes(t.name)).map((t) => [t.name, t]));
  const restrict = (await versionOf(o.psql)) >= 18 ? randomBytes(16).toString("hex") : null;
  const reader = spawn(o.pgRestore, ["--data-only", `--use-list=${o.listFile}`, "--file=-", o.path], { stdio: ["ignore", "pipe", "pipe"] });
  // Its lines from the start: the iterator buffers what comes while the
  // settings are written (a readline interface alone would drop them).
  const lines = createInterface({ input: reader.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const writer = spawn(o.psql, ["--no-psqlrc", "--quiet", "--single-transaction", "--set=ON_ERROR_STOP=1", `--dbname=${o.dbname}`], { env: o.env, stdio: ["pipe", "ignore", "pipe"] });
  let errors = "";
  reader.stderr.on("data", (c: Buffer) => (errors = (errors + c.toString("utf8")).slice(-4000)));
  writer.stderr.on("data", (c: Buffer) => (errors = (errors + c.toString("utf8")).slice(-4000)));
  const readerExited = new Promise<number>((done) => reader.once("exit", (c) => done(c ?? 1)));
  // psql gone (an error stops it): nothing more is written ('exit', not
  // 'close', which waits for its input to be closed too).
  let writerDone = false;
  const writerExited = new Promise<number>((done) =>
    writer.once("exit", (c) => {
      writerDone = true;
      done(c ?? 1);
    }),
  );
  const writerClosed = new Promise<number>((done) => writer.once("close", (c) => done(c ?? 1)));
  writer.stdin.on("error", () => {});
  const send = async (text: string) => {
    if (!writerDone && !writer.stdin.write(text)) await Promise.race([new Promise((done) => writer.stdin.once("drain", done)), writerExited]);
  };
  await send(
    [
      ...(restrict ? [`\\restrict ${restrict}`] : []),
      "SET client_encoding = 'UTF8';",
      "SET client_min_messages = warning;",
      "SET standard_conforming_strings = on;",
      "SET statement_timeout = 0;",
      "SET lock_timeout = 0;",
      `SELECT pg_catalog.set_config('search_path', ${literal(quoteIdent(o.target))}, false);`,
      // Cluster mode: one restore at a time (as lib/db-restore.ts loadSqliteFile).
      "SELECT pg_advisory_xact_lock(hashtextextended('flowplan:restore',0));",
      ...o.before,
      // The version row the schema got: the dump brings its own.
      "DELETE FROM flowplan_meta;",
      "",
    ].join("\n"),
  );
  const sequences = new Map<string, bigint>();
  let copy: CopyState | null = null;
  let refused: Error | null = null;
  try {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (writerDone) break;
      if (copy) {
        const step = copyLine(copy, line);
        if (step.send !== null) await send(`${step.send}\n`);
        if (step.end) copy = null;
        continue;
      }
      if (SCRIPT_NOISE.some((re) => re.test(line))) {
        if (/^SET client_encoding = /.test(line) && line !== "SET client_encoding = 'UTF8';") throw new ForeignObjectsError(`the dump is not in UTF-8 (${line})`);
        continue;
      }
      const head = COPY_HEAD.exec(line);
      if (head) {
        const table = tables.get(unquote(head[2]));
        if (unquote(head[1]) !== o.source || !table) throw new ForeignObjectsError(`the dump writes into a table Flowplan does not have: ${line.slice(0, 120)}`);
        const names = (head[3].match(new RegExp(IDENT, "g")) ?? []).map(unquote);
        if (new Set(names).size !== names.length) throw new ForeignObjectsError(`a COPY of the dump names a column twice: ${line.slice(0, 120)}`);
        const have = new Set(table.columns.map((c) => c.name));
        const keep = names.flatMap((n, i) => (have.has(n) ? [i] : []));
        copy = { keep: keep.length === names.length ? null : keep, fields: names.length, skip: !keep.length };
        if (!copy.skip) await send(`COPY ${quoteIdent(o.target)}.${quoteIdent(table.name)} (${keep.map((i) => quoteIdent(names[i])).join(", ")}) FROM stdin;\n`);
        continue;
      }
      const setval = SETVAL.exec(line);
      const name = setval ? QUALIFIED.exec(setval[1].replace(/''/g, "'")) : null;
      if (setval && name && unquote(name[1]) === o.source) {
        const value = BigInt(setval[2]);
        sequences.set(unquote(name[2]), setval[3] === "true" ? value : value - 1n);
        continue;
      }
      throw new ForeignObjectsError(`the dump holds a statement Flowplan does not write: ${line.slice(0, 120)}`);
    }
    if (copy && !writerDone) throw new ForeignObjectsError("the dump ends inside a COPY");
  } catch (error) {
    refused = error as Error;
  } finally {
    lines.close();
  }
  if (refused) {
    // Before psql reaches the end of its input (and commits).
    writer.kill("SIGKILL");
    reader.kill();
    reader.stdout.destroy();
    await Promise.all([readerExited, writerExited]);
    throw refused;
  }
  if (writerDone) {
    reader.kill();
    reader.stdout.destroy();
  }
  if (!writerDone) {
    const after: string[] = [];
    // Identity columns: their sequence at the dump's value (pg_dump names it
    // <table>_<column>_seq), at least past the highest key restored.
    for (const t of tables.values())
      for (const c of t.columns.filter((x) => x.identity)) {
        const seq = `pg_get_serial_sequence(${literal(quoteIdent(t.name))}, ${literal(c.name)})`;
        after.push(
          `SELECT CASE WHEN m>0 THEN setval(${seq}, m, true) ELSE setval(${seq}, 1, false) END FROM (SELECT GREATEST(${sequences.get(`${t.name}_${c.name}_seq`) ?? 0n}, COALESCE(max(${quoteIdent(c.name)}),0)) AS m FROM ${quoteIdent(t.name)}) x;`,
        );
      }
    for (const t of schema.tables) for (const fk of t.foreignKeys) after.push(`${foreignKeySql(t, fk)};`);
    for (const t of schema.triggers) after.push(t.sql);
    if (restrict) after.push(`\\unrestrict ${restrict}`);
    await send(`${after.join("\n")}\n`);
  }
  writer.stdin.end();
  const [readCode, writeCode] = await Promise.all([readerExited, writerClosed]);
  if (readCode !== 0 || writeCode !== 0) throw new Error(`pg_restore/psql: ${errors.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${readCode}/${writeCode}`}`);
}
// (For tests: the check of a TOC as pg_restore --list writes it.)
export const checkTocList = (list: string) => dumpSchema(parseToc(list), true);
// (For tests: the TOC's lines.)
export async function dumpEntries(path: string) {
  return (await toc(path)).map(({ type, schema, name }) => ({ type, schema, name }));
}
