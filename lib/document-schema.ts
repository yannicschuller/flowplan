import { DrawBlock } from "./draw-block-node";
import { Suggestion } from "./suggestions";
import { BlockReactionAttribute } from "./block-reactions";
import { BlockIdAttribute } from "./block-ids";
import { focusToggleTitle, titleAbove, toggleBlocksPlugin, toggleNodeView, toggleOpen, togglesAround } from "./toggle-view";
import { Extension, Mark, Node, mergeAttributes, getSchema, getMarkRange, getAttributesFromExtensions, getRenderedAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { embedProvider } from "./embed-providers";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { subtasksPlugin } from "./task-subtasks";
import { cycleTaskStatus, taskStatusPlugin } from "./task-status-commands";
import { isStoredStatus, isTaskSymbol, statusHtmlAttrs, statusName, taskStatusOf, taskSymbolOf } from "./task-status";
import type { TaskItemOptions } from "@tiptap/extension-task-item";
import type { Node as PMNode } from "@tiptap/pm/model";
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
import { DrawioBlock } from "./drawio-node";
import { FunctionPlot } from "./function-plot-node";
import { MetricBlock } from "./metric-node";
import { PluginBlock } from "./plugin-node";
import { WorkflowButton } from "./workflow-button-node";
import { FlowCodeBlock } from "./code-block";
import { Bibliography, Citation } from "./citation-nodes";
import { Footnote } from "./footnotes";
import { BlockDirectionExtension } from "./text-direction";
import { ListTidy } from "./list-tidy";
import { calloutColor, calloutIcon } from "./callout-types";
import { blockFigcaption, captionAttribute, captionText } from "./block-captions";
// Images that were marked up keep their original and the markings
// (components/image-annotator.tsx), so they can be edited again. A caption
// (lib/block-captions.ts) makes the image a <figure> with <figcaption>.
export const AnnotatedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      original: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-original"),
        renderHTML: (attrs) => (attrs.original ? { "data-original": attrs.original } : {}),
      },
      annotations: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-annotations"),
        renderHTML: (attrs) => (attrs.annotations ? { "data-annotations": attrs.annotations } : {}),
      },
      caption: captionAttribute(),
    };
  },
  parseHTML() {
    return [
      ...(this.parent?.() || []),
      // The figure's caption is the image's (read by its attribute).
      { tag: "figcaption", ignore: true, getAttrs: (el) => (blockFigcaption(el as HTMLElement) ? null : false) },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const image: DOMOutputSpec = ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
    const caption = captionText(node.attrs.caption);
    return caption ? ["figure", { class: "block-figure" }, image, ["figcaption", {}, caption]] : image;
  },
});
// Tables with a caption: <caption> as their first child.
export const CaptionedTable = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), caption: captionAttribute() };
  },
  parseHTML() {
    return [...(this.parent?.() || []), { tag: "caption", ignore: true }];
  },
  renderHTML(props) {
    const spec = this.parent?.(props) as DOMOutputSpec;
    const caption = captionText(props.node.attrs.caption);
    if (!caption || !Array.isArray(spec)) return spec;
    // [table, attrs, colgroup, tbody] (or a wrapper around it).
    const withCaption = (table: readonly unknown[]): DOMOutputSpec =>
      [table[0], table[1], ["caption", {}, caption], ...table.slice(2)] as unknown as DOMOutputSpec;
    return spec[0] === "table" ? withCaption(spec) : ([...spec.slice(0, 2), withCaption(spec[2] as unknown[])] as unknown as DOMOutputSpec);
  },
});

