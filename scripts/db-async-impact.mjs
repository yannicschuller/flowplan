// How far `async` spreads when database helpers become asynchronous
// (docs/architecture/database.md). Builds the call graph of the project with
// the TypeScript compiler and follows it upwards from the given functions:
// every synchronous function that calls one of them has to become async,
// and so on. Reports the functions, the call sites that need an `await`,
// and the places where the chain ends in something that cannot simply be
// awaited (callbacks of map/filter/sort/…, getters, constructors, module
// top level).
//
//   node scripts/db-async-impact.mjs lib/db.ts:one,all,run,transaction
//   node scripts/db-async-impact.mjs lib/permissions.ts:requirePage lib/permissions.ts:pageRole
//   … --json   (machine-readable)
//   … --list   (the functions, file by file)
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

// TypeScript 7 (the project's compiler) has no JavaScript API yet: this
// needs a TypeScript 5 next to it, e.g.
//   npm install --prefix /tmp/ts5 typescript@5 && TS_API=/tmp/ts5/node_modules/typescript node scripts/db-async-impact.mjs …
const ts = (() => {
  const require = createRequire(import.meta.url);
  for (const id of [process.env.TS_API, "typescript"].filter(Boolean)) {
    try {
      const api = require(id);
      if (typeof api.createProgram === "function") return api;
    } catch {}
  }
  console.error("Needs the TypeScript 5 compiler API: set TS_API to a typescript@5 package folder.");
  process.exit(2);
})();

const root = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const json = process.argv.includes("--json");
const list = process.argv.includes("--list");
if (!args.length) {
  console.error("usage: node scripts/db-async-impact.mjs <file>:<fn>[,<fn>…] …");
  process.exit(2);
}

const config = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const files = config.fileNames.filter((f) => !f.includes("/node_modules/") && !f.endsWith(".d.ts"));
const program = ts.createProgram(files, { ...config.options, noEmit: true });
const checker = program.getTypeChecker();

const isFunction = (n) =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);
const enclosing = (n) => {
  for (let p = n.parent; p; p = p.parent) if (isFunction(p)) return p;
  return null;
};
const key = (n) => `${n.getSourceFile().fileName}:${n.pos}`;
const where = (n) => {
  const sf = n.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
  return `${relative(root, sf.fileName)}:${line + 1}`;
};
const nameOf = (fn) => {
  if (fn.name) return fn.name.getText();
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p)) return p.name.getText();
  if (p && ts.isPropertyAssignment(p)) return p.name.getText();
  if (p && ts.isCallExpression(p)) return `(callback of ${p.expression.getText().slice(-40)})`;
  return "(anonymous)";
};
// The declaration a call resolves to (through imports and re-exports).
function target(call) {
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol.valueDeclaration || symbol.declarations?.[0];
  if (!decl) return null;
  if (isFunction(decl)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer && isFunction(decl.initializer)) return decl.initializer;
  return null;
}

