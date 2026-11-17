"use client";
// The editor of a formatted text property (#126), loaded on demand: one
// paragraph with bold, italic, strike, code, links and line breaks – no
// headings, lists or other blocks. It reads and writes the inline Markdown
// of lib/inline-markdown.ts.
//
// Keys: ⌘/Ctrl B bold, I italic, ⇧X strike, E code, K link; Shift+Enter a
// line break. Enter ends the edit in a table cell (single line) and is a
// line break in the record (multiline); Escape drops the edit. Selecting
// text shows a small format bar. Pasted HTML keeps its inline formatting,
// blocks become line breaks.
//
// `formats="form"` (form descriptions, #306) adds underline (⌘/Ctrl U) and
// the document editor's text colours, stored as bracketed spans
// (lib/form-text.ts); colours render as text-color- classes, never as
// style attributes.
//
// `formats="notify"` (notification messages, #330, lib/notify-text.ts)
// adds underline, mentions and inline formulas: "@" opens the list of
// `members` (arrows, Enter or Tab, Escape), "$x^2$" becomes a formula (or
// the format bar turns the selection into one); a formula shows with KaTeX,
// loaded on demand. With `slots` the value is a workflow template:
// placeholders are chips, "{{" asks for the placeholder picker
// (`onPlaceholder`), `handle` inserts the one picked; typing a whole
// "{{…}}" makes a placeholder as well. Clicking a chip or a formula turns
// it back into text to change it.
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension, Mark, Node, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Code, LinkSimple, MathOperations, Palette, TextB, TextItalic, TextStrikethrough, TextUnderline } from "@phosphor-icons/react";
import { InputRule } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NOTIFY_TEXT, parseNotify, runsTemplate, templateRuns } from "@/lib/notify-text";
import { escapeInline, MAX_INLINE_MATH } from "@/lib/inline-markdown";
import { renderMathInto } from "@/lib/math-render-lazy";
import { formatCombo, isMacPlatform, shortcutLetter } from "@/lib/keymap";
import { htmlRuns, mergeRuns, parseInline, safeHref, serializeInline, type HtmlNode, type InlineOptions, type InlineRun } from "@/lib/inline-markdown";
import { isTextColorId, textColorList, type TextColorId } from "@/lib/text-colors";
import { useT } from "./i18n";

// A document of exactly one paragraph.
const SingleParagraph = Node.create({ name: "doc", topNode: true, content: "paragraph" });

// A text colour of the palette by its name, shown with a class.
const InlineColor = Mark.create({
  name: "inlineColor",
  addAttributes() {
    return { color: { default: null } };
  },
  parseHTML: () => [
    {
      tag: "span[class]",
      getAttrs: (element) => {
        const color = /(?:^|\s)text-color-([a-z]+)/.exec((element as HTMLElement).className)?.[1];
        return isTextColorId(color) ? { color } : false;
      },
    },
  ],
  renderHTML: ({ mark }) => ["span", isTextColorId(mark.attrs.color) ? { class: `text-color-${mark.attrs.color}` } : {}, 0],
});

