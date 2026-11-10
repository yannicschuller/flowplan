import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #182: an effect (or, in React 19, a ref callback) written as an arrow
// without braces returns its expression – and React keeps that as the
// cleanup. Newer Chromium (Chrome 156, the desktop app's Electron 45)
// returns a Promise from scrollIntoView, scrollTo and scrollBy, so
// `useEffect(() => el?.scrollIntoView(…))` made React call a Promise when
// the workflow builder's placeholder picker closed: "i is not a function",
// and the builder was gone. Firefox and older Chromium return undefined.
// Such calls belong in a block.

const root = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

const SCROLL = /\.scroll(?:IntoView|To|By)\(/;
// From `from` (just after an opening bracket) to its closing bracket at the
// same depth, or to the first top-level comma: strings, template literals
// (with their ${…}) and comments skipped.
function until(source: string, from: number, stopAtComma: boolean): string {
  const closers: string[] = [];
  let i = from;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
    } else if (c === "`") {
      for (i++; i < source.length && source[i] !== "`"; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === "$" && source[i + 1] === "{") i += until(source, i + 2, false).length + 2;
      }
    } else if (c === "/" && source[i + 1] === "/") i = source.indexOf("\n", i);
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 1;
    else if (c === "(" || c === "[" || c === "{") closers.push(c === "(" ? ")" : c === "[" ? "]" : "}");
    else if (c === ")" || c === "]" || c === "}") {
      if (!closers.length) break;
      closers.pop();
    } else if (c === "," && stopAtComma && !closers.length) break;
    if (i < 0) break;
  }
  return source.slice(from, i);
}
// The body of an arrow written without braces (not `void …`), or null.
function conciseBody(fn: string): string | null {
  const m = /^\s*(?:async\s*)?(?:\([^()]*\)|\w+)\s*(?::[^=]+)?=>\s*/.exec(fn);
  if (!m) return null;
  const body = fn.slice(m[0].length);
  return body.startsWith("{") || /^void\b/.test(body) ? null : body;
}
function offenders(source: string, name = "x.tsx"): string[] {
  const found: string[] = [];
  const line = (at: number) => `${name}:${source.slice(0, at).split("\n").length}`;
  for (const m of source.matchAll(/\buse(?:Layout|Insertion)?Effect\(/g)) {
    const body = conciseBody(until(source, m.index + m[0].length, true));
    if (body !== null && SCROLL.test(body)) found.push(line(m.index));
  }
  for (const m of source.matchAll(/\bref=\{/g)) {
    const body = conciseBody(until(source, m.index + m[0].length, false));
    if (body !== null && SCROLL.test(body)) found.push(line(m.index));
  }
  return found;
}

test("the check finds an effect or ref callback that returns a scroll call", () => {
  assert.equal(offenders("useEffect(() => document.getElementById(`${list}-${active}`)?.scrollIntoView({ block: \"nearest\" }), [active, list]);").length, 1, "the picker of #182");
  assert.equal(offenders("React.useLayoutEffect(() =>\n  list.current\n    ?.querySelector(`[data-i]`)\n    ?.scrollIntoView(), []);").length, 1);
  assert.equal(offenders("useEffect(() => (open ? box.current?.scrollTo(0, 0) : undefined), [open]);").length, 1);
  assert.equal(offenders("useEffect(() => open && window.scrollBy(0, 1), [open]);").length, 1);
  assert.equal(offenders("const a = <div ref={(el) => el?.scrollIntoView({ block: \"center\" })} />;").length, 1);
  assert.equal(offenders("useEffect(() => {\n  el?.scrollIntoView();\n}, []);").length, 0, "a block returns nothing");
  assert.equal(offenders("useEffect(() => void el?.scrollTo(0, 0), []);").length, 0, "void returns undefined");
  assert.equal(offenders("useEffect(() => setActive(0), [query]);").length, 0);
  assert.equal(offenders("const onPan = useCallback((dx, dy) => scroller.current?.scrollBy(dx, dy), []);").length, 0, "not an effect");
});

test("no effect or ref callback in the app returns a scroll call (#182)", () => {
  const found = ["components", "app", "lib"].flatMap(files).flatMap((file) => offenders(readFileSync(join(root, file), "utf8"), file));
  assert.deepEqual(found, []);
});
