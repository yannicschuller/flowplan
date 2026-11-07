// Codemod for the dialect pass (docs/architecture/database.md, "Dialect"):
// rewrites SQLite-only SQL in string and template literals to SQL that runs
// on SQLite and PostgreSQL alike, without changing what SQLite does.
//
//   TS_API=/tmp/ts5/node_modules/typescript node scripts/codemod-dialect.mjs \
//     --now --ignore [--dry] <files…>
//
// --now     CURRENT_TIMESTAMP in a query → `?` with a `nowText()` argument
//           at the matching position (the text SQLite's CURRENT_TIMESTAMP
//           gives, computed in JavaScript). Only where the position is
//           certain: the literal is the first argument of the call, no
//           substitution before it can add placeholders, no spread before it.
// --ignore  INSERT OR IGNORE INTO … → INSERT INTO … ON CONFLICT DO NOTHING
//           (SQLite ≥ 3.24 reads it too; an INSERT … SELECT without WHERE
//           gets `WHERE true`, SQLite's rule against a parsing ambiguity).
//
// Everything it cannot do safely is listed for a manual edit. Check the
// diff and run tsc and the tests afterwards.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ts = (() => {
  const require = createRequire(import.meta.url);
  for (const id of [process.env.TS_API, "typescript"].filter(Boolean)) {
    try {
      const api = require(id);
      if (typeof api.createSourceFile === "function") return api;
    } catch {}
  }
  console.error("Needs the TypeScript 5 compiler API: set TS_API to a typescript@5 package folder.");
  process.exit(2);
})();

const args = process.argv.slice(2);
const doNow = args.includes("--now");
const doIgnore = args.includes("--ignore");
const dry = args.includes("--dry");
const files = args.filter((a) => !a.startsWith("--"));
const root = resolve(new URL("..", import.meta.url).pathname);
const SQLISH = /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|SET)\b/;
const manual = [];
let edited = 0;

