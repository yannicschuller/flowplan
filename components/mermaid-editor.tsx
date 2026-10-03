"use client";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { MermaidBlock } from "@/lib/mermaid-node";
import { mountDiagram } from "@/lib/mermaid-render";
import { MAX_DIAGRAM_LENGTH } from "@/lib/mermaid-source";
import { Modal } from "./ui";
export type DiagramTarget = {
  source: string;
  getPos?: () => number | undefined;
};
export function mermaidNodeView(onEdit: (target: DiagramTarget) => void) {
  return MermaidBlock.extend({
    addNodeView() {
      return ({ node, editor, getPos }) => {
        let current = node;
        const dom = document.createElement("div");
        dom.className = "mermaid-block";
        dom.contentEditable = "false";
        let cancel = () => {};
        const render = () => {
          cancel();
          dom.dataset.mermaid = current.attrs.source;
          dom.setAttribute("role", editor.isEditable ? "button" : "figure");
          dom.setAttribute(
            "aria-label",
            editor.isEditable ? tr("Diagramm bearbeiten", "Edit diagram") : tr("Mermaid-Diagramm", "Mermaid diagram"),
          );
          dom.tabIndex = editor.isEditable ? 0 : -1;
          cancel = mountDiagram(dom, current.attrs.source);
        };
        const edit = (event: Event) => {
          if (!editor.isEditable) return;
          if ((event.target as Element | null)?.closest?.(".diagram-tools"))
            return;
          event.preventDefault();
          event.stopPropagation();
          onEdit({ source: current.attrs.source, getPos });
        };
        dom.addEventListener("click", edit);
        dom.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) edit(event);
        });
        render();
        return {
          dom,
          update(next) {
            if (next.type !== current.type) return false;
            const changed = next.attrs.source !== current.attrs.source;
            current = next;
            if (changed) render();
            return true;
          },
          destroy: () => cancel(),
          ignoreMutation: () => true,
          stopEvent: (event) =>
            event.type === "click" ||
            (event.type === "keydown" &&
              ["Enter", " "].includes((event as KeyboardEvent).key)),
        };
      };
    },
  });
}
export function DiagramEditorDialog({
  editor,
  target,
  onClose,
}: {
  editor: Editor | null;
  target: DiagramTarget;
  onClose: () => void;
}) {
  const t = useT();
  const [source, setSource] = useState(target.source);
  const [validated, setValidated] = useState<string | null>(null);
  const [conflict, setConflict] = useState("");
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setValidated(null);
    let cancel = () => {};
    const timer = setTimeout(() => {
      if (preview.current)
        cancel = mountDiagram(
          preview.current,
          source,
          (error) => setValidated(error ? null : source),
          false,
        );
    }, 250);
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [source]);
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
        current?.type.name !== "mermaidBlock" ||
        current.attrs.source !== target.source
      ) {
        setConflict(
          t("Dieses Diagramm wurde inzwischen geändert oder gelöscht. Dein Entwurf bleibt hier erhalten. Öffne das aktuelle Diagramm erneut, um es zu bearbeiten.", "This diagram was changed or deleted in the meantime. Your draft is kept here. Open the current diagram again to edit it."),
        );
        return;
      }
      editor.view.dispatch(
        remove
          ? editor.state.tr.delete(pos, pos + current.nodeSize)
          : editor.state.tr.setNodeMarkup(pos, undefined, {
              ...current.attrs,
              source,
            }),
      );
    } else
      editor
        .chain()
        .focus()
        .insertContent({ type: "mermaidBlock", attrs: { source } })
        .run();
    onClose();
  }
  return (
    <Modal
      open
      title={t("Mermaid-Diagramm", "Mermaid diagram")}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        editor?.commands.focus();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validated === source) apply();
        }}
      >
        <label>
          {t("Mermaid-Quelltext", "Mermaid source")}
          <textarea
            aria-label={t("Mermaid-Quelltext", "Mermaid source")}
            autoFocus
            spellCheck={false}
            rows={7}
            maxLength={MAX_DIAGRAM_LENGTH}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
        <div
          ref={preview}
          className="mermaid-preview"
          aria-label={t("Diagrammvorschau", "Diagram preview")}
          role="status"
        />
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
              {t("Diagramm löschen", "Delete diagram")}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={validated !== source}>
            {target.getPos ? t("Speichern", "Save") : t("Einfügen", "Insert")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