// callee declaration → calls of it
const callers = new Map();
const declarations = new Map();
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || sf.fileName.includes("/node_modules/")) continue;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const decl = target(n);
      if (decl && !decl.getSourceFile().fileName.includes("/node_modules/")) {
        const k = key(decl);
        declarations.set(k, decl);
        if (!callers.has(k)) callers.set(k, []);
        callers.get(k).push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// Starting points: <file>:<name>[,<name>]
const start = [];
for (const arg of args) {
  const [file, names] = arg.split(":");
  const sf = program.getSourceFile(resolve(root, file));
  if (!sf) throw new Error(`not in the program: ${file}`);
  for (const name of names.split(",")) {
    let found = null;
    const visit = (n) => {
      if (found) return;
      if (isFunction(n) && nameOf(n) === name && (ts.isSourceFile(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isFunctionDeclaration(n))) found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error(`no function ${name} in ${file}`);
    start.push(found);
  }
}

const becomeAsync = new Map(); // key → fn (already async ones are not added)
const awaitSites = new Set();
const callbacks = [];
const topLevel = [];
const blocked = [];
const queue = [...start];
const seen = new Set(start.map(key));
const isTest = (n) => /\/tests\//.test(n.getSourceFile().fileName);
let testSites = 0;
while (queue.length) {
  const fn = queue.shift();
  for (const call of callers.get(key(fn)) || []) {
    if (isTest(call)) {
      testSites++;
      continue;
    }
    awaitSites.add(key(call));
    const outer = enclosing(call);
    if (!outer) {
      topLevel.push(where(call));
      continue;
    }
    if (ts.isConstructorDeclaration(outer) || ts.isGetAccessor(outer) || ts.isSetAccessor(outer)) {
      blocked.push(`${where(call)} (${ts.SyntaxKind[outer.kind]})`);
      continue;
    }
    // A callback handed to something else (arr.map(x => f(x))): becoming
    // async changes what the receiver gets (promises), so it needs rewriting.
    if ((ts.isArrowFunction(outer) || ts.isFunctionExpression(outer)) && outer.parent && ts.isCallExpression(outer.parent) && outer.parent.arguments.includes(outer)) {
      const receiver = outer.parent.expression.getText();
      const method = receiver.split(".").pop();
      callbacks.push({ at: where(call), receiver: method });
      // The enclosing function of the callback's call still has to wait.
      if (!isAsyncFn(outer) && !seen.has(key(outer))) {
        seen.add(key(outer));
        becomeAsync.set(key(outer), outer);
      }
      const host = enclosing(outer.parent);
      // An async host already returns a promise: its callers await it.
      if (host && !seen.has(key(host))) {
        seen.add(key(host));
        if (!isAsyncFn(host)) {
          becomeAsync.set(key(host), host);
          queue.push(host);
        }
      }
      continue;
    }
    if (seen.has(key(outer))) continue;
    seen.add(key(outer));
    // Already async: only this call needs its await, nothing spreads.
    if (isAsyncFn(outer)) continue;
    becomeAsync.set(key(outer), outer);
    queue.push(outer);
  }
}
function isAsyncFn(fn) {
  return !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

const byReceiver = {};
for (const c of callbacks) byReceiver[c.receiver] = (byReceiver[c.receiver] || 0) + 1;
const filesTouched = new Set([...awaitSites].map((k) => k.split(":")[0]));
const fnsByFile = {};
for (const fn of becomeAsync.values()) {
  const f = relative(root, fn.getSourceFile().fileName);
  (fnsByFile[f] ||= []).push(nameOf(fn));
}
const area = (f) => (f.startsWith("app/") ? (f.includes("/api/") ? "app/api" : "app (pages, RSC)") : f.startsWith("components/") ? "components" : f.startsWith("lib/") ? "lib" : f.split("/")[0]);
const byArea = {};
for (const k of awaitSites) {
  const a = area(relative(root, k.split(":")[0]));
  byArea[a] = (byArea[a] || 0) + 1;
}
const report = {
  start: start.map((fn) => `${relative(root, fn.getSourceFile().fileName)}:${nameOf(fn)}`),
  functionsBecomingAsync: becomeAsync.size,
  callSitesNeedingAwait: awaitSites.size,
  filesTouched: filesTouched.size,
  callSitesByArea: byArea,
  callbacksToRestructure: callbacks.length,
  callbacksByReceiver: Object.fromEntries(Object.entries(byReceiver).sort((a, b) => b[1] - a[1])),
  blockedInGettersOrConstructors: blocked,
  moduleTopLevelCalls: topLevel,
  testCallSites: testSites,
};
if (json) console.log(JSON.stringify(list ? { ...report, functions: fnsByFile } : report, null, 2));
else {
  console.log(`From: ${report.start.join(", ")}`);
  console.log(`functions that become async: ${report.functionsBecomingAsync}`);
  console.log(`call sites that need await:  ${report.callSitesNeedingAwait} in ${report.filesTouched} files (+${testSites} direct calls in tests)`);
  console.log(`  by area: ${Object.entries(byArea).map(([a, n]) => `${a} ${n}`).join(", ")}`);
  console.log(`callbacks to restructure:    ${callbacks.length} (${Object.entries(report.callbacksByReceiver).slice(0, 12).map(([r, n]) => `${r} ${n}`).join(", ")})`);
  console.log(`in getters/constructors:     ${blocked.length}${blocked.length ? ` – ${blocked.slice(0, 5).join("; ")}` : ""}`);
  console.log(`module top level:            ${topLevel.length}${topLevel.length ? ` – ${topLevel.slice(0, 5).join("; ")}` : ""}`);
  if (list) for (const [f, names] of Object.entries(fnsByFile).sort()) console.log(`  ${f}: ${names.join(", ")}`);
}