// The five kinds of GitHub alerts (also Forgejo, Obsidian). Older callouts
// (data-callout="true") are notes.
export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];
export const calloutType = (value: unknown): CalloutType =>
  CALLOUT_TYPES.includes(value as CalloutType) ? (value as CalloutType) : "note";
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({
    type: {
      default: "note",
      parseHTML: (element) => calloutType(element.getAttribute("data-callout")),
      renderHTML: (attributes) => ({ "data-callout": calloutType(attributes.type) }),
    },
    // Its own emoji or symbol in place of the kind's icon, and its own
    // colour from the text palette (issue #72); the kind stays the title.
    icon: {
      default: null,
      parseHTML: (element) => calloutIcon(element.getAttribute("data-callout-icon")),
      renderHTML: (attributes) => {
        const icon = calloutIcon(attributes.icon);
        return icon ? { "data-callout-icon": icon } : {};
      },
    },
    color: {
      default: null,
      parseHTML: (element) => calloutColor(element.getAttribute("data-callout-color")),
      renderHTML: (attributes) => {
        const color = calloutColor(attributes.color);
        return color ? { "data-callout-color": color } : {};
      },
    },
  }),
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "aside",
    mergeAttributes(HTMLAttributes, { class: "editor-callout" }),
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
  // Stored, exported and read: always open. In the editor a node view of
  // its own opens and closes it (lib/toggle-view.ts, #137) – the state is
  // not part of the document.
  renderHTML: ({ node, HTMLAttributes }) => [
    "details",
    mergeAttributes(HTMLAttributes, { open: true }),
    ["summary", node.attrs.title],
    ["div", 0],
  ],
  addNodeView() {
    return (props) => {
      const attributes = getAttributesFromExtensions(props.editor.extensionManager.extensions);
      return toggleNodeView({ ...props, attributesOf: (node) => getRenderedAttributes(node, attributes) });
    };
  },
  addProseMirrorPlugins() {
    return [toggleBlocksPlugin()];
  },
  // ⌘⌥↵ / Ctrl+Alt+Enter inside a toggle closes it (the caret goes to its
  // title, where the same keys open it again); ↑ or ← at the very start of
  // its content go to the title.
  addKeyboardShortcuts() {
    const toTitle = () => {
      const pos = titleAbove(this.editor.state);
      return pos !== null && focusToggleTitle(this.editor.view, pos);
    };
    return {
      "Mod-Alt-Enter": ({ editor }) => {
        const around = togglesAround(editor.state.doc, editor.state.selection.from);
        const inner = around[around.length - 1];
        if (!inner) return false;
        toggleOpen(editor.view, inner.pos, true);
        return true;
      },
      ArrowUp: toTitle,
      ArrowLeft: toTitle,
    };
  },
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
// A synced block: shows the content of a synced page (lib/api.ts
// "synced.create"); editing it anywhere changes it everywhere.
export const SyncedBlock = Node.create({
  name: "syncedBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { pageId: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "div[data-synced-block]",
      getAttrs: (element) => {
        const id = (element as HTMLElement).getAttribute("data-synced-block") || "";
        return /^[0-9a-f-]{36}$/i.test(id) ? { pageId: id } : false;
      },
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    { "data-synced-block": node.attrs.pageId, class: "synced-block-placeholder" },
    "Synchronisierter Block",
  ],
});
// Tasks remember the day they were first carried over in a journal, so a day
// that only holds carried tasks counts as untouched.
// The states beyond open and done (#201, lib/task-status.ts): `status` and
// an Obsidian `symbol`, shown as data-status / data-symbol on the item.
type FlowTaskItemOptions = TaskItemOptions & {
  // Right click or long press on the box: the menu of the five states.
  onStatusMenu: ((pos: number, anchor: DOMRect) => void) | null;
  // The interface language for the box's accessible name.
  translate: (de: string, en: string) => string;
};
export const FlowTaskItem = TaskItem.extend<FlowTaskItemOptions>({
  addOptions() {
    return {
      ...(this.parent?.() as TaskItemOptions),
      onStatusMenu: null,
      translate: (_de: string, en: string) => en.split("||")[0],
    };
  },
  // Ticking a task off ticks off its subtasks (lib/task-subtasks.ts); a
  // state that no longer fits the box goes (lib/task-status-commands.ts).
  addProseMirrorPlugins() {
    return [...(this.parent?.() || []), subtasksPlugin(), taskStatusPlugin()];
  },
  // The box names the state ("In Arbeit: Angebot schreiben"); in progress
  // is "mixed" for screen readers. Right click or a long press opens the
  // menu of the states while editing.
  addNodeView() {
    const parent = this.parent?.();
    if (!parent) return null;
    const options = this.options;
    return (props) => {
      const view = parent(props) as {
        dom: HTMLElement;
        update?: (node: PMNode, ...rest: never[]) => boolean;
      };
      const label = view.dom.querySelector<HTMLElement>(":scope > label");
      const box = label?.querySelector<HTMLInputElement>("input");
      const hidden = label?.querySelector<HTMLElement>("span");
      const describe = (node: PMNode) => {
        if (!box) return;
        const status = taskStatusOf(node.attrs);
        const symbol = taskSymbolOf(node.attrs);
        const text = node.firstChild?.textContent.trim() || options.translate("Leere Aufgabe", "Empty task");
        const name = `${statusName(options.translate, status)}${symbol ? ` [${symbol}]` : ""}: ${text}`;
        box.setAttribute("aria-label", name);
        if (hidden) hidden.textContent = name;
        box.indeterminate = status === "progress";
      };
      describe(props.node);
      if (label && box) {
        let timer: ReturnType<typeof setTimeout> | null = null,
          pressed = 0;
        const open = () => {
          const pos = typeof props.getPos === "function" ? props.getPos() : undefined;
          if (typeof pos !== "number" || !options.onStatusMenu || !props.editor.isEditable) return false;
          options.onStatusMenu(pos, box.getBoundingClientRect());
          return true;
        };
        // A right click leaves the selection alone (no toolbar over the menu).
        label.addEventListener("mousedown", (event) => {
          if (event.button !== 0 && options.onStatusMenu && props.editor.isEditable) {
            event.preventDefault();
            event.stopPropagation();
          }
        });
        label.addEventListener("contextmenu", (event) => {
          // A long press opened it already (Android fires both).
          if (Date.now() - pressed < 800 || open()) {
            event.preventDefault();
            event.stopPropagation();
          }
        });
        const stop = () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
        label.addEventListener(
          "touchstart",
          () => {
            stop();
            timer = setTimeout(() => {
              timer = null;
              if (open()) pressed = Date.now();
            }, 500);
          },
          { passive: true },
        );
        label.addEventListener("touchmove", stop, { passive: true });
        label.addEventListener("touchend", stop);
        label.addEventListener("touchcancel", stop);
        // The tap that ends a long press does not tick the task.
        label.addEventListener(
          "click",
          (event) => {
            if (Date.now() - pressed < 800) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
          true,
        );
      }
      const update = view.update;
      if (update)
        view.update = (node, ...rest) => {
          const kept = update(node, ...rest);
          if (kept) describe(node);
          return kept;
        };
      return view as ReturnType<typeof parent>;
    };
  },
  // Enter at the very start of a task adds an empty task above it; the task
  // itself keeps its date and its carried-over mark (splitting would hand
  // them to the empty line).
  addKeyboardShortcuts() {
    const parent = this.parent?.() || {};
    return {
      ...parent,
      Enter: (props) => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        const depth = $from.depth - 1;
        if (
          empty &&
          depth > 0 &&
          $from.parentOffset === 0 &&
          $from.parent.content.size > 0 &&
          $from.node(depth).type.name === this.name &&
          $from.index(depth) === 0
        ) {
          const item = this.type.createAndFill();
          if (item) {
            view.dispatch(state.tr.insert($from.before(depth), item).scrollIntoView());
            return true;
          }
        }
        return parent.Enter ? parent.Enter(props) : false;
      },
      // Ctrl/Cmd+L (#201): a line becomes a task, a task goes to its next
      // state. Taken while editing, so the browser's address bar keeps out.
      "Mod-l": () => {
        if (!this.editor.isEditable) return false;
        cycleTaskStatus(this.editor.state, this.editor.view.dispatch);
        return true;
      },
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      // Only tasks really carried over keep it: a new task made with Enter
      // from a carried one starts without (and without the ↻ badge).
      journalSince: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => element.getAttribute("data-journal-since"),
        renderHTML: (attributes) =>
          attributes.journalSince
            ? { "data-journal-since": attributes.journalSince }
            : {},
      },
      // In progress, cancelled or deferred (lib/task-status.ts); null: open
      // or done as `checked` says. Rendered from the state it gives with
      // `checked`, so an older client's tick never shows two states.
      status: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const value = element.getAttribute("data-status");
          return isStoredStatus(value) ? value : null;
        },
        renderHTML: (attributes) => statusHtmlAttrs(attributes),
      },
      // An Obsidian symbol Flowplan has no state for ("[?]", "[!]"): the
      // task is open and is written back with it (rendered with `status`).
      symbol: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const value = element.getAttribute("data-symbol");
          return isTaskSymbol(value) ? value : null;
        },
        renderHTML: () => ({}),
      },
      // Due date of the task (YYYY-MM-DD), shown as a chip in the editor.
      // A new task made with Enter starts without one.
      due: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const value = element.getAttribute("data-due");
          return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
        },
        renderHTML: (attributes) =>
          attributes.due ? { "data-due": attributes.due } : {},
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
  // Spoilers stay covered while writing too. The paragraph with the caret in
  // a spoiler (or a clicked one in a read-only view) opens its spoilers;
  // leaving covers them again. The mark goes on the block, not around the
  // text, so typing at the end of a spoiler stays inside it.
  addProseMirrorPlugins() {
    const type = this.type;
    type Open = { from: number; to: number } | null;
    const key = new PluginKey<Open>("spoilerReveal");
    const blockAt = (doc: import("@tiptap/pm/model").Node, pos: number): Open => {
      const $pos = doc.resolve(pos);
      if (!getMarkRange($pos, type)) return null;
      if (!$pos.parent.isTextblock || $pos.depth < 1) return null;
      return { from: $pos.before(), to: $pos.after() };
    };
    return [
      new Plugin<Open>({
        key,
        state: {
          init: (): Open => null,
          apply(tr, value: Open, _old, state): Open {
            const clicked = tr.getMeta(key);
            if (clicked !== undefined) return clicked;
            if (tr.selectionSet || tr.docChanged) {
              const here = state.selection.empty
                ? blockAt(state.doc, state.selection.from)
                : null;
              if (here) return here;
              if (tr.selectionSet) return null;
            }
            if (!value) return null;
            const from = tr.mapping.map(value.from, 1),
              to = tr.mapping.map(value.to, -1);
            return to > from ? { from, to } : null;
          },
        },
        props: {
          handleClick(view, pos) {
            view.dispatch(view.state.tr.setMeta(key, blockAt(view.state.doc, pos)));
            return false;
          },
          decorations(state) {
            const open = key.getState(state);
            if (!open) return null;
            try {
              return DecorationSet.create(state.doc, [
                Decoration.node(open.from, open.to, { "data-spoiler-open": "" }),
              ]);
            } catch {
              return null;
            }
          },
        },
      }),
    ];
  },
});
// Indenting paragraphs and headings with Tab / Shift+Tab (lists, tasks,
// tables and code keep their own Tab). Backspace at the start of an indented
// line first moves it back out.
export const MAX_INDENT = 8;
export const Indent = Extension.create({
  name: "indent",
  // Before the default Backspace; inside lists, tables and code the
  // handlers below step aside so those keep their own Tab.
  priority: 1000,
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) =>
              Math.min(MAX_INDENT, Math.max(0, Number(element.getAttribute("data-indent")) || 0)),
            renderHTML: (attributes) =>
              attributes.indent ? { "data-indent": attributes.indent } : {},
          },
        },
      },
    ];
  },
  // Lists, tasks and tables indent by nesting: a paragraph that ends up
  // inside one (Enter after an indented line, "- " at its start, pasting)
  // drops its own indent, or the item would be indented twice.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("indentInContainers"),
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          // Only where something changed, mapped to the final document.
          const ranges: [number, number][] = [];
          transactions.forEach((t, index) =>
            t.mapping.maps.forEach((map, step) =>
              map.forEach((_a, _b, start, end) => {
                let from = start,
                  to = end;
                for (const later of [...t.mapping.maps.slice(step + 1), ...transactions.slice(index + 1).flatMap((n) => n.mapping.maps)]) {
                  from = later.map(from, -1);
                  to = later.map(to, 1);
                }
                ranges.push([from, to]);
              }),
            ),
          );
          const tr = state.tr;
          const size = state.doc.content.size;
          for (const [from, to] of ranges)
            state.doc.nodesBetween(Math.max(0, from - 1), Math.min(size, to + 1), (node, pos, parent) => {
              if (!node.isTextblock) return true;
              if (node.attrs.indent && parent && ["listItem", "taskItem", "tableCell", "tableHeader"].includes(parent.type.name))
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: 0 });
              return false;
            });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    // Caret moves by the browser (arrow keys) reach the editor a moment
    // later; take them over before reading the selection.
    const syncSelection = () =>
      (
        this.editor.view as unknown as { domObserver?: { flush?: () => void } }
      ).domObserver?.flush?.();
    const shift = (by: number) => () => {
      syncSelection();
      const { state, view } = this.editor;
      const { from, to, $from } = state.selection;
      // Inside lists, tasks, tables and code the other handlers decide.
      for (let d = $from.depth; d > 0; d--)
        if (["listItem", "taskItem", "tableCell", "tableHeader"].includes($from.node(d).type.name))
          return false;
      if ($from.parent.type.name === "codeBlock") return false;
      const tr = state.tr;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
        const indent = Math.min(MAX_INDENT, Math.max(0, (node.attrs.indent || 0) + by));
        if (indent !== (node.attrs.indent || 0))
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent });
        return false;
      });
      if (tr.docChanged) {
        // Keep the caret where it was (the attribute change would otherwise
        // let it jump to the end of the line).
        tr.setSelection(
          TextSelection.create(tr.doc, tr.mapping.map(from), tr.mapping.map(to)),
        );
        view.dispatch(tr);
      }
      // Tab never leaves the text.
      return true;
    };
    return {
      Tab: shift(1),
      "Shift-Tab": shift(-1),
      Backspace: () => {
        syncSelection();
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        const node = $from.parent;
        if (!empty || $from.parentOffset !== 0 || !node.attrs.indent) return false;
        if (node.type.name !== "paragraph" && node.type.name !== "heading") return false;
        const tr = state.tr.setNodeMarkup($from.before(), undefined, {
          ...node.attrs,
          indent: node.attrs.indent - 1,
        });
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.pos)));
        return true;
      },
    };
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
  DrawioBlock,
  FunctionPlot,
  MetricBlock,
  PluginBlock,
  WorkflowButton,
  TaskList,
  FlowTaskItem.configure({ nested: true }),
  ListTidy,
  BlockReactionAttribute,
  BlockIdAttribute,
  SyncedBlock,
  Suggestion,
  CaptionedTable.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  AnnotatedImage.configure({ allowBase64: false }),
  Highlight.configure({ multicolor: true }),
  TextColor,
  Superscript,
  Subscript,
  Spoiler,
  Indent,
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  Callout,
  Toggle,
  MathBlock,
  MathInline,
  LinkedDatabase,
  WhiteboardEmbed,
  DrawBlock,
  Footnote,
  BlockDirectionExtension,
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
    // PDF with a preview of its first page (components/pdf-viewer.tsx).
    {
      tag: "div[data-pdf]",
      priority: 60,
      getAttrs: (el) => ({
        src: (el as HTMLElement).getAttribute("data-pdf"),
        kind: "pdf",
        title: (el as HTMLElement).getAttribute("data-title") || "",
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
    if (kind === "pdf" && /^\/api\/files\/[a-f0-9-]+$/.test(src))
      return [
        "div",
        {
          "data-pdf": src,
          "data-title": title || "PDF",
          class: "pdf-block",
          ...widthStyle(node.attrs.width),
        },
        ["a", { href: src }, title || "PDF"],
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
documentExtensions.push(Mention, Columns, Column, Media, LinkCard, Citation, Bibliography);
