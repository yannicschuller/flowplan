// A hint while typing: after "3/4 + 1/6 =" the result appears greyed out
// behind the cursor; Tab writes it, Escape or typing on dismisses it.
// Nothing is calculated without the "=", and nothing is written without Tab.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Locale } from "./i18n";

type Hint = { pos: number; text: string } | null;
const key = new PluginKey<Hint>("calcHint");
type Solver = typeof import("./math-solve");
let solver: Promise<Solver> | null = null;
// A failed load (offline, new deployment) is tried again at the next "=".
const loadSolver = () =>
  (solver ??= import("./math-solve").catch((error) => {
    solver = null;
    throw error;
  }));

// The line up to the cursor, if it ends with "=".
function lineBeforeCursor(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null;
  const text = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "￼");
  return /=\s?$/.test(text) && !/=\s?=\s?$/.test(text) ? text : null;
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
      new Plugin<Hint>({
        key,
        state: {
          init: () => null,
          apply(tr, hint, _old, state) {
            const meta = tr.getMeta(key) as Hint | undefined;
            if (meta !== undefined) return meta;
            if (!hint) return null;
            // Other transactions (sync, cursors) keep it while the cursor
            // still stands right after the "=".
            const pos = tr.mapping.map(hint.pos);
            return pos === state.selection.from && lineBeforeCursor(state)
              ? { ...hint, pos }
              : null;
          },
        },
        props: {
          decorations(state) {
            const hint = key.getState(state);
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
            const hint = key.getState(view.state);
            if (!hint || hint.pos !== view.state.selection.from) return false;
            if (event.key === "Tab" && !event.shiftKey) {
              // At the cursor, so the cursor moves behind the result.
              view.dispatch(view.state.tr.insertText(hint.text).setMeta(key, null));
              return true;
            }
            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(key, null));
              return true;
            }
            return false;
          },
        },
        view: (view) => {
          // Loaded in the background, so the first hint is quick.
          if (view.editable) setTimeout(() => void loadSolver().catch(() => {}), 3000);
          return {
            update(view: EditorView, previous: EditorState) {
              if (
                !view.editable ||
                (view.state.doc.eq(previous.doc) &&
                  view.state.selection.eq(previous.selection))
              )
                return;
              const line = lineBeforeCursor(view.state);
              if (!line) return;
              const pos = view.state.selection.from;
              const id = ++request;
              void loadSolver().then(({ mathActions, trailingExpression }) => {
                if (
                  id !== request ||
                  view.isDestroyed ||
                  view.state.selection.from !== pos
                )
                  return;
                const expression = trailingExpression(line);
                const action = expression
                  ? mathActions(expression, locale).find(
                      (a) => a.kind !== "solve",
                    )
                  : undefined;
                if (!action) return;
                // The "=" is typed already: only the value is written.
                const value = action.text.replace(/^[=≈]\s*/, "");
                view.dispatch(
                  view.state.tr.setMeta(key, {
                    pos,
                    text: (line.endsWith(" ") ? "" : " ") + value,
                  }),
                );
              }, () => {});
            },
          };
        },
      }),
    ];
  },
});
