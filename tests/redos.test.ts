// Regexes that backtracked exponentially (CodeQL js/redos) now run in linear
// time and still find what they found before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewKind } from "../lib/code-block-options";
import { markdownToRawHtml } from "../lib/markdown-html";
import { chatTextToHtml } from "../lib/chat-paste";

const fast = (run: () => unknown) => {
  const start = performance.now();
  run();
  const ms = performance.now() - start;
  assert.ok(ms < 100, `took ${Math.round(ms)} ms`);
};

// Task lists are rendered from marked's tokens now (lib/task-list-html.ts),
// no regex runs over the HTML any more.
test("task lists are rendered in linear time (#21, #22, #30, #31)", () => {
  // marked itself takes a while for long lists: a looser bound than fast().
  for (const markdown of ["- [ ] a\n".repeat(5_000), "- [ ] a\n  - [x] b\n".repeat(2_000), '<ul><li><input type="checkbox">'.repeat(50_000)]) {
    const start = performance.now();
    markdownToRawHtml(markdown);
    chatTextToHtml(markdown);
    assert.ok(performance.now() - start < 3000);
  }
});

test("pasted chat checklists still become task lists", () => {
  assert.equal(
    chatTextToHtml("☐ one\n☑ two"),
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>one</p></li>\n<li data-type="taskItem" data-checked="true"><p>two</p></li>\n</ul>\n',
  );
});

test("task lists keep their items and due dates", () => {
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
