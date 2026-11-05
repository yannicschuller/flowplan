// Regexes that backtracked exponentially (CodeQL js/redos) now run in linear
// time and still find what they found before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_LISTS } from "../lib/task-list-html";
import { previewKind } from "../lib/code-block-options";
import { markdownToRawHtml } from "../lib/markdown-html";
import { chatTextToHtml } from "../lib/chat-paste";

const fast = (run: () => unknown) => {
  const start = performance.now();
  run();
  const ms = performance.now() - start;
  assert.ok(ms < 100, `took ${Math.round(ms)} ms`);
};

test("task lists are found in linear time (#21, #22, #30, #31)", () => {
  const attack = "<ul><li><input" + 'type="checkbox"type="checkbox"></li><li><input'.repeat(50_000);
  fast(() => attack.replace(TASK_LISTS, () => "x"));
  fast(() => '<ul><li><input type="checkbox">'.repeat(50_000).replace(TASK_LISTS, () => "x"));
});

test("pasted chat checklists still become task lists", () => {
  assert.equal(
    chatTextToHtml("☐ one\n☑ two"),
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>one</p></li>\n<li data-type="taskItem" data-checked="true"><p>two</p></li>\n</ul>\n',
  );
});

test("task lists match as the regex did", () => {
  const items = (html: string) => html.replace(TASK_LISTS, (list, inner) => `[${list === html ? "all" : list}|${inner}]`);
  assert.equal(items('<ul>\n<li><input type="checkbox"> a</li>\n</ul>'), '[all|<li><input type="checkbox"> a</li>\n]');
  // The first item decides, and the list runs to the first "</li> </ul>".
  assert.equal(
    items('<ul>\n<li><input disabled="" type="checkbox"> a</li>\n<li>b</li>\n</ul>'),
    '[all|<li><input disabled="" type="checkbox"> a</li>\n<li>b</li>\n]',
  );
  assert.equal(items("<ul><li>a</li></ul>"), "<ul><li>a</li></ul>");
  assert.equal(items('<ul><li><input type="radio"></li></ul>'), '<ul><li><input type="radio"></li></ul>');
  assert.equal(
    items('<p>x</p><ul><li><input type="checkbox">a</li></ul><ul><li><input type="checkbox" checked>b</li> </ul>'),
    '<p>x</p>[<ul><li><input type="checkbox">a</li></ul>|<li><input type="checkbox">a</li>][<ul><li><input type="checkbox" checked>b</li> </ul>|<li><input type="checkbox" checked>b</li> ]',
  );
  assert.equal(
    markdownToRawHtml("- [x] done\n- [ ] open 📅 2026-05-04"),
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li>\n<li data-type="taskItem" data-checked="false" data-due="2026-05-04"><p>open</p></li>\n</ul>\n',
  );
});

test("SVG roots are recognised in linear time (#72, #73)", () => {
  fast(() => assert.equal(previewKind("xml", "<!--" + "-->&lt;!--".repeat(50_000)), null));
  fast(() => assert.equal(previewKind("xml", "<!--" + "-->&lt;!--".repeat(50_000) + "--><svg>"), "svg"));
  fast(() => assert.equal(previewKind("xml", "<!--" + "--><!DOCTYPE".repeat(50_000)), null));
});

test("SVG roots are recognised as the regex did", () => {
  const svg = (text: string) => previewKind("xml", text) === "svg";
  assert.ok(svg("<svg></svg>"));
  assert.ok(svg('  <?xml version="1.0"?>\n<SVG\nviewBox="0 0 1 1"/>'));
  assert.ok(svg("<!-- a --> <!-- b -->\n<svg>"));
  assert.ok(svg('<!-- a --><!DOCTYPE svg PUBLIC "x">\n<!-- b --><svg>'));
  assert.ok(svg('<?xml?><!doctype svg><!-- b --> <svg >'));
  // A run of comments counted as one, from "<!--" to any later "-->".
  assert.ok(svg("<!-- a --> b --><svg>"));
  assert.ok(!svg("<root/>"));
  assert.ok(!svg("<svgx>"));
  assert.ok(!svg("<!--><svg>"));
  assert.ok(!svg("<!-- a --> b <svg>"));
  assert.ok(!svg("<!DOCTYPE svg><!DOCTYPE svg><svg>"));
});
