"use client";
import { Select } from "./select";
import { useState } from "react";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { FlowCodeBlock } from "@/lib/code-block";
import {
  codeLanguages,
  languageLabel,
  MAX_HIGHLIGHT_LENGTH,
} from "@/lib/code-highlight";
function CodeView({ node, editor, updateAttributes }: NodeViewProps) {
  const [copyStatus, setCopyStatus] = useState("");
  const language = String(node.attrs.language || "plaintext");
  return (
    <NodeViewWrapper className="code-block-view" data-language={language}>
      <div className="code-block-toolbar" contentEditable={false}>
        <label>
          Sprache
          <Select
            aria-label="Code-Sprache"
            value={language}
            disabled={!editor.isEditable}
            onChange={(event) =>
              updateAttributes({ language: event.target.value })
            }
          >
            {!codeLanguages.includes(language) && (
              <option value={language}>
                {languageLabel(language)} (importiert)
              </option>
            )}
            {codeLanguages.map((value) => (
              <option value={value} key={value}>
                {languageLabel(value)}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          aria-pressed={!!node.attrs.wrap}
          disabled={!editor.isEditable}
          onClick={() => updateAttributes({ wrap: !node.attrs.wrap })}
        >
          Zeilenumbruch
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(node.textContent);
              setCopyStatus("Code kopiert");
            } catch {
              setCopyStatus(
                "Kopieren fehlgeschlagen. Bitte den Code markieren und kopieren.",
              );
            }
          }}
        >
          Kopieren
        </button>
      </div>
      <NodeViewContent<"pre">
        as="pre"
        data-code-wrap={node.attrs.wrap ? "true" : undefined}
        spellCheck={false}
        style={{ whiteSpace: node.attrs.wrap ? "pre-wrap" : "pre" }}
      />
      {node.textContent.length > MAX_HIGHLIGHT_LENGTH && (
        <p className="code-block-note" contentEditable={false}>
          Langer Codeblock: Hervorhebung ausgeschaltet.
        </p>
      )}
      <span role="status" className="sr-only" contentEditable={false}>
        {copyStatus}
      </span>
    </NodeViewWrapper>
  );
}
export const EditableCodeBlock = FlowCodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView, { contentDOMElementTag: "code" });
  },
});
