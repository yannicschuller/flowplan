"use client";
// draw.io diagrams in the editor (#110, lib/drawio.ts). The block shows its
// stored picture; editing (button, double-click, Enter) opens draw.io in
// embed mode in a dialog. Saving there asks draw.io for the picture
// (xmlsvg export), cleans it (lib/drawio-svg.ts) and writes diagram and
// picture into the block in one step – undo takes it back.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { beginUndoStep, nodeTargetPosition, openedNode } from "@/lib/node-target";
import { onEditableChange } from "./editor-editable";
import { DrawioBlock } from "@/lib/drawio-node";
import { mountDrawioPreview, drawioLabel } from "@/lib/drawio-preview";
import { drawioEditor, useDrawioPrefs } from "@/lib/drawio-prefs";
import {
  MAX_DRAWIO_SVG,
  MAX_DRAWIO_XML,
  drawioDark,
  drawioEditorUrl,
  drawioImageUrl,
  parseDrawioMessage,
  svgFromDataUrl,
} from "@/lib/drawio";
import { openDiagramViewer } from "@/lib/diagram-tools";
import { PAGE_LOCALE, tr } from "@/lib/locale-tag";

export type DrawioTarget = {
  xml: string;
  getPos?: () => number | undefined;
};

function toolButton(label: string, text: string, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "diagram-tool";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = text;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  button.addEventListener("keydown", (event) => event.stopPropagation());
  return button;
}

export function drawioNodeView(onEdit: (target: DrawioTarget) => void) {
  return DrawioBlock.extend({
    addNodeView() {
      return ({ node, editor, getPos }) => {
        let current = node;
        const dom = document.createElement("div");
        dom.className = "drawio-block";
        dom.contentEditable = "false";
        const position = () => (typeof getPos === "function" ? getPos() : undefined);
        const edit = () => {
          if (!editor.isEditable || !drawioEditor()) return;
          onEdit({ xml: String(current.attrs.xml || ""), getPos: position });
        };
        const remove = () => {
          const pos = position();
          if (typeof pos !== "number" || !editor.isEditable) return;
          const at = editor.state.doc.nodeAt(pos);
          if (at?.type.name === "drawioBlock") editor.view.dispatch(editor.state.tr.delete(pos, pos + at.nodeSize));
        };
        const render = () => {
          const svg = String(current.attrs.svg || "");
          mountDrawioPreview(dom, svg, !!current.attrs.xml);
          const editable = editor.isEditable;
          dom.setAttribute("role", editable ? "button" : "figure");
          dom.setAttribute("aria-label", editable ? tr("draw.io-Diagramm bearbeiten", "Edit draw.io diagram") : drawioLabel());
          dom.tabIndex = editable ? 0 : -1;
          const tools = document.createElement("div");
          tools.className = "diagram-tools";
          tools.setAttribute("role", "toolbar");
          tools.setAttribute("aria-label", drawioLabel());
          if (svg) tools.append(toolButton(tr("Diagramm vergrößern", "Enlarge diagram"), "⤢", () => openDiagramViewer(drawioImageUrl(svg))));
          if (editable) {
            const button = toolButton(tr("In draw.io bearbeiten", "Edit in draw.io"), tr("Bearbeiten", "Edit"), edit);
            if (!drawioEditor()) {
              button.disabled = true;
              button.title = tr("draw.io ist auf diesem Server nicht eingerichtet.", "draw.io is not set up on this server.");
            }
            tools.append(button, toolButton(tr("Diagramm löschen", "Delete diagram"), "×", remove));
          }
          if (tools.childElementCount) dom.append(tools);
        };
        dom.addEventListener("dblclick", (event) => {
          if ((event.target as Element | null)?.closest?.(".diagram-tools")) return;
          event.preventDefault();
          edit();
        });
        dom.addEventListener("keydown", (event) => {
          if (event.target === dom && event.key === "Enter") {
            event.preventDefault();
            edit();
          }
        });
        render();
        const unsubscribe = onEditableChange(editor, render);
        return {
          dom,
          update(next) {
            if (next.type !== current.type) return false;
            const changed = next.attrs.svg !== current.attrs.svg || next.attrs.xml !== current.attrs.xml;
            current = next;
            if (changed) render();
            return true;
          },
          destroy: unsubscribe,
          ignoreMutation: () => true,
          // Clicks select the block (for the block menu and Backspace);
          // double-click, Enter and the tools belong to the view.
          stopEvent: (event) =>
            event.type === "dblclick" ||
            (event.type === "keydown" && (event as KeyboardEvent).key === "Enter") ||
            !!(event.target as Element | null)?.closest?.(".diagram-tools"),
        };
      };
    },
  });
}

