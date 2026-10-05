"use client";
import { useLocale, useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type { MathAction } from "@/lib/math-solve";
import { tr } from "@/lib/locale-tag";
import type { Editor, Node } from "@tiptap/core";
import { MathBlock, MathInline } from "@/lib/document-schema";
import { mathError, renderMath, MAX_MATH_LENGTH } from "@/lib/math-render";
import { Modal } from "./ui";
export type MathTarget = {
  type: "mathBlock" | "mathInline";
  expression: string;
  getPos?: () => number | undefined;
};
export function mathNodeViews(onEdit: (target: MathTarget) => void) {
  return [MathBlock, MathInline].map((extension: Node) =>
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
            dom.innerHTML = renderMath(current.attrs.expression, inline);
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
}
// Building blocks for the formula; "|" marks where the cursor goes.
const SNIPPETS: [de: string, en: string, latex: string, shown: string][] = [
  ["Bruch", "Fraction", "\\frac{|}{}", "a⁄b"],
  ["Wurzel", "Square root", "\\sqrt{|}", "√"],
  ["n-te Wurzel", "n-th root", "\\sqrt[|]{}", "ⁿ√"],
  ["Hochgestellt", "Superscript", "^{|}", "xⁿ"],
  ["Tiefgestellt", "Subscript", "_{|}", "xₙ"],
  ["Mal", "Times", "\\cdot |", "·"],
  ["Plus-minus", "Plus-minus", "\\pm |", "±"],
  ["Pi", "Pi", "\\pi |", "π"],
  ["Ungleich", "Not equal", "\\neq |", "≠"],
  ["Kleiner gleich", "Less or equal", "\\leq |", "≤"],
  ["Größer gleich", "Greater or equal", "\\geq |", "≥"],
  ["Klammern", "Parentheses", "\\left(|\\right)", "( )"],
  ["Summe", "Sum", "\\sum_{i=1}^{|}", "Σ"],
];
// Mounted per opening: a remote update never replaces the user's local draft.
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
  const [expression, setExpression] = useState(target.expression);
  const input = useRef<HTMLTextAreaElement>(null);
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
  const error = mathError(expression, inline);
  function apply(remove = false) {
    if (!editor?.isEditable) {
      setConflict(t("Das Dokument kann nicht bearbeitet werden.", "The document cannot be edited."));
      return;
    }
    if (target.getPos) {
      const pos = target.getPos();
      const current =
        typeof pos === "number" ? editor.state.doc.nodeAt(pos) : null;
      if (
        typeof pos !== "number" ||
        current?.type.name !== target.type ||
        current.attrs.expression !== target.expression
      ) {
        setConflict(
          t("Diese Formel wurde inzwischen geändert oder gelöscht. Dein Entwurf bleibt hier erhalten. Öffne die aktuelle Formel erneut, um sie zu bearbeiten.", "This formula was changed or deleted in the meantime. Your draft is kept here. Open the current formula again to edit it."),
        );
        return;
      }
      const transaction = remove
        ? editor.state.tr.delete(pos, pos + current.nodeSize)
        : editor.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            expression,
          });
      editor.view.dispatch(transaction);
    } else {
      editor
        .chain()
        .focus()
        .insertContent({ type: target.type, attrs: { expression } })
        .run();
    }
    onClose();
  }
  return (
    <Modal
      open
      title={inline ? t("Inline-Formel", "Inline formula") : t("Mathematische Formel", "Math formula")}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        editor?.commands.focus();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!error) apply();
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
            autoFocus
            rows={3}
            value={expression}
            maxLength={MAX_MATH_LENGTH}
            onChange={(event) => setExpression(event.target.value)}
            placeholder={String.raw`E = mc^2`}
          />
        </label>
        <p className="muted">
          {inline
            ? t("Die Formel steht direkt im Satz.", "The formula sits inside the sentence.")
            : t("Die Formel steht in einem eigenen Absatz.", "The formula sits in its own paragraph.")}
        </p>
        <div
          className="math-preview"
          aria-label={t("Formelvorschau", "Formula preview")}
          dangerouslySetInnerHTML={{ __html: renderMath(expression, inline) }}
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
        {error && expression && (
          <p className="math-validation" role="status">
            {error}
          </p>
        )}
        {conflict && (
          <p className="math-validation" role="alert">
            {conflict}
          </p>
        )}
        <div className="modal-actions">
          {target.getPos && (
            <button
              type="button"
              className="button"
              onClick={() => apply(true)}
            >
              {t("Formel löschen", "Delete formula")}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={!!error}>
            {target.getPos ? t("Speichern", "Save") : t("Einfügen", "Insert")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
