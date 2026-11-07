// The asynchronous sweep of #127 (docs/architecture/database.md §4, §12):
// the database helpers of lib/db.ts became async; this codemod follows
// their callers through the whole program – with the TypeScript checker, so
// imports, re-exports, methods and object members resolve – and
//
//   - wraps every call of a function that became async in `(await …)`,
//   - marks the function around it `async` (an annotated return type T
//     becomes Promise<T>) and follows *its* callers, to a fixpoint,
//   - rewrites callbacks of array methods that became async
//     (`xs.map(x => f(x))` → `await mapAsync(xs, async x => f(x))`,
//     lib/each-async.ts; forEach, filter, flatMap, some, every, find,
//     findIndex, reduce likewise),
//   - awaits calls of generic wrappers whose result is the callback's
//     (`withRequestLocale(l, () => f())`) and lists them for review,
//   - turns assert.throws/doesNotThrow around them into
//     assert.rejects/doesNotReject,
//   - removes the parentheses the wrapping left where they are not needed.
//
// What it cannot do safely is listed, not changed: calls in constructors,
// getters and setters, at a module's top level outside tests, inside sort
// comparators, Map.forEach and other callbacks of functions that ignore the
// callback's result (timers, event handlers), functions passed as values.
//
//   TS_API=/path/to/typescript@5 node scripts/codemod-async-sweep.mjs \
//     --seed lib/db.ts:one,all,run,transaction [--seed …] [--dry] [--report out.json]
//
// TypeScript 7 (the project's compiler) has no JavaScript API: TS_API
// points to a typescript@5 package (npm install --prefix /tmp/ts5 typescript@5).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

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
const argv = process.argv.slice(2);
const opt = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
};
const dry = argv.includes("--dry");
const reportPath = opt("--report")[0];
const seedSpecs = opt("--seed");
// Files the codemod reads but never edits (hand-written async code).
const frozen = [/\/lib\/db\.ts$/, /\/lib\/db-driver\//, /\/lib\/each-async\.ts$/, /\/node_modules\//, /\.d\.ts$/];
const editable = (f) => !frozen.some((r) => r.test(f));

const config = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const files = config.fileNames.filter((f) => !f.includes("/node_modules/") && !f.endsWith(".d.ts") && !f.includes("/.next/"));
const program = ts.createProgram(files, { ...config.options, noEmit: true, incremental: false });
const checker = program.getTypeChecker();
const sources = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));

const isFunction = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n) ||
  ts.isConstructorDeclaration(n);
const enclosing = (n) => {
  for (let p = n.parent; p; p = p.parent) if (isFunction(p)) return p;
  return null;
};
const key = (n) => `${n.getSourceFile().fileName}:${n.getStart()}:${n.end}`;
const where = (n) => {
  const sf = n.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
  return `${relative(root, sf.fileName)}:${line + 1}`;
};
const isAsync = (fn) => !!(ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async);
const isTestFile = (sf) => /\/tests\//.test(sf.fileName);
const nameOf = (fn) => {
  if (fn.name) return fn.name.getText();
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p)) return p.name.getText();
  if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return p.name.getText();
  if (p && ts.isCallExpression(p)) return `(callback of ${p.expression.getText().slice(-40)})`;
  return "(anonymous)";
};
const unwrapParens = (n) => {
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
};

