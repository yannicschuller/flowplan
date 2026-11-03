"use client";
import { useT } from "./i18n";
import { useEditorEditable } from "./editor-editable";
import { useState, type ClipboardEvent } from "react";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { FlowCodeBlock } from "@/lib/code-block";
import { MAX_HIGHLIGHT_LENGTH } from "@/lib/code-highlight";
import { codeHighlightPlugin } from "@/lib/code-highlight-plugin";
import { isPlainLanguage, languageLabel, rememberLanguage } from "@/lib/code-languages";
import { detectLanguage } from "@/lib/code-detect";
import { CodeLanguagePicker } from "./code-language-picker";
function CodeView({ node, editor, updateAttributes }: NodeViewProps) {
  const t = useT();
  const [copyStatus, setCopyStatus] = useState("");
  // A guess for pasted code in a block without a language: offered, never
  // applied by itself.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const language = String(node.attrs.language || "plaintext");
  const editable = useEditorEditable(editor);
  const plain = isPlainLanguage(language);
  const setLanguage = (next: string) => {
    rememberLanguage(next);
    setSuggestion(null);
    updateAttributes({ language: next });
  };
  return (
    <NodeViewWrapper
      className="code-block-view"
      data-language={language}
      onPaste={(event: ClipboardEvent) => {
        if (!editable || !plain) return;
        const text = event.clipboardData?.getData("text/plain") || "";
        const guess = detectLanguage(text);
        if (guess) setSuggestion(guess);
      }}
    >
      <div className="code-block-toolbar" contentEditable={false}>
        <span className="code-block-language">
          <span aria-hidden="true">{t("Sprache", "Language")}</span>
          <CodeLanguagePicker value={language} disabled={!editable} onChange={setLanguage} />
        </span>
        {suggestion && plain && editable && (
          <span className="code-language-suggestion">
            <button type="button" onClick={() => setLanguage(suggestion)}>
              {t(`Sieht aus wie ${languageLabel(suggestion)} – übernehmen?`, `Looks like ${languageLabel(suggestion)} – set?`)}
            </button>
            <button
              type="button"
              className="code-language-dismiss"
              aria-label={t("Vorschlag ausblenden", "Dismiss suggestion")}
              onClick={() => setSuggestion(null)}
            >
              ×
            </button>
          </span>
        )}
        <button
          type="button"
          aria-pressed={!!node.attrs.wrap}
          disabled={!editable}
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
  addProseMirrorPlugins() {
    return [...(this.parent?.() || []), codeHighlightPlugin(this.name)];
  },
});
