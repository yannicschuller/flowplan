"use client";
import { useT } from "./i18n";
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
  const t = useT();
  const [copyStatus, setCopyStatus] = useState("");
  const language = String(node.attrs.language || "plaintext");
  return (
    <NodeViewWrapper className="code-block-view" data-language={language}>
      <div className="code-block-toolbar" contentEditable={false}>
        <label>
          {t("Sprache", "Language")}
          <Select
            aria-label={t("Code-Sprache", "Code language")}
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
          {t("Zeilenumbruch", "Line wrap")}
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(node.textContent);
              setCopyStatus(t("Code kopiert", "Code copied"));
            } catch {
              setCopyStatus(
                t("Kopieren fehlgeschlagen. Bitte den Code markieren und kopieren.", "Copying failed. Please select the code and copy it."),
              );
            }
          }}
        >
          {t("Kopieren", "Copy")}
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
          {t("Langer Codeblock: Hervorhebung ausgeschaltet.", "Long code block: highlighting turned off.")}
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
