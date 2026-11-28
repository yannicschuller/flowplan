// A hint while typing: after "3/4 + 1/6 =" the result appears greyed out
// behind the cursor; Tab writes it, Escape or typing on dismisses it.
// Nothing is calculated without the "=", and nothing is written without Tab.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Locale } from "./i18n";

// `latex`: the result as a formula, when the calculation used formulas.
type Hint = { pos: number; text: string; latex?: string } | null;
// A hint dismissed with Escape stays away for that "=": `pos` is the cursor
// there, `line` the text before it. Changes that leave both as they were –
// a block id given a moment later (lib/block-ids-plugin.ts), someone
// editing another paragraph – do not bring it back.
type Dismissed = { pos: number; line: string } | null;
type CalcState = { hint: Hint; dismissed: Dismissed };
type Meta = { hint: Hint } | { dismiss: Dismissed };
const key = new PluginKey<CalcState>("calcHint");
type Solver = typeof import("./math-solve");
let solver: Promise<Solver> | null = null;
// A failed load (offline, new deployment) is tried again at the next "=".
const loadSolver = () =>
  (solver ??= import("./math-solve").catch((error) => {
    solver = null;
    throw error;
  }));

// Questions about a function written before (lib/math-analysis.ts):
// "f′(x) =", "F(x) =", "f(2) =", "lim x→∞ f(x) =", "∫₀² f(x) dx =".
type Analysis = typeof import("./math-analysis");
let analysis: Promise<Analysis> | null = null;
const loadAnalysis = () =>
  (analysis ??= import("./math-analysis").catch((error) => {
    analysis = null;
    throw error;
  }));
const FUNCTION_QUESTION = /(?:[a-zA-Z]\s*(?:['′″‴]{1,3})?\s*\([^()=]{1,40}\)|\blim\b[^=]*|∫[^=]*)\s*=\s?$/;
// The paragraphs before the cursor's that may define a function, nearest last.
function definitionsBefore(state: EditorState): string[] {
  const $from = state.selection.$from;
  if ($from.depth < 1) return [];
  const out: string[] = [];
  state.doc.nodesBetween(0, $from.before(), (node) => {
    if (!node.isTextblock) return true;
    const text = node.textContent;
    if (text.includes("=") && text.includes("(")) out.push(text);
    return false;
  });
  return out.slice(-200);
}

// Whether a hint is shown right now (other key handlers let it go first).
export function calcHintShown(state: EditorState) {
  const hint = key.getState(state)?.hint;
  return !!hint && hint.pos === state.selection.from;
}
// The line up to the cursor (or `at`), if it ends with "=".
function lineBeforeCursor(state: EditorState, at?: number) {
  const { selection } = state;
  if (at === undefined && !selection.empty) return null;
  const $pos = at === undefined ? selection.$from : state.doc.resolve(at);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null;
  const text = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "￼");
  // Something already stands after the cursor (e.g. a result written
  // before): no hint, only at the end of what was typed.
  const after = $pos.parent.textBetween($pos.parentOffset, $pos.parent.content.size, undefined, "￼");
  if (after.trim()) return null;
  return /=\s?$/.test(text) && !/=\s?=\s?$/.test(text) ? text : null;
}

// A calculation being written: a number and an arithmetic sign before the
// cursor in the same line (or a formula there).
export function startsCalculation(state: EditorState) {
  const $pos = state.selection.$from;
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  const text = $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 40), $pos.parentOffset, undefined, "\ufffc");
  return /\d\s*[-+−*/×·÷:^]/.test(text) || lineWithFormulas(state).formulas.length > 0;
}
// The line up to the cursor with formulas in it ("12/23" as a fraction)
// kept apart, so they can be calculated with: text plus the LaTeX of each
// formula at its place (\u0000 index \u0000).
function lineWithFormulas(state: EditorState) {
  const $pos = state.selection.$from;
  let text = "";
  const formulas: string[] = [];
  $pos.parent.forEach((child, offset) => {
    if (offset >= $pos.parentOffset) return;
    if (child.isText) text += (child.text || "").slice(0, $pos.parentOffset - offset);
    else if (child.type.name === "mathInline") {
      text += `\u0000${formulas.length}\u0000`;
      formulas.push(child.attrs.expression || "");
    } else text += "\ufffc";
  });
  return { text, formulas };
}