// The function declaration a call or reference resolves to.
function declarationOf(expr) {
  const at = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr;
  let symbol = checker.getSymbolAtLocation(at);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return functionOfSymbol(symbol);
}
function functionOfSymbol(symbol) {
  const decl = symbol.valueDeclaration || symbol.declarations?.[0];
  if (!decl) return null;
  if (isFunction(decl)) return decl.body || ts.isArrowFunction(decl) ? decl : implementationOf(decl, symbol);
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
    const init = unwrapParens(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  if (ts.isShorthandPropertyAssignment(decl)) {
    const value = checker.getShorthandAssignmentValueSymbol(decl);
    if (value) return functionOfSymbol(value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value);
  }
  return null;
}
// Overloads: the declaration with a body.
function implementationOf(decl, symbol) {
  for (const d of symbol.declarations || []) if (isFunction(d) && d.body) return d;
  return decl;
}

// callee declaration → calls; and references that are not calls.
const callers = new Map();
const references = new Map();
for (const sf of sources) {
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const decl = declarationOf(n.expression);
      if (decl && !decl.getSourceFile().fileName.includes("/node_modules/")) {
        const k = key(decl);
        if (!callers.has(k)) callers.set(k, []);
        callers.get(k).push(n);
      }
    } else if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && valuePosition(n)) {
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decl = symbol && symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method | ts.SymbolFlags.Variable | ts.SymbolFlags.Property) ? functionOfSymbol(symbol) : null;
      if (decl && !decl.getSourceFile().fileName.includes("/node_modules/")) {
        const k = key(decl);
        if (!references.has(k)) references.set(k, []);
        references.get(k).push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
// A function used as a value: handed to a call, stored, returned.
function valuePosition(n) {
  const p = n.parent;
  if (!p) return false;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return !!p.arguments?.includes(n);
  if (ts.isPropertyAssignment(p)) return p.initializer === n;
  if (ts.isShorthandPropertyAssignment(p)) return true;
  if (ts.isArrayLiteralExpression(p)) return true;
  if (ts.isVariableDeclaration(p)) return p.initializer === n;
  if (ts.isReturnStatement(p)) return true;
  if (ts.isConditionalExpression(p)) return p.whenTrue === n || p.whenFalse === n;
  if (ts.isBinaryExpression(p)) return p.right === n && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.EqualsToken].includes(p.operatorToken.kind);
  if (ts.isJsxExpression(p)) return true;
  return false;
}
// Seeds: <file>:<name>[,<name>…]
const targets = new Map(); // key → fn
const queue = [];
for (const spec of seedSpecs) {
  const [file, names] = spec.split(":");
  const sf = program.getSourceFile(resolve(root, file));
  if (!sf) throw new Error(`not in the program: ${file}`);
  for (const name of names.split(",")) {
    let found = null;
    const visit = (n) => {
      if (found) return;
      if (isFunction(n) && (n.body || ts.isArrowFunction(n)) && nameOf(n) === name && (ts.isSourceFile(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n.parent) || ts.isMethodDeclaration(n)))
        found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error(`no function ${name} in ${file}`);
    targets.set(key(found), found);
    queue.push(found);
  }
}

// ---- edits ----
const edits = new Map(); // file → [{pos, rank, text} | {start, end, text}]
const addEdit = (sf, e) => {
  if (!edits.has(sf.fileName)) edits.set(sf.fileName, []);
  edits.get(sf.fileName).push(e);
};
const wrapped = new Set();
function wrapAwait(node) {
  const sf = node.getSourceFile();
  if (!editable(sf.fileName)) return;
  const k = key(node);
  if (wrapped.has(k)) return;
  wrapped.add(k);
  const start = node.getStart(sf);
  addEdit(sf, { pos: start, rank: -node.end * 4, text: "(await " });
  addEdit(sf, { pos: node.end, rank: -1e12 - start, text: ")" });
}
const madeAsync = new Set();
function makeAsync(fn) {
  const sf = fn.getSourceFile();
  if (!editable(sf.fileName) || isAsync(fn) || madeAsync.has(key(fn))) return;
  madeAsync.add(key(fn));
  let at;
  if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) at = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword).getStart(sf);
  else if (ts.isMethodDeclaration(fn)) at = fn.name.getStart(sf);
  else at = fn.getStart(sf);
  addEdit(sf, { pos: at, rank: 1e12, text: "async " });
  if (fn.type && !ts.isTypePredicateNode(fn.type) && !/^Promise</.test(fn.type.getText(sf))) {
    addEdit(sf, { pos: fn.type.getStart(sf), rank: -fn.type.end * 4, text: "Promise<" });
    addEdit(sf, { pos: fn.type.end, rank: -1e12 - fn.type.getStart(sf), text: ">" });
  }
  // Overload signatures before the implementation.
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    const symbol = checker.getSymbolAtLocation(fn.name);
    for (const d of symbol?.declarations || [])
      if (d !== fn && ts.isFunctionDeclaration(d) && !d.body && d.type && !/^Promise</.test(d.type.getText(sf))) {
        addEdit(sf, { pos: d.type.getStart(sf), rank: -d.type.end * 4, text: "Promise<" });
        addEdit(sf, { pos: d.type.end, rank: -1e12 - d.type.getStart(sf), text: ">" });
      }
  }
}
const replaced = new Set();
function replace(sf, start, end, text) {
  if (!editable(sf.fileName)) return;
  const k = `${sf.fileName}:${start}:${end}`;
  if (replaced.has(k)) return;
  replaced.add(k);
  addEdit(sf, { start, end, text });
}

