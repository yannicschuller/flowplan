// Automatic links of a workspace (#202): templates, validation, matching
// (lib/auto-link.ts) and linking while typing and pasting in the editor
// (lib/auto-link-plugin.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Slice, type Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import {
  autoLinkHref,
  compilePattern,
  compileRules,
  expandTemplate,
  findAutoLinks,
  hasNestedQuantifier,
  ruleProblems,
  type AutoLinkRule,
} from "../lib/auto-link";
import { autoLinkKey, autoLinkPlugin, setAutoLinkRules, undoAutoLink, workspaceAutoLinkRules } from "../lib/auto-link-plugin";

const rule = (pattern: string, template: string, extra: Partial<AutoLinkRule> = {}): AutoLinkRule => ({ id: pattern, name: "", pattern, template, enabled: true, ...extra });
const JIRA = rule("\\bABC-\\d+\\b", "https://jira.example/browse/{match}");
const ISSUE = rule("#(\\d+)", "https://github.com/acme/app/issues/$1");

// ---- Templates ----

test("templates put in the match and its groups, URL-encoded", () => {
  assert.equal(expandTemplate("https://x.example/{match}", ["ABC-1"]), "https://x.example/ABC-1");
  assert.equal(expandTemplate("https://x.example/$1/{2}?q={match}", ["a b", "c/d", "e&f"]), "https://x.example/c%2Fd/e%26f?q=a%20b");
  assert.equal(expandTemplate("https://x.example/$3{3}", ["x"]), "https://x.example/", "missing groups are empty");
  assert.equal(expandTemplate("https://x.example/?q=#{match}", ["ä?#"]), "https://x.example/?q=#%C3%A4%3F%23");
  assert.equal(expandTemplate("mailto:{match}", ["a@b.example"]), "mailto:a%40b.example");
});

test("only http(s) and mailto addresses come out; anything else links nothing", () => {
  assert.equal(autoLinkHref("https://jira.example/browse/{match}", ["ABC-1"]), "https://jira.example/browse/ABC-1");
  assert.equal(autoLinkHref("{match}", ["javascript:alert(1)"]), null, "the scheme cannot come from the text");
  assert.equal(autoLinkHref("javascript:alert('{match}')", ["x"]), null);
  assert.equal(autoLinkHref("data:text/html,{match}", ["x"]), null);
  assert.equal(autoLinkHref("ftp://x.example/{match}", ["x"]), null);
  assert.equal(autoLinkHref("https://", []), null);
});

test("rules are validated: pattern, template, length, empty matches, nested repeats", () => {
  assert.deepEqual(ruleProblems(JIRA), []);
  assert.deepEqual(ruleProblems(ISSUE), []);
  assert.deepEqual(ruleProblems(rule("", "https://x.example/{match}")), ["pattern-empty"]);
  assert.deepEqual(ruleProblems(rule("(ABC", "https://x.example/{match}")), ["pattern-invalid"]);
  assert.deepEqual(ruleProblems(rule("x".repeat(201), "https://x.example/{match}")), ["pattern-long"]);
  assert.deepEqual(ruleProblems(rule("a*", "https://x.example/{match}")), ["pattern-empty-match"]);
  assert.deepEqual(ruleProblems(rule("(?:)|ABC", "https://x.example/{match}")), ["pattern-empty-match"]);
  assert.deepEqual(ruleProblems(rule("\\b", "https://x.example/{match}")), ["pattern-empty-match"]);
  assert.deepEqual(ruleProblems(rule("(a+)+$", "https://x.example/{match}")), ["pattern-nested"]);
  assert.deepEqual(ruleProblems(rule("(?:\\d*x)*y", "https://x.example/{match}")), ["pattern-nested"]);
  assert.deepEqual(ruleProblems(rule("ABC", "")), ["template-empty"]);
  assert.deepEqual(ruleProblems(rule("ABC", "javascript:alert(1)")), ["template-scheme"]);
  assert.deepEqual(ruleProblems(rule("ABC", "{match}")), ["template-scheme"]);
  assert.deepEqual(ruleProblems(rule("ABC", "https://")), ["template-scheme"]);
  assert.deepEqual(ruleProblems(rule("ABC", `https://x.example/${"a".repeat(500)}`)), ["template-long"]);
  assert.deepEqual(ruleProblems({ ...JIRA, name: "n".repeat(61) }), ["name-long"]);
  // Bounded or plain repeats are fine; classes and escapes are not groups.
  assert.equal(hasNestedQuantifier("(ab)+"), false);
  assert.equal(hasNestedQuantifier("([a+]x)+"), false);
  assert.equal(hasNestedQuantifier("\\(a+\\)+"), false);
  assert.equal(hasNestedQuantifier("(\\d+){2,}"), true);
  // Patterns written without the Unicode syntax still compile.
  assert.ok(compilePattern("ABC\\-\\d+"));
  assert.equal(compilePattern("ABC\\-\\d+")!.flags, "g");
  assert.equal(compilePattern("\\p{Lu}+-\\d+")!.flags, "gu");
});

