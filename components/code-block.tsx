"use client";
import { useT } from "./i18n";
import { useEditorEditable } from "./editor-editable";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties } from "react";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { FlowCodeBlock } from "@/lib/code-block";
import { MAX_HIGHLIGHT_LENGTH } from "@/lib/code-highlight";
import { codeHighlightPlugin } from "@/lib/code-highlight-plugin";
import { codeLinesPlugin } from "@/lib/code-lines-plugin";
import { isPlainLanguage, languageLabel, rememberLanguage } from "@/lib/code-languages";
import { detectLanguage } from "@/lib/code-detect";
import {
  AUTO_COLLAPSE_LINES,
  collapsedLines,
  effectiveView,
  lineCount,
  previewFirst,
  previewKind,
  startLine,
  type CodeBlockOptions,
  type CodeView,
} from "@/lib/code-block-options";
import { lineNumbersByDefault, onLineNumbersDefault, useLineNumbersByDefault } from "@/lib/code-block-prefs";
import { mountCodePreview } from "@/lib/code-preview";
import { CodeLanguagePicker } from "./code-language-picker";
import { CodeBlockMenu } from "./code-block-menu";

// Code, preview or both side by side (#92): a switch in the toolbar. Editors
// store their choice in the block; readers switch for themselves.
export function CodeViewSwitch({ view, onChange }: { view: CodeView; onChange: (view: CodeView) => void }) {
  const t = useT();
  const labels: Record<CodeView, string> = {
    code: t("Code", "Code"),
    preview: t("Vorschau", "Preview"),
    split: t("Geteilt", "Split"),
  };
  return (
    <span className="code-view-switch" role="group" aria-label={t("Ansicht", "View")}>
      {(["code", "preview", "split"] as CodeView[]).map((option) => (
        <button key={option} type="button" aria-pressed={view === option} onClick={() => onChange(option)}>
          {labels[option]}
        </button>
      ))}
    </span>
  );
}

