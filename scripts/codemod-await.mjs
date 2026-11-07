// Codemod for the asynchronous database (docs/architecture/database.md):
// after functions became async, every call of them gets an `await`, every
// function around such a call becomes async (its return type a Promise),
// and that function's own callers in the same files follow – until nothing
// changes. assert.throws around an awaited call becomes assert.rejects.
//
//   TS_API=/tmp/ts5/node_modules/typescript node scripts/codemod-await.mjs \
//     --fn identityFromToken,identityFromApiToken tests/*.test.ts
//
// Only the given files are edited; the names are matched by identifier
// (also `obj.name(…)`), so check the diff and run tsc afterwards. Calls
// that are already awaited, returned from an async function or passed on
// as a value are left alone.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

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
const fnIndex = args.indexOf("--fn");
if (fnIndex < 0) {
  console.error("usage: node scripts/codemod-await.mjs --fn a,b,c <files…>");
  process.exit(2);
}
const targets = new Set(args[fnIndex + 1].split(","));
const files = args.filter((_, i) => i !== fnIndex && i !== fnIndex + 1);

const isFunction = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const isAsync = (fn) => !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
const calledName = (call) => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};
const nameOf = (fn) => {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
};
const enclosing = (n) => {
  for (let p = n.parent; p; p = p.parent) if (isFunction(p)) return p;
  return null;
};

// Names found to become async in a file apply to that file only (local
// helpers); the given ones everywhere.
const local = new Map(files.map((f) => [f, new Set()]));
const wanted = (file, name) => targets.has(name) || local.get(file).has(name);
let total = 0;
for (let round = 0; round < 10; round++) {
  let changedNames = false;
  for (const file of files) {
    let text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [];
    const makeAsync = new Map();
    const visit = (n) => {
      if (ts.isCallExpression(n) && wanted(file, calledName(n) ?? "")) {
        const parent = n.parent;
        const awaited = ts.isAwaitExpression(parent) || (ts.isParenthesizedExpression(parent) && ts.isAwaitExpression(parent.parent));
        const fn = enclosing(n);
        const returned = (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === n)) && fn && isAsync(fn);
        if (!awaited && !returned) {
          edits.push({ at: n.getStart(sf), insert: "(await " }, { at: n.getEnd(), insert: ")" });
          if (fn && !isAsync(fn)) makeAsync.set(fn.pos, fn);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const fn of makeAsync.values()) {
      // async before the function (or its parameters for arrows).
      const keyword = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
      const at = keyword ? keyword.getStart(sf) : ts.isMethodDeclaration(fn) ? fn.name.getStart(sf) : fn.getStart(sf);
      edits.push({ at, insert: "async " });
      if (fn.type && !/^Promise</.test(fn.type.getText(sf))) {
        edits.push({ at: fn.type.getStart(sf), insert: "Promise<" }, { at: fn.type.getEnd(), insert: ">" });
      }
      const name = nameOf(fn);
      if (name && !wanted(file, name)) {
        local.get(file).add(name);
        changedNames = true;
      }
    }
    if (!edits.length) continue;
    edits.sort((a, b) => b.at - a.at || (a.insert === ")" ? -1 : 1));
    for (const e of edits) text = text.slice(0, e.at) + e.insert + text.slice(e.at);
    // assert.throws(() => (await f(…)), …) → await assert.rejects(async () => f(…), …)
    text = text.replace(/assert\.throws\(\s*async\s*\(\)\s*=>\s*\(await ([^]*?)\),/g, "await assert.rejects(async () => $1,");
    text = text.replace(/assert\.throws\(\s*async\s*\(\)\s*=>/g, "await assert.rejects(async () =>");
    writeFileSync(file, text);
    total += edits.length;
  }
  if (!changedNames) break;
}
// Parentheses the wrapping left where they are not needed:
// f((await g())) → f(await g()), (await g()); → await g();
for (const file of files) {
  let text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cuts = [];
  const visit = (n) => {
    if (ts.isParenthesizedExpression(n) && ts.isAwaitExpression(n.expression)) {
      const p = n.parent;
      const safe =
        (ts.isCallExpression(p) && p.arguments.includes(n)) ||
        ts.isExpressionStatement(p) ||
        (ts.isVariableDeclaration(p) && p.initializer === n) ||
        ts.isReturnStatement(p) ||
        (ts.isArrayLiteralExpression(p)) ||
        (ts.isPropertyAssignment(p) && p.initializer === n) ||
        (ts.isArrowFunction(p) && p.body === n);
      if (safe) cuts.push(n.getStart(sf), n.getEnd() - 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!cuts.length) continue;
  for (const at of cuts.sort((a, b) => b - a)) text = text.slice(0, at) + text.slice(at + 1);
  writeFileSync(file, text);
}
const found = [...local].filter(([, names]) => names.size).map(([f, names]) => `${f}: ${[...names].join(", ")}`);
console.log(`${total} edits; local functions that became async:\n  ${found.join("\n  ")}`);
