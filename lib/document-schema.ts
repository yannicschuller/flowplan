import { Mark, Node, mergeAttributes, getSchema } from "@tiptap/core";
import { embedProvider } from "./embed-providers";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Subscript, Superscript, TextColor } from "./text-marks";
import { MermaidBlock } from "./mermaid-node";
import { FlowCodeBlock } from "./code-block";
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "aside",
    mergeAttributes(HTMLAttributes, {
      "data-callout": "true",
      class: "editor-callout",
    }),
    0,
  ],
});
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      title: {
        default: "Weitere Informationen",
        parseHTML: (el) =>
          el.querySelector("summary")?.textContent || "Details",
      },
    };
  },
  parseHTML: () => [{ tag: "details", contentElement: "div" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "details",
    mergeAttributes(HTMLAttributes, { open: true }),
    ["summary", node.attrs.title],
    ["div", 0],
  ],
});
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return { expression: { default: "E = mc^2" } };
  },
  parseHTML: () => [
    {
      tag: "div[data-math]",
      getAttrs: (e) => ({
        expression: (e as HTMLElement).getAttribute("data-math"),
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    { "data-math": node.attrs.expression, class: "math-block" },
    node.attrs.expression,
  ],
});
export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { expression: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "span[data-math]",
      getAttrs: (element) => ({
        expression: (element as HTMLElement).getAttribute("data-math") || "",
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "span",
    { "data-math": node.attrs.expression, class: "math-inline" },
    node.attrs.expression,
  ],
  renderText: ({ node }) => node.attrs.expression,
});
export const LinkedDatabase = Node.create({
  name: "linkedDatabase",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      id: { default: "" },
      source: { default: "" },
      views: { default: "[]" },
      version: { default: "1" },
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-linked-database]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        return {
          id: el.getAttribute("data-linked-database"),
          source: el.getAttribute("data-linked-source"),
          views: el.getAttribute("data-linked-views") || "[]",
          version: el.getAttribute("data-linked-version") || "1",
        };
      },
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-linked-database": node.attrs.id,
      "data-linked-source": node.attrs.source,
      "data-linked-views": node.attrs.views,
      "data-linked-version": node.attrs.version,
      class: "linked-database-placeholder",
    },
    "Verknüpfte Datenbank · Zugriff im Arbeitsbereich erforderlich",
  ],
});
// A whiteboard shown inside a document; the view is filled in by the editor
// and read-only renderers, the stored HTML only names the board.
export const WhiteboardEmbed = Node.create({
  name: "whiteboardEmbed",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      pageId: { default: "" },
      height: { default: 360 },
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-whiteboard]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        const height = Number(el.getAttribute("data-whiteboard-height"));
        return {
          pageId: el.getAttribute("data-whiteboard"),
          height:
            Number.isFinite(height) && height >= 160 && height <= 1200
              ? height
              : 360,
        };
      },
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-whiteboard": node.attrs.pageId,
      "data-whiteboard-height": String(node.attrs.height),
      class: "whiteboard-embed-placeholder",
    },
    "Eingebettetes Whiteboard",
  ],
});
// Tasks remember the day they were first carried over in a journal, so a day
// that only holds carried tasks counts as untouched.
export const FlowTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      journalSince: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-journal-since"),
        renderHTML: (attributes) =>
          attributes.journalSince
            ? { "data-journal-since": attributes.journalSince }
            : {},
      },
    };
  },
});
// Spoiler text: covered for readers until clicked, lightly marked while
// writing.
export const Spoiler = Mark.create({
  name: "spoiler",
  parseHTML() {
    return [{ tag: "span[data-spoiler]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-spoiler": "" }), 0];
  },
  addKeyboardShortcuts() {
    return { "Mod-Alt-h": () => this.editor.commands.toggleMark(this.name) };
  },
});
export const documentExtensions = [
  StarterKit.configure({
    codeBlock: false,
    undoRedo: false,
    link: {
      openOnClick: false,
      HTMLAttributes: { rel: "noopener noreferrer" },
    },
  }),
  FlowCodeBlock,
  MermaidBlock,
  TaskList,
  FlowTaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  Image.configure({ allowBase64: false }),
  Highlight.configure({ multicolor: true }),
  TextColor,
  Superscript,
  Subscript,
  Spoiler,
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  Callout,
  Toggle,
  MathBlock,
  MathInline,
  LinkedDatabase,
  WhiteboardEmbed,
];
export const documentSchema = () => getSchema(documentExtensions);
export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { userId: { default: "" }, label: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "span[data-mention]",
      getAttrs: (el) => ({
        userId: (el as HTMLElement).getAttribute("data-mention"),
        label: (el as HTMLElement).textContent?.replace(/^@/, ""),
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "span",
    { "data-mention": node.attrs.userId, class: "mention" },
    "@" + node.attrs.label,
  ],
});
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,3}",
  defining: true,
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: () => [
    "div",
    { "data-columns": "true", class: "editor-columns" },
    0,
  ],
});
export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: () => [
    "div",
    { "data-column": "true", class: "editor-column" },
    0,
  ],
});
export const MEDIA_WIDTHS = [25, 50, 75, 100] as const;
function mediaWidth(style: string | null) {
  const value = Number(/(?:^|;)\s*width\s*:\s*(\d+)%/i.exec(style || "")?.[1]);
  return MEDIA_WIDTHS.includes(value as (typeof MEDIA_WIDTHS)[number])
    ? value
    : 100;
}
export const widthStyle = (width: unknown) =>
  MEDIA_WIDTHS.includes(Number(width) as (typeof MEDIA_WIDTHS)[number]) &&
  Number(width) !== 100
    ? { style: `width: ${Number(width)}%` }
    : {};