test("matches: every rule, no overlaps, first rule wins a tie, disabled and invalid rules ignored", () => {
  const rules = compileRules([JIRA, ISSUE, rule("ABC-\\d+", "https://other.example/{match}"), rule("XYZ-\\d+", "https://x.example/{match}", { enabled: false }), rule("(a+)+", "https://x.example/")]);
  assert.equal(rules.length, 3);
  const found = findAutoLinks("See ABC-12, #7 and abc-1 or XYZ-3.", rules);
  assert.deepEqual(
    found.map((m) => [m.text, m.href]),
    [
      ["ABC-12", "https://jira.example/browse/ABC-12"],
      ["#7", "https://github.com/acme/app/issues/7"],
    ],
  );
  assert.deepEqual(findAutoLinks("", rules), []);
  // The compiled rule set is kept while the rules stay the same.
  setAutoLinkRules([JIRA]);
  const first = workspaceAutoLinkRules();
  setAutoLinkRules([{ ...JIRA }]);
  assert.equal(workspaceAutoLinkRules(), first);
  setAutoLinkRules([]);
  assert.equal(workspaceAutoLinkRules().length, 0);
});

// ---- In the editor ----

const schema = documentSchema();
const p = (...content: (string | Node)[]) => schema.nodes.paragraph.create(null, content.map((c) => (typeof c === "string" ? schema.text(c) : c)));
const doc = (...nodes: Node[]) => schema.nodes.doc.create(null, nodes);
const rules = compileRules([JIRA, ISSUE]);
const create = (d: Node, at?: number) => {
  const state = EditorState.create({ schema, doc: d, plugins: [autoLinkPlugin({ rules: () => rules })] });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at ?? state.doc.content.size - 1)));
};
const apply = (state: EditorState, tr: Transaction) => state.applyTransaction(tr).state;
const type = (state: EditorState, text: string) => {
  for (const ch of text) state = apply(state, state.tr.insertText(ch));
  return state;
};
const links = (state: EditorState) => {
  const out: [string, string][] = [];
  state.doc.descendants((node) => {
    const mark = node.marks.find((m) => m.type.name === "link");
    if (node.isText && mark) out.push([node.text!, mark.attrs.href]);
  });
  return out;
};

test("typing a word boundary after a match links it; typing on inside the word does not", () => {
  let state = create(doc(p("See ")));
  state = type(state, "ABC-12");
  assert.deepEqual(links(state), [], "not while the word is being typed");
  state = type(state, " ");
  assert.deepEqual(links(state), [["ABC-12", "https://jira.example/browse/ABC-12"]]);
  state = type(state, "and #42.");
  assert.deepEqual(links(state), [
    ["ABC-12", "https://jira.example/browse/ABC-12"],
    ["#42", "https://github.com/acme/app/issues/42"],
  ]);
  assert.equal(state.doc.textContent, "See ABC-12 and #42.");
});

test("a Markdown delimiter after a match waits: `ABC-1` can still become code", () => {
  let state = type(create(doc(p("Code: "))), "`ABC-1`");
  assert.deepEqual(links(state), []);
  state = type(state, " ");
  assert.deepEqual(links(state), [], "the delimiter, not the match, ends at the boundary");
  state = type(create(doc(p("x "))), "ABC-2* ");
  assert.deepEqual(links(state), []);
});

test("Enter after a match links it", () => {
  let state = type(create(doc(p("Fix "))), "ABC-7");
  state = apply(state, state.tr.split(state.selection.from));
  assert.deepEqual(links(state), [["ABC-7", "https://jira.example/browse/ABC-7"]]);
  assert.equal(state.doc.childCount, 2);
});

