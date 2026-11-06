import CodeBlock, { backtickInputRegex, tildeInputRegex } from "@tiptap/extension-code-block";
import { mergeAttributes, textblockTypeInputRule } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { fenceLanguage } from "./code-languages";
import { captionAttribute, captionText } from "./block-captions";
import { optionAttributes, optionsFromAttributes, previewFirst, type CodeBlockOptions } from "./code-block-options";
// The code block of documents (schema, server and editor). Highlighting is
// added by the editor only (components/code-block.tsx with
// lib/code-highlight-plugin.ts), so the schema carries no grammar.
// A caption (lib/block-captions.ts) puts the code into a <figure> with
// <figcaption> below it.
// The block's own view (code, preview, split), line numbers and collapse
// (lib/code-block-options.ts) are attributes as well, data-… on <pre>.
const languageOf = (element: HTMLElement) =>
  [...(element.firstElementChild?.classList || [])].find((name) => name.startsWith("language-"))?.slice("language-".length) || null;
const option = (key: keyof CodeBlockOptions) => ({
  default: null as unknown,
  parseHTML: (element: HTMLElement) => optionsFromAttributes((name) => element.getAttribute(name), languageOf(element))[key],
  rendered: false,
});
export const FlowCodeBlock = CodeBlock.extend({
  // Code takes no formatting – but suggested changes (lib/suggestions.ts):
  // while suggesting, and the AI's proposals for a code block (#135).
  marks: "suggestion",
  addAttributes() {
    const parent = this.parent?.() || {};
    return {
      ...parent,
      language: {
        ...parent.language,
        // Older ids and aliases ("js", "py", "sh") become Shiki's ids when
        // HTML is read (paste, import); unknown languages stay as written.
        parseHTML: (element: HTMLElement) => {
          const language = languageOf(element);
          return language ? fenceLanguage(language) : null;
        },
      },
      wrap: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-code-wrap") === "true",
        rendered: false,
      },
      view: option("view"),
      lineNumbers: option("lineNumbers"),
      startLine: { ...option("startLine"), default: 1 },
      highlightLines: { ...option("highlightLines"), default: "" },
      collapsed: option("collapsed"),
      collapsedLines: option("collapsedLines"),
      caption: captionAttribute(),
    };
  },
  // ```mermaid starts a block that shows code and diagram side by side (#95).
  addInputRules() {
    const getAttributes = (match: RegExpMatchArray) => ({
      language: match[1],
      ...(previewFirst(match[1]) ? { view: "split" } : {}),
    });
    return [
      textblockTypeInputRule({ find: backtickInputRegex, type: this.type, getAttributes }),
      textblockTypeInputRule({ find: tildeInputRegex, type: this.type, getAttributes }),
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const pre: DOMOutputSpec = [
      "pre",
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        node.attrs.wrap ? { "data-code-wrap": "true" } : {},
        optionAttributes(node.attrs as Partial<CodeBlockOptions>),
      ),
      [
        "code",
        {
          class: node.attrs.language ? `language-${node.attrs.language}` : null,
        },
        0,
      ],
    ];
    const caption = captionText(node.attrs.caption);
    return caption ? ["figure", { class: "block-figure" }, pre, ["figcaption", {}, caption]] : pre;
  },
}).configure({
  defaultLanguage: "plaintext",
  enableTabIndentation: true,
  tabSize: 2,
});
