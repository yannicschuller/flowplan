import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { tr } from "./locale-tag";
import { reveal } from "./motion";

// Footnotes: a marker in the text that carries its note. The note travels
// with the marker (moving, copying, deleting, undo), and two people editing
// different notes never collide – there is no separate list to keep in step.
// Numbers follow the order of the markers and are never stored; the notes are
// listed under "Fußnoten" at the end of the document.
export const MAX_FOOTNOTE = 4000;
export const footnoteText = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FOOTNOTE);

export type FootnoteEntry = { pos: number; note: string; number: number };
export function footnoteList(doc: PMNode): FootnoteEntry[] {
  const list: FootnoteEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "footnote")
      list.push({ pos, note: String(node.attrs.note || ""), number: list.length + 1 });
  });
  return list;
}

export type FootnoteEdit = { pos: number | null; note: string };
export type FootnoteOptions = {
  // Opens the editor's dialog for a note (pos null: a new one at the caret).
  edit: ((target: FootnoteEdit) => void) | null;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      // Asks the editor to open its dialog for a new note at the caret.
      openFootnote: () => ReturnType;
    };
  }
}

const key = new PluginKey<{ list: FootnoteEntry[]; decorations: DecorationSet }>("footnotes");

// Shows a note: scrolls to it and lets it light up briefly (the generic
// jump highlight of lib/motion.ts: an overlay, nothing in the editor DOM).
function flash(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) return;
  reveal(element);
}

function section(view: EditorView, list: FootnoteEntry[], editable: boolean, edit: FootnoteOptions["edit"]) {
  const root = document.createElement("section");
  root.className = "footnotes";
  root.contentEditable = "false";
  root.setAttribute("aria-label", tr("Fußnoten", "Footnotes"));
  const title = document.createElement("p");
  title.className = "footnotes-title";
  title.textContent = tr("Fußnoten", "Footnotes");
  const items = document.createElement("ol");
  for (const entry of list) {
    const item = document.createElement("li");
    item.dataset.footnoteNumber = String(entry.number);
    // A span, not a button: printed copies drop buttons.
    const text = document.createElement("span");
    text.className = "footnote-text";
    linkify(text, entry.note || tr("(leer)", "(empty)"));
    if (editable && edit) {
      text.setAttribute("role", "button");
      text.tabIndex = 0;
      text.title = tr("Fußnote bearbeiten", "Edit footnote");
      const open = (event: Event) => {
        if (!view.editable || (event.target as HTMLElement).closest("a")) return;
        event.preventDefault();
        const current = footnoteList(view.state.doc)[entry.number - 1];
        if (current) edit({ pos: current.pos, note: current.note });
      };
      text.addEventListener("click", open);
      text.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      });
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "footnote-back";
    back.textContent = "↩";
    back.title = tr("Zurück zur Textstelle", "Back to the reference");
    back.setAttribute("aria-label", tr(`Zurück zu Fußnote ${entry.number}`, `Back to footnote ${entry.number}`));
    back.addEventListener("click", () => {
      const current = footnoteList(view.state.doc)[entry.number - 1];
      if (!current) return;
      if (view.editable) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, current.pos)));
      flash(view.nodeDOM(current.pos) as Element | null);
    });
    item.append(text, " ", back);
    items.append(item);
  }
  root.append(title, items);
  return root;
}

// Notes as text with clickable web addresses (no markup is ever read).
export const URL_PATTERN = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;
export function linkify(target: HTMLElement, text: string) {
  const parts = text.split(URL_PATTERN);
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) target.append(part);
      return;
    }
    const link = target.ownerDocument.createElement("a");
    link.href = part;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = part;
    link.addEventListener("click", (event) => event.stopPropagation());
    target.append(link);
  });
}