export function DrawioEditorDialog({
  editor,
  target,
  onClose,
}: {
  editor: Editor | null;
  target: DrawioTarget;
  onClose: () => void;
}) {
  const t = useT();
  const config = drawioEditor();
  const prefs = useDrawioPrefs();
  // Fixed while the dialog is open: a new address would reload draw.io.
  const src = useMemo(
    () =>
      config
        ? drawioEditorUrl(config, {
            ui: prefs.ui,
            dark: drawioDark(prefs.theme, typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"),
            lang: PAGE_LOCALE,
          })
        : "",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving">("loading");
  const [problem, setProblem] = useState("");
  // The diagram as it was when the dialog opened (lib/node-target.ts).
  const [opened] = useState(() => (editor ? openedNode(editor.state, target) : null));
  const modified = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!config) return;
    const origin = config.origin;
    let saving: string | null = null;
    const post = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(JSON.stringify(message), origin);
    const fail = (text: string) => {
      saving = null;
      setState("ready");
      setProblem(text);
      post({ action: "spinner", show: false });
    };
    const apply = async (xml: string, exported: string) => {
      if (!xml || xml.length > MAX_DRAWIO_XML) return fail(t("Das Diagramm ist zu groß, um es hier zu speichern.", "The diagram is too large to be saved here."));
      const { sanitizeDrawioSvg } = await import("@/lib/drawio-svg");
      const svg = sanitizeDrawioSvg(exported);
      if (!svg || svg.length > MAX_DRAWIO_SVG)
        return fail(
          exported.length > MAX_DRAWIO_SVG
            ? t("Das Diagramm ist zu groß, um es hier zu speichern.", "The diagram is too large to be saved here.")
            : t("draw.io hat kein Bild des Diagramms geliefert.", "draw.io did not return a picture of the diagram."),
        );
      if (!editor?.isEditable) return fail(t("Das Dokument kann nicht bearbeitet werden.", "The document cannot be edited."));
      if (target.getPos) {
        const pos = nodeTargetPosition(editor.state, target, opened);
        const node = typeof pos === "number" ? editor.state.doc.nodeAt(pos) : null;
        if (typeof pos !== "number" || node?.type.name !== "drawioBlock" || node.attrs.xml !== target.xml)
          return fail(
            t(
              "Dieses Diagramm wurde inzwischen geändert oder gelöscht. Deine Änderungen sind noch in draw.io geöffnet – exportiere sie dort, bevor du schließt.",
              "This diagram was changed or deleted in the meantime. Your changes are still open in draw.io – export them there before closing.",
            ),
          );
        beginUndoStep(editor.state);
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, xml, svg }));
      } else {
        beginUndoStep(editor.state);
        editor.chain().focus().insertContent({ type: "drawioBlock", attrs: { xml, svg } }).run();
      }
      modified.current = false;
      close.current();
    };
    const listener = (event: MessageEvent) => {
      if (event.origin !== origin || !frame.current || event.source !== frame.current.contentWindow) return;
      const message = parseDrawioMessage(event.data);
      if (!message) return;
      switch (message.event) {
        case "init":
          // autosave: draw.io tells about every change, so closing the
          // dialog can ask before throwing changes away.
          post({ action: "load", xml: target.xml, autosave: 1, title: drawioLabel() });
          return;
        case "load":
          setState("ready");
          return;
        case "autosave":
          modified.current = true;
          return;
        case "save":
          if (saving !== null) return;
          saving = message.xml;
          setProblem("");
          setState("saving");
          post({ action: "export", format: "xmlsvg", spinKey: "saving" });
          return;
        case "export":
          if (saving === null) return;
          void apply(saving || message.xml, svgFromDataUrl(message.data)).catch(() =>
            fail(t("Das Diagramm konnte nicht gespeichert werden.", "The diagram could not be saved.")),
          );
          return;
        case "exit":
          modified.current = false;
          close.current();
          return;
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    if (modified.current && !window.confirm(t("Änderungen am Diagramm verwerfen?", "Discard changes to the diagram?"))) return;
    onClose();
  };
  return (
    <Modal
      open
      wide
      className="drawio-dialog"
      title={t("draw.io-Diagramm", "draw.io diagram")}
      onClose={dismiss}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        editor?.commands.focus();
      }}
    >
      {config?.external && (
        <p className="drawio-privacy">
          {t(
            "Während du bearbeitest, wird der Inhalt des Diagramms an diagrams.net (draw.io) gesendet. Zum Anzeigen braucht Flowplan diagrams.net nicht.",
            "While you edit, the diagram's content is sent to diagrams.net (draw.io). Flowplan does not need diagrams.net to show it.",
          )}
        </p>
      )}
      {problem && (
        <p className="math-validation" role="alert">
          {problem}
        </p>
      )}
      {config ? (
        <div className="drawio-frame" data-state={state}>
          <iframe
            ref={frame}
            src={src}
            title={t("draw.io-Editor", "draw.io editor")}
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals"
          />
        </div>
      ) : (
        <p role="alert">{t("draw.io ist auf diesem Server nicht eingerichtet.", "draw.io is not set up on this server.")}</p>
      )}
    </Modal>
  );
}
