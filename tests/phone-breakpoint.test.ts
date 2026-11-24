// The phone layout ends where the tablet/desktop layout starts (#510): below
// 768 px the sidebar is a drawer, from 768 px it is docked and can be
// collapsed. Windows with display scaling (125 %, 150 %) have fractional
// CSS widths – half a 1920 px screen at 125 % is about 767.2 px – and there
// "max-width: 767px" and "min-width: 768px" both fail: the sidebar stayed
// docked with neither the drawer's button nor a working hide button. The
// phone side of the boundary is "max-width: 767.98px" everywhere, in the
// style sheets and in the media queries of the components.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

test("no media or container query leaves a gap below 768 px", () => {
  const sources = [...files("app", /\.css$/), ...files("components", /\.tsx?$/), ...files("lib", /\.tsx?$/)];
  const gaps: string[] = [];
  for (const file of sources) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/max-width:\s*767px/.test(line)) gaps.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(gaps, [], "use max-width: 767.98px – a fractional width such as 767.2 px matches neither 767px nor 768px");
});

test("767.98px covers the fractional widths of the usual Windows scales", () => {
  // Widths just below 768 CSS px at 125 %, 150 %, 175 % and 200 %.
  for (const scale of [1.25, 1.5, 1.75, 2]) {
    const width = (Math.ceil(768 * scale) - 1) / scale;
    assert.ok(width < 768 && width <= 767.98, `${width} at ${scale}`);
  }
});