// A member named in the text (#330): an atom like the document editor's
// mention, "@Name" with the person's id.
const InlineMention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { userId: { default: null }, label: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "span[data-mention]",
      getAttrs: (el) => ({ userId: (el as HTMLElement).getAttribute("data-mention"), label: ((el as HTMLElement).textContent || "").replace(/^@/, "") }),
    },
  ],
  renderHTML: ({ node }) => ["span", { "data-mention": node.attrs.userId || "", class: "mention" }, `@${node.attrs.label}`],
  renderText: ({ node }) => `@${node.attrs.label}`,
});
// An inline formula (#330), set with KaTeX once it is loaded.
const InlineMath = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { expression: { default: "" } };
  },
  parseHTML: () => [{ tag: "span[data-math]", getAttrs: (el) => ({ expression: (el as HTMLElement).getAttribute("data-math") || "" }) }],
  renderHTML: ({ node }) => ["span", { "data-math": node.attrs.expression, class: "math-inline" }, node.attrs.expression],
  renderText: ({ node }) => `$${node.attrs.expression}$`,
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "math-inline rich-text-math";
      dom.contentEditable = "false";
      const show = (n: PMNode) => {
        dom.dataset.math = n.attrs.expression;
        dom.setAttribute("aria-label", n.attrs.expression);
        renderMathInto(dom, n.attrs.expression, true);
      };
      show(node);
      return {
        dom,
        update: (next) => {
          if (next.type.name !== "mathInline") return false;
          show(next);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
  addInputRules() {
    // "$x^2$": the closing dollar makes the formula (not "$5 and $").
    return [
      new InputRule({
        find: /(?:^|[^$\\])(\$([^\s$](?:[^$\n]*[^\s$\\])?)\$)$/,
        handler: ({ state, range, match }) => {
          const whole = match[1];
          const expression = match[2];
          if (!expression || expression.length > MAX_INLINE_MATH) return null;
          const from = range.to - whole.length;
          state.tr.replaceWith(from, range.to, this.type.create({ expression }));
        },
      }),
    ];
  },
});
// A placeholder of a workflow's message (#330): a chip with its name.
const InlinePlaceholder = Node.create({
  name: "placeholder",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { label: (raw: string) => raw.replace(/^\{\{\s*|\s*\}\}$/g, "") };
  },
  addAttributes() {
    return { raw: { default: "" } };
  },
  parseHTML: () => [{ tag: "span[data-placeholder-raw]", getAttrs: (el) => ({ raw: (el as HTMLElement).getAttribute("data-placeholder-raw") || "" }) }],
  renderHTML({ node }) {
    return ["span", { "data-placeholder-raw": node.attrs.raw, class: "wf-chip rich-text-placeholder" }, this.options.label(String(node.attrs.raw || ""))];
  },
  renderText: ({ node }) => node.attrs.raw,
});

// A placeholder typed out: "{{…}}" (quoted filter arguments may hold braces).
const TYPED_PLACEHOLDER = /\{\{(?:[^}"\\]|\\.|"(?:[^"\\]|\\.)*"|\}(?!\}))*\}\}/g;

// Runs of the notification dialect as the editor makes them: "$x$" typed
// or pasted as text is a formula, "{{…}}" (with `raws`) a placeholder.
function notifyRuns(runs: InlineRun[], raws: string[] | null): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    if (run.code || run.mention || run.math || run.slot !== undefined || (!run.text.includes("$") && !(raws && run.text.includes("{{")))) {
      out.push(run);
      continue;
    }
    const { text, ...marks } = run;
    const parts = raws ? text.split(new RegExp(`(${TYPED_PLACEHOLDER.source})`)) : [text];
    for (const part of parts) {
      if (!part) continue;
      if (raws && new RegExp(`^${TYPED_PLACEHOLDER.source}$`).test(part)) {
        out.push({ ...marks, text: part, slot: raws.push(part) - 1 });
        continue;
      }
      if (!part.includes("$")) {
        out.push({ ...marks, text: part });
        continue;
      }
      // Escaped except for "$": only formulas come out of it.
      for (const r of parseInline(escapeInline(part), { math: true })) out.push({ ...marks, ...r });
    }
  }
  return mergeRuns(out);
}

export function runsToContent(runs: InlineRun[], raws: string[] = []): JSONContent {
  const content: JSONContent[] = [];
  for (const run of runs) {
    const marks = [
      run.bold && { type: "bold" },
      run.italic && { type: "italic" },
      run.strike && { type: "strike" },
      run.code && { type: "code" },
      run.href && { type: "link", attrs: { href: run.href } },
      run.underline && { type: "underline" },
      run.color && { type: "inlineColor", attrs: { color: run.color } },
    ].filter(Boolean) as JSONContent["marks"];
    const atomMarks = marks?.filter((m) => m?.type !== "code" && m?.type !== "link");
    const withMarks = atomMarks?.length ? { marks: atomMarks } : {};
    if (run.mention) {
      content.push({ type: "mention", attrs: { userId: run.mention, label: run.text.replace(/^@/, "") }, ...withMarks });
      continue;
    }
    if (run.math) {
      content.push({ type: "mathInline", attrs: { expression: run.text }, ...withMarks });
      continue;
    }
    if (run.slot !== undefined) {
      content.push({ type: "placeholder", attrs: { raw: raws[run.slot] || "" }, ...(marks?.length ? { marks } : {}) });
      continue;
    }
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) content.push({ type: "hardBreak" });
      if (part) content.push({ type: "text", text: part, ...(marks?.length ? { marks } : {}) });
    });
  }
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

