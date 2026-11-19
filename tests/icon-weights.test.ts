// The build keeps only some weights of every Phosphor icon
// (scripts/icon-weights-loader.cjs): the code must ask for no other one, and
// the loader must keep exactly those of an icon's weight map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { stripWeights, WEIGHTS } = require("../scripts/icon-weights-loader.cjs") as {
  stripWeights: (source: string, keep: string[]) => string;
  WEIGHTS: string[];
};
const ALL = ["thin", "light", "regular", "bold", "fill", "duotone"];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield path;
  }
}

test("the code draws icons only in the weights the build keeps", () => {
  const found: string[] = [];
  for (const dir of ["app", "components", "lib"])
    for (const file of sources(dir)) {
      const text = readFileSync(file, "utf8");
      // weight="x", weight={… "x" …} and weight: "x" (IconContext, props objects).
      for (const match of text.matchAll(/\bweight(?:=\{([^}]*)\}|=("[a-z]+")|:\s*("[a-z]+"))/g)) {
        const expression = match[1] ?? match[2] ?? match[3];
        for (const literal of expression.matchAll(/"([a-z]+)"/g))
          if (ALL.includes(literal[1]) && !WEIGHTS.includes(literal[1])) found.push(`${file}: ${match[0]}`);
      }
      if (/IconContext/.test(text) && file.endsWith("x")) found.push(`${file}: IconContext (check its weight)`);
    }
  assert.deepEqual(found, []);
});

test("the loader keeps the listed weights of an icon definition", () => {
  const source = readFileSync("node_modules/@phosphor-icons/react/dist/defs/Tag.es.js", "utf8");
  const out = stripWeights(source, WEIGHTS);
  for (const weight of ALL) assert.equal(out.includes(`"${weight}"`), WEIGHTS.includes(weight), weight);
  // Still a module with its default export, smaller by the dropped weights.
  assert.match(out, /export \{\s*\w+ as default\s*\}/);
  assert.ok(out.length < source.length * 0.8);
  assert.throws(() => stripWeights("export default 1;", WEIGHTS), /no weight map/);
});