// ---- the fixpoint ----
const report = {
  wrappers: {},
  fireAndForget: [],
  blocked: [],
  topLevel: [],
  manualCallbacks: [],
  passedAsValue: [],
  typePredicates: [],
};
const note = (list, node, what) => report[list].push(`${where(node)} ${what}`);
const ARRAY_HELPERS = {
  map: "mapAsync",
  forEach: "forEachAsync",
  filter: "filterAsync",
  flatMap: "flatMapAsync",
  some: "someAsync",
  every: "everyAsync",
  find: "findAsync",
  findIndex: "findIndexAsync",
  reduce: "reduceAsync",
};
const TEST_FUNCTIONS = new Set(["test", "it", "describe", "suite", "before", "after", "beforeEach", "afterEach", "todo", "skip", "only"]);
const helperImports = new Map(); // file → Set(helper)
const seenTargets = new Set([...targets.keys()]);
const handledCalls = new Set();

function becomeAsync(fn) {
  // fn now returns a promise: its callers must await it.
  makeAsync(fn);
  if (seenTargets.has(key(fn))) return;
  seenTargets.add(key(fn));
  targets.set(key(fn), fn);
  queue.push(fn);
}

// The receiver's type – awaited, since it may be a call that is awaited now.
const receiverType = (expr) => {
  const type = checker.getTypeAtLocation(expr);
  return checker.getApparentType(checker.getAwaitedType(type) ?? type);
};
function isArrayLike(expr) {
  const type = receiverType(expr);
  const name = type.symbol?.name;
  if (name === "Array" || name === "ReadonlyArray" || checker.isTupleType?.(type) || name === "Set") return true;
  // A chain on a call that returns a promise now has no type yet
  // (`all(…).filter(…).map(…)`): array methods are what those are.
  return !!(type.flags & ts.TypeFlags.Any);
}

// A call `call` now yields a promise; await it and let the function around
// it follow.
function awaitCall(call) {
  if (handledCalls.has(key(call))) return;
  handledCalls.add(key(call));
  const sf = call.getSourceFile();
  let p = call.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  const alreadyAwaited = p && ts.isAwaitExpression(p);
  const fn = enclosing(call);
  if (!fn) {
    if (isTestFile(sf)) {
      if (!alreadyAwaited) wrapAwait(call);
    } else note("topLevel", call, call.getText().slice(0, 60));
    return;
  }
  if (ts.isConstructorDeclaration(fn) || ts.isGetAccessor(fn) || ts.isSetAccessor(fn) || fn.asteriskToken) {
    note("blocked", call, `${ts.SyntaxKind[fn.kind]}${fn.asteriskToken ? " (generator)" : ""}: ${call.getText().slice(0, 60)}`);
    return;
  }
  if (!alreadyAwaited) wrapAwait(call);
  if (fn.type && ts.isTypePredicateNode(fn.type)) note("typePredicates", fn, nameOf(fn));
  if (isAsync(fn)) return; // already returns a promise: nothing spreads
  functionBecomesAsync(fn);
}

function functionBecomesAsync(fn) {
  if (isAsync(fn) || madeAsync.has(key(fn))) return;
  const parent = fn.parent;
  // A callback handed to a call: what the receiver does with a promise decides.
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(fn)) {
    makeAsync(fn);
    callbackBecameAsync(parent, fn);
    return;
  }
  becomeAsync(fn);
}