export function contentToRuns(doc: JSONContent, raws: string[] = []): InlineRun[] {
  const runs: InlineRun[] = [];
  (doc.content || []).forEach((block, b) => {
    if (b > 0) runs.push({ text: "\n" });
    for (const node of block.content || []) {
      if (node.type === "hardBreak") runs.push({ text: "\n" });
      else if ((node.type === "text" && node.text) || node.type === "mention" || node.type === "mathInline" || node.type === "placeholder") {
        const run: InlineRun =
          node.type === "mention"
            ? { text: `@${String(node.attrs?.label || "").trim()}`, mention: String(node.attrs?.userId || "") }
            : node.type === "mathInline"
              ? { text: String(node.attrs?.expression || "").trim(), math: true }
              : node.type === "placeholder"
                ? { text: "\uE000", slot: raws.push(String(node.attrs?.raw || "")) - 1 }
                : { text: node.text! };
        if ((run.mention && run.text === "@") || (run.math && !run.text)) continue;
        for (const mark of node.marks || []) {
          if (mark.type === "bold") run.bold = true;
          if (mark.type === "italic") run.italic = true;
          if (mark.type === "strike") run.strike = true;
          if (mark.type === "code") run.code = true;
          if (mark.type === "link") run.href = safeHref(String(mark.attrs?.href || ""));
          if (mark.type === "underline") run.underline = true;
          if (mark.type === "inlineColor" && isTextColorId(mark.attrs?.color)) run.color = mark.attrs.color;
        }
        if (run.mention || run.math) {
          delete run.code;
          delete run.href;
        }
        runs.push(run);
      }
    }
  });
  return mergeRuns(runs);
}

export function domToHtmlNodes(nodes: NodeListOf<ChildNode> | ChildNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of Array.from(nodes)) {
    if (node.nodeType === 3) out.push({ type: "text", text: node.textContent || "" });
    else if (node.nodeType === 1) {
      const el = node as Element;
      const attrs: Record<string, string> = {};
      for (const name of ["href", "style", "class"]) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = value;
      }
      out.push({ type: "element", name: el.tagName.toLowerCase(), attrs, children: domToHtmlNodes(el.childNodes) });
    }
  }
  return out;
}

function pastedRuns(data: DataTransfer | null, options: InlineOptions): InlineRun[] | null {
  if (!data) return null;
  const html = data.getData("text/html");
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return htmlRuns(domToHtmlNodes(doc.body.childNodes), options);
  }
  const text = data.getData("text/plain");
  return text ? [{ text: text.replace(/\r\n?/g, "\n") }] : null;
}

// What a notification message's field can do with the editor (#330).
export type RichTextHandle = {
  // A placeholder at the cursor (a "{{" typed just before goes).
  insertPlaceholder: (raw: string) => void;
  // Text at the cursor ("@" opens the list of members).
  insertText: (text: string) => void;
  focus: () => void;
};
export type MentionPerson = { id: string; name: string; email?: string };

