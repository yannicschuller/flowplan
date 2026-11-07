// SQLite triggers in PL/pgSQL (docs/architecture/database.md, "Triggers").
// The translator (pg-schema.ts) reads each CREATE TRIGGER of the SQLite
// schema and writes a trigger function plus the trigger for PostgreSQL, so
// both databases keep the same logic in one place: the writes these
// triggers react to are spread over hundreds of statements in the code.
//
// What changes on the way: the WHEN clause moves into the function (a
// PostgreSQL WHEN cannot hold subqueries), RAISE(IGNORE) becomes RETURN NULL
// (the row is skipped, as in SQLite), RAISE(ABORT,'…') an exception with the
// same message, and the SQLite functions their PostgreSQL counterparts. A
// queue INSERT guarded by NOT EXISTS also gets ON CONFLICT DO NOTHING: under
// READ COMMITTED two transactions can both pass the guard.
import { postgresDialect } from "./dialect";

export type PgTrigger = { name: string; table: string; sql: string };

// Triggers whose body needs more than the mechanical translation.
const OVERRIDES: Record<string, string> = {
  // SQLite also fills seq from the rowid here; Postgres' seq is an identity.
  pages_created_at: `IF NEW.created_at IS NULL THEN UPDATE pages SET created_at=${"to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')"} WHERE id=NEW.id; END IF;`,
  // SQLite: by rowid (the space just inserted). Postgres has no rowid: by id.
  spaces_position_insert: `UPDATE spaces SET position=COALESCE((SELECT MAX(position) FROM spaces WHERE workspace_id IS NOT DISTINCT FROM NEW.workspace_id AND id<>NEW.id),0)+1 WHERE id=NEW.id;`,
};

// unixepoch()*1000 counts whole seconds; julianday('now') milliseconds.
const NOW_MS = postgresDialect.nowMs();
const NOW_EXACT_MS = "(extract(epoch from statement_timestamp())*1000)::bigint";
// A SQLite expression or statement of a trigger body in PostgreSQL.
export function triggerSql(sql: string): string {
  return (
    sql
      .replace(/CAST\(\s*\(\s*julianday\('now'\)\s*-\s*2440587\.5\s*\)\s*\*\s*86400000\s+AS\s+INTEGER\s*\)/gi, NOW_EXACT_MS)
      .replace(/\bunixepoch\(\)\s*\*\s*1000/gi, NOW_MS)
      .replace(/\binstr\s*\(/gi, "strpos(")
      .replace(/\bifnull\s*\(/gi, "coalesce(")
      // json_object: a text column receives it (jsonb text: `{"a": 1}`).
      .replace(/\bjson_object\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi, "jsonb_build_object($1)::text")
      .replace(/\bCURRENT_TIMESTAMP\b/g, postgresDialect.nowText())
      // `a IS NOT b` / `a IS b` with b not NULL: null-safe comparisons.
      .replace(/\bIS\s+NOT\s+(?!NULL\b|DISTINCT\b)/gi, "IS DISTINCT FROM ")
      .replace(/\bIS\s+(?!NOT\b|NULL\b|DISTINCT\b|TRUE\b|FALSE\b)/gi, "IS NOT DISTINCT FROM ")
  );
}

// Splits a trigger body into statements (no `;` inside strings in ours).
function statements(body: string) {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of body) {
    if (c === "'") quoted = !quoted;
    if (c === ";" && !quoted) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const HEAD =
  /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)(\w+)\1\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|DELETE|UPDATE(?:\s+OF\s+[\w\s,]+?)?)\s+ON\s+("?)(\w+)\5\s+(?:FOR\s+EACH\s+ROW\s+)?(?:WHEN\s+([\s\S]+?)\s+)?BEGIN\s+([\s\S]*)END\s*;?\s*$/i;

export function translateTrigger(sqliteSql: string): PgTrigger {
  const m = HEAD.exec(sqliteSql.trim());
  if (!m) throw new Error(`Trigger not understood: ${sqliteSql.slice(0, 120)}`);
  const [, , name, timingRaw, eventRaw, , table, when, body] = m;
  const timing = timingRaw.toUpperCase();
  if (timing !== "BEFORE" && timing !== "AFTER") throw new Error(`Trigger ${name}: ${timing} is not supported`);
  const event = eventRaw.replace(/\s+/g, " ").toUpperCase().replace(/^UPDATE OF /, "UPDATE OF ").replace(/ OF (.*)$/, (_m, cols: string) => ` OF ${cols.toLowerCase().split(/\s*,\s*/).join(",")}`);
  const kind = event.startsWith("INSERT") ? "INSERT" : event.startsWith("DELETE") ? "DELETE" : "UPDATE";
  const pass = timing === "AFTER" ? "NULL" : kind === "DELETE" ? "OLD" : "NEW";
  const lines = (OVERRIDES[name] ? [OVERRIDES[name].replace(/;$/, "")] : statements(body)).map((s) => {
    const raise = /^SELECT\s+RAISE\s*\(\s*(IGNORE|ABORT|FAIL|ROLLBACK)\s*(?:,\s*'((?:[^']|'')*)')?\s*\)$/i.exec(s);
    if (raise) return raise[1].toUpperCase() === "IGNORE" ? "RETURN NULL;" : `RAISE EXCEPTION '%', '${raise[2] ?? "constraint failed"}';`;
    let out = triggerSql(s);
    if (/^INSERT\s+INTO\b/i.test(out) && /\bNOT\s+EXISTS\s*\(/i.test(out) && !/\bON\s+CONFLICT\b/i.test(out)) out += " ON CONFLICT DO NOTHING";
    return `${out};`;
  });
  const inner = lines.map((l) => `    ${l}`).join("\n");
  const fn = `trg_${name}`;
  const code = when ? `  IF ${triggerSql(when.trim())} THEN\n${inner}\n  END IF;` : inner.replace(/^ {2}/gm, "");
  return {
    name,
    table,
    sql: `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n${code}\n  RETURN ${pass};\nEND\n$fn$;\nCREATE OR REPLACE TRIGGER ${name} ${timing} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
  };
}
