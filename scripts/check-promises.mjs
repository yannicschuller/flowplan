// Promises used as values (#127, the asynchronous sweep): tsc reports most
// places where a function that became async is used as before – not these,
// where any value is accepted. Reported (exit code 1 when there are any):
//
//   - a promise as a statement of its own, not awaited (`void p` marks a
//     deliberate fire-and-forget),
//   - a promise as a condition (`!p`, `p ? a : b`, `p && …`, `if (p)`),
//   - a callback that returns a promise to filter/some/every/find/
//     findIndex/sort/forEach (they do not wait for it),
//   - a promise as an argument where any value goes (JSON.stringify,
//     Response.json, assert.equal, console.log, String(…)), as a property
//     of an object literal or element of an array literal passed there,
//     in a template literal or a `+`, or compared with ===/!==,
//   - an array of promises that does not go to Promise.all/allSettled/race.
//
//   TS_API=/path/to/typescript@5 node scripts/check-promises.mjs [--json] [files…]
import { createRequire } from "node:module";
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
const only = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((f) => resolve(f));
const config = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const files = config.fileNames.filter((f) => !f.includes("/node_modules/") && !f.endsWith(".d.ts") && !f.includes("/.next/"));
const program = ts.createProgram(files, { ...config.options, noEmit: true, incremental: false });
const checker = program.getTypeChecker();

const isPromise = (type) => {
  if (!type) return false;
  // A union counts when every member besides null/undefined is a promise
  // (ReactNode, for one, includes a promise).
  if (type.isUnion()) {
    const members = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    return members.length > 0 && members.every(isPromise);
  }
  const then = checker.getPropertyOfType(type, "then");
  return !!then && !!(type.symbol && /^(Promise|PromiseLike)$/.test(type.symbol.name));
};
const typeOf = (n) => checker.getTypeAtLocation(n);
const loose = (type) => !type || !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (type.symbol?.name === "Object" && !type.isUnion()) || checker.typeToString(type) === "{}";
const findings = [];
const report = (node, what) => {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  findings.push(`${relative(root, sf.fileName)}:${line + 1}: ${what}: ${node.getText().replace(/\s+/g, " ").slice(0, 100)}`);
};
const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
};
const CALLBACK_METHODS = new Set(["filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort", "toSorted", "forEach"]);
const AGGREGATES = /^Promise\.(all|allSettled|race|any)$/;

