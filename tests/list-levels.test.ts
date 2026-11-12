import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_LEVELS, listLevelCss, listMarker } from "../lib/list-levels";
// The export modules open the database: a folder of their own.
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-list-levels-"));
const { PRINT_STYLE } = await import("../lib/export-pdf");
const { EPUB_STYLE } = await import("../lib/export-epub");

// Nested lists (#234): 1. → a. → i. and • → ◦ → ▪, again from level 4.
test("list markers change per level and repeat from the fourth", () => {
  assert.deepEqual(
    Array.from({ length: 7 }, (_, level) => listMarker("ol", level)),
    ["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman", "decimal"],
  );
  assert.deepEqual(
    Array.from({ length: 4 }, (_, level) => listMarker("ul", level)),
    ["disc", "circle", "square", "disc"],
  );
  const css = listLevelCss(".scope", 3);
  // The level counts the list items around a list, of any kind.
  assert.match(css, /^\.scope :where\(ol\) \{ list-style-type: decimal; \}$/m);
  assert.match(css, /^\.scope :where\(li\) :where\(ol\) \{ list-style-type: lower-alpha; \}$/m);
  assert.match(css, /^\.scope :where\(li\) :where\(li\) :where\(ul\) \{ list-style-type: square; \}$/m);
  // Without a scope (e-books) the rules start at the list.
  assert.match(listLevelCss("", 1), /^:where\(ol\) \{/m);
});

test("the editor, the combined print view and e-books number lists alike", () => {
  // app/globals.css holds the editor's rules as written; they stay what
  // lib/list-levels.ts gives (published pages and a page's print use them).
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const rule of listLevelCss(".document-editor").split("\n")) assert.ok(globals.includes(rule), `globals.css lacks: ${rule}`);
  assert.equal(listLevelCss(".document-editor").split("\n").length, LIST_LEVELS * 2);
  assert.ok(PRINT_STYLE.includes(listLevelCss(".print-book")));
  assert.ok(EPUB_STYLE.includes(listLevelCss("")));
  // Task lists and tables of contents keep hiding their markers: their
  // rules weigh more than the :where() ones.
  assert.match(PRINT_STYLE, /\.print-book ul\.task-list \{ list-style: none;/);
  assert.match(PRINT_STYLE, /\.print-book \.toc ol \{ list-style: none;/);
});