function callbackBecameAsync(host, fn) {
  const sf = host.getSourceFile();
  if (ts.isNewExpression(host)) {
    note("fireAndForget", host, `new ${host.expression.getText()}(async …)`);
    return;
  }
  const callee = host.expression;
  const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
  // Already a call of a function that became async (transaction(…), …): its own entry awaits it.
  const decl = declarationOf(callee);
  if (decl && targets.has(key(decl))) return;
  if (ts.isPropertyAccessExpression(callee) && ARRAY_HELPERS[method] && isArrayLike(callee.expression)) {
    if (callee.questionDotToken || host.questionDotToken || host.typeArguments) {
      note("manualCallbacks", host, `${method} with ?. or type arguments`);
      return;
    }
    if (method === "forEach" && receiverType(callee.expression).symbol?.name === "Map") {
      note("manualCallbacks", host, "Map.forEach");
      return;
    }
    const helper = ARRAY_HELPERS[method];
    const recv = callee.expression;
    const open = host.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.OpenParenToken);
    addEdit(sf, { pos: recv.getStart(sf), rank: -host.end * 4 + 1, text: `${helper}(` });
    replace(sf, recv.end, open.end, ", ");
    if (!helperImports.has(sf.fileName)) helperImports.set(sf.fileName, new Set());
    helperImports.get(sf.fileName).add(helper);
    awaitCall(host);
    return;
  }
  if (ts.isPropertyAccessExpression(callee) && ["sort", "reduceRight", "findLast", "findLastIndex", "toSorted"].includes(method)) {
    note("manualCallbacks", host, method);
    return;
  }
  if (ts.isPropertyAccessExpression(callee) && ["then", "catch", "finally"].includes(method)) return;
  if (TEST_FUNCTIONS.has(method) && (isTestFile(sf) || /node:test/.test(callee.getText()))) return;
  if (ts.isPropertyAccessExpression(callee) && /^assert$/.test(callee.expression.getText()) && (method === "throws" || method === "doesNotThrow")) {
    replace(sf, callee.name.getStart(sf), callee.name.end, method === "throws" ? "rejects" : "doesNotReject");
    awaitCall(host);
    return;
  }
  // A function of this project that calls the callback it gets: that call
  // is awaited now, the function becomes async, and so its call here.
  if (decl && decl.body && editable(decl.getSourceFile().fileName)) {
    const index = host.arguments.indexOf(fn);
    const param = decl.parameters[Math.min(index, decl.parameters.length - 1)];
    if (param && ts.isIdentifier(param.name)) {
      const symbol = checker.getSymbolAtLocation(param.name);
      const calls = [];
      const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && checker.getSymbolAtLocation(n.expression) === symbol) calls.push(n);
        ts.forEachChild(n, visit);
      };
      visit(decl.body);
      if (calls.length) {
        (report.wrappers[nameOf(decl)] ||= []).push(where(host));
        for (const call of calls) awaitCall(call);
        if (!handledCalls.has(key(host)) && (isAsync(decl) || madeAsync.has(key(decl)))) awaitCall(host);
        return;
      }
    }
  }
  // A generic wrapper whose result is the callback's: its result is a promise now.
  if (resultFlowsFromCallback(host, fn)) {
    const name = callee.getText().slice(-50);
    (report.wrappers[name] ||= []).push(where(host));
    awaitCall(host);
    return;
  }
  note("fireAndForget", host, callee.getText().slice(-50));
}

function resultFlowsFromCallback(host, fn) {
  const signature = checker.getResolvedSignature(host);
  const decl = signature?.getDeclaration?.() ?? signature?.declaration;
  if (!decl || !decl.typeParameters?.length || !decl.parameters) return false;
  const index = host.arguments.indexOf(fn);
  const param = decl.parameters[Math.min(index, decl.parameters.length - 1)];
  if (!param?.type) return false;
  const names = decl.typeParameters.map((t) => t.name.text);
  // Without a return type: what it returns is inferred – from the callback.
  const returnText = decl.type ? decl.type.getText() : names.join(" ");
  const paramText = param.type.getText();
  return names.some((n) => new RegExp(`=>\\s*(Promise<)?${n}\\b`).test(paramText) && new RegExp(`\\b${n}\\b`).test(returnText));
}

while (queue.length) {
  const fn = queue.shift();
  for (const call of callers.get(key(fn)) || []) awaitCall(call);
  for (const ref of references.get(key(fn)) || []) {
    // xs.map(f) with f async now: the same as a callback.
    const host = ref.parent;
    if (ts.isCallExpression(host) && host.arguments.includes(ref) && ts.isPropertyAccessExpression(host.expression) && ARRAY_HELPERS[host.expression.name.text] && isArrayLike(host.expression.expression)) {
      callbackBecameAsync(host, ref);
      continue;
    }
    note("passedAsValue", ref, `${nameOf(fn)} in ${ref.parent.getText().slice(0, 60)}`);
  }
}

