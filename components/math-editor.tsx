"use client";
import { useLocale, useT } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MathAction } from "@/lib/math-solve";
import { tr } from "@/lib/locale-tag";
import { Extension, type Editor, type Node } from "@tiptap/core";
import { Plugin, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { MathBlock, MathInline } from "@/lib/document-schema";
import { loadMath, mathLoaded, renderMathInto, MAX_MATH_LENGTH } from "@/lib/math-render-lazy";
import { Modal } from "./ui";
import { beginUndoStep, nodeTargetPosition, openedNode } from "@/lib/node-target";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { mathKeyAction, mathLeaveSide } from "@/lib/math-keys";
import { COMMENT_SHEET_MAX_WIDTH, placeCommentPopover, placeFixed, unionBox, visibleViewport } from "@/lib/comment-popover-layout";
export type MathTarget = {
  type: "mathBlock" | "mathInline";
  expression: string;
  getPos?: () => number | undefined;
  // Opened from the keyboard (#541): where the caret goes in the LaTeX.
  caret?: "start" | "end";
};
// Backspace / Delete and the arrow keys right beside a formula open it
// (lib/math-keys.ts) – before the editor's own keys (the priority).
function mathKeys(onEdit: (target: MathTarget) => void) {
  return Extension.create({
    name: "mathKeys",
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handleKeyDown(view, event) {
              if (!view.editable || view.composing || event.isComposing || event.keyCode === 229) return false;
              const action = mathKeyAction(view.state, event, (direction) => view.endOfTextblock(direction));
              if (!action) return false;
              event.preventDefault();
              const { pos } = action;
              onEdit({ type: action.type, expression: action.expression, getPos: () => pos, caret: action.caret });
              return true;
            },
          },
        }),
      ];
    },
  });
}
export function mathNodeViews(onEdit: (target: MathTarget) => void) {
  const views: (Node | Extension)[] = [MathBlock, MathInline].map((extension: Node) =>
    extension.extend({
      addNodeView() {
        return ({ node, editor, getPos }) => {
          let current = node;
          const inline = node.type.name === "mathInline";
          const dom = document.createElement(inline ? "span" : "div");
          const render = () => {
            dom.className = inline ? "math-inline" : "math-block";
            dom.dataset.math = current.attrs.expression;
            dom.contentEditable = "false";
            dom.setAttribute("role", editor.isEditable ? "button" : "math");
            dom.setAttribute(
              "aria-label",
              `${editor.isEditable ? tr("Formel bearbeiten: ", "Edit formula: ") : tr("Formel: ", "Formula: ")}${current.attrs.expression}`,
            );
            dom.tabIndex = editor.isEditable ? 0 : -1;
            renderMathInto(dom, current.attrs.expression, inline);
          };
          const edit = (event: Event) => {
            if (!editor.isEditable) return;
            event.preventDefault();
            event.stopPropagation();
            onEdit({
              type: inline ? "mathInline" : "mathBlock",
              expression: current.attrs.expression,
              getPos,
            });
          };
          dom.addEventListener("click", edit);
          dom.addEventListener("keydown", (input) => {
            const event = input as KeyboardEvent;
            if (event.key === "Enter" || event.key === " ") edit(event);
          });
          render();
          return {
            dom,
            update(next) {
              if (next.type !== current.type) return false;
              current = next;
              render();
              return true;
            },
            stopEvent: (event) =>
              event.type === "click" ||
              (event.type === "keydown" &&
                ["Enter", " "].includes((event as KeyboardEvent).key)),
            ignoreMutation: () => true,
          };
        };
      },
    }),
  );
  views.push(mathKeys(onEdit));
  return views;
}
// Building blocks for the formula; "|" marks where the cursor goes.
// i18n-table: 1 – [German, English, LaTeX, shown]
const SNIPPETS: [de: string, en: string, latex: string, shown: string][] = [
  ["Bruch", "Fraction", "\\frac{|}{}", "a⁄b"],
  ["Wurzel", "Square root", "\\sqrt{|}", "√"],
  ["n-te Wurzel", "n-th root", "\\sqrt[|]{}", "ⁿ√"],
  ["Hochgestellt", "Superscript", "^{|}", "xⁿ"],
  ["Tiefgestellt", "Subscript", "_{|}", "xₙ"],
  ["Mal", "Times", "\\cdot |", "·"],
  ["Vektor", "Vector", "\\begin{pmatrix}|\\\\ \\\\ \\end{pmatrix}", "(⋮)"],
  ["Vektorpfeil", "Vector arrow", "\\vec{|}", "a⃗"],
  ["Kreuzprodukt", "Cross product", "\\times |", "×"],
  ["Plus-minus", "Plus-minus", "\\pm |", "±"],
  ["Pi", "Pi", "\\pi |", "π"],
  ["Ungleich", "Not equal", "\\neq |", "≠"],
  ["Kleiner gleich", "Less or equal", "\\leq |", "≤"],
  ["Größer gleich", "Greater or equal", "\\geq |", "≥"],
  ["Klammern", "Parentheses", "\\left(|\\right)", "( )"],
  ["Summe", "Sum", "\\sum_{i=1}^{|}", "Σ"],
];
// Up to this width the editor is the dialog (a sheet on phones), wider an
// anchored popover at the formula.
const NARROW = `(max-width: ${COMMENT_SHEET_MAX_WIDTH}px)`;
// Where the editor's caret goes when the formula closes: before or after
// it, or nowhere in particular (a click elsewhere puts it there itself).
type Side = "before" | "after" | null;