export const Footnote = Node.create<FootnoteOptions>({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ edit: null }),
  addAttributes() {
    return {
      note: {
        default: "",
        parseHTML: (element) => footnoteText(element.getAttribute("data-footnote")),
        renderHTML: (attributes) => ({ "data-footnote": footnoteText(attributes.note) }),
      },
    };
  },
  parseHTML: () => [{ tag: "sup[data-footnote]", priority: 100 }],
  renderHTML: ({ HTMLAttributes }) => ["sup", mergeAttributes(HTMLAttributes, { class: "footnote-ref" })],
  renderText: () => "",
  addCommands() {
    return {
      openFootnote:
        () =>
        ({ editor, dispatch }) => {
          if (!this.options.edit || !editor.isEditable) return false;
          // can(): only whether it would work.
          if (!dispatch) return true;
          const { selection } = editor.state;
          // A selected note opens for editing.
          if (selection instanceof NodeSelection && selection.node.type.name === this.name) {
            this.options.edit({ pos: selection.from, note: String(selection.node.attrs.note || "") });
            return true;
          }
          this.options.edit({ pos: null, note: "" });
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Alt-f": () => this.editor.commands.openFootnote() };
  },
  addProseMirrorPlugins() {
    const edit = this.options.edit;
    const build = (doc: PMNode) => {
      const list = footnoteList(doc);
      const decorations = list.map((entry) =>
        Decoration.node(entry.pos, entry.pos + 1, {
          "data-footnote-number": String(entry.number),
          "aria-label": tr(`Fußnote ${entry.number}`, `Footnote ${entry.number}`),
          title: entry.note,
        }),
      );
      if (list.length)
        decorations.push(
          Decoration.widget(
            doc.content.size,
            (view) => section(view, list, view.editable, edit),
            {
              side: 1,
              ignoreSelection: true,
              stopEvent: () => true,
              // Drawn again only when a note, the order or editing changes.
              key: `footnotes:${JSON.stringify(list.map((entry) => entry.note))}`,
            },
          ),
        );
      return { list, decorations: DecorationSet.create(doc, decorations) };
    };
    return [
      new Plugin({
        key,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (transaction, value) => (transaction.docChanged ? build(transaction.doc) : value),
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          // A click on a marker shows its note; a double click edits it.
          handleClickOn: (view, _pos, node, nodePos, event, direct) => {
            if (!direct || node.type.name !== "footnote") return false;
            const entry = key.getState(view.state)?.list.find((e) => e.pos === nodePos);
            if (!entry) return false;
            const note = view.dom.querySelector(`.footnotes li[data-footnote-number="${entry.number}"]`);
            if (note) {
              event.preventDefault();
              flash(note);
            }
            return false;
          },
          handleDoubleClickOn: (view, _pos, node, nodePos, _event, direct) => {
            if (!direct || node.type.name !== "footnote" || !view.editable || !edit) return false;
            edit({ pos: nodePos, note: String(node.attrs.note || "") });
            return true;
          },
        },
      }),
    ];
  },
});

// Read-only HTML (shared pages, templates, exports): numbers the markers and
// lists the notes at the end, with the same jumps as in the editor. With
// `links` (a file of its own, without the app's styles and scripts) the
// numbers are text and the jumps plain anchors.
export function renderFootnotes(root: HTMLElement, { links = false } = {}) {
  root.querySelector(":scope > section.footnotes")?.remove();
  const markers = Array.from(root.querySelectorAll<HTMLElement>("sup[data-footnote]"));
  if (!markers.length) return;
  const doc = root.ownerDocument;
  const section = doc.createElement("section");
  section.className = "footnotes";
  section.setAttribute("aria-label", tr("Fußnoten", "Footnotes"));
  const title = doc.createElement("p");
  title.className = "footnotes-title";
  title.textContent = tr("Fußnoten", "Footnotes");
  const list = doc.createElement("ol");
  markers.forEach((marker, index) => {
    const number = String(index + 1);
    if (links) {
      const item = doc.createElement("li");
      item.id = `fn-${number}`;
      linkify(item, footnoteText(marker.getAttribute("data-footnote")));
      const back = doc.createElement("a");
      back.href = `#fnref-${number}`;
      back.textContent = "↩";
      back.setAttribute("aria-label", tr(`Zurück zu Fußnote ${number}`, `Back to footnote ${number}`));
      item.append(" ", back);
      list.append(item);
      const anchor = doc.createElement("a");
      anchor.href = `#fn-${number}`;
      anchor.id = `fnref-${number}`;
      anchor.textContent = number;
      marker.replaceChildren(anchor);
      return;
    }
    marker.dataset.footnoteNumber = number;
    marker.setAttribute("role", "doc-noteref");
    marker.setAttribute("aria-label", tr(`Fußnote ${number}`, `Footnote ${number}`));
    marker.title = marker.getAttribute("data-footnote") || "";
    marker.tabIndex = 0;
    const item = doc.createElement("li");
    item.dataset.footnoteNumber = number;
    const text = doc.createElement("span");
    text.className = "footnote-text";
    linkify(text, footnoteText(marker.getAttribute("data-footnote")));
    const back = doc.createElement("button");
    back.type = "button";
    back.className = "footnote-back";
    back.textContent = "↩";
    back.title = tr("Zurück zur Textstelle", "Back to the reference");
    back.setAttribute("aria-label", tr(`Zurück zu Fußnote ${number}`, `Back to footnote ${number}`));
    back.addEventListener("click", () => flash(marker));
    const show = (event: Event) => {
      event.preventDefault();
      flash(item);
    };
    marker.addEventListener("click", show);
    marker.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") show(event);
    });
    item.append(text, " ", back);
    list.append(item);
  });
  section.append(title, list);
  root.append(section);
}

// The notes of stored HTML, for the search index.
export function footnoteTexts(html: string) {
  const notes: string[] = [];
  for (const match of html.matchAll(/<sup\b[^>]*\bdata-footnote="([^"]*)"/g))
    notes.push(
      match[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    );
  return notes.filter(Boolean);
}
