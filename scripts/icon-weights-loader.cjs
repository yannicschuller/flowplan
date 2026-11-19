// Turbopack loader for @phosphor-icons/react (next.config.ts, turbopack.rules):
// every icon brings its paths in six weights (thin, light, regular, bold,
// fill, duotone) – about 1 KB gzip per icon, some 300 icons in the shared
// JavaScript. Flowplan draws icons only in the weights WEIGHTS names; the
// other entries of an icon's weight map (dist/defs/<Icon>.es.js) go.
// tests/icon-weights.test.ts checks that the code asks for no other weight.
//
// A definition file is a Map literal of [weight, element] pairs:
//   const a = new Map([["bold", e.createElement(…)], ["duotone", …], …]);
// The loader splits it at the top-level pairs by bracket depth (path data
// holds no brackets or quotes that could confuse it) and fails the build on
// anything else, so a changed format of a future version is noticed.
"use strict";

const WEIGHTS = ["regular", "bold", "fill", "duotone"];

function stripWeights(source, keep) {
  const start = source.indexOf("new Map([");
  if (start < 0) throw new Error("icon-weights-loader: no weight map found");
  const open = start + "new Map(".length; // at "["
  let depth = 0;
  let inString = null;
  let entryStart = -1;
  const entries = [];
  let end = -1;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inString = c;
    else if (c === "[" || c === "(" || c === "{") {
      depth++;
      if (depth === 2 && c === "[") entryStart = i;
    } else if (c === "]" || c === ")" || c === "}") {
      if (depth === 2 && c === "]") entries.push([entryStart, i + 1]);
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0 || entries.length === 0) throw new Error("icon-weights-loader: unexpected weight map");
  const kept = entries
    .map(([a, b]) => source.slice(a, b))
    .filter((entry) => {
      const name = /^\[\s*"([a-z]+)"/.exec(entry);
      if (!name) throw new Error("icon-weights-loader: unexpected weight entry");
      return keep.includes(name[1]);
    });
  return source.slice(0, open + 1) + kept.join(",") + source.slice(end);
}

module.exports = function iconWeightsLoader(source) {
  return stripWeights(source, WEIGHTS);
};
module.exports.stripWeights = stripWeights;
module.exports.WEIGHTS = WEIGHTS;