// The caret beside the node at `pos` (or where it was, once removed).
function caretBeside(tr: Transaction, pos: number, size: number, inline: boolean, side: "before" | "after") {
  const at = Math.max(0, Math.min(side === "after" ? pos + size : pos, tr.doc.content.size));
  const $at = tr.doc.resolve(at);
  return tr.setSelection(inline && $at.parent.inlineContent ? TextSelection.create(tr.doc, at) : Selection.near($at, side === "after" ? 1 : -1));
}

// The popover at the formula (#541): below it, above where there is no
// room below, inside the visible area; placed with --popover-left /
// --popover-top (CSSOM, no style attributes), again on scrolling,
// resizing and every change of the text (lib/comment-popover-layout.ts).
// A click elsewhere ends the editing like leaving it with the keys.
function MathPopover({
  editor,
  anchor,
  label,
  onOutside,
  children,
}: {
  editor: Editor;
  // The formula's element on screen (null when it is not drawn).
  anchor: () => HTMLElement | null;
  label: string;
  onOutside: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const place = useRef(() => {});
  place.current = () => {
    const el = root.current;
    if (!el || editor.isDestroyed) return;
    const node = anchor();
    // Not drawn (scrolled away in a long list, say): at the text's top.
    const box = unionBox([(node ?? editor.view.dom).getBoundingClientRect()]);
    if (!box) return;
    const p = placeCommentPopover({ passage: box, size: { width: el.offsetWidth, height: el.offsetHeight }, viewport: visibleViewport(), beside: false, gap: 6 });
    el.dataset.side = p.side;
    el.style.setProperty("--popover-max-height", `${Math.round(p.maxHeight)}px`);
    placeFixed(el, p.left, p.top);
  };
  useLayoutEffect(() => place.current(), []);
  useEffect(() => {
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place.current());
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    if (root.current) observer?.observe(root.current);
    editor.on("transaction", again);
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    window.visualViewport?.addEventListener("resize", again);
    window.visualViewport?.addEventListener("scroll", again);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      editor.off("transaction", again);
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
      window.visualViewport?.removeEventListener("resize", again);
      window.visualViewport?.removeEventListener("scroll", again);
    };
  }, [editor]);
  const outside = useRef(onOutside);
  outside.current = onOutside;
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest || !root.current || root.current.contains(target)) return;
      // The formula itself (its click opens it again), other dialogs.
      if (anchor()?.contains(target) || target.closest(".modal, [role=dialog], [role=menu], [role=listbox]")) return;
      outside.current();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [anchor]);
  return (
    <section ref={root} className="math-popover" role="dialog" aria-modal={false} aria-label={label}>
      {children}
    </section>
  );
}

