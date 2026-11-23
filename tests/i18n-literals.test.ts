// German left in the English interface (#453): texts written straight into
// JSX, and server messages with values that lib/i18n-errors.ts cannot match.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

type Node = { type: string; loc: { start: { line: number } }; [key: string]: unknown };
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : files(join(dir, e.name), ext)) : ext.test(e.name) && !e.name.endsWith(".d.ts") ? [join(dir, e.name)] : [],
  );
function walk(node: unknown, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []) {
  if (!node || typeof (node as Node).type !== "string") return;
  const n = node as Node;
  visit(n, parents);
  parents.push(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    const value = n[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit, parents);
    else walk(value, visit, parents);
  }
  parents.pop();
}
const ast = (file: string) =>
  parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", ...(file.endsWith("x") ? (["jsx"] as const) : [])] }).program;

// Umlauts, or a German word that English UI text does not use.
const german =
  /[äöüßÄÖÜ]|\b(und|oder|nicht|kein\w*|Keine?|Bitte|der|die|das|Der|Die|Das|eine?|mit|für|Zeile|Spalte|Seite|Datei|Bild|Neue?[rs]?|Speichern|Abbrechen|Bearbeiten|Zurück|Weiter|Fertig)\b/;
const TRANSLATORS = new Set(["t", "tr", "ct", "pick", "say", "bad", "translate", "serverT", "serverMessage", "localizedMessage", "englishMessage"]);
const translated = (parents: Node[]) =>
  parents.some((p) => {
    if (p.type !== "CallExpression") return false;
    const callee = p.callee as Node & { name?: string; callee?: Node & { name?: string }; property?: { name?: string } };
    return (
      (callee.type === "Identifier" && TRANSLATORS.has(callee.name!)) ||
      (callee.type === "CallExpression" && callee.callee?.type === "Identifier" && TRANSLATORS.has(callee.callee.name!)) ||
      (callee.type === "MemberExpression" && /^(t|tr)$/.test(callee.property?.name || ""))
    );
  });
// Shown as it is on purpose: an example of a foreign format.
const ALLOWED = [/^@article\{/];

test("JSX texts and labels go through t() (no German in the English interface)", () => {
  const found: string[] = [];
  for (const file of [...files("components", /\.tsx$/), ...files("app", /\.tsx$/)])
    walk(ast(file), (node, parents) => {
      const parent = parents[parents.length - 1];
      let text: string | null = null;
      if (node.type === "JSXText") text = String(node.value).trim();
      else if (node.type === "StringLiteral" && parent?.type === "JSXExpressionContainer" && parents[parents.length - 2]?.type !== "JSXAttribute")
        text = String(node.value);
      else if (
        node.type === "StringLiteral" &&
        parent?.type === "JSXAttribute" &&
        /^(aria-label|aria-description|title|placeholder|alt|label)$/.test(String((parent.name as { name?: string })?.name))
      )
        text = String(node.value);
      if (!text || !german.test(text) || translated(parents) || ALLOWED.some((a) => a.test(text!))) return;
      found.push(`${file}:${node.loc.start.line}: ${text.slice(0, 80)}`);
    });
  assert.deepEqual(found, []);
});

test("server messages with values have an English version", async () => {
  const { englishMessage } = await import("../lib/i18n-errors");
  const found: string[] = [];
  for (const file of [...files("lib", /\.tsx?$/), ...files("app", /\.tsx?$/)]) {
    if (file.endsWith("i18n-errors.ts")) continue;
    walk(ast(file), (node) => {
      if (node.type !== "NewExpression") return;
      const callee = node.callee as Node & { name?: string };
      if (callee.type !== "Identifier" || !/Error$/.test(callee.name!)) return;
      for (const arg of node.arguments as Node[]) {
        if (arg.type !== "TemplateLiteral") continue;
        const quasis = arg.quasis as { value: { cooked: string } }[];
        // A message that starts with a value is put together elsewhere.
        if (!quasis[0].value.cooked) continue;
        const sample = (value: string) => quasis.map((q, i) => (i ? value : "") + q.value.cooked).join("");
        if (!german.test(sample(""))) continue;
        // A value is a number or a name: one of them must find the English.
        if (["3", "Status", "12,5 MB"].every((value) => englishMessage(sample(value)) === sample(value)))
          found.push(`${file}:${arg.loc.start.line}: ${sample("…")}`);
      }
    });
  }
  assert.deepEqual(found, []);
});