// ---- apply ----
let total = 0;
const changedFiles = [];
for (const [file, list] of edits) {
  let text = readFileSync(file, "utf8");
  const inserts = list.filter((e) => e.pos !== undefined).sort((a, b) => a.pos - b.pos || a.rank - b.rank);
  const replaces = list.filter((e) => e.start !== undefined).sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  let r = 0;
  let i = 0;
  while (i < inserts.length || r < replaces.length) {
    const nextInsert = i < inserts.length ? inserts[i].pos : Infinity;
    const nextReplace = r < replaces.length ? replaces[r].start : Infinity;
    if (nextInsert <= nextReplace) {
      out += text.slice(at, nextInsert) + inserts[i].text;
      at = nextInsert;
      i++;
    } else {
      const e = replaces[r++];
      out += text.slice(at, e.start) + e.text;
      at = e.end;
    }
  }
  out += text.slice(at);
  const helpers = helperImports.get(file);
  if (helpers) out = addImport(file, out, [...helpers]);
  total += list.length;
  changedFiles.push(relative(root, file));
  if (!dry) writeFileSync(file, removeParens(file, out));
}
function addImport(file, text, names) {
  const from = relative(resolve(file, ".."), resolve(root, "lib/each-async")).replace(/\\/g, "/");
  const spec = from.startsWith(".") ? from : `./${from}`;
  const existing = new RegExp(`import \\{([^}]*)\\} from "${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}";`);
  const m = text.match(existing);
  if (m) {
    const have = new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean));
    for (const n of names) have.add(n);
    return text.replace(existing, `import { ${[...have].sort().join(", ")} } from "${spec}";`);
  }
  const line = `import { ${names.sort().join(", ")} } from "${spec}";\n`;
  // After the last import (or "use …" directive and leading comments).
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
  const pos = imports.length ? imports[imports.length - 1].end + 1 : sf.statements.find((s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)))?.getFullStart() ?? 0;
  return text.slice(0, pos) + line + text.slice(pos);
}
// f((await g())) → f(await g()), (await g()); → await g(); and similar.
function removeParens(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const cuts = [];
  const visit = (n) => {
    if (ts.isParenthesizedExpression(n) && ts.isAwaitExpression(n.expression)) {
      const p = n.parent;
      const safe =
        (ts.isCallExpression(p) && p.arguments.includes(n)) ||
        (ts.isNewExpression(p) && p.arguments?.includes(n)) ||
        ts.isExpressionStatement(p) ||
        (ts.isVariableDeclaration(p) && p.initializer === n) ||
        ts.isReturnStatement(p) ||
        ts.isArrayLiteralExpression(p) ||
        (ts.isPropertyAssignment(p) && p.initializer === n) ||
        (ts.isArrowFunction(p) && p.body === n) ||
        (ts.isIfStatement(p) && p.expression === n) ||
        (ts.isWhileStatement(p) && p.expression === n) ||
        (ts.isForOfStatement(p) && p.expression === n) ||
        ts.isTemplateSpan(p) ||
        ts.isJsxExpression(p) ||
        ts.isSpreadElement(p) ||
        (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind));
      // `() => (await f())` keeps nothing to cut when the body would start
      // with `{` – never the case for await.
      if (safe) cuts.push(n.getStart(sf), n.end - 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const at of cuts.sort((a, b) => b - a)) text = text.slice(0, at) + text.slice(at + 1);
  return text;
}

const summary = {
  seeds: seedSpecs,
  functionsMadeAsync: madeAsync.size,
  awaitsAdded: wrapped.size,
  filesChanged: changedFiles.length,
  edits: total,
  arrayHelperFiles: helperImports.size,
  wrappers: Object.fromEntries(Object.entries(report.wrappers).map(([k, v]) => [k, v.length])),
  fireAndForget: report.fireAndForget.length,
  blocked: report.blocked.length,
  topLevel: report.topLevel.length,
  manualCallbacks: report.manualCallbacks.length,
  passedAsValue: report.passedAsValue.length,
  typePredicates: report.typePredicates.length,
};
console.log(JSON.stringify(summary, null, 2));
if (reportPath) writeFileSync(reportPath, JSON.stringify({ summary, ...report, changedFiles }, null, 2));
