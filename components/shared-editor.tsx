"use client";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  CheckSquare,
  Code,
  FileArrowUp,
  Function as FunctionIcon,
  Graph,
  Highlighter,
  Info,
  ListBullets,
  ListNumbers,
  Minus,
  Plus,
  Quotes,
  TextAlignLeft,
  TextB,
  TextHFour,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
} from "@phosphor-icons/react";
import { TextSelection } from "@tiptap/pm/state";
import { SlashMenu, type SlashItem } from "./slash-menu";
import { AlignMenu, HeadingMenu } from "./format-menus";
import { slashSections } from "@/lib/slash-commands";
import { typedMenu } from "@/lib/mention-trigger";
import { blockForInsert, emptyBlockNear } from "@/lib/document-blocks";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import type * as Y from "yjs";
import {
  mathNodeViews,
  MathEditorDialog,
  type MathTarget,
} from "./math-editor";
import { documentExtensions, FlowTaskItem, Media, widthStyle } from "@/lib/document-schema";
import { DrawBlock } from "@/lib/draw-block-node";
import { DrawioBlock } from "@/lib/drawio-node";
import { mountDrawioPreview } from "@/lib/drawio-preview";
import { BlockDirectionExtension } from "@/lib/text-direction";
import {
  mermaidNodeView,
  DiagramEditorDialog,
  type DiagramTarget,
} from "./mermaid-editor";
import { DEFAULT_DIAGRAM } from "@/lib/mermaid-source";
import { DocumentBlockControls } from "./document-block-controls";
import { BlockShortcuts } from "@/lib/block-shortcuts";
import { BlockGaps } from "@/lib/block-gaps";
import { EditableCodeBlock } from "./code-block";
import { BlockCaptions } from "./block-captions-view";
import { embedProvider } from "@/lib/embed-providers";
import { guestCursors } from "@/lib/guest-cursors";
import { PageLinkIcons } from "./page-link-icons";
export type GuestUpload = { url: string; name: string; mime: string };
export default function SharedEditor({
  html,
  onChange,
  disabled,
  upload,
  ydoc,
  presence,
}: {
  html: string;
  onChange: (html: string) => void;
  disabled: boolean;
  upload?: (file: File) => Promise<GuestUpload | null>;
  // Live editing: the content lives in this Yjs document.
  ydoc?: Y.Doc;
  // Live cursors with members and other guests (edit links).
  presence?: { token: string; pageId: string; rowId?: string; clientId: string };
}) {
  const t = useT();
  const [diagram, setDiagram] = useState<DiagramTarget | null>(null);
  const [math, setMath] = useState<MathTarget | null>(null);
  // The "/" menu (#278), as in the app: typed in the text ("inline", the
  // "/" stays and what follows filters) or opened by the toolbar's "+"
  // ("button", with its own search field). The handle's "+" types a "/"
  // into a new block below, which opens it inline.
  const [slash, setSlash] = useState<{ from: number; mode: "inline" | "button"; query: string } | null>(null);
  const [slashActive, setSlashActive] = useState(0);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const activeRef = useRef(slashActive);
  activeRef.current = slashActive;
  const itemsRef = useRef<SlashItem[]>([]);
  const pickRef = useRef((_index: number) => {});
  const lastKey = useRef("");
  const fileInput = useRef<HTMLInputElement>(null);
  const openSlash = (from: number, mode: "inline" | "button") => {
    setSlash({ from, mode, query: "" });
    setSlashActive(0);
  };
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      EditableCodeBlock,
      BlockShortcuts,
      BlockGaps,
      // Links between published pages show the page's icon (#96).
      PageLinkIcons,
      mermaidNodeView(setDiagram),
      ...mathNodeViews(setMath),
      ...documentExtensions
        .filter(
          (e) =>
            !["mathBlock", "mathInline", "codeBlock", "mermaidBlock"].includes(
              e.name,
            ),
        )
        .map((e) =>
          e.name === "drawBlock"
            ? DrawBlock.extend({
                // Drawings show as their picture (read-only here).
                addNodeView() {
                  return ({ node }) => {
                    const dom = document.createElement("div");
                    dom.className = "ink-block-static";
                    dom.contentEditable = "false";
                    dom.style.aspectRatio = `720 / ${Number(node.attrs.height) || 300}`;
                    if (presence?.token)
                      void fetch(
                        `/api/share/${presence.token}/ink?page=${encodeURIComponent(presence.pageId)}&block=${encodeURIComponent(String(node.attrs.id || ""))}&height=${Number(node.attrs.height) || 300}&paper=${encodeURIComponent(String(node.attrs.paper || ""))}`,
                      )
                        .then((r) => (r.ok ? r.json() : null))
                        .then((data: { svg?: string | null } | null) => {
                          // The picture is drawn on the server from checked ink (lib/ink/svg.ts).
                          if (data?.svg) dom.innerHTML = data.svg.replace("<svg ", '<svg class="ink-block-picture" ');
                        })
                        .catch(() => {});
                    return { dom };
                  };
                },
              })
            : e.name === "taskItem"
            ? // The box names its state in the reader's language (#201).
              FlowTaskItem.configure({ nested: true, translate: t })
            : e.name === "drawioBlock"
            ? DrawioBlock.extend({
                // draw.io diagrams show their picture; editing is for members.
                addNodeView() {
                  return ({ node }) => {
                    const dom = document.createElement("div");
                    dom.contentEditable = "false";
                    mountDrawioPreview(dom, String(node.attrs.svg || ""), !!node.attrs.xml);
                    return { dom, ignoreMutation: () => true };
                  };
                },
              })
            : e.name === "media"
            ? Media.extend({
                renderHTML: ({ node }) => {
                  const { src, kind } = node.attrs;
                  if (
                    ["audio", "video"].includes(kind) &&
                    /^\/api\/share\/[\w-]+\/files\/[\w-]+$/.test(src)
                  )
                    return [
                      kind,
                      {
                        src,
                        controls: true,
                        preload: "metadata",
                        ...widthStyle(node.attrs.width),
                      },
                    ];
                  const provider =
                    kind === "embed" ? embedProvider(src || "") : undefined;
                  if (provider)
                    return [
                      "iframe",
                      {
                        src,
                        title: provider.name,
                        ...widthStyle(node.attrs.width),
                        sandbox:
                          "allow-scripts allow-same-origin allow-presentation",
                        loading: "lazy",
                      },
                    ];
                  return ["p", {}, t("Medium nicht verfügbar", "Media not available")];
                },
              })
            : e.name === "blockDirection"
              ? BlockDirectionExtension.configure({ auto: true })
              : e,
        ),
      // Captions below images, tables and code (lib/block-captions.ts).
      BlockCaptions,
      ...(ydoc ? [Collaboration.configure({ document: ydoc })] : []),
      ...(ydoc && presence ? [guestCursors(presence)] : []),
    ],
    ...(ydoc ? {} : { content: html }),
    editable: !disabled,
    editorProps: {
      attributes: {
        "aria-label": t("Geteilten Inhalt bearbeiten", "Edit shared content"),
        role: "textbox",
        "aria-multiline": "true",
      },
      // "/" typed without a key that names it (Android keyboards) – and the
      // "/" the handle's "+" types (components/document-block-controls.tsx).
      handleTextInput: (view, from, to, text) => {
        const menu = view.editable ? typedMenu(view.state, from, to, text, lastKey.current) : null;
        lastKey.current = "";
        if (menu === "slash") openSlash(from, "inline");
        return false;
      },
      handleKeyDown: (view, event) => {
        lastKey.current = event.key;
        const menu = slashRef.current;
        if (menu?.mode === "inline") {
          const count = itemsRef.current.length;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (count) setSlashActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
            return true;
          }
          if ((event.key === "Enter" || event.key === "Tab") && count) {
            pickRef.current(activeRef.current);
            return true;
          }
          if (event.key === "Escape") {
            setSlash(null);
            return true;
          }
        }
        if (event.key === "/" && view.editable && view.state.selection.empty && !view.state.selection.$from.parent.type.spec.code)
          openSlash(view.state.selection.from, "inline");
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onBlur: () => {
      if (slashRef.current?.mode === "inline") setSlash(null);
    },
  });
  // Keeps the typed query in step with the text; leaving the "/…" word
  // closes the menu.
  useEffect(() => {
    if (!editor) return;
    const follow = () => {
      const menu = slashRef.current;
      if (menu?.mode !== "inline") return;
      const { selection, doc } = editor.state;
      const close = () => setSlash(null);
      if (!selection.empty || selection.from <= menu.from || menu.from > doc.content.size) return close();
      if (doc.resolve(menu.from).parent !== selection.$from.parent) return close();
      const typed = doc.textBetween(menu.from, selection.from, "\n", "\ufffc");
      if (!typed.startsWith("/") || /[\n\ufffc]/.test(typed) || typed.length > 40 || /^\s/.test(typed.slice(1))) return close();
      if (typed.slice(1) !== menu.query) {
        setSlash({ ...menu, query: typed.slice(1) });
        setSlashActive(0);
      }
    };
    editor.on("transaction", follow);
    return () => {
      editor.off("transaction", follow);
    };
  }, [editor]);
  const chain = () => editor?.chain().focus();
  // Which marks and lists the caret is in, for the pressed buttons.
  const ACTIVE = ["bold", "italic", "underline", "strike", "highlight", "bulletList", "orderedList", "taskList"];
  const active =
    useEditorState({
      editor,
      selector: ({ editor: e }) => (e ? ACTIVE.filter((name) => e.isActive(name)).join(" ") : ""),
    }) ?? "";
  const on = (name: string) => active.split(" ").includes(name);
  // The blocks a guest can add: those of the toolbar and the plain blocks
  // of the app's "/" menu (no pages, databases or AI here).
  const commands: SlashItem[] = [
    { id: "text", group: "text", name: t("Text", "Text"), keywords: ["text", "p", "absatz", "paragraph"], description: t("Einfach losschreiben", "Just start writing"), icon: TextAlignLeft, run: () => chain()?.setParagraph().run() },
    ...([1, 2, 3, 4] as const).map((level) => ({
      id: `h${level}`,
      group: "text" as const,
      name: t(`Überschrift ${level}`, `Heading ${level}`),
      keywords: [`h${level}`, "#".repeat(level), `heading${level}`, "überschrift"],
      description: [t("Große Überschrift", "Large heading"), t("Mittlere Überschrift", "Medium heading"), t("Kleine Überschrift", "Small heading"), t("Kleinste Überschrift", "Smallest heading")][level - 1],
      icon: [TextHOne, TextHTwo, TextHThree, TextHFour][level - 1],
      run: () => chain()?.setHeading({ level }).run(),
    })),
    { id: "quote", group: "text", name: t("Zitat", "Quote"), keywords: ["quote", ">", "zitat"], description: t("Einen Gedanken hervorheben", "Highlight a thought"), icon: Quotes, run: () => chain()?.toggleBlockquote().run() },
    { id: "todo", group: "lists", name: t("Aufgabenliste", "Task list"), keywords: ["todo", "aufgabe", "task", "checkbox", "[]"], description: t("Schritt für Schritt abhaken", "Tick off step by step"), icon: CheckSquare, run: () => chain()?.toggleTaskList().run() },
    { id: "bullets", group: "lists", name: t("Aufzählung", "Bulleted list"), keywords: ["ul", "liste", "bullet", "punkte", "-"], description: t("Eine Liste mit Punkten", "A list with bullets"), icon: ListBullets, run: () => chain()?.toggleBulletList().run() },
    { id: "numbered", group: "lists", name: t("Nummerierte Liste", "Numbered list"), keywords: ["ol", "1.", "nummer", "numbered"], description: t("Eine geordnete Liste", "An ordered list"), icon: ListNumbers, run: () => chain()?.toggleOrderedList().run() },
    { id: "callout-note", group: "blocks", name: t("Hinweis", "Callout"), keywords: ["callout", "hinweis", "note", "info", "box"], description: t("Hervorgehobener Kasten", "Highlighted box"), icon: Info, run: () => chain()?.wrapIn("callout", { type: "note" }).run() },
    { id: "code", group: "blocks", name: t("Code", "Code"), keywords: ["code", "```", "snippet"], description: t("Code mit Syntaxhervorhebung", "Code with syntax highlighting"), icon: Code, run: () => chain()?.toggleCodeBlock().run() },
    { id: "divider", group: "blocks", name: t("Trennlinie", "Divider"), keywords: ["divider", "hr", "---", "trennlinie", "linie"], description: t("Abschnitte trennen", "Separate sections"), icon: Minus, run: () => chain()?.setHorizontalRule().run() },
    ...(upload
      ? [{ id: "file", group: "media" as const, name: t("Datei einfügen", "Insert file"), keywords: ["file", "datei", "bild", "image", "upload", "pdf"], description: t("Bild, PDF oder Textdatei hochladen", "Upload an image, PDF or text file"), icon: FileArrowUp, run: () => fileInput.current?.click() }]
      : []),
    { id: "math", group: "math", name: t("Formel", "Block equation"), keywords: ["math", "formel", "latex", "equation", "$$"], description: t("Eine abgesetzte Formel in LaTeX", "A displayed equation in LaTeX"), icon: FunctionIcon, run: () => setMath({ type: "mathBlock", expression: "" }) },
    { id: "inline-math", group: "math", name: t("Inline-Formel", "Inline formula"), keywords: ["inline", "formel", "math", "$"], description: t("Eine Formel im Text", "A formula within the text"), icon: FunctionIcon, run: () => setMath({ type: "mathInline", expression: "" }) },
    { id: "mermaid", group: "math", name: t("Mermaid-Diagramm", "Mermaid diagram"), keywords: ["mermaid", "diagramm", "diagram", "flowchart"], description: t("Diagramm aus Text", "A diagram from text"), icon: Graph, run: () => setDiagram({ source: DEFAULT_DIAGRAM }) },
  ];
  const sections = slash ? slashSections(commands, slash.query) : [];
  const matches = sections.flatMap((section) => section.items);
  itemsRef.current = matches;
  pickRef.current = (index: number) => {
    const item = matches[Math.min(index, matches.length - 1)],
      menu = slashRef.current;
    if (!item || !menu || !editor) return;
    setSlash(null);
    if (menu.mode === "inline") {
      const to = editor.state.selection.from;
      if (to > menu.from) editor.chain().focus().deleteRange({ from: menu.from, to }).run();
    } else editor.commands.focus();
    item.run();
  };
  // A typed query that matches nothing closes the menu ("und/oder").
  useEffect(() => {
    if (slash?.mode === "inline" && slash.query && !matches.length) setSlash(null);
  }, [slash, matches.length]);
  let slashAnchor: { left: number; top: number; bottom: number } | null = null;
  if (slash && editor && !editor.isDestroyed)
    try {
      slashAnchor = editor.view.coordsAtPos(Math.min(slash.from, editor.state.doc.content.size));
    } catch {
      slashAnchor = null;
    }
  const insertFile = async (file: File) => {
    if (!upload) return;
    const result = await upload(file);
    if (!result || !editor) return;
    if (result.mime.startsWith("image/")) editor.chain().focus().setImage({ src: result.url, alt: result.name }).run();
    else
      editor
        .chain()
        .focus()
        .insertContent({
          type: "paragraph",
          content: [{ type: "text", text: result.name, marks: [{ type: "link", attrs: { href: result.url } }] }],
        })
        .run();
  };
  // A toolbar button: an icon with its name as tooltip and accessible name.
  const tool = (label: string, icon: React.ReactNode, run: () => void, active = false) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={active ? "active" : undefined}
      disabled={disabled}
      onClick={run}
    >
      {icon}
    </button>
  );
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  return (
    <div className="shared-rich-editor">
      <div
        className="editor-toolbar shared-toolbar"
        role="toolbar"
        aria-label={t("Textformatierung", "Text formatting")}
        // Buttons keep the caret and selection in the text.
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) event.preventDefault();
        }}
      >
        <HeadingMenu editor={editor} />
        <span className="toolbar-separator" />
        {tool(t("Fett", "Bold"), <TextB />, () => chain()?.toggleBold().run(), on("bold"))}
        {tool(t("Kursiv", "Italic"), <TextItalic />, () => chain()?.toggleItalic().run(), on("italic"))}
        {tool(t("Unterstrichen", "Underline"), <TextUnderline />, () => chain()?.toggleUnderline().run(), on("underline"))}
        {tool(t("Durchgestrichen", "Strikethrough"), <TextStrikethrough />, () => chain()?.toggleStrike().run(), on("strike"))}
        {tool(t("Markieren", "Highlight"), <Highlighter />, () => chain()?.toggleHighlight().run(), on("highlight"))}
        <span className="toolbar-separator" />
        {tool(t("Aufzählung", "Bulleted list"), <ListBullets />, () => chain()?.toggleBulletList().run(), on("bulletList"))}
        {tool(t("Nummerierte Liste", "Numbered list"), <ListNumbers />, () => chain()?.toggleOrderedList().run(), on("orderedList"))}
        {tool(t("Aufgabenliste", "Task list"), <CheckSquare />, () => chain()?.toggleTaskList().run(), on("taskList"))}
        <AlignMenu editor={editor} />
        <span className="toolbar-separator" />
        {tool(t("Inline-Formel", "Inline formula"), <FunctionIcon />, () => setMath({ type: "mathInline", expression: "" }))}
        {tool(t("Mermaid-Diagramm", "Mermaid diagram"), <Graph />, () => setDiagram({ source: DEFAULT_DIAGRAM }))}
        {upload && tool(t("Datei einfügen", "Insert file"), <FileArrowUp />, () => fileInput.current?.click())}
        {tool(t("Block hinzufügen", "Add block"), <Plus />, () => {
          if (!editor) return;
          // A new block below the current one, as the app's toolbar "+".
          const block = blockForInsert(editor.state);
          const placed = block && editor.isEditable ? emptyBlockNear(editor.state, block) : null;
          if (placed) editor.view.dispatch(placed.tr.setSelection(TextSelection.create(placed.tr.doc, placed.caret)).scrollIntoView());
          openSlash(editor.state.selection.from, "button");
        })}
        {upload && (
          <input
            ref={fileInput}
            type="file"
            hidden
            tabIndex={-1}
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void insertFile(file);
            }}
          />
        )}
      </div>
      {slash && slashAnchor && (
        <SlashMenu
          sections={sections}
          active={Math.min(slashActive, Math.max(0, matches.length - 1))}
          anchor={slashAnchor}
          measureAnchor={() => {
            if (!editor || editor.isDestroyed) return null;
            try {
              return editor.view.coordsAtPos(Math.min(slash.from, editor.state.doc.content.size));
            } catch {
              return null;
            }
          }}
          search={slash.mode === "button" ? slash.query : undefined}
          onSearch={(query) => {
            setSlash({ ...slash, query });
            setSlashActive(0);
          }}
          onKey={(event) => {
            const count = matches.length;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (count) setSlashActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
            } else if ((event.key === "Enter" || event.key === "Tab") && count) {
              event.preventDefault();
              pickRef.current(slashActive);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setSlash(null);
              editor?.commands.focus();
            }
          }}
          onPick={(index) => pickRef.current(index)}
          onHover={setSlashActive}
          onClose={() => setSlash(null)}
        />
      )}
      {diagram && (
        <DiagramEditorDialog
          editor={editor}
          target={diagram}
          onClose={() => setDiagram(null)}
        />
      )}
      {math && (
        <MathEditorDialog
          editor={editor}
          target={math}
          onClose={() => setMath(null)}
        />
      )}
      <DocumentBlockControls editor={editor} allowLinkedCopies={false}>
        <EditorContent editor={editor} className="document-editor" />
      </DocumentBlockControls>
    </div>
  );
}
