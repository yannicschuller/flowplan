import { Node, mergeAttributes, getSchema } from "@tiptap/core";
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
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  Image.configure({ allowBase64: false }),
  Highlight.configure({ multicolor: true }),
  TextColor,
  Superscript,
  Subscript,
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  Callout,
  Toggle,
  MathBlock,
  MathInline,
  LinkedDatabase,
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
export const Media = Node.create({
  name: "media",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: "" },
      kind: { default: "video" },
      title: { default: "" },
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
        { src, controls: "true", preload: "metadata", class: "media-block" },
      ];
    return ["p", {}, "Medium nicht verfügbar"];
  },
});
documentExtensions.push(Mention, Columns, Column, Media);