export const Media = Node.create({
  name: "media",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: "" },
      kind: { default: "video" },
      title: { default: "" },
      // Width in percent of the text column (25–100).
      width: {
        default: 100,
        parseHTML: (el: HTMLElement) => mediaWidth(el.getAttribute("style")),
      },
    };
  },
  parseHTML: () => [
    {
      tag: "video",
      getAttrs: (el) => ({
        src: (el as HTMLElement).getAttribute("src"),
        kind: "video",
      }),
    },
    {
      tag: "audio",
      getAttrs: (el) => ({
        src: (el as HTMLElement).getAttribute("src"),
        kind: "audio",
      }),
    },
    {
      tag: "iframe",
      getAttrs: (el) => ({
        src: (el as HTMLElement).getAttribute("src"),
        kind: "embed",
      }),
    },
  ],
  renderHTML: ({ node }) => {
    const { src, kind, title } = node.attrs;
    const provider = kind === "embed" ? embedProvider(src || "") : undefined;
    if (provider)
      return [
        "iframe",
        {
          src,
          title: title || provider.name,
          "data-provider": provider.name.toLowerCase(),
          ...widthStyle(node.attrs.width),
          class: "video-embed",
          allowfullscreen: "true",
          sandbox: "allow-scripts allow-same-origin allow-presentation",
          loading: "lazy",
        },
      ];
    if (
      ["audio", "video"].includes(kind) &&
      /^\/api\/files\/[a-f0-9-]+$/.test(src)
    )
      return [
        kind,
        {
          src,
          controls: "true",
          preload: "metadata",
          class: "media-block",
          ...widthStyle(node.attrs.width),
        },
      ];
    return ["p", {}, "Medium nicht verfügbar"];
  },
});
// Preview card for any web page (title, provider, description, image).
const httpsOnly = (value: string | null) =>
  value && /^https:\/\//i.test(value) ? value : "";
export const LinkCard = Node.create({
  name: "linkCard",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      url: { default: "" },
      title: { default: "" },
      provider: { default: "" },
      description: { default: "" },
      image: { default: "" },
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-link-card]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        const url = httpsOnly(el.getAttribute("data-link-card"));
        if (!url) return false;
        return {
          url,
          title: el.getAttribute("data-link-title") || "",
          provider: el.getAttribute("data-link-provider") || "",
          description: el.getAttribute("data-link-description") || "",
          image: httpsOnly(el.getAttribute("data-link-image")),
        };
      },
    },
  ],
  renderHTML: ({ node }) => {
    const { url, title, provider, description, image } = node.attrs;
    const safe = httpsOnly(url);
    const picture = httpsOnly(image);
    return [
      "div",
      {
        class: "link-card",
        "data-link-card": safe,
        "data-link-title": title,
        "data-link-provider": provider,
        "data-link-description": description,
        "data-link-image": picture,
      },
      [
        "a",
        { href: safe, target: "_blank", rel: "noopener noreferrer" },
        [
          "span",
          { class: "link-card-text" },
          ["strong", {}, title || safe],
          ...(description ? [["span", {}, description]] : []),
          ["small", {}, provider],
        ],
        ...(picture ? [["img", { src: picture, alt: "" }]] : []),
      ],
    ];
  },
});
documentExtensions.push(Mention, Columns, Column, Media, LinkCard);
