// The global stylesheets are appended to by many changes; an unclosed rule
// silently swallows every rule after it, and a leftover merge marker breaks
// the production build. Both are caught here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const file of ["app/globals.css", "app/mobile-ux.css"]) {
  test(`${file} has balanced braces and no merge markers`, () => {
    const css = readFileSync(file, "utf8");
    assert.doesNotMatch(css, /^(<<<<<<<|=======|>>>>>>>)( |$)/m, "leftover merge marker");
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
    let depth = 0;
    let line = 1;
    for (const c of code) {
      if (c === "\n") line++;
      if (c === "{") depth++;
      if (c === "}") depth--;
      assert.ok(depth >= 0, `closing brace without an opening one near line ${line} (comments removed)`);
    }
    assert.equal(depth, 0, "a rule is not closed");
  });
}
