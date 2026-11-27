// Charts of one colour follow the accent (#590, lib/chart-colors.ts,
// --chart-accent in app/globals.css): sparklines, charts of a single series
// and usage rings and meters take the workspace's accent; charts of several
// series keep the colour-blind-safe palette. The accent the look sets is
// readable on every background in light and dark, also for light colours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACCENT_SERIES, SERIES, seriesColor } from "../lib/chart-colors";
import { BACKGROUND_PRESETS, contrast, derivePalette, themeVariables } from "../lib/workspace-theme";

test("one series in the first colour takes the accent; several series and chosen colours keep the palette", () => {
  assert.equal(seriesColor(undefined, 0, 1), ACCENT_SERIES);
  assert.equal(seriesColor(0, 0, 1), ACCENT_SERIES);
  // A single series coloured on purpose (errors, storage) keeps its colour.
  assert.equal(seriesColor(1, 0, 1), SERIES[1]);
  assert.equal(seriesColor(3, 0, 1), SERIES[3]);
  // Several series: the palette, unchanged.
  assert.deepEqual([0, 1, 2].map((k) => seriesColor(undefined, k, 3)), [SERIES[0], SERIES[1], SERIES[2]]);
  assert.equal(seriesColor(0, 0, 2), "var(--chart-1)");
  assert.equal(seriesColor(9, 0, 2), SERIES[SERIES.length - 1], "out of range: the neutral colour");
});

test("--chart-accent is the look's accent, else Flowplan's --chart-1; the palette itself stays", () => {
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(css, /--chart-accent: var\(--accent, var\(--chart-1\)\);/);
  assert.match(css, /:root \{\n  --chart-accent[^}]*--chart-1: #3b3fd8;\n  --chart-2: #eb6834;\n  --chart-3: #1baf7a;\n  --chart-4: #eda100;\n  --chart-5: #e87ba4;/);
  assert.match(css, /\[data-theme="dark"\] \{\n  --chart-1: #7a80f5;\n  --chart-2: #d95926;/);
  // Single-colour meters and rings.
  const rule = (file: string, selector: string) => {
    const text = readFileSync(file, "utf8");
    const at = text.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${file}: ${selector}`);
    return text.slice(at, text.indexOf("}", at));
  };
  for (const [file, selector] of [
    ["app/globals.css", ".mon-share-fill"],
    ["app/globals.css", ".settings-tile-meter > span"],
    ["app/globals.css", ".mon-bars b"],
    ["app/admin-monitoring.css", ".mon-kpi-meter b"],
    ["app/settings-screen.css", ".sv-ring-value"],
  ])
    assert.match(rule(file, selector), /var\(--chart-accent\)/, `${file} ${selector}`);
  // Two-part bars keep the palette.
  assert.match(rule("app/settings-screen.css", ".sv-stack-a"), /var\(--chart-1\)/);
  // The sparkline uses the shared colours.
  assert.match(readFileSync("components/sparkline.tsx", "utf8"), /seriesColor\(tone - 1, 0, 1\)/);
});

test("the accent a look sets is readable as a chart colour (3:1) on every background, also a very light or very dark one", () => {
  for (const accent of ["#ffff00", "#fff9c4", "#e0f7fa", "#ffffff", "#000000", "#3b3fd8", "#0f766e", "#be123c"])
    for (const preset of BACKGROUND_PRESETS)
      for (const mode of ["light", "dark"] as const) {
        const vars = themeVariables({ accent, background: preset.id }, mode);
        const chart = vars["--accent"]!;
        assert.equal(chart, derivePalette(accent, mode, preset.id).blue);
        for (const bg of [preset[mode].bg, preset[mode].surface, preset[mode].sidebar])
          assert.ok(contrast(chart, bg) >= 3, `${accent} ${preset.id} ${mode}: ${chart} on ${bg} = ${contrast(chart, bg).toFixed(2)}`);
      }
});