// Mounted per opening: a remote update never replaces the user's local draft.
// An existing formula opens in a popover at it (#541; the dialog on
// phones), a new one in the dialog.
export function MathEditorDialog({
  editor,
  target,
  onClose,
}: {
  editor: Editor | null;
  target: MathTarget;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const hints = useKeyboardHints();
  const [expression, setExpression] = useState(target.expression);
  // KaTeX for the check and the preview (lib/math-render-lazy.ts).
  const [math, setMath] = useState(mathLoaded);
  useEffect(() => {
    if (!math) void loadMath().then(setMath).catch(() => {});
  }, [math]);
  // The formula as it was when the dialog opened (lib/node-target.ts).
  const [opened] = useState(() => (editor ? openedNode(editor.state, target) : null));
  const input = useRef<HTMLTextAreaElement>(null);
  const [narrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW).matches);
  const anchored = !!editor && !!target.getPos && !narrow;
  // The caret in the LaTeX: at its start or end when opened from the
  // keyboard, else at the end. Right away (the popover is placed before:
  // its layout effect runs first), so the next key typed lands in the
  // field; again after the dialog's own focus.
  useLayoutEffect(() => {
    const focus = (again: boolean) => {
      const area = input.current;
      if (!area || (again && document.activeElement === area)) return;
      area.focus({ preventScroll: true });
      const at = target.caret === "start" ? 0 : area.value.length;
      area.setSelectionRange(at, at);
    };
    focus(false);
    const frame = requestAnimationFrame(() => focus(true));
    return () => cancelAnimationFrame(frame);
    // Once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Results of the formula (fractions, binomial formulas, equations).
  const [calc, setCalc] = useState<MathAction[]>([]);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void import("@/lib/math-solve").then(({ latexToExpression, mathActions }) => {
        const written = latexToExpression(expression.replace(/=\s*$/, ""));
        if (current) setCalc(written ? mathActions(written, locale).slice(0, 4) : []);
      });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [expression, locale]);
  // Inserts a building block at the cursor.
  function insertSnippet(snippet: string) {
    const area = input.current;
    const start = area?.selectionStart ?? expression.length,
      end = area?.selectionEnd ?? expression.length;
    const [before, after] = snippet.split("|");
    const next = expression.slice(0, start) + before + after + expression.slice(end);
    setExpression(next);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + before.length, start + before.length);
    });
  }
  const [conflict, setConflict] = useState("");
  const inline = target.type === "mathInline";
  // The shortcut shown on the primary button.
  const submitKeys = inline ? "Enter" : "Mod+Enter";
  const empty = !expression.trim();
  const error = math ? math.mathError(expression, inline) : null;
  // An empty formula that exists is saved by removing it (#541).
  const blocked = !!error && !(empty && target.getPos);
  // Where the formula is now (undefined: changed or deleted meanwhile).
  function currentPosition() {
    if (!editor || !target.getPos) return undefined;
    const pos = nodeTargetPosition(editor.state, target, opened);
    const current = typeof pos === "number" ? editor.state.doc.nodeAt(pos) : null;
    return typeof pos === "number" && current?.type.name === target.type && current.attrs.expression === target.expression
      ? { pos, node: current }
      : undefined;
  }
  // Saves `next` (empty: removes the formula) as one undo step and closes;
  // `side` puts the editor's caret before or after the formula, focused.
  function apply(next: string, side: Side, remove = false) {
    if (!editor?.isEditable) {
      setConflict(t("Das Dokument kann nicht bearbeitet werden.", "The document cannot be edited."));
      return;
    }
    if (target.getPos) {
      const found = currentPosition();
      if (!found) {
        setConflict(
          t("Diese Formel wurde inzwischen geändert oder gelöscht. Dein Entwurf bleibt hier erhalten. Öffne die aktuelle Formel erneut, um sie zu bearbeiten.", "This formula was changed or deleted in the meantime. Your draft is kept here. Open the current formula again to edit it."),
        );
        return;
      }
      const { pos, node } = found;
      const gone = remove || !next.trim();
      let transaction = editor.state.tr;
      if (gone) transaction = transaction.delete(pos, pos + node.nodeSize);
      else if (next !== node.attrs.expression) transaction = transaction.setNodeMarkup(pos, undefined, { ...node.attrs, expression: next });
      // Removed: the caret where the formula was, on the side it came from.
      if (side) caretBeside(transaction, pos, gone ? 0 : node.nodeSize, inline, gone ? (target.caret === "start" ? "before" : "after") : side);
      if (transaction.docChanged) beginUndoStep(editor.state);
      if (transaction.docChanged || transaction.selectionSet) editor.view.dispatch(transaction);
      if (side) editor.view.focus();
    } else if (next.trim()) {
      beginUndoStep(editor.state);
      editor.chain().focus().insertContent({ type: target.type, attrs: { expression: next } }).run();
    } else editor.commands.focus();
    onClose();
  }
  // Esc and "Cancel": nothing saved, the caret after the formula.
  function cancel() {
    const found = currentPosition();
    if (editor && found) {
      editor.view.dispatch(caretBeside(editor.state.tr, found.pos, found.node.nodeSize, inline, "after"));
      editor.view.focus();
    } else editor?.commands.focus();
    onClose();
  }
  // Esc, "Cancel" and a click beside the dialog.
  const dismiss = target.getPos ? cancel : onClose;
  // The formula's element in the text, for the popover.
  const anchorElement = useRef(() => {
    if (!editor || editor.isDestroyed) return null;
    const pos = nodeTargetPosition(editor.state, target, opened);
    const dom = typeof pos === "number" ? editor.view.nodeDOM(pos) : null;
    return dom instanceof HTMLElement ? dom : null;
  });
  const title = inline ? t("Inline-Formel", "Inline formula") : t("Mathematische Formel", "Math formula");
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) apply(expression, "after");
      }}
      // ⌘/Ctrl+Enter inserts or saves, like the button (#446); in an
      // inline formula Enter alone does too (⇧Enter: a new line), in a
      // formula block Enter stays a new line. Esc cancels. Never while an
      // input method composes.
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" && anchored) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        if (event.key !== "Enter" || event.altKey) return;
        const submit = event.metaKey || event.ctrlKey || (inline && !event.shiftKey && event.target === input.current);
        if (!submit) return;
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }}
    >
      <label>
        {t("LaTeX-Formel", "LaTeX formula")}
        <div className="math-snippets" role="toolbar" aria-label={t("Bausteine", "Building blocks")}>
          {SNIPPETS.map(([de, en, latex, shown]) => (
            <button key={latex} type="button" title={t(de, en)} aria-label={t(de, en)} onClick={() => insertSnippet(latex)}>
              {shown}
            </button>
          ))}
        </div>
        <textarea
          ref={input}
          aria-label={t("LaTeX-Formel", "LaTeX formula")}
          autoFocus={!anchored}
          rows={anchored ? 2 : 3}
          value={expression}
          maxLength={MAX_MATH_LENGTH}
          onChange={(event) => setExpression(event.target.value)}
          // At its edges the arrow keys leave the formula, saving it (#541);
          // Backspace in an empty field removes the formula.
          onKeyDown={(event) => {
            if (!target.getPos || event.nativeEvent.isComposing || event.keyCode === 229) return;
            const area = event.currentTarget;
            if (event.key === "Backspace" && !area.value && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              apply("", "after", true);
              return;
            }
            const side = mathLeaveSide(area.value, area.selectionStart, area.selectionEnd, event, !inline);
            if (!side) return;
            event.preventDefault();
            event.stopPropagation();
            apply(area.value, side);
          }}
          placeholder={String.raw`E = mc^2`}
        />
      </label>
      {!anchored && (
        <p className="muted">
          {inline
            ? t("Die Formel steht direkt im Satz.", "The formula sits inside the sentence.")
            : t("Die Formel steht in einem eigenen Absatz.", "The formula sits in its own paragraph.")}
        </p>
      )}
      <div
        className="math-preview"
        aria-label={t("Formelvorschau", "Formula preview")}
        {...(math ? { dangerouslySetInnerHTML: { __html: math.renderMath(expression, inline) } } : { children: expression })}
      />
      {calc.length > 0 && (
        <div className="math-calc" role="group" aria-label={t("Rechnen", "Calculate")}>
          {calc.map((action) => (
            <button
              key={action.kind + action.latex}
              type="button"
              title={t("An die Formel anhängen", "Append to the formula")}
              onClick={() => setExpression(`${expression.replace(/=\s*$/, "").trimEnd()} ${action.latex}`)}
            >
              <span>{action.label}</span>
              <strong>{action.text.replace(/^[=⇒]\s*/, "")}</strong>
            </button>
          ))}
        </div>
      )}
      {error && !empty && (
        <p className="math-validation" role="status">
          {error}
        </p>
      )}
      {empty && target.getPos && (
        <p className="muted" role="status">
          {t("Speicherst du sie leer, wird die Formel entfernt.", "Saving it empty removes the formula.")}
        </p>
      )}
      {conflict && (
        <p className="math-validation" role="alert">
          {conflict}
        </p>
      )}
      <div className="modal-actions">
        {target.getPos && (
          <button type="button" className="button" onClick={() => apply("", "after", true)}>
            {t("Formel löschen", "Delete formula")}
          </button>
        )}
        <button type="button" className="button" onClick={dismiss}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button
          className="button primary"
          disabled={blocked}
          title={(target.getPos ? t("Speichern", "Save") : t("Einfügen", "Insert")) + hints.suffix(submitKeys)}
          aria-keyshortcuts={inline ? "Enter" : hints.mac ? "Meta+Enter" : "Control+Enter"}
        >
          {target.getPos ? t("Speichern", "Save") : t("Einfügen", "Insert")}
          {hints.keys(submitKeys) && (
            <kbd className="button-kbd" aria-hidden>
              {hints.keys(submitKeys)}
            </kbd>
          )}
        </button>
      </div>
    </form>
  );
  if (anchored && editor)
    return (
      <MathPopover
        editor={editor}
        label={title}
        anchor={anchorElement.current}
        // A click elsewhere saves like leaving the formula (an invalid
        // formula too: it shows as such in the text); the click places the
        // caret itself. Changed meanwhile, it stays open with the draft
        // and says so.
        onOutside={() => apply(expression, null)}
      >
        {form}
      </MathPopover>
    );
  return (
    <Modal
      open
      title={title}
      onClose={dismiss}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        editor?.commands.focus();
      }}
    >
      {form}
    </Modal>
  );
}