test("pasting text links every match in it", () => {
  let state = create(doc(p("Notes: ")));
  const pasted = new Slice(p("ABC-1, ABC-22 and #3").content, 0, 0);
  state = apply(state, state.tr.replaceSelection(pasted).setMeta("uiEvent", "paste").setMeta("paste", true));
  assert.deepEqual(links(state).map(([text]) => text), ["ABC-1", "ABC-22", "#3"]);
  // Typing on right after a pasted link does not extend it.
  assert.ok(state.storedMarks && !state.storedMarks.some((m) => m.type.name === "link"));
  state = type(state, "x");
  assert.deepEqual(links(state).map(([text]) => text), ["ABC-1", "ABC-22", "#3"]);
  // Inserted the same way by the program (a template, the AI): no links.
  let other = create(doc(p("Notes: ")));
  other = apply(other, other.tr.replaceSelection(new Slice(p("ABC-1, ABC-22 and #3").content, 0, 0)));
  assert.deepEqual(links(other), []);
});

test("undo right after takes back only the automatic link", () => {
  let state = type(create(doc(p("See "))), "ABC-12 ");
  assert.equal(links(state).length, 1);
  let sent: Transaction | null = null;
  assert.equal(undoAutoLink(state, (tr) => (sent = tr)), true);
  assert.equal(sent!.getMeta("addToHistory"), false, "not a step of its own in the undo history");
  state = apply(state, sent!);
  assert.deepEqual(links(state), []);
  assert.equal(state.doc.textContent, "See ABC-12 ", "the text stays");
  assert.equal(undoAutoLink(state), false, "a second undo is the usual undo");
  // Once something else happened, undo is the usual undo again.
  let later = type(create(doc(p("See "))), "ABC-12 x");
  assert.equal(links(later).length, 1);
  assert.equal(undoAutoLink(later), false);
  later = type(create(doc(p("See "))), "ABC-12 ");
  later = apply(later, later.tr.setSelection(TextSelection.create(later.doc, 2)));
  assert.equal(autoLinkKey.getState(later)!.added, null);
});

test("never in code, existing links, math, remote changes or undo", () => {
  // Code block.
  const code = schema.nodes.codeBlock.create(null, schema.text("x"));
  let state = create(doc(code), 2);
  state = type(state, "ABC-1 ");
  assert.deepEqual(links(state), []);
  // Inline code: the typed text carries the code mark.
  state = create(doc(p(schema.text("ABC-1", [schema.marks.code.create()]))));
  state = apply(state, state.tr.insertText(" "));
  assert.deepEqual(links(state), []);
  // An existing link stays as it is.
  state = create(doc(p(schema.text("ABC-1", [schema.marks.link.create({ href: "https://mine.example/" })]))));
  state = apply(state, state.tr.insertText(" "));
  assert.deepEqual(links(state).map(([, href]) => href), ["https://mine.example/"]);
  // Inline math is an atom: no match runs across it.
  const math = schema.nodes.mathInline.create({ latex: "x" });
  state = create(doc(p("ABC-", math, "1")));
  state = apply(state, state.tr.insertText(" "));
  assert.deepEqual(links(state), []);
  // Someone else's typing arrives through collaboration: not linked here.
  state = create(doc(p("ABC-1")));
  state = apply(state, state.tr.insertText(" ").setMeta("y-sync$", { isChangeOrigin: true }));
  assert.deepEqual(links(state), []);
  // Content set by the program (setContent) or redone history.
  state = create(doc(p("ABC-1")));
  state = apply(state, state.tr.insertText(" ").setMeta("preventUpdate", true));
  assert.deepEqual(links(state), []);
  state = create(doc(p("ABC-1")));
  state = apply(state, state.tr.insertText(" ").setMeta("addToHistory", false));
  assert.deepEqual(links(state), []);
});

test("existing text elsewhere is not linked retroactively", () => {
  let state = create(doc(p("Old ABC-1 here"), p("New ")));
  state = type(state, "word ");
  assert.deepEqual(links(state), []);
  // Typing a space right after old text in the middle of a block links only
  // what ends at the typed boundary.
  state = create(doc(p("ABC-1 and ABC-2")), 16);
  state = type(state, " ");
  assert.deepEqual(links(state).map(([t]) => t), ["ABC-2"]);
});
