#!/usr/bin/env node
// Keeps the language catalogues in locales/ in step with the code.
//
//   npm run i18n              collect every English text, update all catalogues
//   npm run i18n -- --add it  start a catalogue for a new language
//   npm run i18n -- --check   only report what is missing (exit code 0)
//
// The English text of t(de, en), tr(de, en), ct(de, en), translate(…)(…),
// tr(…)(…) and (await serverT())(…) calls is the key; texts with variables get numbered placeholders
// (`Group ${name}` → "Group {0}"). A context after "||" ("Open||status")
// keeps two meanings of one English word apart. The tables of lib/i18n-errors.ts,
// lib/i18n-labels.ts and the saving states in components/i18n.tsx count as
// well. locales/en.json lists all keys (the source for translation tools);
// every other locales/<code>.json maps them to its language, "" meaning not
// translated yet (shown in English).
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

const root = new URL("..", import.meta.url).pathname;
const localesDir = join(root, "locales");
const TRANSLATORS = new Set(["t", "tr", "ct", "pick", "say", "bad"]);
const CURRIED = new Set(["translate", "tr", "serverT"]);
const TABLE_FILES = new Set(["lib/i18n-errors.ts", "lib/i18n-labels.ts", "components/i18n.tsx"]);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}
// The text of a string or template literal, variables as {0}, {1} …
function text(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral")
    return node.quasis.map((q, i) => (i ? `{${i - 1}}` : "") + q.value.cooked).join("");
  return null;
}
const keys = new Map(); // key → first place it occurs
function add(key, file, node) {
  if (!key || !/\p{L}/u.test(key.replace(/\{\d+\}/g, ""))) return;
  if (!keys.has(key)) keys.set(key, `${relative(root, file)}:${node.loc.start.line}`);
}
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}
for (const file of ["components", "lib", "app"].flatMap((d) => files(join(root, d)))) {
  const ast = parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    plugins: ["typescript", ...(file.endsWith(".tsx") ? ["jsx"] : [])],
  });
  const table = TABLE_FILES.has(relative(root, file));
  walk(ast.program, (node) => {
    // Tables marked "// i18n-table: 1" (English at that tuple index; several
    // indexes allowed) or "// i18n-table: values" (English object values).
    const marker = node.leadingComments?.map((c) => c.value.match(/i18n-table:\s*([\w ]+?)\s*(?:–|$)/)?.[1]).find(Boolean);
    if (marker && (node.type === "VariableDeclaration" || node.type === "ExportNamedDeclaration"))
      walk(node, (inner) => {
        if (marker === "values") {
          if (inner.type === "ObjectProperty" && inner.value.type === "StringLiteral") add(inner.value.value, file, inner.value);
          return;
        }
        if (inner.type !== "ArrayExpression") return;
        for (const index of marker.split(/\s+/).map(Number)) {
          const value = text(inner.elements[index]);
          if (value !== null) add(value, file, inner.elements[index]);
        }
      });
    if (node.type === "CallExpression" && node.arguments.length >= 2) {
      const callee = node.callee;
      const named = callee.type === "Identifier" && TRANSLATORS.has(callee.name);
      // translate(locale)(de, en), tr(locale)(de, en), (await serverT())(de, en)
      const factory = callee.type === "AwaitExpression" ? callee.argument : callee;
      const curried = factory?.type === "CallExpression" && factory.callee.type === "Identifier" && CURRIED.has(factory.callee.name);
      if (named || curried) {
        const de = text(node.arguments[0]), en = text(node.arguments[1]);
        if (de !== null && en !== null) add(en, file, node.arguments[1]);
      }
    }
    // { de: "Frage", en: "Question" }
    if (node.type === "ObjectExpression") {
      const prop = (name) => node.properties.find((p) => p.type === "ObjectProperty" && ((p.key.type === "Identifier" && p.key.name === name) || (p.key.type === "StringLiteral" && p.key.value === name)));
      const de = prop("de"), en = prop("en");
      if (de && en && text(de.value) !== null && text(en.value) !== null) add(text(en.value), file, en.value);
    }
    if (!table) return;
    // "German": "English"
    if (node.type === "ObjectProperty" && node.value.type === "StringLiteral" && (node.key.type === "StringLiteral" || node.key.type === "Identifier"))
      add(node.value.value, file, node.value);
    // [/^German (.+)$/, "English $1"]
    if (node.type === "ArrayExpression" && node.elements.length === 2 && node.elements[0]?.type === "RegExpLiteral" && node.elements[1]?.type === "StringLiteral")
      add(node.elements[1].value.replace(/\$(\d)/g, (_, n) => `{${Number(n) - 1}}`), file, node.elements[1]);
  });
}

const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b, "en"));
const args = process.argv.slice(2);
const check = args.includes("--check");
const added = args.includes("--add") ? args[args.indexOf("--add") + 1] : null;
if (added && !/^[a-z]{2}(-[A-Z]{2})?$/.test(added)) {
  console.error(`Language code like "it" or "pt-BR" expected, got "${added}".`);
  process.exit(1);
}
const write = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
// "Open||status": the English text is the part before "||" (lib/i18n.ts).
if (!check) write(join(localesDir, "en.json"), Object.fromEntries(sorted.map((k) => [k, k.split("||")[0]])));
if (added && !existsSync(join(localesDir, `${added}.json`))) write(join(localesDir, `${added}.json`), {});

const catalogs = readdirSync(localesDir).filter((f) => f.endsWith(".json") && f !== "en.json");
console.log(`${sorted.length} texts in the code.`);
for (const name of catalogs) {
  const path = join(localesDir, name);
  const current = JSON.parse(readFileSync(path, "utf8"));
  const next = Object.fromEntries(sorted.map((k) => [k, typeof current[k] === "string" ? current[k] : ""]));
  const obsolete = Object.keys(current).filter((k) => !keys.has(k));
  const missing = sorted.filter((k) => !next[k]);
  // Placeholders must survive the translation.
  const broken = sorted.filter((k) => next[k] && (k.match(/\{\d+\}/g) || []).sort().join() !== (next[k].match(/\{\d+\}/g) || []).sort().join());
  const done = sorted.length - missing.length;
  console.log(`${name.replace(".json", "")}: ${done}/${sorted.length} translated (${Math.floor((done / sorted.length) * 100)} %)${obsolete.length ? `, ${obsolete.length} no longer used` : ""}${broken.length ? `, ${broken.length} with wrong placeholders` : ""}`);
  if (check) {
    for (const k of broken) console.log(`  placeholders differ: ${JSON.stringify(k)} → ${JSON.stringify(next[k])}`);
    if (args.includes("--missing")) for (const k of missing) console.log(`  missing: ${JSON.stringify(k)}  (${keys.get(k)})`);
  } else write(path, next);
}
if (added) console.log(`\nNext: add "${added}" to LANGUAGES in lib/i18n.ts and to serverCatalogs in lib/i18n-catalogs-server.ts.`);
