// Files on their way to the server (#561): where a dropped or pasted file
// will go, a placeholder with its name, the upload's progress and a cancel
// button. Only a widget decoration of this editor – never a node of the
// document, so neither saves nor collaborators ever see it. Its position
// follows the edits (local ones through the transaction's mapping, those of
// others through a Yjs relative position), and the finished file is
// inserted there.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { LOCALE_TAG } from "./locale-tag";
import { sizeText } from "./size-text";

type Entry = { pos: number; anchor: Y.RelativePosition | null; element: HTMLElement };
type Meta = { add: { id: string; pos: number; anchor: Y.RelativePosition | null; element: HTMLElement } } | { remove: string };
const key = new PluginKey<Map<string, Entry>>("uploadPlaceholders");

type SyncState = {
  doc: Y.Doc;
  type: Y.XmlFragment;
  binding?: { mapping: Parameters<typeof relativePositionToAbsolutePosition>[3] };
  isChangeOrigin?: boolean;
  snapshot?: unknown;
  prevSnapshot?: unknown;
};
const syncOf = (state: EditorState) => {
  const sync = ySyncPluginKey.getState(state) as SyncState | undefined;
  return sync?.binding?.mapping.size && !sync.snapshot && !sync.prevSnapshot ? sync : null;
};

function move(entry: Entry, tr: Transaction, state: EditorState): Entry {
  const size = state.doc.content.size;
  let pos: number | null = null;
  const sync = syncOf(state);
  // Changes of others replace whole blocks: the Yjs position knows better.
  if (sync?.isChangeOrigin && entry.anchor)
    try {
      pos = relativePositionToAbsolutePosition(sync.doc, sync.type, entry.anchor, sync.binding!.mapping);
    } catch {
      pos = null;
    }
  // Text typed right there goes before the file, as before (#561).
  pos ??= tr.mapping.map(entry.pos, 1);
  return { ...entry, pos: Math.max(0, Math.min(size, pos)) };
}

export const uploadPlaceholderPlugin = new Plugin<Map<string, Entry>>({
  key,
  state: {
    init: () => new Map(),
    apply(tr, previous, _old, state) {
      const meta = tr.getMeta(key) as Meta | undefined;
      if (!tr.docChanged && !meta) return previous;
      const next = new Map<string, Entry>();
      for (const [id, entry] of previous) next.set(id, tr.docChanged ? move(entry, tr, state) : entry);
      if (meta && "add" in meta) next.set(meta.add.id, { pos: meta.add.pos, anchor: meta.add.anchor, element: meta.add.element });
      if (meta && "remove" in meta) next.delete(meta.remove);
      return next;
    },
  },
  props: {
    decorations(state) {
      const entries = key.getState(state);
      if (!entries?.size) return DecorationSet.empty;
      return DecorationSet.create(
        state.doc,
        [...entries].map(([id, entry]) =>
          Decoration.widget(entry.pos, entry.element, { key: `upload-${id}`, side: 1, ignoreSelection: true, stopEvent: () => true }),
        ),
      );
    },
  },
});
export const UploadPlaceholders = Extension.create({ name: "uploadPlaceholders", addProseMirrorPlugins: () => [uploadPlaceholderPlugin] });

// Where the file of this placeholder goes now (null: it is gone, e.g. the
// editor was set up anew).
export const placeholderPosition = (state: EditorState, id: string) => key.getState(state)?.get(id)?.pos ?? null;
export const removePlaceholder = (tr: Transaction, id: string) => tr.setMeta(key, { remove: id } satisfies Meta);

export type PlaceholderTexts = {
  // The progress bar's name, e.g. "Hochladen von „a.pdf“".
  label: (name: string) => string;
  cancel: (name: string) => string;
  // "12 MB von 48 MB"
  of: (loaded: string, total: string) => string;
};

export { sizeText };
const percent = (share: number) => new Intl.NumberFormat(LOCALE_TAG, { style: "percent", maximumFractionDigits: 0 }).format(share);

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
const SVG = "http://www.w3.org/2000/svg";
function crossIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

// One placeholder at the current selection; `progress` updates it in place
// (no transaction), `remove` takes it out (also inside a transaction that
// inserts the file).
export function addPlaceholder(view: EditorView, name: string, size: number, texts: PlaceholderTexts, onCancel: () => void) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const element = make("span", "upload-placeholder");
  element.contentEditable = "false";
  element.dataset.upload = id;
  const title = make("span", "upload-placeholder-name", name);
  title.title = name;
  const bar = make("span", "upload-placeholder-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", texts.label(name));
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.append(make("span", "upload-placeholder-fill"));
  const status = make("span", "upload-placeholder-status");
  const cancel = make("button", "upload-placeholder-cancel");
  cancel.type = "button";
  cancel.setAttribute("aria-label", texts.cancel(name));
  cancel.title = texts.cancel(name);
  cancel.append(crossIcon());
  cancel.addEventListener("mousedown", (e) => e.preventDefault());
  cancel.addEventListener("click", (e) => {
    e.preventDefault();
    onCancel();
  });
  element.append(title, bar, status, cancel);
  const progress = (loaded: number, total: number) => {
    const share = total > 0 ? Math.min(1, loaded / total) : 0;
    const value = String(Math.round(share * 100));
    if (bar.getAttribute("aria-valuenow") === value && status.textContent) return;
    bar.setAttribute("aria-valuenow", value);
    const of = texts.of(sizeText(loaded), sizeText(total));
    bar.setAttribute("aria-valuetext", `${percent(share)} – ${of}`);
    // The width through a custom property: no style attribute (CSP).
    element.style.setProperty("--upload-share", String(share));
    status.textContent = `${percent(share)} · ${of}`;
  };
  progress(0, size);
  const sync = syncOf(view.state);
  const pos = view.state.selection.from;
  let anchor: Y.RelativePosition | null = null;
  if (sync)
    try {
      anchor = absolutePositionToRelativePosition(pos, sync.type, sync.binding!.mapping);
    } catch {
      anchor = null;
    }
  view.dispatch(view.state.tr.setMeta(key, { add: { id, pos, anchor, element } } satisfies Meta).setMeta("addToHistory", false));
  return {
    id,
    progress,
    remove() {
      if (!view.isDestroyed && placeholderPosition(view.state, id) !== null) view.dispatch(removePlaceholder(view.state.tr, id).setMeta("addToHistory", false));
    },
  };
}

// A polite line for screen readers when an upload is done.
let region: HTMLElement | null = null;
export function announce(text: string) {
  if (typeof document === "undefined") return;
  if (!region?.isConnected) {
    region = make("div", "sr-only");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  region.textContent = "";
  const target = region;
  setTimeout(() => (target.textContent = text), 50);
}
