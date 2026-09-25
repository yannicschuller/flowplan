"use client";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  highlightColors,
  Subscript,
  Superscript,
  TextColor,
  textColors,
} from "@/lib/text-marks";
import { embedFromUrl, embedProviders } from "@/lib/embed-providers";
import {
  mermaidNodeView,
  DiagramEditorDialog,
  type DiagramTarget,
} from "./mermaid-editor";
import { DEFAULT_DIAGRAM } from "@/lib/mermaid-source";
import { DocumentBlockControls } from "./document-block-controls";
import { BlockShortcuts, moveSelectedBlock } from "@/lib/block-shortcuts";
import { registerDocumentFlush } from "@/lib/document-flush";
import { collaborationCursors } from "@/lib/collaboration-cursors";
import { inlineCommentExtension } from "@/lib/inline-comment-plugin";
import { InlineComments } from "./inline-comments";
import { EditableCodeBlock } from "./code-block";
import {
  linkedDatabaseNode,
  type LinkedEditorContext,
} from "./linked-database";
import { freshLinkedIds } from "@/lib/linked-paste";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { useEditor, EditorContent } from "@tiptap/react";
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
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Collaboration from "@tiptap/extension-collaboration";
import { Node, mergeAttributes } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  Highlighter,
  Palette,
  TextSubscript,
  TextSuperscript,
  Link as LinkIcon,
  ListBullets,
  ListNumbers,
  CheckSquare,
  Quotes,
  Code,
  Image as ImageIcon,
  Table as TableIcon,
  ArrowUUpLeft,
  ArrowUUpRight,
  TextHOne,
  TextHTwo,
  TextHThree,
  Minus,
  Paperclip,
  Plus,
  Info,
  CaretRight,
  Function as FunctionIcon,
  TextAlignLeft,
  TextAlignCenter,
} from "@phosphor-icons/react";
import { api, Modal } from "./ui";
import type { Page, User } from "@/lib/types";
import {
  mathNodeViews,
  MathEditorDialog,
  type MathTarget,
} from "./math-editor";
import {
  Callout,
  Toggle,
  Mention,
  Columns,
  Column,
  Media,
} from "@/lib/document-schema";
export default function DocumentEditor({
  pageId,
  rowId,
  userId,
  pages,
  members,
  state,
  html,
  generation,
  editable,
  onStatus,
  onError,
  onHtml,
}: {
  pageId: string;
  rowId?: string;
  userId: string;
  pages: Page[];
  members: User[];
  state: string | null;
  html: string;
  generation: string;
  editable: boolean;
  onStatus: (v: string) => void;
  onError: (v: string) => void;
  onHtml: (v: string) => void;
}) {
  const doc = useMemo(() => new Y.Doc(), [pageId, rowId]);
  const ready = useRef(false),
    dirty = useRef(false),
    inflight = useRef(false),
    lastHtml = useRef(html),
    initial = useRef({ state, html }),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slash, setSlash] = useState(false),
    [link, setLink] = useState(false),
    [linkUrl, setLinkUrl] = useState(""),
    [diagram, setDiagram] = useState<DiagramTarget | null>(null),
    [math, setMath] = useState<MathTarget | null>(null),
    [toggle, setToggle] = useState(false),
    [toggleTitle, setToggleTitle] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const [tick, setTick] = useState(0);
  const [references, setReferences] = useState(false),
    [outline, setOutline] = useState(false),
    [embed, setEmbed] = useState(false),
    [embedUrl, setEmbedUrl] = useState("");
  const [linkedPicker, setLinkedPicker] = useState(false),
    [linking, setLinking] = useState(false),
    [linkedSearch, setLinkedSearch] = useState("");
  const colorSelection = useRef<{ from: number; to: number } | null>(null);
  const colorChain = () => {
    const saved = colorSelection.current,
      chain = editor?.chain().focus();
    return saved && editor && saved.to <= editor.state.doc.content.size
      ? chain?.setTextSelection(saved)
      : chain;
  };
  const linkedContext = useRef<LinkedEditorContext>(null!);
  linkedContext.current = {
    pageId,
    rowId,
    userId,
    pages,
    members,
    generation,
    update: () => bytesTo64(Y.encodeStateAsUpdate(doc)),
    receive: (state) => Y.applyUpdate(doc, from64(state), "remote"),
  };
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          undoRedo: false,
          link: {
            openOnClick: false,
            HTMLAttributes: { rel: "noopener noreferrer" },
          },
        }),
        EditableCodeBlock,
        BlockShortcuts,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableCell,
        TableHeader,
        // Images are resized by their side handles, keeping proportions.
        Image.configure({
          allowBase64: false,
          resize: editable
            ? {
                enabled: true,
                directions: ["left", "right", "bottom-left", "bottom-right"],
                minWidth: 60,
                alwaysPreserveAspectRatio: true,
              }
            : false,
        }),
        Placeholder.configure({
          placeholder: "Schreibe etwas oder tippe / für Befehle …",
        }),
        Highlight.configure({ multicolor: true }),
        TextColor,
        Superscript,
        Subscript,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Typography,
        Callout,
        Toggle,
        ...mathNodeViews(setMath),
        mermaidNodeView(setDiagram),
        Mention,
        Columns,
        Column,
        Media,
        linkedDatabaseNode(() => linkedContext.current),
        Collaboration.configure({ document: doc }),
        collaborationCursors({ pageId, rowId, generation }),
        inlineCommentExtension(generation),
      ],
      editorProps: {
        transformPasted: freshLinkedIds,
        attributes: {
          class: "document-editor",
          "aria-label": "Dokumentinhalt",
        },
        handleKeyDown: (_view, event) => {
          if (_view.state.selection.$from.parent.type.name === "codeBlock")
            return false;
          if (event.key === "@" && editable) {
            setReferences(true);
            return true;
          }
          if (event.key === "/" && editable) {
            setSlash(true);
            return true;
          }
          if (event.key === "Escape") setSlash(false);
          return false;
        },
      },
      onUpdate: ({ editor, transaction }) => {
        lastHtml.current = editor.getHTML();
        onHtml(lastHtml.current);
        if (
          ready.current &&
          editable &&
          !transaction.getMeta("y-sync$")?.isChangeOrigin
        ) {
          dirty.current = true;
          onStatus(navigator.onLine ? "Änderungen …" : "Offline gespeichert");
        }
      },
      onSelectionUpdate: () => setTick((t) => t + 1),
    },
    [doc],
  );
  const sync = useCallback(async () => {
    if (!editor || !ready.current || inflight.current || !navigator.onLine)
      return;
    inflight.current = true;
    try {
      if (dirty.current && editable) {
        dirty.current = false;
        onStatus("Speichern …");
        const result = await api<{ state: string }>("/api/command", {
          action: rowId ? "row.document.sync" : "document.sync",
          rowId,
          pageId,
          generation,
          update: bytesTo64(Y.encodeStateAsUpdate(doc)),
          html: lastHtml.current,
        });
        Y.applyUpdate(doc, from64(result.state), "remote");
        onStatus(dirty.current ? "Änderungen …" : "Gespeichert");
      } else {
        const result = await api<{ state: string | null; generation: string }>(
          rowId ? `/api/pages/${pageId}/rows/${rowId}` : `/api/pages/${pageId}`,
        );
        // A restored or guest-edited document has a new CRDT identity. The parent
        // remounts this editor with that generation; merging it into this one duplicates content.
        if (result.generation !== generation) {
          onStatus("Neue Dokumentversion wird geladen …");
          return;
        }
        if (result.state) Y.applyUpdate(doc, from64(result.state), "remote");
      }
    } catch (e) {
      dirty.current = true;
      onStatus(
        navigator.onLine ? "Speichern fehlgeschlagen" : "Offline gespeichert",
      );
      if (navigator.onLine) onError((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }, [doc, editor, editable, pageId, rowId, generation, onStatus, onError]);
  useEffect(
    () =>
      registerDocumentFlush(async () => {
        if (!editable) return;
        if (!ready.current)
          throw new Error("Das Dokument wird noch geladen. Bitte kurz warten.");
        if (!navigator.onLine)
          throw new Error(
            "Zum Exportieren bitte die Verbindung wiederherstellen.",
          );
        if (!dirty.current && !inflight.current) return;
        const result = await api<{ state: string }>("/api/command", {
          action: rowId ? "row.document.sync" : "document.sync",
          pageId,
          rowId,
          generation,
          update: bytesTo64(Y.encodeStateAsUpdate(doc)),
        });
        Y.applyUpdate(doc, from64(result.state), "remote");
      }),
    [doc, editable, pageId, rowId, generation],
  );
  const persistOnLeave = useCallback(() => {
    if (!editable || !ready.current || !dirty.current || !navigator.onLine)
      return;
    const body = JSON.stringify({
      action: rowId ? "row.document.sync" : "document.sync",
      pageId,
      rowId,
      generation,
      update: bytesTo64(Y.encodeStateAsUpdate(doc)),
    });
    // SPA navigation must flush before effect cleanup marks the editor unready.
    // IndexedDB remains the retry source if the request cannot finish.
    void fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: new TextEncoder().encode(body).length < 60000,
    }).catch(() => {});
  }, [doc, editable, pageId, rowId, generation]);
  useEffect(() => {
    if (!editor) return;
    let alive = true;
    const persistence = new IndexeddbPersistence(
      `flowplan:${userId}:${pageId}:${rowId || "page"}:${generation}`,
      doc,
    );
    persistence.whenSynced.then(() => {
      if (!alive) return;
      if (initial.current.state)
        Y.applyUpdate(doc, from64(initial.current.state), "remote");
      if (
        !doc.getXmlFragment("default").length &&
        initial.current.html &&
        editable
      )
        editor.commands.setContent(initial.current.html);
      lastHtml.current = editor.getHTML();
      onHtml(lastHtml.current);
      ready.current = true;
      dirty.current = editable;
      onStatus(
        navigator.onLine
          ? editable
            ? "Synchronisieren …"
            : "Gespeichert"
          : "Offline gespeichert",
      );
    });
    const update = (_u: Uint8Array, origin: unknown) => {
      if (
        ready.current &&
        origin !== "remote" &&
        origin !== persistence &&
        editable
      )
        dirty.current = true;
    };
    doc.on("update", update);
    return () => {
      persistOnLeave();
      alive = false;
      ready.current = false;
      doc.off("update", update);
      void persistence.destroy();
    };
  }, [
    doc,
    editor,
    pageId,
    rowId,
    generation,
    userId,
    editable,
    onHtml,
    onStatus,
    persistOnLeave,
  ]);
  useEffect(() => {
    const interval = setInterval(sync, 1800);
    window.addEventListener("online", sync);
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        persistOnLeave();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", sync);
      window.removeEventListener("beforeunload", unload);
      void sync();
    };
  }, [sync, persistOnLeave]);
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);
  async function upload(file: File) {
    const form = new FormData();
    form.set("pageId", pageId);
    form.set("file", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (file.type.startsWith("image/"))
        editor
          ?.chain()
          .focus()
          .setImage({ src: data.url, alt: file.name })
          .run();
      else if (file.type.startsWith("video/") || file.type.startsWith("audio/"))
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "media",
            attrs: {
              src: data.url,
              kind: file.type.startsWith("video/") ? "video" : "audio",
              title: file.name,
            },
          })
          .run();
      else
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: file.name,
                marks: [{ type: "link", attrs: { href: data.url } }],
              },
            ],
          })
          .run();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  const commands = [
    {
      name: "Text",
      description: "Einfach losschreiben",
      icon: TextAlignLeft,
      run: () => editor?.chain().focus().setParagraph().run(),
    },
    {
      name: "Überschrift 1",
      description: "Große Überschrift",
      icon: TextHOne,
      run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      name: "Überschrift 2",
      description: "Mittlere Überschrift",
      icon: TextHTwo,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      name: "Überschrift 3",
      description: "Kleine Überschrift",
      icon: TextHThree,
      run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      name: "Aufgabenliste",
      description: "Schritt für Schritt abhaken",
      icon: CheckSquare,
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      name: "Aufzählung",
      description: "Eine Liste mit Punkten",
      icon: ListBullets,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      name: "Nummerierte Liste",
      description: "Eine geordnete Liste",
      icon: ListNumbers,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      name: "Zitat",
      description: "Einen Gedanken hervorheben",
      icon: Quotes,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      name: "Hinweis",
      description: "Wichtige Informationen",
      icon: Info,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "callout",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Gut zu wissen …" }],
              },
            ],
          })
          .run(),
    },
    {
      name: "Aufklappbarer Block",
      description: "Details ein- und ausblenden",
      icon: CaretRight,
      run: () => setToggle(true),
    },
    {
      name: "Code",
      description: "Codeblock einfügen",
      icon: Code,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    {
      name: "Tabelle",
      description: "Zeilen und Spalten",
      icon: TableIcon,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      name: "Bild oder Datei",
      description: "Datei vom Gerät hochladen",
      icon: ImageIcon,
      run: () => uploadRef.current?.click(),
    },
    {
      name: "Mermaid-Diagramm",
      description: "Abläufe, Sequenzen und Beziehungen",
      icon: Code,
      run: () => setDiagram({ source: DEFAULT_DIAGRAM }),
    },
    {
      name: "Formel",
      description: "Mathematischer Ausdruck",
      icon: FunctionIcon,
      run: () => setMath({ type: "mathBlock", expression: "" }),
    },
    {
      name: "Inline-Formel",
      description: "Mathematik direkt im Satz",
      icon: FunctionIcon,
      run: () => openInlineMath(),
    },
    {
      name: "Seite oder Person erwähnen",
      description: "Mit @ Wissen verknüpfen",
      icon: LinkIcon,
      run: () => setReferences(true),
    },
    {
      name: "Verknüpfte Datenbank",
      description: "Bestehende Einträge mit eigener Ansicht",
      icon: TableIcon,
      run: () => {
        setLinkedSearch("");
        setLinkedPicker(true);
      },
    },
    {
      name: "Zwei Spalten",
      description: "Inhalte nebeneinander",
      icon: TableIcon,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "columns",
            content: [
              { type: "column", content: [{ type: "paragraph" }] },
              { type: "column", content: [{ type: "paragraph" }] },
            ],
          })
          .run(),
    },
    {
      name: "Einbetten",
      description: "YouTube, Vimeo, Loom, Spotify, Figma oder CodePen",
      icon: ImageIcon,
      run: () => setEmbed(true),
    },
    {
      name: "Trennlinie",
      description: "Inhalte voneinander trennen",
      icon: Minus,
      run: () => editor?.chain().focus().setHorizontalRule().run(),
    },
  ];
  function openInlineMath() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    setMath({
      type: "mathInline",
      expression: editor.state.doc.textBetween(from, to, " "),
    });
  }
  function moveBlock(direction: -1 | 1) {
    moveSelectedBlock(editor, direction);
  }
  const headings: { text: string; pos: number; level: number }[] = [];
  editor?.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading")
      headings.push({ text: node.textContent, pos, level: node.attrs.level });
  });
  return (
    <div className="editor-wrapper">
      <div className="document-writing-surface">
        {editable && (
          <div
            className="editor-toolbar"
            role="toolbar"
            aria-label="Textformatierung"
          >
            <button
              title="Rückgängig"
              onClick={() => editor?.chain().focus().undo().run()}
            >
              <ArrowUUpLeft />
            </button>
            <button
              title="Wiederholen"
              onClick={() => editor?.chain().focus().redo().run()}
            >
              <ArrowUUpRight />
            </button>
            <span className="toolbar-separator" />
            <button
              title="Fett"
              className={editor?.isActive("bold") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <TextB />
            </button>
            <button
              title="Kursiv"
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <TextItalic />
            </button>
            <button
              title="Unterstrichen"
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
            >
              <TextUnderline />
            </button>
            <button
              title="Durchgestrichen"
              onClick={() => editor?.chain().focus().toggleStrike().run()}
            >
              <TextStrikethrough />
            </button>
            <button
              title="Markieren"
              onClick={() => editor?.chain().focus().toggleHighlight().run()}
            >
              <Highlighter />
            </button>
            <Dropdown.Root
              onOpenChange={(open) => {
                // The menu takes focus; colours apply to the remembered text.
                if (open && editor) {
                  const { from, to } = editor.state.selection;
                  colorSelection.current = { from, to };
                }
              }}
            >
              <Dropdown.Trigger asChild>
                <button title="Farbe" aria-label="Text- und Hintergrundfarbe">
                  <Palette />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content
                  className="dropdown-content color-menu"
                  sideOffset={6}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <div className="color-menu-label">Textfarbe</div>
                  <div className="color-swatches">
                    {textColors.map(([name, color]) => (
                      <Dropdown.Item
                        key={color}
                        className="color-swatch"
                        aria-label={`Textfarbe ${name}`}
                        title={name}
                        style={{ color }}
                        onSelect={() => colorChain()?.setTextColor(color).run()}
                      >
                        A
                      </Dropdown.Item>
                    ))}
                  </div>
                  <div className="color-menu-label">Hintergrund</div>
                  <div className="color-swatches">
                    {highlightColors.map(([name, color]) => (
                      <Dropdown.Item
                        key={color}
                        className="color-swatch"
                        aria-label={`Hintergrund ${name}`}
                        title={name}
                        style={{ background: color }}
                        onSelect={() =>
                          editor?.chain().focus().setHighlight({ color }).run()
                        }
                      >
                        A
                      </Dropdown.Item>
                    ))}
                  </div>
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={() =>
                      colorChain()?.unsetTextColor().unsetHighlight().run()
                    }
                  >
                    Farben entfernen
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
            <button
              title="Hochgestellt"
              className={editor?.isActive("superscript") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleSuperscript().run()}
            >
              <TextSuperscript />
            </button>
            <button
              title="Tiefgestellt"
              className={editor?.isActive("subscript") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleSubscript().run()}
            >
              <TextSubscript />
            </button>
            <button
              title="Link"
              onClick={() => {
                setLinkUrl(editor?.getAttributes("link").href || "");
                setLink(true);
              }}
            >
              <LinkIcon />
            </button>
            <span className="toolbar-separator" />
            <button
              title="Überschrift"
              onClick={() =>
                editor?.chain().focus().toggleHeading({ level: 2 }).run()
              }
            >
              <TextHTwo />
            </button>
            <button
              title="Aufgabenliste"
              onClick={() => editor?.chain().focus().toggleTaskList().run()}
            >
              <CheckSquare />
            </button>
            <button
              title="Zentrieren"
              onClick={() =>
                editor?.chain().focus().setTextAlign("center").run()
              }
            >
              <TextAlignCenter />
            </button>
            <button title="Block nach oben" onClick={() => moveBlock(-1)}>
              ↑
            </button>
            <button title="Block nach unten" onClick={() => moveBlock(1)}>
              ↓
            </button>
            <button
              title="Inhaltsverzeichnis"
              onClick={() => setOutline(!outline)}
            >
              <ListBullets />
            </button>
            <button title="Inline-Formel" onClick={openInlineMath}>
              <FunctionIcon />
            </button>
            <button title="Block hinzufügen" onClick={() => setSlash(true)}>
              <Plus />
            </button>
          </div>
        )}
        {outline && (
          <nav className="document-outline" aria-label="Inhaltsverzeichnis">
            <strong>Inhalt</strong>
            {headings.map((h) => (
              <button
                key={h.pos}
                style={{ paddingLeft: (h.level - 1) * 12 }}
                onClick={() => {
                  const node = editor?.view.nodeDOM(h.pos);
                  if (node instanceof HTMLElement)
                    node.scrollIntoView({ block: "center" });
                }}
              >
                {h.text || "Überschrift"}
              </button>
            ))}
          </nav>
        )}
        <DocumentBlockControls editor={editor}>
          <EditorContent editor={editor} />
        </DocumentBlockControls>
        {editor?.isActive("table") && editable && (
          <div className="table-tools">
            <button onClick={() => editor.chain().focus().addRowAfter().run()}>
              + Zeile
            </button>
            <button
              onClick={() => editor.chain().focus().addColumnAfter().run()}
            >
              + Spalte
            </button>
            <button onClick={() => editor.chain().focus().deleteRow().run()}>
              Zeile löschen
            </button>
            <button onClick={() => editor.chain().focus().deleteColumn().run()}>
              Spalte löschen
            </button>
          </div>
        )}
      </div>
      <InlineComments
        editor={editor}
        pageId={pageId}
        rowId={rowId}
        generation={generation}
        userId={userId}
      />
      <input
        ref={uploadRef}
        type="file"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <Modal
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
        open={slash}
        onClose={() => setSlash(false)}
        title="Block hinzufügen"
      >
        <div className="slash-list">
          {commands.map((c) => (
            <button
              key={c.name}
              onClick={() => {
                setSlash(false);
                c.run();
              }}
            >
              <span>
                <c.icon size={23} />
              </span>
              <div>
                <strong>{c.name}</strong>
                <small>{c.description}</small>
              </div>
            </button>
          ))}
        </div>
      </Modal>
      <Modal
        open={linkedPicker}
        title="Datenbank verknüpfen"
        onClose={() => {
          if (!linking) setLinkedPicker(false);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
      >
        <p>
          Einträge bleiben in der Quelldatenbank. Filter und Darstellung gelten
          nur für diese Einbettung.
        </p>
        <input
          aria-label="Datenquelle suchen"
          autoFocus
          value={linkedSearch}
          onChange={(event) => setLinkedSearch(event.target.value)}
          placeholder="Datenbank suchen …"
        />
        <div className="linked-source-list">
          {pages
            .filter(
              (p) =>
                p.kind === "database" &&
                !p.deleted_at &&
                p.title.toLowerCase().includes(linkedSearch.toLowerCase()),
            )
            .map((source) => (
              <button
                className="button"
                key={source.id}
                disabled={linking}
                onClick={async () => {
                  setLinking(true);
                  try {
                    const data = await api<{
                      database: { views: import("@/lib/types").View[] };
                    }>(`/api/pages/${source.id}`);
                    editor
                      ?.chain()
                      .focus()
                      .command(({ tr, state }) => {
                        if (state.selection instanceof NodeSelection)
                          tr.setSelection(
                            Selection.near(tr.doc.resolve(state.selection.to)),
                          );
                        return true;
                      })
                      .insertContent({
                        type: "linkedDatabase",
                        attrs: {
                          id: crypto.randomUUID(),
                          source: source.id,
                          version: "1",
                          views: JSON.stringify([
                            {
                              ...data.database.views[0],
                              id: crypto.randomUUID(),
                            },
                          ]),
                        },
                      })
                      .run();
                    await sync();
                    setLinkedPicker(false);
                  } catch (error) {
                    onError((error as Error).message);
                  } finally {
                    setLinking(false);
                  }
                }}
              >
                {source.title}
              </button>
            ))}
          {!pages.some(
            (p) =>
              p.kind === "database" &&
              !p.deleted_at &&
              p.title.toLowerCase().includes(linkedSearch.toLowerCase()),
          ) && <p className="muted">Keine passende Datenbank.</p>}
        </div>
      </Modal>
      <Modal open={link} onClose={() => setLink(false)} title="Link einfügen">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              /^https?:\/\//.test(linkUrl) ||
              /^mailto:/.test(linkUrl) ||
              linkUrl.startsWith("/")
            ) {
              editor?.chain().focus().setLink({ href: linkUrl }).run();
              setLink(false);
            } else onError("Bitte eine gültige URL eingeben.");
          }}
        >
          <label>
            Adresse
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                editor?.chain().focus().unsetLink().run();
                setLink(false);
              }}
            >
              Link entfernen
            </button>
            <button className="button primary">Einfügen</button>
          </div>
        </form>
      </Modal>
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
      <Modal
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
        open={references}
        onClose={() => setReferences(false)}
        title="Seite oder Person erwähnen"
      >
        <div className="reference-list">
          <h3>Seiten</h3>
          {pages
            .filter((p) => p.id !== pageId)
            .map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  editor
                    ?.chain()
                    .focus()
                    .insertContent({
                      type: "text",
                      text: p.title,
                      marks: [
                        { type: "link", attrs: { href: `/#page=${p.id}` } },
                      ],
                    })
                    .run();
                  setReferences(false);
                }}
              >
                <LinkIcon />
                {p.title}
              </button>
            ))}
          <h3>Personen</h3>
          {members.map((u) => (
            <button
              key={u.id}
              onClick={() => {
                editor
                  ?.chain()
                  .focus()
                  .insertContent({
                    type: "mention",
                    attrs: { userId: u.id, label: u.name },
                  })
                  .run();
                setReferences(false);
              }}
            >
              @{u.name}
            </button>
          ))}
        </div>
      </Modal>
      <Modal
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
        open={embed}
        onClose={() => setEmbed(false)}
        title="Inhalt einbetten"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const embedded = embedFromUrl(embedUrl);
              if (!embedded)
                throw Error(
                  `Bitte einen Link von ${embedProviders.map((p) => p.name).join(", ")} eingeben.`,
                );
              const media = {
                type: "media",
                attrs: {
                  src: embedded.src,
                  kind: "embed",
                  title: embedded.provider,
                },
              };
              // A selected block (e.g. the previous embed) is kept; the new
              // one goes after it.
              const selection = editor?.state.selection;
              if (selection instanceof NodeSelection)
                editor
                  ?.chain()
                  .focus()
                  .insertContentAt(selection.to, media)
                  .run();
              else editor?.chain().focus().insertContent(media).run();
              setEmbed(false);
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          <label>
            Link (YouTube, Vimeo, Loom, Spotify, Figma, CodePen)
            <input
              autoFocus
              type="url"
              value={embedUrl}
              onChange={(e) => setEmbedUrl(e.target.value)}
            />
          </label>
          <button className="button primary">Einbetten</button>
        </form>
      </Modal>
      <Modal
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
        open={toggle}
        onClose={() => setToggle(false)}
        title="Aufklappbarer Block"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            editor
              ?.chain()
              .focus()
              .insertContent({
                type: "toggle",
                attrs: { title: toggleTitle || "Details" },
                content: [{ type: "paragraph" }],
              })
              .run();
            setToggle(false);
          }}
        >
          <label>
            Titel
            <input
              autoFocus
              value={toggleTitle}
              onChange={(e) => setToggleTitle(e.target.value)}
            />
          </label>
          <button className="button primary">Einfügen</button>
        </form>
      </Modal>
    </div>
  );
}
function bytesTo64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function from64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