function CodeView({ node, editor, updateAttributes, getPos }: NodeViewProps) {
  const t = useT();
  const id = useId();
  const [copyStatus, setCopyStatus] = useState("");
  // A guess for pasted code in a block without a language: offered, never
  // applied by itself.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const language = String(node.attrs.language || "plaintext");
  const attrs = node.attrs as Partial<CodeBlockOptions>;
  const editable = useEditorEditable(editor);
  const plain = isPlainLanguage(language);
  const text = node.textContent;
  const lines = lineCount(text);
  const kind = previewKind(language, text);
  // Readers switch the view and collapse for themselves, without editing.
  const [ownView, setOwnView] = useState<CodeView | null>(null);
  const view = editable ? effectiveView(attrs.view, kind, true) : kind ? (ownView ?? effectiveView(attrs.view, kind, false)) : "code";
  const numbersByDefault = useLineNumbersByDefault();
  const numbered = typeof attrs.lineNumbers === "boolean" ? attrs.lineNumbers : numbersByDefault;
  const first = startLine(attrs.startLine);
  // Long blocks start collapsed (#94): decided when the block appears, so a
  // block does not fold up while someone types it longer.
  const [longAtStart] = useState(() => lines > AUTO_COLLAPSE_LINES);
  const [ownCollapsed, setOwnCollapsed] = useState<boolean | null>(null);
  const limit = collapsedLines(attrs.collapsedLines);
  const collapsible = lines > limit;
  const stored = typeof attrs.collapsed === "boolean" ? attrs.collapsed : longAtStart;
  const collapsed = collapsible && (editable ? stored : (ownCollapsed ?? stored));
  const preId = `${id}-code`;

  const setLanguage = (next: string) => {
    rememberLanguage(next);
    setSuggestion(null);
    // Mermaid shows its diagram (#95): with the code beside it while empty.
    const view = !attrs.view && previewFirst(next) ? (text.trim() ? "preview" : "split") : attrs.view;
    updateAttributes({ language: next, view: view ?? null });
  };
  const setView = (next: CodeView) => {
    if (!editable) return setOwnView(next);
    // The caret does not stay in code that is hidden now.
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (next === "preview" && typeof pos === "number") {
      const { from, to } = editor.state.selection;
      if (from > pos && to < pos + node.nodeSize) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    }
    updateAttributes({ view: next });
  };
  const toggleCollapsed = () => {
    if (editable) updateAttributes({ collapsed: !collapsed });
    else setOwnCollapsed(!collapsed);
  };

  // The preview: drawn right away the first time, then a moment after the
  // last keystroke.
  const preview = useRef<HTMLDivElement>(null);
  const drawn = useRef(false);
  useEffect(() => {
    const element = preview.current;
    if (!kind || view === "code" || !element) {
      drawn.current = false;
      return;
    }
    let cancel = () => {};
    const timer = setTimeout(() => (cancel = mountCodePreview(element, kind, text)), drawn.current ? 400 : 0);
    drawn.current = true;
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [kind, text, view]);

  // The fade at the bottom of a collapsed block goes once it is scrolled to
  // the end.
  const wrapper = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  useLayoutEffect(() => {
    const pre = wrapper.current?.querySelector<HTMLElement>("pre");
    if (!pre || !collapsed) return;
    const check = () => setAtEnd(pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4);
    check();
    pre.addEventListener("scroll", check, { passive: true });
    return () => pre.removeEventListener("scroll", check);
  }, [collapsed, text]);

  const digits = String(first + Math.max(0, lines - 1)).length;
  return (
    <NodeViewWrapper
      ref={wrapper}
      className="code-block-view"
      data-language={language}
      data-view={view}
      data-collapsed={collapsed ? "true" : undefined}
      style={{ "--code-gutter": `${digits}ch`, "--code-collapsed-lines": limit } as CSSProperties}
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
        {kind && <CodeViewSwitch view={view} onChange={setView} />}
        <span className="code-block-actions">
          {view !== "preview" && (
            <button
              type="button"
              aria-pressed={!!node.attrs.wrap}
              disabled={!editable}
              onClick={() => updateAttributes({ wrap: !node.attrs.wrap })}
            >
              {t("Zeilenumbruch", "Line wrap")}
            </button>
          )}
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
          {editable && (
            <CodeBlockMenu
              attrs={attrs}
              numbered={numbered}
              collapsed={collapsed}
              collapsible={collapsible}
              onChange={(next) => updateAttributes(next)}
            />
          )}
        </span>
      </div>
      <div className="code-block-body">
        <div className="code-block-code">
          <NodeViewContent<"pre">
            as="pre"
            id={preId}
            data-code-wrap={node.attrs.wrap ? "true" : undefined}
            data-line-numbers={numbered ? "true" : undefined}
            // A collapsed block scrolls inside: reachable by keyboard.
            tabIndex={collapsed && !editable ? 0 : undefined}
            spellCheck={false}
            style={{ whiteSpace: node.attrs.wrap ? "pre-wrap" : "pre" }}
          />
          {collapsed && !atEnd && <div className="code-block-fade" contentEditable={false} aria-hidden="true" />}
        </div>
        {kind && view !== "code" && (
          <div
            ref={preview}
            className="code-block-preview"
            contentEditable={false}
            role="region"
            aria-label={t("Vorschau", "Preview")}
          />
        )}
      </div>
      {collapsible && view !== "preview" && (
        <button
          type="button"
          className="code-block-expand"
          contentEditable={false}
          aria-expanded={!collapsed}
          aria-controls={preId}
          onClick={toggleCollapsed}
        >
          {collapsed ? t(`Alle ${lines} Zeilen anzeigen`, `Show all ${lines} lines`) : t("Einklappen", "Collapse")}
        </button>
      )}
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
    return [
      ...(this.parent?.() || []),
      codeHighlightPlugin(this.name),
      codeLinesPlugin(this.name, lineNumbersByDefault, onLineNumbersDefault),
    ];
  },
});