// The literal's pieces: text parts with their source offsets, and the
// substitutions between them.
function pieces(node, sf) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { texts: [{ text: node.text, start: node.getStart(sf) + 1, raw: node.getText(sf).slice(1, -1) }], subs: [] };
  if (ts.isTemplateExpression(node)) {
    const texts = [{ text: node.head.text, start: node.head.getStart(sf) + 1, raw: node.head.getText(sf).slice(1, -2) }];
    const subs = [];
    for (const span of node.templateSpans) {
      subs.push(span.expression);
      const lit = span.literal;
      const raw = lit.getText(sf);
      texts.push({ text: lit.text, start: lit.getStart(sf) + 1, raw: raw.slice(1, ts.isTemplateTail(lit) ? -1 : -2) });
    }
    return { texts, subs };
  }
  return null;
}
// datetime('now'[,'±N unit']) → the nowText() argument computing it.
const TIME = /datetime\('now'(?:,'[^']*')?\)/;
const UNIT = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
function timeArg(text) {
  const m = /^datetime\('now'(?:,'([+-])(\d+) (second|minute|hour|day)s?')?\)$/.exec(text);
  if (!m) return null;
  if (!m[1]) return "nowText()";
  const ms = Number(m[2]) * UNIT[m[3]];
  return `nowText(Date.now() ${m[1]} ${ms.toLocaleString("en-US").replace(/,/g, "_")})`;
}
// A substitution that could add `?` placeholders.
const mayAddPlaceholders = (expr, sf) => /\?|placeholder|\.map\(|join\(|marks|holes|params|args/i.test(expr.getText(sf));

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  let needsNow = false;
  const where = (node) => `${relative(root, resolve(file))}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

  const visit = (node) => {
    const p = pieces(node, sf);
    if (p) {
      const full = p.texts.map((t) => t.text).join("${}");
      if (SQLISH.test(full)) {
        if (doIgnore && /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(full)) ignoreEdit(node, p, full);
        if (doNow && (/\bCURRENT_TIMESTAMP\b/.test(full) || TIME.test(full))) nowEdit(node, p);
      }
    }
    ts.forEachChild(node, visit);
  };

  function ignoreEdit(node, p, full) {
    // One statement per literal, the INSERT at its start.
    if (/;\s*\S/.test(full.replace(/'(?:[^']|'')*'/g, "''")) || !/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(p.texts[0].text) || /\bON\s+CONFLICT\b|\bRETURNING\b/i.test(full)) {
      manual.push(`${where(node)}  INSERT OR IGNORE (shape): ${full.replace(/\s+/g, " ").slice(0, 120)}`);
      return;
    }
    const last = p.texts[p.texts.length - 1];
    if (p.texts.length > 1 && !/\S/.test(last.text) && !/\)\s*$/.test(p.texts[p.texts.length - 2].text)) {
      // Ends with a substitution (e.g. a VALUES list built in code): fine
      // as long as it is a VALUES list; else by hand.
      if (!/\bVALUES\s*$/i.test(p.texts[p.texts.length - 2].text.trim()) && !/VALUES\s*\(?\s*$/i.test(p.texts[p.texts.length - 2].text)) {
        manual.push(`${where(node)}  INSERT OR IGNORE (dynamic tail): ${full.replace(/\s+/g, " ").slice(0, 120)}`);
        return;
      }
    }
    const first = p.texts[0];
    const m = /INSERT\s+OR\s+IGNORE\s+INTO/i.exec(first.raw);
    edits.push({ start: first.start + m.index, end: first.start + m.index + m[0].length, text: "INSERT INTO" });
    // INSERT … SELECT: the last SELECT needs a WHERE before ON CONFLICT.
    const body = full.replace(/'(?:[^']|'')*'/g, "''");
    const isSelect = !/\bVALUES\b/i.test(body) && /\bSELECT\b/i.test(body);
    let suffix = " ON CONFLICT DO NOTHING";
    if (isSelect) {
      const lastSelect = body.slice(body.search(/\bSELECT\b(?![\s\S]*\bSELECT\b)/i));
      const depthZeroWhere = (() => {
        let depth = 0;
        for (let i = 0; i < lastSelect.length; i++) {
          const c = lastSelect[i];
          if (c === "(") depth++;
          else if (c === ")") depth--;
          else if (depth === 0 && /^WHERE\b/i.test(lastSelect.slice(i, i + 6)) && /\W/.test(lastSelect[i - 1] || " ")) return true;
        }
        return false;
      })();
      // A SELECT inside parentheses (e.g. `IN (SELECT …)`) only: the last
      // top-level SELECT is what counts; keep it simple – unusual shapes by hand.
      if (/\b(ORDER\s+BY|GROUP\s+BY|LIMIT)\b/i.test(lastSelect) && !depthZeroWhere) {
        manual.push(`${where(node)}  INSERT OR IGNORE (SELECT with ORDER/GROUP/LIMIT): ${full.replace(/\s+/g, " ").slice(0, 120)}`);
        edits.pop();
        return;
      }
      if (!depthZeroWhere) suffix = ` WHERE true${suffix}`;
    }
    // Before trailing whitespace and a `;`.
    const tail = /\s*;?\s*$/.exec(last.raw);
    const at = last.start + tail.index;
    edits.push({ start: at, end: at, text: suffix });
    edited++;
  }

  function nowEdit(node, p) {
    const call = node.parent;
    if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) {
      manual.push(`${where(node)}  CURRENT_TIMESTAMP (not a call's first argument)`);
      return;
    }
    // Occurrences with the number of `?` before each.
    const found = [];
    let placeholders = 0;
    let unsafeFrom = Infinity;
    p.texts.forEach((t, index) => {
      if (index > 0 && mayAddPlaceholders(p.subs[index - 1], sf)) unsafeFrom = Math.min(unsafeFrom, index);
      const re = /\?|\bCURRENT_TIMESTAMP\b|datetime\('now'(?:,'[^']*')?\)|'(?:[^']|'')*'/g;
      let m;
      while ((m = re.exec(t.raw))) {
        if (m[0] === "?") placeholders++;
        else if (m[0] === "CURRENT_TIMESTAMP") found.push({ piece: index, offset: t.start + m.index, length: m[0].length, before: placeholders, arg: "nowText()" });
        else if (m[0].startsWith("datetime(")) {
          const arg = timeArg(m[0]);
          if (!arg) {
            manual.push(`${where(node)}  ${m[0]} (modifier)`);
            continue;
          }
          found.push({ piece: index, offset: t.start + m.index, length: m[0].length, before: placeholders, arg });
        }
      }
    });
    if (found.some((f) => f.piece >= unsafeFrom)) {
      manual.push(`${where(node)}  CURRENT_TIMESTAMP (placeholders built in code before it)`);
      return;
    }
    const callArgs = call.arguments;
    for (const f of found)
      if (callArgs.slice(1, f.before + 2).some((a) => ts.isSpreadElement(a)) || callArgs.length - 1 < f.before) {
        manual.push(`${where(node)}  CURRENT_TIMESTAMP (spread or missing arguments before it)`);
        return;
      }
    for (const f of found) {
      edits.push({ start: f.offset, end: f.offset + f.length, text: "?" });
      // Insert the argument: after argument #before (0 = after the SQL).
      const after = callArgs[f.before];
      edits.push({ start: after.getEnd(), end: after.getEnd(), text: `, ${f.arg}`, order: f.before });
    }
    needsNow = true;
    edited++;
  }

  visit(sf);
  if (!edits.length) continue;
  // Apply from the end; ties (several arguments after the same one) keep order.
  edits.sort((a, b) => b.start - a.start || (b.order ?? 0) - (a.order ?? 0));
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (needsNow && !/\bnowText\b/.test(text.replace(/,\s*nowText\(\)/g, ""))) out = addImport(out, file);
  if (!dry) writeFileSync(file, out);
}

// `nowText` from lib/db.ts: into an existing import of it, else a new line.
function addImport(source, file) {
  const dbPath = relative(dirname(resolve(file)), resolve(root, "lib/db")).replace(/\\/g, "/");
  const spec = dbPath.startsWith(".") ? dbPath : `./${dbPath}`;
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["'](${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}|@/lib/db)["'];?`);
  const m = re.exec(source);
  if (m && !/\btype\s+\{/.test(m[0])) return source.replace(m[0], m[0].replace(m[1], `${m[1].replace(/\s*$/, "")}, nowText `).replace(", nowText ,", ", nowText,"));
  const firstImport = source.search(/^import\s/m);
  const line = `import { nowText } from "${spec}";\n`;
  return firstImport < 0 ? line + source : source.slice(0, firstImport) + line + source.slice(firstImport);
}

console.log(`${edited} literals ${dry ? "would be " : ""}edited`);
if (manual.length) console.log(`\nBy hand:\n${manual.join("\n")}`);