export default function RichTextEditor({
  value,
  onChange,
  commit = "blur",
  multiline = false,
  autoFocus = false,
  disabled = false,
  label,
  placeholder,
  onCancel,
  formats = "text",
  members = [],
  slots = false,
  onPlaceholder,
  chipLabel,
  handle,
  describedBy,
}: {
  value: string;
  onChange: (markdown: string) => void | Promise<unknown>;
  commit?: "blur" | "change";
  // Enter makes a line break (the record) instead of ending the edit.
  multiline?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  // The edit ended without a change (Escape, or Enter in a table cell).
  onCancel?: () => void;
  // "form": also underline and text colours (form descriptions, #306);
  // "notify": underline, mentions and formulas (notifications, #330).
  formats?: "text" | "form" | "notify";
  // "notify": the people "@" offers.
  members?: MentionPerson[];
  // "notify": the value is a workflow template with placeholders.
  slots?: boolean;
  // "{{" was typed: the field opens its placeholder picker.
  onPlaceholder?: () => void;
  // A placeholder chip's name.
  chipLabel?: (raw: string) => string;
  handle?: MutableRefObject<RichTextHandle | null>;
  describedBy?: string;
}) {
  const t = useT();
  const mac = typeof navigator !== "undefined" && isMacPlatform();
  const key = (combo: string) => formatCombo(combo, mac);
  const wrap = useRef<HTMLDivElement>(null);
  const saved = useRef(value);
  const live = useRef({ onChange, onCancel, commit, multiline });
  live.current = { onChange, onCancel, commit, multiline };
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [colors, setColors] = useState(false);
  // The open list of members: where "@…" starts, what is typed, the choice.
  const [mention, setMention] = useState<{ from: number; to: number; query: string } | null>(null);
  const [choice, setChoice] = useState(0);
  const listId = useMemo(() => `rich-mentions-${Math.random().toString(36).slice(2, 9)}`, []);
  const colorNames: Record<TextColorId, string> = {
    gray: t("Grau", "Grey"),
    brown: t("Braun", "Brown"),
    orange: t("Orange", "Orange"),
    yellow: t("Gelb", "Yellow"),
    green: t("Grün", "Green"),
    blue: t("Blau", "Blue"),
    purple: t("Lila", "Purple"),
    pink: t("Pink", "Pink"),
    red: t("Rot", "Red"),
  };
  const form = formats === "form";
  const notify = formats === "notify";
  const dialect: InlineOptions = notify ? NOTIFY_TEXT : { spans: form };
  // The placeholders as written, by slot (a link's address refers to them).
  const raws = useRef<string[]>([]);
  const parse = (markdown: string) => {
    if (!notify) return runsToContent(parseInline(markdown, dialect));
    if (!slots) return runsToContent(parseNotify(markdown));
    const parsed = templateRuns(markdown);
    raws.current = parsed.raws;
    return runsToContent(parsed.runs, parsed.raws);
  };
  const linkInput = useRef<HTMLInputElement>(null);
  const people = useRef(members);
  people.current = members;
  const shownPeople = mention
    ? members
        .filter((m) => `${m.name} ${m.email || ""}`.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 8)
    : [];
  const picker = useRef({ mention, choice, shownPeople, onPlaceholder });
  picker.current = { mention, choice, shownPeople, onPlaceholder };

  const markdownOf = (editor: Editor) => {
    if (!notify) return serializeInline(contentToRuns(editor.getJSON()));
    const list = slots ? [...raws.current] : [];
    const runs = notifyRuns(contentToRuns(editor.getJSON(), list), slots ? list : null);
    return slots ? runsTemplate(runs, list) : serializeInline(runs, NOTIFY_TEXT);
  };
  // "@…" before the cursor opens the list of members; "{{" asks for the
  // placeholder picker.
  const watchTyping = (editor: Editor, typed: boolean) => {
    if (!notify) return;
    const { $from, empty } = editor.state.selection;
    const before = empty ? $from.parent.textBetween(0, $from.parentOffset, "\n", "\uFFFC") : "";
    const at = members.length || people.current.length ? /(?:^|[\s(\[„“"'«])@([\p{L}\p{N} ._-]{0,40})$/u.exec(before) : null;
    if (at) {
      setMention((m) => (m && m.query === at[1] ? m : { from: $from.pos - at[1].length - 1, to: $from.pos, query: at[1] }));
      setChoice((c) => (picker.current.mention?.query === at[1] ? c : 0));
    } else setMention(null);
    if (typed && slots && before.endsWith("{{") && !before.endsWith("\\{{")) picker.current.onPlaceholder?.();
  };
  const pickPerson = (editor: Editor, person: MentionPerson) => {
    const range = picker.current.mention;
    if (!range) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: range.from, to: range.to }, [
        { type: "mention", attrs: { userId: person.id, label: person.name.slice(0, 200) } },
        { type: "text", text: " " },
      ])
      .run();
    setMention(null);
  };
  // Saves a change. `end`: the edit ends (Enter in a table cell) – without
  // a change the cell closes as with Escape; a blur alone leaves it open,
  // as the other cell inputs do.
  const finish = (editor: Editor, end: boolean) => {
    const markdown = markdownOf(editor);
    if (markdown !== saved.current) {
      saved.current = markdown;
      void live.current.onChange(markdown);
    } else if (end) live.current.onCancel?.();
    if (end) editor.commands.blur();
  };
  const openLink = (editor: Editor) => {
    if (editor.state.selection.empty && !editor.isActive("link")) return false;
    // A placeholder in the address shows as written.
    setLink(String(editor.getAttributes("link").href || "").replace(/\uE000(\d+)\uE001/g, (_, n: string) => raws.current[Number(n)] || ""));
    setLinkError(false);
    placeBar(editor);
    requestAnimationFrame(() => linkInput.current?.focus());
    return true;
  };
  // Closes the format bar once focus has moved on: removing it while the
  // focus is between two elements makes a dialog around the editor (the
  // form designer, #306) take the focus back from the next field.
  const closeBar = () =>
    setTimeout(() => {
      if (wrap.current?.contains(document.activeElement)) return;
      setBar(null);
      setLink(null);
      setColors(false);
    });
  const placeBar = (editor: Editor) => {
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from),
      end = editor.view.coordsAtPos(to);
    setBar({ x: (start.left + end.right) / 2, y: Math.min(start.top, end.top) });
  };

  // The options once: a new options object on every render would make the
  // editor set its props again, which writes its selection back into the
  // page while the browser still moves it (Shift+arrows got lost).
  // Everything they use is a ref or a state setter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo<Parameters<typeof useEditor>[0]>(() => ({
    immediatelyRender: false,
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    content: parse(value),
    extensions: [
      SingleParagraph,
      StarterKit.configure({
        document: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        underline: form || notify ? {} : false,
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
          isAllowedUri: (url) => !!safeHref(url),
          shouldAutoLink: (url) => !!safeHref(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`),
          HTMLAttributes: { target: "_blank", rel: "noopener noreferrer", class: null },
        },
      }),
      ...(form ? [InlineColor] : []),
      ...(notify ? [InlineMention, InlineMath, InlinePlaceholder.configure(chipLabel ? { label: chipLabel } : {})] : []),
      Extension.create({
        name: "inlineTextKeys",
        addKeyboardShortcuts() {
          return {
            "Mod-Shift-x": () => this.editor.commands.toggleStrike(),
            Enter: () => {
              if (live.current.multiline) return this.editor.commands.setHardBreak();
              finish(this.editor, true);
              return true;
            },
            Escape: () => {
              this.editor.commands.setContent(parse(saved.current));
              live.current.onCancel?.();
              this.editor.commands.blur();
              return true;
            },
          };
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: `rich-text-input${multiline ? " multiline" : ""}`,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(notify && members.length ? { "aria-autocomplete": "list", "aria-haspopup": "listbox" } : {}),
      },
      // A chip or a formula turns back into its text to change it.
      handleClickOn: (view, pos, node) => {
        if (!view.editable || (node.type.name !== "mathInline" && node.type.name !== "placeholder")) return false;
        const text = node.type.name === "mathInline" ? `$${node.attrs.expression}$` : String(node.attrs.raw || "");
        const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(text));
        const caret = pos + text.length - (node.type.name === "mathInline" ? 1 : 2);
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)));
        view.focus();
        return true;
      },
      handlePaste: (view, event) => {
        const runs = pastedRuns(event.clipboardData, dialect);
        if (!runs) return false;
        event.preventDefault();
        const doc = view.state.schema.nodeFromJSON(runsToContent(runs));
        const tr = view.state.tr.replaceSelection(new Slice(doc.firstChild!.content, 0, 0));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleDrop: () => true,
      // ⌘/Ctrl K links the selection; it must not also reach the app's
      // quick search (a listener on the window). Without a selection the
      // quick search opens as everywhere.
      handleKeyDown: (_view, event) => {
        // The list of members: arrows, Enter or Tab, Escape.
        const open = picker.current;
        if (open.mention && !event.isComposing && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
          const current = editorRef.current;
          if (event.key === "Escape") {
            setMention(null);
            event.preventDefault();
            return true;
          }
          if (open.shownPeople.length && current) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") setChoice((c) => (c + (event.key === "ArrowDown" ? 1 : -1) + open.shownPeople.length) % open.shownPeople.length);
            else pickPerson(current, open.shownPeople[open.choice] || open.shownPeople[0]);
            event.preventDefault();
            return true;
          }
        }
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || shortcutLetter(event) !== "k") return false;
        const current = editorRef.current;
        if (!current || !openLink(current)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      watchTyping(editor, true);
      if (live.current.commit === "change") {
        const markdown = markdownOf(editor);
        if (markdown !== saved.current) {
          saved.current = markdown;
          void live.current.onChange(markdown);
        }
      }
    },
    onSelectionUpdate: ({ editor }) => {
      watchTyping(editor, false);
      if (editor.state.selection.empty) {
        setBar(null);
        setLink(null);
        setColors(false);
      } else placeBar(editor);
    },
    onBlur: ({ editor, event }) => {
      // The format bar and its link field keep the edit open.
      if (event.relatedTarget instanceof globalThis.Node && wrap.current?.contains(event.relatedTarget)) return;
      closeBar();
      setMention(null);
      finish(editor, false);
    },
  }), []);
  const editor = useEditor(options, []);
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // A new value from outside (another person, a refresh) while not editing.
  useEffect(() => {
    if (!editor || editor.isFocused || value === saved.current) return;
    saved.current = value;
    editor.commands.setContent(parse(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  // The list of members for assistive technology.
  useEffect(() => {
    const dom = editor?.view?.dom;
    if (!dom || !notify) return;
    dom.setAttribute("aria-expanded", mention ? "true" : "false");
    if (mention) dom.setAttribute("aria-controls", listId);
    else dom.removeAttribute("aria-controls");
    if (mention && shownPeople[choice]) dom.setAttribute("aria-activedescendant", `${listId}-${choice}`);
    else dom.removeAttribute("aria-activedescendant");
  });
  if (handle)
    handle.current = {
      insertPlaceholder: (raw) => {
        if (!editor) return;
        const { from, to } = editor.state.selection;
        const before = editor.state.doc.textBetween(Math.max(0, from - 2), from, "\n", "\uFFFC");
        editor
          .chain()
          .focus()
          .insertContentAt({ from: before === "{{" ? from - 2 : from, to }, [{ type: "placeholder", attrs: { raw } }])
          .run();
      },
      insertText: (text) => {
        if (!editor) return;
        const { from } = editor.state.selection;
        const before = editor.state.doc.textBetween(Math.max(0, from - 1), from, "\n", "\uFFFC");
        editor.chain().focus().insertContent(`${text.startsWith("@") && before && !/\s/.test(before) ? " " : ""}${text}`).run();
      },
      focus: () => editor?.commands.focus(),
    };

  const applyLink = () => {
    if (!editor) return;
    // A placeholder typed into the address (workflows): a slot behind the
    // address the author wrote (lib/notify-text.ts checks that).
    const raw = (slots ? (link || "").replace(TYPED_PLACEHOLDER, (p) => `\uE000${raws.current.push(p) - 1}\uE001`) : link || "").trim();
    if (!raw) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else {
      const href = safeHref(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`);
      if (!href) {
        setLinkError(true);
        return;
      }
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLink(null);
  };

  const mark = (name: string, title: string, icon: React.ReactNode, run: () => void) => (
    <button
      type="button"
      aria-pressed={!!editor?.isActive(name)}
      aria-label={title}
      title={title}
      className={editor?.isActive(name) ? "active" : ""}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  );

  return (
    <div className="rich-text-field" ref={wrap}>
      <EditorContent editor={editor} />
      {editor && !disabled && (bar || link !== null) && (
        <div
          className="text-menu selection rich-text-bar"
          role="toolbar"
          aria-label={t("Formatieren", "Format")}
          style={bar ? { left: bar.x, top: bar.y } : undefined}
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
          }}
        >
          {link === null && colors ? (
            <div className="text-menu-format rich-text-colors" role="group" aria-label={t("Textfarbe", "Text colour")}>
              {textColorList.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`rich-text-swatch${editor.isActive("inlineColor", { color: c.id }) ? " active" : ""}`}
                  aria-label={t(`Textfarbe ${colorNames[c.id]}`, `Text colour ${colorNames[c.id]}`)}
                  aria-pressed={editor.isActive("inlineColor", { color: c.id })}
                  title={colorNames[c.id]}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor.chain().focus().setMark("inlineColor", { color: c.id }).run();
                    setColors(false);
                  }}
                >
                  <span className={`text-color-${c.id}`}>A</span>
                </button>
              ))}
              <button
                type="button"
                className="rich-text-swatch rich-text-swatch-none"
                aria-label={t("Farbe entfernen", "Remove colour")}
                title={t("Farbe entfernen", "Remove colour")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().unsetMark("inlineColor").run();
                  setColors(false);
                }}
              >
                <span>A</span>
              </button>
            </div>
          ) : link === null ? (
            <div className="text-menu-format">
              {mark("bold", `${t("Fett", "Bold")} (${key("Mod+B")})`, <TextB size={16} />, () => editor.chain().focus().toggleBold().run())}
              {mark("italic", `${t("Kursiv", "Italic")} (${key("Mod+I")})`, <TextItalic size={16} />, () => editor.chain().focus().toggleItalic().run())}
              {(form || notify) && mark("underline", `${t("Unterstrichen", "Underline")} (${key("Mod+U")})`, <TextUnderline size={16} />, () => editor.chain().focus().toggleUnderline().run())}
              {mark("strike", `${t("Durchgestrichen", "Strikethrough")} (${key("Mod+Shift+X")})`, <TextStrikethrough size={16} />, () => editor.chain().focus().toggleStrike().run())}
              {mark("code", `Code (${key("Mod+E")})`, <Code size={16} />, () => editor.chain().focus().toggleCode().run())}
              {mark("link", `Link (${key("Mod+K")})`, <LinkSimple size={16} />, () => openLink(editor))}
              {form && mark("inlineColor", t("Textfarbe", "Text colour"), <Palette size={16} />, () => setColors(true))}
              {notify &&
                mark("mathInline", t("Als Formel", "As a formula"), <MathOperations size={16} />, () => {
                  const { from, to } = editor.state.selection;
                  const expression = editor.state.doc.textBetween(from, to, " ").trim();
                  if (expression) editor.chain().focus().insertContentAt({ from, to }, { type: "mathInline", attrs: { expression: expression.slice(0, MAX_INLINE_MATH) } }).run();
                })}
            </div>
          ) : (
            // No <form>: the editor may sit inside one (the form designer,
            // #306), and Enter here must not submit that.
            <div className="rich-text-link">
              <input
                ref={linkInput}
                type="text"
                inputMode="url"
                value={link}
                aria-label={t("Link-Adresse", "Link address")}
                aria-invalid={linkError || undefined}
                placeholder="https://…"
                onChange={(e) => {
                  setLink(e.target.value);
                  setLinkError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    applyLink();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setLink(null);
                    editor.commands.focus();
                  }
                }}
                onBlur={(e) => {
                  if (e.relatedTarget instanceof globalThis.Node && wrap.current?.contains(e.relatedTarget)) return;
                  closeBar();
                  finish(editor, false);
                }}
              />
              <button type="button" className="button compact primary" onClick={applyLink}>
                {t("Übernehmen", "Apply")}
              </button>
              {linkError && (
                <span className="rich-text-link-error" role="alert">
                  {t("Nur http-, https- und mailto-Links.", "Only http, https and mailto links.")}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {editor && mention && (
        <div className="rich-text-mentions" role="listbox" id={listId} aria-label={t("Mitglieder", "Members")}>
          {shownPeople.map((person, i) => (
            <button
              type="button"
              role="option"
              id={`${listId}-${i}`}
              key={person.id}
              aria-selected={i === choice}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickPerson(editor, person)}
            >
              <span>{person.name}</span>
              {person.email && <small>{person.email}</small>}
            </button>
          ))}
          {!shownPeople.length && <p className="muted small">{t("Kein Mitglied gefunden.", "No member found.")}</p>}
        </div>
      )}
    </div>
  );
}
