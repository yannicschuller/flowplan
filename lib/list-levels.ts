// Markers of nested lists by level (#234), as in Notion, Google Docs and
// Word: numbered lists 1. → a. → i., bullets • → ◦ → ▪, again from the
// fourth level. The level counts every list item around a list, whatever
// its kind: a numbered list inside a bullet or a task on level 2 counts
// a., b., c. Only the look changes – the document, the Markdown export
// ("1.") and the stored HTML stay as they are. DOCX writes the same levels
// as Word numbering (lib/export-docx.ts).
//
// The rules are written with :where(), so they weigh as little as the scope
// alone: lists that hide their markers (task lists, tables of contents,
// lists of the app around the text) keep doing so.
export const LIST_MARKERS = {
  ol: ["decimal", "lower-alpha", "lower-roman"],
  ul: ["disc", "circle", "square"],
} as const;
// Levels with a rule of their own; deeper lists keep the last one's marker.
export const LIST_LEVELS = 9;

export const listMarker = (tag: "ol" | "ul", level: number) => LIST_MARKERS[tag][Math.max(0, level) % 3];

// The rules for the lists below `scope` (".document-editor", ".print-book"
// or "" for a whole document), one per kind and level, deeper ones last.
export function listLevelCss(scope: string, levels = LIST_LEVELS) {
  const rules: string[] = [];
  for (const tag of ["ol", "ul"] as const)
    for (let level = 0; level < levels; level++) {
      const selector = [scope, ...Array.from({ length: level }, () => ":where(li)"), `:where(${tag})`].filter(Boolean).join(" ");
      rules.push(`${selector} { list-style-type: ${listMarker(tag, level)}; }`);
    }
  return rules.join("\n");
}