// Calls whose promise is looked after: test(…) of node:test, …catch(…),
// …then(ok, failed), …finally after a catch.
const TESTS = new Set(["test", "it", "describe", "suite", "before", "after", "beforeEach", "afterEach"]);
function handled(e) {
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
  if (TESTS.has(name) && (ts.isIdentifier(callee) || /^(t|test|it|describe|suite)$/.test(callee.expression.getText()))) return true;
  if (name === "catch") return true;
  if (name === "then" && e.arguments.length >= 2) return true;
  return false;
}
// Hosts that call an async callback and are fine with the promise they
// do not wait for: test registration, timers and event emitters (a
// rejection there is the same as a throw was before), afterTransaction
// (catches and logs).
const IGNORED_HOSTS = /(^|\.)(test|it|describe|before|after|beforeEach|afterEach|setTimeout|setInterval|setImmediate|queueMicrotask|on|once|addEventListener|subscribe|afterTransaction|then|catch|finally|\w+Async)$/;
function contextualMember(method) {
  const literal = checker.getContextualType(method.parent);
  if (!literal || !method.name) return undefined;
  const prop = checker.getPropertyOfType(checker.getNonNullableType(literal), method.name.getText());
  return prop ? checker.getTypeOfSymbolAtLocation(prop, method) : undefined;
}
function returnsPromise(fn) {
  const signature = checker.getSignatureFromDeclaration(fn);
  return signature && isPromise(checker.getReturnTypeOfSignature(signature));
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || sf.fileName.includes("/node_modules/")) continue;
  if (only.length && !only.includes(sf.fileName)) continue;
  const visit = (n) => {
    if (ts.isExpressionStatement(n)) {
      const e = unwrap(n.expression);
      if (!ts.isVoidExpression(e) && !ts.isAwaitExpression(e) && !ts.isBinaryExpression(e) && !handled(e) && isPromise(typeOf(e))) report(n, "floating promise");
    }
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && isPromise(typeOf(unwrap(n.operand)))) report(n, "negated promise");
    if (ts.isConditionalExpression(n) && isPromise(typeOf(unwrap(n.condition)))) report(n.condition, "promise as condition");
    if ((ts.isIfStatement(n) || ts.isWhileStatement(n)) && isPromise(typeOf(unwrap(n.expression)))) report(n.expression, "promise as condition");
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if ((k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken) && isPromise(typeOf(unwrap(n.left)))) report(n.left, "promise as condition");
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.PlusEqualsToken].includes(k) && (isPromise(typeOf(unwrap(n.left))) || isPromise(typeOf(unwrap(n.right))))) report(n, "promise in + (text)");
      if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(k) && (isPromise(typeOf(unwrap(n.left))) || isPromise(typeOf(unwrap(n.right))))) report(n, "promise compared");
    }
    // An async function where a function returning void is expected:
    // nobody waits for it (event handlers, hooks typed `=> void`).
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent))) && returnsPromise(n)) {
      const contextual = ts.isMethodDeclaration(n) ? checker.getContextualTypeForObjectLiteralElement?.(n) ?? contextualMember(n) : checker.getContextualType(n);
      const signatures = contextual ? checker.getNonNullableType(contextual).getCallSignatures() : [];
      const returns = signatures.map((sig) => checker.getReturnTypeOfSignature(sig));
      if (returns.length && returns.every((r) => r.flags & (ts.TypeFlags.Void | ts.TypeFlags.Unknown | ts.TypeFlags.Any) || (r.isUnion() && r.types.some((t) => t.flags & ts.TypeFlags.Unknown)))) {
        const host = n.parent && ts.isCallExpression(n.parent) ? n.parent.expression.getText() : "";
        if (!IGNORED_HOSTS.test(host)) report(n, `async function where void/unknown is expected${host ? ` (${host.slice(-40)})` : ""}`);
      }
    }
    if (ts.isTemplateSpan(n) && isPromise(typeOf(unwrap(n.expression)))) report(n.expression, "promise in a template");
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (CALLBACK_METHODS.has(method))
        for (const arg of n.arguments) {
          const fn = unwrap(arg);
          if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && returnsPromise(fn)) report(arg, `async callback of ${method}`);
          else if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
            const sig = typeOf(fn).getCallSignatures()[0];
            if (sig && isPromise(checker.getReturnTypeOfSignature(sig))) report(arg, `async function given to ${method}`);
          }
        }
      const signature = checker.getResolvedSignature(n);
      const aggregate = AGGREGATES.test(callee.getText());
      n.arguments.forEach((arg, i) => {
        const e = unwrap(arg);
        const param = signature?.parameters[Math.min(i, (signature?.parameters.length ?? 1) - 1)];
        let paramType = param && checker.getTypeOfSymbolAtLocation(param, n);
        if (paramType && signature?.hasRestParameter && i >= signature.parameters.length - 1) paramType = checker.getIndexTypeOfType(paramType, ts.IndexKind.Number) ?? paramType;
        // A function returning a promise handed where one returning void goes.
        if (paramType && !ts.isArrowFunction(e) && !ts.isFunctionExpression(e) && !IGNORED_HOSTS.test(callee.getText())) {
          const given = typeOf(e).getCallSignatures();
          const wanted = checker.getNonNullableType(paramType).getCallSignatures();
          if (given.length && wanted.length && given.every((g) => isPromise(checker.getReturnTypeOfSignature(g))) && wanted.every((w) => checker.getReturnTypeOfSignature(w).flags & ts.TypeFlags.Void))
            report(arg, `async function given where void is expected (${callee.getText().slice(-40)})`);
        }
        if (aggregate || !loose(paramType)) return;
        const type = typeOf(e);
        if (isPromise(type)) report(arg, `promise given to ${callee.getText().slice(-40)}`);
        else if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) deep(e, callee.getText().slice(-40));
        else if (checker.isArrayType?.(type) && isPromise(checker.getIndexTypeOfType(type, ts.IndexKind.Number))) report(arg, `promises given to ${callee.getText().slice(-40)}`);
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
// Promises inside a literal that goes where any value goes.
function deep(literal, where) {
  const items = ts.isObjectLiteralExpression(literal)
    ? literal.properties.map((p) => (ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : ts.isSpreadAssignment(p) ? p.expression : null))
    : literal.elements;
  for (const item of items) {
    if (!item) continue;
    const e = unwrap(item);
    if (isPromise(typeOf(e))) report(item, `promise inside what goes to ${where}`);
    else if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) deep(e, where);
  }
}

if (process.argv.includes("--json")) console.log(JSON.stringify(findings, null, 2));
else for (const f of findings) console.log(f);
console.error(`${findings.length} findings`);
process.exit(findings.length ? 1 : 0);
