// Cursors and hover feedback (app/globals.css, #543, #544, #545): the UI
// chrome shows the arrow, links and fields keep theirs, page rows show the
// pointer, and cards under the pointer do not move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("app/globals.css");
const rules = (source: string) =>
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim().replace(/\s+/g, " "), body] as const);
const all = rules(css);

test("the chrome rule shows the arrow, links and fields keep their cursor (#543)", () => {
  const chrome = all.findIndex(([selector, body]) => selector.startsWith(":where(") && selector.includes(".mobile-tab-bar") && /user-select:\s*none/.test(body));
  assert.ok(chrome >= 0);
  assert.match(all[chrome][1], /(^|;|\s)cursor:\s*default\s*(;|$)/);
  const after = (pattern: RegExp, cursor: string) => {
    const index = all.findIndex(([selector, body]) => pattern.test(selector) && new RegExp(`cursor:\\s*${cursor}`).test(body));
    assert.ok(index > chrome, `${pattern} keeps cursor: ${cursor} after the chrome rule`);
    assert.ok(all[index][0].startsWith(":where("), "with zero specificity, so component cursors win");
  };
  after(/a\[href\]/, "pointer");
  after(/textarea/, "text");
  after(/\.ProseMirror/, "auto");
});

test("page rows show the pointer, space titles grab only while dragged (#544)", () => {
  assert.ok(all.some(([selector, body]) => selector === ".page-nav" && /cursor:\s*pointer/.test(body)));
  assert.ok(all.some(([selector, body]) => selector === '.page-nav[draggable="true"]:active' && /cursor:\s*grabbing/.test(body)));
  assert.ok(!all.some(([selector, body]) => selector === '.nav-section-title[draggable="true"]' && /cursor/.test(body)));
  assert.ok(all.some(([selector, body]) => selector === '.nav-section-title[draggable="true"]:active' && /cursor:\s*grabbing/.test(body)));
});

test("cards and journal buttons do not move under the pointer (#545)", () => {
  const cards = [".record-card", ".recent-card", ".journal-today", ".journal-memory", ".journal-scale button"];
  for (const file of readdirSync("app").filter((name) => name.endsWith(".css"))) {
    for (const [selector, body] of rules(read(`app/${file}`))) {
      if (!selector.includes(":hover") || !cards.some((card) => selector.includes(card))) continue;
      assert.doesNotMatch(body, /translate|transform/, `${file}: ${selector} moves on hover`);
    }
  }
});
