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
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension, Node, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { Code, LinkSimple, TextB, TextItalic, TextStrikethrough } from "@phosphor-icons/react";
import { formatCombo, isMacPlatform } from "@/lib/keymap";
import { htmlRuns, mergeRuns, parseInline, safeHref, serializeInline, type HtmlNode, type InlineRun } from "@/lib/inline-markdown";
import { useT } from "./i18n";

// A document of exactly one paragraph.
const SingleParagraph = Node.create({ name: "doc", topNode: true, content: "paragraph" });

export function runsToContent(runs: InlineRun[]): JSONContent {
  const content: JSONContent[] = [];
  for (const run of runs) {
    const marks = [
      run.bold && { type: "bold" },
      run.italic && { type: "italic" },
      run.strike && { type: "strike" },
      run.code && { type: "code" },
      run.href && { type: "link", attrs: { href: run.href } },
    ].filter(Boolean) as JSONContent["marks"];
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) content.push({ type: "hardBreak" });
      if (part) content.push({ type: "text", text: part, ...(marks?.length ? { marks } : {}) });
    });
  }
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

export function contentToRuns(doc: JSONContent): InlineRun[] {
  const runs: InlineRun[] = [];
  (doc.content || []).forEach((block, b) => {
    if (b > 0) runs.push({ text: "\n" });
    for (const node of block.content || []) {
      if (node.type === "hardBreak") runs.push({ text: "\n" });
      else if (node.type === "text" && node.text) {
        const run: InlineRun = { text: node.text };
        for (const mark of node.marks || []) {
          if (mark.type === "bold") run.bold = true;
          if (mark.type === "italic") run.italic = true;
          if (mark.type === "strike") run.strike = true;
          if (mark.type === "code") run.code = true;
          if (mark.type === "link") run.href = safeHref(String(mark.attrs?.href || ""));
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
      for (const name of ["href", "style"]) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = value;
      }
      out.push({ type: "element", name: el.tagName.toLowerCase(), attrs, children: domToHtmlNodes(el.childNodes) });
    }
  }
  return out;
}

function pastedRuns(data: DataTransfer | null): InlineRun[] | null {
  if (!data) return null;
  const html = data.getData("text/html");
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return htmlRuns(domToHtmlNodes(doc.body.childNodes));
  }
  const text = data.getData("text/plain");
  return text ? [{ text: text.replace(/\r\n?/g, "\n") }] : null;
}

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
  const linkInput = useRef<HTMLInputElement>(null);

  const markdownOf = (editor: Editor) => serializeInline(contentToRuns(editor.getJSON()));
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
    setLink(String(editor.getAttributes("link").href || ""));
    setLinkError(false);
    placeBar(editor);
    requestAnimationFrame(() => linkInput.current?.focus());
    return true;
  };
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
    content: runsToContent(parseInline(value)),
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
        underline: false,
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
              this.editor.commands.setContent(runsToContent(parseInline(saved.current)));
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
      },
      handlePaste: (view, event) => {
        const runs = pastedRuns(event.clipboardData);
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
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return false;
        const current = editorRef.current;
        if (!current || !openLink(current)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (live.current.commit === "change") {
        const markdown = markdownOf(editor);
        if (markdown !== saved.current) {
          saved.current = markdown;
          void live.current.onChange(markdown);
        }
      }
    },
    onSelectionUpdate: ({ editor }) => {
      if (editor.state.selection.empty) {
        setBar(null);
        setLink(null);
      } else placeBar(editor);
    },
    onBlur: ({ editor, event }) => {
      // The format bar and its link field keep the edit open.
      if (event.relatedTarget instanceof globalThis.Node && wrap.current?.contains(event.relatedTarget)) return;
      setBar(null);
      setLink(null);
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
    editor.commands.setContent(runsToContent(parseInline(value)));
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const applyLink = () => {
    if (!editor) return;
    const raw = (link || "").trim();
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
          {link === null ? (
            <div className="text-menu-format">
              {mark("bold", `${t("Fett", "Bold")} (${key("Mod+B")})`, <TextB size={16} />, () => editor.chain().focus().toggleBold().run())}
              {mark("italic", `${t("Kursiv", "Italic")} (${key("Mod+I")})`, <TextItalic size={16} />, () => editor.chain().focus().toggleItalic().run())}
              {mark("strike", `${t("Durchgestrichen", "Strikethrough")} (${key("Mod+Shift+X")})`, <TextStrikethrough size={16} />, () => editor.chain().focus().toggleStrike().run())}
              {mark("code", `Code (${key("Mod+E")})`, <Code size={16} />, () => editor.chain().focus().toggleCode().run())}
              {mark("link", `Link (${key("Mod+K")})`, <LinkSimple size={16} />, () => openLink(editor))}
            </div>
          ) : (
            <form
              className="rich-text-link"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
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
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setLink(null);
                    editor.commands.focus();
                  }
                }}
                onBlur={(e) => {
                  if (e.relatedTarget instanceof globalThis.Node && wrap.current?.contains(e.relatedTarget)) return;
                  setLink(null);
                  setBar(null);
                  finish(editor, false);
                }}
              />
              <button type="submit" className="button compact primary">
                {t("Übernehmen", "Apply")}
              </button>
              {linkError && (
                <span className="rich-text-link-error" role="alert">
                  {t("Nur http-, https- und mailto-Links.", "Only http, https and mailto links.")}
                </span>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