export const CalcHint = Extension.create<{ locale: Locale }>({
  name: "calcHint",
  // Before indenting, which also listens to Tab.
  priority: 1100,
  addOptions() {
    return { locale: "de" };
  },
  addProseMirrorPlugins() {
    const locale = this.options.locale;
    let request = 0;
    return [
      new Plugin<CalcState>({
        key,
        state: {
          init: () => ({ hint: null, dismissed: null }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(key) as Meta | undefined;
            // Where it was dismissed, while the line there stays the same.
            let dismissed = value.dismissed;
            if (dismissed && tr.docChanged) {
              const pos = tr.mapping.map(dismissed.pos);
              dismissed = lineBeforeCursor(state, pos) === dismissed.line ? { ...dismissed, pos } : null;
            }
            if (meta && "dismiss" in meta) return { hint: null, dismissed: meta.dismiss };
            if (meta) return { hint: meta.hint, dismissed };
            const hint = value.hint;
            if (!hint) return value.dismissed === dismissed ? value : { hint: null, dismissed };
            // Other transactions (sync, cursors) keep it while the cursor
            // still stands right after the "=".
            const pos = tr.mapping.map(hint.pos);
            return pos === state.selection.from && lineBeforeCursor(state)
              ? { hint: { ...hint, pos }, dismissed }
              : { hint: null, dismissed };
          },
        },
        props: {
          decorations(state) {
            const hint = key.getState(state)?.hint;
            if (!hint || hint.pos !== state.selection.from) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                hint.pos,
                () => {
                  const span = document.createElement("span");
                  span.className = "calc-hint";
                  span.textContent = hint.text;
                  span.setAttribute("aria-hidden", "true");
                  const tab = document.createElement("kbd");
                  tab.textContent = "Tab";
                  span.append(tab);
                  return span;
                },
                { side: 1, key: `calc-${hint.text}` },
              ),
            ]);
          },
          handleKeyDown(view, event) {
            const hint = key.getState(view.state)?.hint;
            if (!hint || hint.pos !== view.state.selection.from) return false;
            if (event.key === "Tab" && !event.shiftKey) {
              // At the cursor, so the cursor moves behind the result; with
              // formulas in the calculation the result is a formula too.
              const math = view.state.schema.nodes.mathInline;
              let tr = view.state.tr;
              if (hint.latex && math) {
                if (hint.text.startsWith(" ")) tr = tr.insertText(" ");
                tr = tr.replaceSelectionWith(math.create({ expression: hint.latex }), false);
              } else tr = tr.insertText(hint.text);
              view.dispatch(tr.setMeta(key, { hint: null } satisfies Meta));
              return true;
            }
            if (event.key === "Escape") {
              // A result still being worked out for it does not show either.
              request++;
              const line = lineBeforeCursor(view.state);
              view.dispatch(view.state.tr.setMeta(key, { dismiss: line ? { pos: hint.pos, line } : null } satisfies Meta));
              return true;
            }
            return false;
          },
        },
        view: () => {
          return {
            update(view: EditorView, previous: EditorState) {
              if (
                !view.editable ||
                (view.state.doc.eq(previous.doc) &&
                  view.state.selection.eq(previous.selection))
              )
                return;
              const line = lineBeforeCursor(view.state);
              const dismissed = key.getState(view.state)?.dismissed;
              if (line && dismissed && dismissed.pos === view.state.selection.from && dismissed.line === line) return;
              // mathjs (180 KB) loads once a calculation is being written – a
              // number and an operator before the cursor – not with every
              // document, so the hint at the "=" is still quick.
              if (!line) {
                if (!solver && view.state.selection.empty && startsCalculation(view.state)) void loadSolver().catch(() => {});
                return;
              }
              const written = lineWithFormulas(view.state);
              const pos = view.state.selection.from;
              const id = ++request;
              const current = () => id === request && !view.isDestroyed && view.state.selection.from === pos;
              const show = (hint: NonNullable<Hint>) => view.dispatch(view.state.tr.setMeta(key, { hint } satisfies Meta));
              // A question about a function first; else a calculation.
              const asks = !written.formulas.length && FUNCTION_QUESTION.test(line);
              const before = asks ? definitionsBefore(view.state) : [];
              const answer = asks ? loadAnalysis().then(({ analysisHint }) => analysisHint(line, before, locale)) : Promise.resolve(null);
              const calculate = () => loadSolver().then(({ mathActions, trailingExpression, latexToExpression }) => {
                if (
                  id !== request ||
                  view.isDestroyed ||
                  view.state.selection.from !== pos
                )
                  return;
                // Formulas count as bracketed terms: \frac{12}{23} → ((12)/(23)).
                const usedFormula = written.formulas.length > 0;
                const readable = written.text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => {
                  const converted = latexToExpression(written.formulas[Number(i)]);
                  return converted ? `(${converted})` : "\ufffc";
                });
                const expression = trailingExpression(readable);
                const action = expression
                  ? mathActions(expression, locale).find(
                      (a) => a.kind !== "solve" && a.kind !== "vector",
                    )
                  : undefined;
                if (!action) return;
                // The "=" is typed already: only the value is written.
                const value = action.text.replace(/^[=≈]\s*/, "");
                const formula = usedFormula && action.kind !== "decimal" ? action.latex.replace(/^(=|\\approx)\s*/, "") : undefined;
                view.dispatch(
                  view.state.tr.setMeta(key, {
                    hint: {
                      pos,
                      text: (line.endsWith(" ") ? "" : " ") + value,
                      latex: formula,
                    },
                  } satisfies Meta),
                );
              }, () => {});
              void answer.catch(() => null).then((found) => {
                if (!current()) return;
                if (found) {
                  show({ pos, text: (line.endsWith(" ") ? "" : " ") + found.text });
                  return;
                }
                return calculate();
              });
            },
          };
        },
      }),
    ];
  },
});
