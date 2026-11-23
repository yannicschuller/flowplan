// Formulas typed with dollars (#446), by the rule of lib/math-dollars.ts:
//
// - Typing the closing "$" of $…$ turns it into an inline formula
//   (mathInline); "costs $5 and $10" stays text. A digit typed right after
//   the closing "$" takes the formula back – "$5 and 6$5" is text, as in
//   Pandoc, whose rule looks at the character after the "$".
// - Typing the closing "$$" of $$…$$: a paragraph made only of it becomes a
//   formula block (mathBlock); inside a sentence it becomes an inline
//   formula with that content – the editor has no display-style formula
//   inside a line, and taking the sentence apart would be a surprise.
// - "$$" at the start of an empty paragraph, then a space or Enter, takes
//   the "$$" away and opens the formula dialog for a new formula block (as
//   /math does; Cancel leaves the empty paragraph).
//
// Never inside code (code blocks, inline code) or across anything that is
// not text. Backspace or ⌘/Ctrl+Z right after a conversion brings the typed
// text back (TipTap's undoInputRule) – also with the collaboration's undo,
// which would otherwise take the typing of the last half second along.
import { Extension, InputRule, type AnyExtension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { dollarMathAtEnd, insideOpenDollarMath, type DollarMath } from "./math-dollars";

type Converted = { end: number; inline: boolean } | null;
export const mathDollarKey = new PluginKey<Converted>("mathDollars");

function hasCode(doc: PMNode, from: number, to: number) {
  let code = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.marks.some((mark) => mark.type.spec.code)) code = true;
    return !code;
  });
  return code;
}

// Whether a formula block may stand in place of the paragraph at $pos.
function blockFits($pos: ResolvedPos, block: PMNode) {
  if ($pos.parent.type.name !== "paragraph" || $pos.depth < 1) return false;
  const parent = $pos.node(-1),
    index = $pos.index(-1);
  return parent.canReplaceWith(index, index + 1, block.type);
}

export type MathDollarsOptions = {
  // Opens the formula dialog for a new formula block ("$$" + space/Enter).
  openBlock: (() => void) | null;
};

export const MathDollars = Extension.create<MathDollarsOptions>({
  name: "mathDollars",
  // Before the undo of collaboration (priority 1000) and of the history.
  priority: 1100,
  addOptions() {
    return { openBlock: null };
  },
  addInputRules() {
    const { schema } = this.editor;
    const inline = schema.nodes.mathInline,
      block = schema.nodes.mathBlock;
    if (!inline || !block) return [];
    const rules = [
      new InputRule({
        find: (text) => {
          const math = dollarMathAtEnd(text);
          return math ? { index: math.from, text: text.slice(math.from), data: { math } } : null;
        },
        handler: ({ state, range, match }) => {
          const math = (match.data as { math?: DollarMath } | undefined)?.math;
          if (!math) return null;
          const { tr } = state;
          const $from = tr.doc.resolve(range.from);
          if (!$from.parent.isTextblock || $from.parent.type.spec.code || $from.parent !== tr.doc.resolve(range.to).parent) return null;
          if (hasCode(tr.doc, range.from, range.to)) return null;
          // Not followed immediately by a digit (typed in front of one).
          if (/^[0-9]/.test(tr.doc.textBetween(range.to, Math.min(range.to + 1, $from.end()), "", ""))) return null;
          const index = $from.index();
          if (!$from.parent.canReplaceWith(index, index, inline)) return null;
          const formulaBlock = block.create({ expression: math.expression });
          if (math.display && range.from === $from.start() && range.to === $from.end() && blockFits($from, formulaBlock)) {
            const before = $from.before(),
              after = $from.after();
            // The caret goes on to the next paragraph (a new one at the end).
            const next = tr.doc.resolve(after).nodeAfter;
            tr.replaceWith(before, after, next?.isTextblock ? formulaBlock : [formulaBlock, schema.nodes.paragraph.create()]);
            tr.setSelection(TextSelection.create(tr.doc, before + formulaBlock.nodeSize + 1));
            tr.setMeta(mathDollarKey, { end: before + formulaBlock.nodeSize, inline: false });
            return;
          }
          tr.replaceWith(range.from, range.to, inline.create({ expression: math.expression }));
          tr.setMeta(mathDollarKey, { end: range.from + 1, inline: true });
        },
      }),
    ];
    const open = this.options.openBlock;
    if (!open) return rules;
    // "$$" + space at the start of an empty paragraph (Enter: the shortcut
    // below). Backspace right after brings "$$ " back.
    rules.push(
      new InputRule({
        find: /^\$\$ $/,
        handler: ({ state, range }) => {
          const { tr } = state;
          const $from = tr.doc.resolve(range.from);
          if ($from.parent.textContent !== "$$ " || $from.parent.childCount !== 1 || !blockFits($from, block.create())) return null;
          tr.delete(range.from, range.to);
          setTimeout(open);
        },
      }),
    );
    return rules;
  },
  addKeyboardShortcuts() {
    const undo = () => !!mathDollarKey.getState(this.editor.state) && this.editor.commands.undoInputRule();
    return {
      "Mod-z": undo,
      Enter: () => {
        const open = this.options.openBlock;
        const { state, view } = this.editor;
        const { $cursor } = state.selection as TextSelection;
        const block = state.schema.nodes.mathBlock;
        if (!open || !block || !$cursor || view.composing || !this.editor.isEditable) return false;
        if ($cursor.parent.textContent !== "$$" || $cursor.parent.childCount !== 1 || $cursor.parentOffset !== 2) return false;
        if (!blockFits($cursor, block.create()) || hasCode(state.doc, $cursor.start(), $cursor.end())) return false;
        view.dispatch(state.tr.delete($cursor.start(), $cursor.end()));
        setTimeout(open);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<Converted>({
        key: mathDollarKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(mathDollarKey) as Converted | undefined;
            if (meta !== undefined) return meta;
            if (!value) return null;
            // Other plugins' follow-up steps (block ids …) keep it.
            if (tr.getMeta("appendedTransaction") && !tr.selectionSet) return tr.docChanged ? { ...value, end: tr.mapping.map(value.end) } : value;
            return tr.docChanged || tr.selectionSet ? null : value;
          },
        },
        props: {
          // A digit right after the closing "$": the "$" did not close a
          // formula after all – the text comes back, with the digit.
          handleTextInput(view, from, to, text) {
            const converted = mathDollarKey.getState(view.state);
            if (!converted?.inline || from !== to || from !== converted.end || !/^[0-9]/.test(text)) return false;
            if (!editor.commands.undoInputRule()) return false;
            const at = view.state.selection.from;
            view.dispatch(view.state.tr.insertText(text, at, at).setMeta(mathDollarKey, null));
            return true;
          },
        },
      }),
    ];
  },
});

// For the tests: whether the last change was a dollar conversion.
export const justConvertedDollars = (state: EditorState) => !!mathDollarKey.getState(state);

// Another extension's input rules (Typography: "^2" → "²", "->" → "→")
// leave the LaTeX of a formula being typed between dollars alone.
export function outsideDollarMath<E extends AnyExtension>(extension: E): E {
  return extension.extend({
    addInputRules() {
      const rules = (this.parent?.() || []) as InputRule[];
      return rules.map(
        (rule) =>
          new InputRule({
            find: rule.find,
            undoable: rule.undoable,
            handler: (props) => {
              const $from = props.state.doc.resolve(props.range.from);
              const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
              return insideOpenDollarMath(before) ? null : rule.handler(props);
            },
          }),
      );
    },
  }) as E;
}
