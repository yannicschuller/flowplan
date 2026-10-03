"use client";
import { useT } from "./i18n";
import { TaskDue, pickTaskDue } from "@/lib/task-due-plugin";
import {
  resolveSuggestions,
  suggestionGroups,
  Suggestion,
  SuggestChanges,
} from "@/lib/suggestions";
import { syncedBlockNode, type SyncedContext } from "./synced-block";
import { VoiceRecorder } from "./voice-recorder";
import { TextMenu } from "./text-menu";
import { BlockReactionAttribute, BlockReactions } from "@/lib/block-reactions";
import { whiteboardEmbedNode } from "./whiteboard/embed";
import { Select } from "./select";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  highlightColors,
  Subscript,
  Superscript,
  TextColor,
  textColors,
} from "@/lib/text-marks";
import { embedFromUrl } from "@/lib/embed-providers";
import {
  mermaidNodeView,
  DiagramEditorDialog,
  type DiagramTarget,
} from "./mermaid-editor";
import { DEFAULT_DIAGRAM } from "@/lib/mermaid-source";
import { DocumentBlockControls } from "./document-block-controls";
import {
  BlockShortcuts,
  PlainNewLine,
  moveSelectedBlock,
} from "@/lib/block-shortcuts";
import { registerDocumentFlush } from "@/lib/document-flush";
import { collaborationCursors } from "@/lib/collaboration-cursors";
import {
  commentMarkedNodeView,
  inlineCommentExtension,
} from "@/lib/inline-comment-plugin";
import { InlineComments } from "./inline-comments";
import { EditableCodeBlock } from "./code-block";
import {
  linkedDatabaseNode,
  type LinkedEditorContext,
} from "./linked-database";
import { freshLinkedIds } from "@/lib/linked-paste";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
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
import type { Editor as TiptapEditor } from "@tiptap/core";
import { SlashMenu, type SlashItem } from "./slash-menu";
import { rankCommands } from "@/lib/slash-commands";
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
  EyeSlash,
  Link as LinkIcon,
  ListBullets,
  ListNumbers,
  CheckSquare,
  Quotes,
  Code,
  Image as ImageIcon,
  Table as TableIcon,
  PresentationChart,
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
  ArrowsClockwise,
  Microphone,
  PencilLine,
  Check,
  X,
  CalendarBlank,
} from "@phosphor-icons/react";
import { api, isTransient, Modal } from "./ui";
import { withPdfView } from "./pdf-node";
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
  LinkCard,
  FlowTaskItem,
  Spoiler,
  Indent,
  MEDIA_WIDTHS,
} from "@/lib/document-schema";
import { compressImage } from "@/lib/image-compress";
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
  embedded = false,
  transcription = false,
}: {
  // The server turns voice notes into text (Whisper).
  transcription?: boolean;
  // Shown inside another document (synced block): no toolbar, outline,
  // block management or comment bar.
  embedded?: boolean;
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
  const t = useT();
  const doc = useMemo(() => new Y.Doc(), [pageId, rowId]);
  // One id per open editor: the live channel does not echo its own changes
  // and cursor moves back to it.
  const liveId = useMemo(() => crypto.randomUUID(), [pageId, rowId, generation]);
  const ready = useRef(false),
    dirty = useRef(false),
    inflight = useRef(false),
    // Live editing (lib/document-live.ts): local changes not yet stored,
    // whether the next save must carry the whole state (first save, after
    // an error), the push channel and the last full poll.
    pending = useRef<Uint8Array[]>([]),
    sendAll = useRef(true),
    live = useRef(false),
    lastPoll = useRef(0),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    lastHtml = useRef(html),
    initial = useRef({ state, html }),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "/" menu: typed in the text (inline) or opened from the toolbar (button,
  // with its own search field). `from` is where the "/" sits.
  const [slash, setSlash] = useState<{
      from: number;
      mode: "inline" | "button";
      query: string;
    } | null>(null),
    [slashActive, setSlashActive] = useState(0),
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
  const [boardPicker, setBoardPicker] = useState(false),
    [boardSearch, setBoardSearch] = useState("");
  const [voice, setVoice] = useState(false);
  // "Vorschlagen": changes become suggestions others can accept or reject.
  const [suggesting, setSuggesting] = useState(false);
  const suggestingRef = useRef(false);
  suggestingRef.current = suggesting && editable;
  const [suggestionList, setSuggestionList] = useState(false);
  const [syncedPicker, setSyncedPicker] = useState<
    { id: string; preview: string; origin: string }[] | null
  >(null);
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
  function insertBoard(id: string) {
    editor
      ?.chain()
      .focus()
      .command(({ tr, state }) => {
        if (state.selection instanceof NodeSelection)
          tr.setSelection(Selection.near(tr.doc.resolve(state.selection.to)));
        return true;
      })
      .insertContent({ type: "whiteboardEmbed", attrs: { pageId: id } })
      .run();
    setBoardPicker(false);
  }
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
  // Names for reaction tooltips (read by the reactions plugin).
  const memberNames = useRef(new Map<string, string>());
  memberNames.current = new Map(members.map((m) => [m.id, m.name]));
  const syncedContext = useRef<SyncedContext>(null!);
  syncedContext.current = { userId, pages, members, editable, onError };
  function insertSynced(id: string) {
    editor
      ?.chain()
      .focus()
      .command(({ tr, state }) => {
        if (state.selection instanceof NodeSelection)
          tr.setSelection(Selection.near(tr.doc.resolve(state.selection.to)));
        return true;
      })
      .insertContent([{ type: "syncedBlock", attrs: { pageId: id } }, { type: "paragraph" }])
      .run();
    setSyncedPicker(null);
  }
  const slashState = useRef(slash);
  slashState.current = slash;
  const slashActiveRef = useRef(slashActive);
  slashActiveRef.current = slashActive;
  const slashItems = useRef<SlashItem[]>([]);
  const uploadFile = useRef(async (_file: File) => {});
  const slashPick = useRef((_index: number) => {});
  // Keeps the typed query in step with the text; leaving the "/…" word,
  // a line break or a query without any match closes the menu.
  const slashFollow = useRef((current: TiptapEditor) => {
    const menu = slashState.current;
    if (menu?.mode !== "inline") return;
    const { selection, doc: content } = current.state;
    const close = () => setSlash(null);
    if (!selection.empty || selection.from <= menu.from) return close();
    if (content.resolve(menu.from).parent !== selection.$from.parent)
      return close();
    const text = content.textBetween(menu.from, selection.from, "\n", "\ufffc");
    if (!text.startsWith("/") || /[\n\ufffc]/.test(text) || text.length > 40)
      return close();
    const query = text.slice(1);
    // "/ " is a plain slash: a space right after it closes the menu.
    if (/^\s/.test(query)) return close();
    if (query !== menu.query) {
      setSlash({ ...menu, query });
      setSlashActive(0);
    }
  });
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
        PlainNewLine,
        TaskList,
        FlowTaskItem.configure({ nested: true }),
        TaskDue,
        Suggestion,
        SuggestChanges.configure({
          enabled: () => suggestingRef.current,
          user: () => ({
            id: userId,
            name: memberNames.current.get(userId) || t("Jemand", "Someone"),
          }),
        }),
        BlockReactionAttribute,
        BlockReactions.configure({
          userId,
          names: () => memberNames.current,
        }),
        Table.configure({ resizable: true }),
        TableRow,
        TableCell,
        TableHeader,
        // Images are resized by their side handles, keeping proportions.
        Image.extend({
          addNodeView() {
            const render = this.parent?.();
            return render ? commentMarkedNodeView(render, "img") : null;
          },
        }).configure({
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
          placeholder: t("Schreibe etwas oder tippe / für Befehle …", "Write something or type / for commands …"),
        }),
        Highlight.configure({ multicolor: true }),
        TextColor,
        Superscript,
        Subscript,
        Spoiler,
        Indent,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Typography,
        Callout,
        Toggle,
        ...mathNodeViews(setMath),
        mermaidNodeView(setDiagram),
        Mention,
        Columns,
        Column,
        withPdfView(Media),
        LinkCard,
        linkedDatabaseNode(() => linkedContext.current),
        syncedBlockNode(() => syncedContext.current),
        whiteboardEmbedNode(),
        Collaboration.configure({ document: doc }),
        collaborationCursors({ pageId, rowId, generation }, liveId),
        inlineCommentExtension(generation),
      ],
      editorProps: {
        transformPasted: freshLinkedIds,
        attributes: {
          class: "document-editor",
          "aria-label": t("Dokumentinhalt", "Document content"),
        },
        // Images and files from the clipboard or dropped on the page are
        // uploaded and inserted where the caret is.
        handlePaste: (_view, event) => {
          const data = event.clipboardData;
          const files = [...(data?.files || [])];
          if (!editable || !files.length) return false;
          // Copied web content brings text along; then paste it as usual.
          if (data?.getData("text/plain").trim()) return false;
          event.preventDefault();
          for (const file of files) void uploadFile.current(file);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = [...(event.dataTransfer?.files || [])];
          if (!editable || moved || !files.length) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (at)
            view.dispatch(
              view.state.tr.setSelection(
                Selection.near(view.state.doc.resolve(at.pos)),
              ),
            );
          for (const file of files) void uploadFile.current(file);
          return true;
        },
        handleKeyDown: (_view, event) => {
          if (_view.state.selection.$from.parent.type.name === "codeBlock")
            return false;
          if (event.key === "@" && editable) {
            setReferences(true);
            return true;
          }
          const menu = slashState.current;
          if (menu?.mode === "inline") {
            const count = slashItems.current.length;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (count)
                setSlashActive(
                  (i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count,
                );
              return true;
            }
            if ((event.key === "Enter" || event.key === "Tab") && count) {
              slashPick.current(slashActiveRef.current);
              return true;
            }
            if (event.key === "Escape") {
              setSlash(null);
              return true;
            }
          }
          // The "/" stays in the text; what follows filters the menu.
          if (event.key === "/" && editable && _view.state.selection.empty) {
            setSlash({ from: _view.state.selection.from, mode: "inline", query: "" });
            setSlashActive(0);
          }
          return false;
        },
      },
      onBlur: () => {
        if (slashState.current?.mode === "inline") setSlash(null);
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
        slashFollow.current(editor);
      },
      onSelectionUpdate: ({ editor }) => {
        setTick((t) => t + 1);
        slashFollow.current(editor);
      },
      // Toggling a format without a selection only changes the marks for the
      // next character; the toolbar has to show that right away.
      onTransaction: ({ transaction }) => {
        if (!transaction.docChanged && !transaction.selectionSet)
          setTick((t) => t + 1);
      },
    },
    [doc],
  );
  // Changes of others, from the push channel or a save/poll answer.
  const applyRemote = useCallback(
    (state: string) => {
      Y.applyUpdate(doc, from64(state), "remote");
    },
    [doc, editor],
  );
  const sync = useCallback(async () => {
    if (!editor || !ready.current || inflight.current || !navigator.onLine)
      return;
    inflight.current = true;
    try {
      if (dirty.current && editable) {
        dirty.current = false;
        // Normally only the changes since the last save; the whole state
        // on the first save and after a failed one.
        const all = sendAll.current,
          sent = pending.current.length;
        const update = all
          ? Y.encodeStateAsUpdate(doc)
          : sent
            ? Y.mergeUpdates(pending.current)
            : null;
        if (update) {
          onStatus("Speichern …");
          const result = await api<{ state: string }>("/api/command", {
            action: rowId ? "row.document.sync" : "document.sync",
            rowId,
            pageId,
            generation,
            update: bytesTo64(update),
            vector: bytesTo64(Y.encodeStateVector(doc)),
            client: liveId,
            html: lastHtml.current,
          });
          pending.current.splice(0, sent);
          if (all) sendAll.current = false;
          applyRemote(result.state);
        }
        onStatus(dirty.current ? "Änderungen …" : "Gespeichert");
      } else {
        // With the live channel open, changes arrive by push; the full
        // check (new document version, missed updates) runs less often.
        if (live.current && Date.now() - lastPoll.current < 20_000) return;
        lastPoll.current = Date.now();
        const result = await api<{ state: string | null; generation: string }>(
          rowId ? `/api/pages/${pageId}/rows/${rowId}` : `/api/pages/${pageId}`,
        );
        // A restored or guest-edited document has a new CRDT identity. The parent
        // remounts this editor with that generation; merging it into this one duplicates content.
        if (result.generation !== generation) {
          onStatus("Neue Dokumentversion wird geladen …");
          return;
        }
        if (result.state) applyRemote(result.state);
      }
    } catch (e) {
      dirty.current = true;
      sendAll.current = true;
      // Server briefly away (e.g. restarting): the changes stay here and
      // go out with the next try, without an error message.
      const away = !navigator.onLine || isTransient(e);
      onStatus(
        !navigator.onLine
          ? "Offline gespeichert"
          : away
            ? "Verbindung unterbrochen – wird wiederholt …"
            : "Speichern fehlgeschlagen",
      );
      if (!away) onError((e as Error).message);
    } finally {
      inflight.current = false;
      // Typing went on during the request: send the rest right away.
      if (dirty.current && editable && navigator.onLine && !sendAll.current)
        saveSoon.current();
    }
  }, [doc, editor, editable, pageId, rowId, generation, liveId, applyRemote, onStatus, onError]);
  // Changes go out shortly after typing instead of on the next interval.
  const saveSoon = useRef(() => {});
  saveSoon.current = () => {
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      void sync();
    }, 80);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  // Push channel: changes and cursor moves of the others arrive at once.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const params = new URLSearchParams({ page: pageId, generation, client: liveId });
    if (rowId) params.set("row", rowId);
    const source = new EventSource(`/api/documents/live?${params}`);
    const key = `${pageId}:${rowId || ""}:${generation}`;
    source.onmessage = (event) => {
      let message: { type: string; update?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "revoked") {
        // Access ended: no reconnect; the next check reports it.
        live.current = false;
        source.close();
        lastPoll.current = 0;
      } else if (message.type === "ready") {
        live.current = true;
        // Anything missed while the channel was down comes with a full check.
        lastPoll.current = 0;
        void sync();
      } else if (message.type === "update" && message.update)
        applyRemote(message.update);
      else if (message.type === "check") {
        lastPoll.current = 0;
        void sync();
      } else if (message.type === "presence")
        window.dispatchEvent(new CustomEvent("flowplan:presence", { detail: key }));
    };
    source.onerror = () => {
      live.current = false;
    };
    return () => {
      live.current = false;
      source.close();
    };
  }, [doc, pageId, rowId, generation, liveId, sync, applyRemote]);
  useEffect(
    () =>
      registerDocumentFlush(async () => {
        if (!editable) return;
        if (!ready.current)
          throw new Error(t("Das Dokument wird noch geladen. Bitte kurz warten.", "The document is still loading. Please wait a moment."));
        if (!navigator.onLine)
          throw new Error(
            t("Zum Exportieren bitte die Verbindung wiederherstellen.", "Please restore the connection to export."),
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
            ? t("Synchronisieren …", "Syncing …")
            : "Gespeichert"
          : "Offline gespeichert",
      );
    });
    const update = (change: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === persistence || !editable) return;
      // Kept even before loading finished: the first save sends everything.
      pending.current.push(change);
      if (ready.current) {
        dirty.current = true;
        saveSoon.current();
      }
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
  uploadFile.current = (file: File) => upload(file);
  async function upload(original: File) {
    // Photos shrink before upload; the alt text keeps the original name.
    const file = await compressImage(original);
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
          .setImage({ src: data.url, alt: original.name })
          .run();
      else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name))
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "media",
            attrs: { src: data.url, kind: "pdf", title: file.name },
          })
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
  const commands: SlashItem[] = [
    {
      name: t("Text", "Text"),
      keywords: ["text", "p", "absatz", "paragraph"],
      description: t("Einfach losschreiben", "Just start writing"),
      icon: TextAlignLeft,
      run: () => editor?.chain().focus().setParagraph().run(),
    },
    {
      name: t("Überschrift 1", "Heading 1"),
      keywords: ["h1", "#", "titel", "heading1"],
      description: t("Große Überschrift", "Large heading"),
      icon: TextHOne,
      run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      name: t("Überschrift 2", "Heading 2"),
      keywords: ["h2", "##", "heading2"],
      description: t("Mittlere Überschrift", "Medium heading"),
      icon: TextHTwo,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      name: t("Überschrift 3", "Heading 3"),
      keywords: ["h3", "###", "heading3"],
      description: t("Kleine Überschrift", "Small heading"),
      icon: TextHThree,
      run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      name: t("Aufgabenliste", "Task list"),
      keywords: ["todo", "aufgabe", "task", "checkbox", "[]"],
      description: t("Schritt für Schritt abhaken", "Tick off step by step"),
      icon: CheckSquare,
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      name: t("Aufzählung", "Bulleted list"),
      keywords: ["ul", "liste", "bullet", "punkte", "-"],
      description: t("Eine Liste mit Punkten", "A list with bullets"),
      icon: ListBullets,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      name: t("Nummerierte Liste", "Numbered list"),
      keywords: ["ol", "1.", "nummer", "numbered"],
      description: t("Eine geordnete Liste", "An ordered list"),
      icon: ListNumbers,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      name: t("Zitat", "Quote"),
      keywords: ["quote", ">"],
      description: t("Einen Gedanken hervorheben", "Highlight a thought"),
      icon: Quotes,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      name: t("Hinweis", "Callout"),
      keywords: ["callout", "info", "note"],
      description: t("Wichtige Informationen", "Important information"),
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
                content: [{ type: "text", text: t("Gut zu wissen …", "Good to know …") }],
              },
            ],
          })
          .run(),
    },
    {
      name: t("Aufklappbarer Block", "Toggle"),
      keywords: ["toggle", "details", "aufklappen"],
      description: t("Details ein- und ausblenden", "Show and hide details"),
      icon: CaretRight,
      run: () => setToggle(true),
    },
    {
      name: "Code",
      keywords: ["codeblock", "```"],
      description: t("Codeblock einfügen", "Insert a code block"),
      icon: Code,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    {
      name: t("Tabelle", "Table"),
      keywords: ["table"],
      description: t("Zeilen und Spalten", "Rows and columns"),
      icon: TableIcon,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      name: t("Bild oder Datei", "Image or file"),
      keywords: ["bild", "image", "img", "datei", "file", "upload", "foto"],
      description: t("Datei vom Gerät hochladen", "Upload a file from your device"),
      icon: ImageIcon,
      run: () => uploadRef.current?.click(),
    },
    {
      name: t("Mermaid-Diagramm", "Mermaid diagram"),
      keywords: ["mermaid", "diagramm", "flowchart", "chart"],
      description: t("Abläufe, Sequenzen und Beziehungen", "Flows, sequences and relationships"),
      icon: Code,
      run: () => setDiagram({ source: DEFAULT_DIAGRAM }),
    },
    {
      name: t("Formel", "Formula"),
      keywords: ["math", "latex", "katex", "tex"],
      description: t("Mathematischer Ausdruck", "Mathematical expression"),
      icon: FunctionIcon,
      run: () => setMath({ type: "mathBlock", expression: "" }),
    },
    {
      name: t("Inline-Formel", "Inline formula"),
      keywords: ["inlinemath"],
      description: t("Mathematik direkt im Satz", "Math right inside a sentence"),
      icon: FunctionIcon,
      run: () => openInlineMath(),
    },
    {
      name: t("Seite oder Person erwähnen", "Mention a page or person"),
      keywords: ["mention", "link", "@", "seite", "person"],
      description: t("Mit @ Wissen verknüpfen", "Connect knowledge with @"),
      icon: LinkIcon,
      run: () => setReferences(true),
    },
    {
      name: t("Whiteboard", "Whiteboard"),
      keywords: ["board", "canvas"],
      description: t("Board anzeigen oder neu anlegen", "Show or create a board"),
      icon: PresentationChart,
      run: () => {
        setBoardSearch("");
        setBoardPicker(true);
      },
    },
    {
      name: t("Sprachnotiz", "Voice note"),
      keywords: ["audio", "aufnahme", "mikrofon", "diktat", "voice", "sprache"],
      description: transcription ? t("Aufnehmen und als Text einfügen", "Record and insert as text") : t("Aufnehmen und als Audio einfügen", "Record and insert as audio"),
      icon: Microphone,
      run: () => setVoice(true),
    },
    {
      name: t("Synchronisierter Block", "Synced block"),
      keywords: ["sync", "synced", "synchron", "wiederverwenden"],
      description: t("Inhalt, der auf mehreren Seiten gleich bleibt", "Content that stays the same on several pages"),
      icon: ArrowsClockwise,
      run: async () => {
        try {
          const created = await api<{ id: string }>("/api/command", {
            action: "synced.create",
            pageId,
          });
          insertSynced(created.id);
        } catch (error) {
          onError((error as Error).message);
        }
      },
    },
    {
      name: t("Synchronisierten Block einfügen", "Insert synced block"),
      keywords: ["sync", "synced", "einfuegen", "kopie"],
      description: t("Einen bestehenden synchronisierten Block zeigen", "Show an existing synced block"),
      icon: ArrowsClockwise,
      run: async () => {
        const host = pages.find((p) => p.id === pageId);
        try {
          const list = await api<{ blocks: { id: string; preview: string; origin: string }[] }>(
            `/api/synced?workspace=${host?.workspace_id || ""}`,
          );
          setSyncedPicker(list.blocks);
        } catch (error) {
          onError((error as Error).message);
        }
      },
    },
    {
      name: t("Verknüpfte Datenbank", "Linked database"),
      keywords: ["datenbank", "db", "database", "linked"],
      description: t("Bestehende Einträge mit eigener Ansicht", "Existing records with a view of their own"),
      icon: TableIcon,
      run: () => {
        setLinkedSearch("");
        setLinkedPicker(true);
      },
    },
    {
      name: t("Zwei Spalten", "Two columns"),
      keywords: ["spalten", "columns", "cols"],
      description: t("Inhalte nebeneinander", "Content side by side"),
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
      name: t("Einbetten", "Embed"),
      keywords: ["embed", "youtube", "video", "figma", "loom"],
      description: t("YouTube, Vimeo, Loom, Spotify, Figma oder CodePen", "YouTube, Vimeo, Loom, Spotify, Figma or CodePen"),
      icon: ImageIcon,
      run: () => setEmbed(true),
    },
    {
      name: t("Spoiler", "Spoiler"),
      keywords: ["verdecken", "versteckt", "hide", "geheim"],
      description: t("Text verdecken, bis jemand darauf klickt", "Hide text until someone clicks it"),
      icon: EyeSlash,
      run: () => editor?.chain().focus().toggleMark("spoiler").run(),
    },
    {
      name: t("Trennlinie", "Divider"),
      keywords: ["hr", "divider", "linie", "---"],
      description: t("Inhalte voneinander trennen", "Separate content"),
      icon: Minus,
      run: () => editor?.chain().focus().setHorizontalRule().run(),
    },
  ];
  const slashMatches = slash ? rankCommands(commands, slash.query) : [];
  slashItems.current = slashMatches;
  // Runs a block command; typed "/…" text is removed first.
  slashPick.current = (index: number) => {
    const list = slashItems.current,
      item = list[Math.min(index, list.length - 1)],
      menu = slashState.current;
    if (!item || !menu) return;
    setSlash(null);
    if (menu.mode === "inline" && editor) {
      const to = editor.state.selection.from;
      if (to > menu.from)
        editor.chain().focus().deleteRange({ from: menu.from, to }).run();
    } else editor?.commands.focus();
    item.run();
  };
  // A typed query that matches nothing closes the menu ("und/oder").
  useEffect(() => {
    if (slash?.mode === "inline" && slash.query && !slashMatches.length)
      setSlash(null);
  }, [slash, slashMatches.length]);
  // The menu stays next to the text while the page scrolls.
  useEffect(() => {
    if (!slash) return;
    const follow = () => setTick((t) => t + 1);
    window.addEventListener("scroll", follow, true);
    return () => window.removeEventListener("scroll", follow, true);
  }, [slash]);
  let slashAnchor: { left: number; top: number; bottom: number } | null =
    null;
  if (slash && editor && !editor.isDestroyed)
    try {
      slashAnchor = editor.view.coordsAtPos(
        Math.min(slash.from, editor.state.doc.content.size),
      );
    } catch {}
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
  // The toolbar follows the selection for the width of videos and embeds.
  const selectedMediaWidth = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current?.isActive("media")
        ? Number(current.getAttributes("media").width || 100)
        : null,
  });
  const headings: { text: string; pos: number; level: number }[] = [];
  editor?.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading")
      headings.push({ text: node.textContent, pos, level: node.attrs.level });
  });
  return (
    <div className={`editor-wrapper${embedded ? " embedded" : ""}`}>
      <div className={`document-writing-surface${suggesting && editable ? " suggesting" : ""}`}>
        {editable && !embedded && (
          <div
            className="editor-toolbar"
            role="toolbar"
            aria-label={t("Textformatierung", "Text formatting")}
            // Buttons keep the caret and selection in the text; fields and
            // pickers still take focus.
            onMouseDown={(event) => {
              if ((event.target as HTMLElement).closest("button"))
                event.preventDefault();
            }}
          >
            <button
              title={t("Rückgängig", "Undo")}
              onClick={() => editor?.chain().focus().undo().run()}
            >
              <ArrowUUpLeft />
            </button>
            <button
              title={t("Wiederholen", "Redo")}
              onClick={() => editor?.chain().focus().redo().run()}
            >
              <ArrowUUpRight />
            </button>
            <span className="toolbar-separator" />
            <button
              title={t("Fett", "Bold")}
              className={editor?.isActive("bold") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <TextB />
            </button>
            <button
              title={t("Kursiv", "Italic")}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <TextItalic />
            </button>
            <button
              title={t("Unterstrichen", "Underline")}
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
            >
              <TextUnderline />
            </button>
            <button
              title={t("Durchgestrichen", "Strikethrough")}
              onClick={() => editor?.chain().focus().toggleStrike().run()}
            >
              <TextStrikethrough />
            </button>
            <button
              title={t("Markieren", "Highlight")}
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
                <button title={t("Farbe", "Colour")} aria-label={t("Text- und Hintergrundfarbe", "Text and background colour")}>
                  <Palette />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content
                  className="dropdown color-menu"
                  sideOffset={6}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <div className="color-menu-label">{t("Textfarbe", "Text colour")}</div>
                  <div className="color-swatches">
                    {textColors.map(([name, color]) => (
                      <Dropdown.Item
                        key={color}
                        className="color-swatch"
                        aria-label={t(`Textfarbe ${name}`, `Text colour ${name}`)}
                        title={name}
                        style={{ color }}
                        onSelect={() => colorChain()?.setTextColor(color).run()}
                      >
                        A
                      </Dropdown.Item>
                    ))}
                  </div>
                  <div className="color-menu-label">{t("Hintergrund", "Background")}</div>
                  <div className="color-swatches">
                    {highlightColors.map(([name, color]) => (
                      <Dropdown.Item
                        key={color}
                        className="color-swatch"
                        aria-label={t(`Hintergrund ${name}`, `Background ${name}`)}
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
                    {t("Farben entfernen", "Remove colours")}
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
            {editor && selectedMediaWidth !== null && (
              <Select
                aria-label={t("Medienbreite", "Media width")}
                title={t("Breite des Videos oder der Einbettung", "Width of the video or embed")}
                value={String(selectedMediaWidth)}
                onChange={(e) =>
                  editor
                    .chain()
                    .focus()
                    .updateAttributes("media", {
                      width: Number(e.target.value),
                    })
                    .run()
                }
              >
                {MEDIA_WIDTHS.map((w) => (
                  <option key={w} value={w}>
                    {w} %
                  </option>
                ))}
              </Select>
            )}
            <button
              title={t("Hochgestellt", "Superscript")}
              className={editor?.isActive("superscript") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleSuperscript().run()}
            >
              <TextSuperscript />
            </button>
            <button
              title={t("Tiefgestellt", "Subscript")}
              className={editor?.isActive("subscript") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleSubscript().run()}
            >
              <TextSubscript />
            </button>
            <button
              title={t("Verdecken (Spoiler) · ⌘⌥H", "Hide (spoiler) · ⌘⌥H")}
              aria-pressed={!!editor?.isActive("spoiler")}
              className={editor?.isActive("spoiler") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleMark("spoiler").run()}
            >
              <EyeSlash />
            </button>
            <button
              title={suggesting ? t("Vorschlagen beenden – wieder direkt bearbeiten", "Stop suggesting – edit directly again") : t("Vorschlagen: Änderungen als Vorschläge markieren", "Suggest: mark changes as suggestions")}
              aria-label={t("Vorschlagen", "Suggest")}
              aria-pressed={suggesting}
              className={`suggest-toggle${suggesting ? " active" : ""}`}
              onClick={() => setSuggesting(!suggesting)}
            >
              <PencilLine />
              {suggesting && <span>{t("Vorschlagen", "Suggest")}</span>}
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
              title={t("Überschrift", "Heading")}
              onClick={() =>
                editor?.chain().focus().toggleHeading({ level: 2 }).run()
              }
            >
              <TextHTwo />
            </button>
            <button
              title={t("Aufgabenliste", "Task list")}
              onClick={() => editor?.chain().focus().toggleTaskList().run()}
            >
              <CheckSquare />
            </button>
            {editor?.isActive("taskItem") && (
              <button
                title={t("Fälligkeit setzen", "Set due date")}
                aria-label={t("Fälligkeit setzen", "Set due date")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => editor && pickTaskDue(editor.view, e.currentTarget)}
              >
                <CalendarBlank />
              </button>
            )}
            <button
              title={t("Zentrieren", "Centre")}
              onClick={() =>
                editor?.chain().focus().setTextAlign("center").run()
              }
            >
              <TextAlignCenter />
            </button>
            <button title={t("Block nach oben", "Move block up")} onClick={() => moveBlock(-1)}>
              ↑
            </button>
            <button title={t("Block nach unten", "Move block down")} onClick={() => moveBlock(1)}>
              ↓
            </button>
            <button
              title={t("Inhaltsverzeichnis", "Table of contents")}
              onClick={() => setOutline(!outline)}
            >
              <ListBullets />
            </button>
            <button title={t("Inline-Formel", "Inline formula")} onClick={openInlineMath}>
              <FunctionIcon />
            </button>
            <button
              title={t("Block hinzufügen", "Add block")}
              onClick={() => {
                if (!editor) return;
                setSlash({
                  from: editor.state.selection.from,
                  mode: "button",
                  query: "",
                });
                setSlashActive(0);
              }}
            >
              <Plus />
            </button>
          </div>
        )}
        {(() => {
          if (!editor || embedded) return null;
          const groups = suggestionGroups(editor.state.doc);
          if (!groups.length) return null;
          const ids = new Set(groups.map((g) => g.id));
          const apply = (accept: boolean, test: (a: { id: string; kind: string }) => boolean) =>
            editor.view.dispatch(resolveSuggestions(editor.state, accept, test));
          return (
            <div className="suggestion-bar" role="region" aria-label={t("Vorschläge", "Suggestions")}>
              <button type="button" className="suggestion-count" aria-expanded={suggestionList} onClick={() => setSuggestionList(!suggestionList)}>
                <PencilLine size={15} />
                {ids.size} {ids.size === 1 ? t("Vorschlag", "Suggestion") : t("Vorschläge", "Suggestions")}
              </button>
              {editable && (
                <>
                  <button type="button" className="text-button" onClick={() => apply(true, () => true)}>
                    {t("Alle annehmen", "Accept all")}
                  </button>
                  <button type="button" className="text-button" onClick={() => apply(false, () => true)}>
                    {t("Alle ablehnen", "Reject all")}
                  </button>
                </>
              )}
              {suggestionList && (
                <ul className="suggestion-list">
                  {groups.map((g) => (
                    <li key={`${g.id}:${g.kind}`} className={`suggestion-item ${g.kind}`}>
                      <button
                        type="button"
                        className="suggestion-jump"
                        onClick={() => {
                          editor.chain().focus().setTextSelection(g.from).run();
                          const node = editor.view.domAtPos(g.from).node as HTMLElement;
                          (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({ block: "center" });
                        }}
                      >
                        <strong>{g.name || t("Jemand", "Someone")}</strong>
                        <span>{g.kind === "insert" ? t("fügt ein", "inserts") : t("löscht", "deletes")}</span>
                        <q>{g.text.length > 80 ? `${g.text.slice(0, 78)}…` : g.text}</q>
                      </button>
                      {editable && (
                        <span className="suggestion-actions">
                          <button type="button" aria-label={t("Annehmen", "Accept")} title={t("Annehmen", "Accept")} onClick={() => apply(true, (a) => a.id === g.id)}>
                            <Check size={15} />
                          </button>
                          <button type="button" aria-label={t("Ablehnen", "Reject")} title={t("Ablehnen", "Reject")} onClick={() => apply(false, (a) => a.id === g.id)}>
                            <X size={15} />
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
        {outline && (
          <nav className="document-outline" aria-label={t("Inhaltsverzeichnis", "Table of contents")}>
            <strong>{t("Inhalt", "Content")}</strong>
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
                {h.text || t("Überschrift", "Heading")}
              </button>
            ))}
          </nav>
        )}
        {embedded ? (
          <EditorContent editor={editor} />
        ) : (
          <DocumentBlockControls editor={editor}>
            <EditorContent editor={editor} />
          </DocumentBlockControls>
        )}
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
              {t("Zeile löschen", "Delete row")}
            </button>
            <button onClick={() => editor.chain().focus().deleteColumn().run()}>
              {t("Spalte löschen", "Delete column")}
            </button>
          </div>
        )}
      </div>
      {!embedded && (
      <InlineComments
        editor={editor}
        pageId={pageId}
        rowId={rowId}
        generation={generation}
        userId={userId}
      />
      )}
      <input
        ref={uploadRef}
        type="file"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0]);
          e.target.value = "";
        }}
      />
      {slash && slashAnchor && (
        <SlashMenu
          items={slashMatches}
          active={Math.min(slashActive, Math.max(0, slashMatches.length - 1))}
          anchor={slashAnchor}
          search={slash.mode === "button" ? slash.query : undefined}
          onSearch={(query) => {
            setSlash({ ...slash, query });
            setSlashActive(0);
          }}
          onKey={(event) => {
            const count = slashMatches.length;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (count)
                setSlashActive(
                  (i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count,
                );
            } else if (event.key === "Enter" && count) {
              event.preventDefault();
              slashPick.current(slashActive);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setSlash(null);
              editor?.commands.focus();
            }
          }}
          onPick={(index) => slashPick.current(index)}
          onHover={setSlashActive}
          onClose={() => setSlash(null)}
          container={
            editor?.view.dom.closest<HTMLElement>('[role="dialog"]') || null
          }
        />
      )}
      {!embedded && (
        <TextMenu
          editor={editor}
          userId={userId}
          editable={editable}
          onLink={() => {
            setLinkUrl(editor?.getAttributes("link").href || "");
            setLink(true);
          }}
        />
      )}
      <VoiceRecorder
        open={voice}
        transcription={transcription}
        onClose={() => setVoice(false)}
        onInsert={async (file, toText) => {
          setVoice(false);
          await upload(file);
          if (!toText) return;
          onStatus("Sprachnotiz wird in Text umgewandelt …");
          try {
            const form = new FormData();
            form.set("pageId", pageId);
            form.set("file", file);
            const response = await fetch("/api/transcribe", { method: "POST", body: form });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            const paragraphs = String(data.text || "")
              .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/)
              .map((p) => p.trim())
              .filter(Boolean);
            if (paragraphs.length)
              editor
                ?.chain()
                .focus()
                .insertContent(paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })))
                .run();
            else onError(t("In der Aufnahme wurde keine Sprache erkannt.", "No speech was recognised in the recording."));
          } catch (error) {
            onError((error as Error).message);
          } finally {
            onStatus("Gespeichert");
          }
        }}
      />
      <Modal
        open={!!syncedPicker}
        title={t("Synchronisierten Block einfügen", "Insert synced block")}
        onClose={() => setSyncedPicker(null)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
      >
        <div className="linked-source-list">
          {syncedPicker?.length ? (
            syncedPicker.map((block) => (
              <button key={block.id} className="synced-choice" onClick={() => insertSynced(block.id)}>
                <strong>{block.preview}</strong>
                {block.origin && <small>{t("aus „", "from “")}{block.origin}“</small>}
              </button>
            ))
          ) : (
            <p className="muted">
              {t("Noch keine synchronisierten Blöcke. Lege mit /sync einen an.", "No synced blocks yet. Create one with /sync.")}
            </p>
          )}
        </div>
      </Modal>
      <Modal
        open={boardPicker}
        title={t("Whiteboard einbetten", "Embed whiteboard")}
        onClose={() => setBoardPicker(false)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
      >
        <input
          aria-label={t("Whiteboard suchen", "Search whiteboard")}
          autoFocus
          value={boardSearch}
          onChange={(event) => setBoardSearch(event.target.value)}
          placeholder={t("Whiteboard suchen …", "Search whiteboards …")}
        />
        <div className="linked-source-list">
          <button
            className="button primary"
            onClick={async () => {
              const host = pages.find((p) => p.id === pageId);
              if (!host) return;
              try {
                const created = await api<{ id: string }>("/api/command", {
                  action: "page.create",
                  workspaceId: host.workspace_id,
                  spaceId: host.space_id,
                  ...(rowId ? {} : { parentId: host.id }),
                  title: boardSearch.trim() || t("Whiteboard", "Whiteboard"),
                  kind: "whiteboard",
                });
                insertBoard(created.id);
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            {t("Neues Whiteboard anlegen", "Create new whiteboard")}
          </button>
          {pages
            .filter(
              (p) =>
                p.kind === "whiteboard" &&
                !p.deleted_at &&
                p.title.toLowerCase().includes(boardSearch.toLowerCase()),
            )
            .map((board) => (
              <button
                className="button"
                key={board.id}
                onClick={() => insertBoard(board.id)}
              >
                {board.title}
              </button>
            ))}
        </div>
      </Modal>
      <Modal
        open={linkedPicker}
        title={t("Datenbank verknüpfen", "Link database")}
        onClose={() => {
          if (!linking) setLinkedPicker(false);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
      >
        <p>
          {t("Einträge bleiben in der Quelldatenbank. Filter und Darstellung gelten nur für diese Einbettung.", "Records stay in the source database. Filters and layout only apply to this embed.")}
        </p>
        <input
          aria-label={t("Datenquelle suchen", "Search data source")}
          autoFocus
          value={linkedSearch}
          onChange={(event) => setLinkedSearch(event.target.value)}
          placeholder={t("Datenbank suchen …", "Search databases …")}
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
          ) && <p className="muted">{t("Keine passende Datenbank.", "No matching database.")}</p>}
        </div>
      </Modal>
      <Modal open={link} onClose={() => setLink(false)} title={t("Link einfügen", "Insert link")}>
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
            } else onError(t("Bitte eine gültige URL eingeben.", "Please enter a valid URL."));
          }}
        >
          <label>
            {t("Adresse", "Address")}
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
              {t("Link entfernen", "Remove link")}
            </button>
            <button className="button primary">{t("Einfügen", "Insert")}</button>
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
        title={t("Seite oder Person erwähnen", "Mention a page or person")}
      >
        <div className="reference-list">
          <h3>{t("Seiten", "Pages")}</h3>
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
          <h3>{t("Personen", "People")}</h3>
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
        title={t("Inhalt einbetten", "Embed content")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const known = embedFromUrl(embedUrl);
              // Other pages are resolved on the server: player or link card.
              const resolved = known
                ? ({ kind: "player", ...known } as const)
                : await api<
                    | { kind: "player"; src: string; provider: string }
                    | {
                        kind: "card";
                        url: string;
                        title: string;
                        provider: string;
                        description: string;
                        image: string;
                      }
                  >(`/api/embed?url=${encodeURIComponent(embedUrl)}`);
              if (resolved.kind === "card") {
                const { kind: _kind, ...card } = resolved;
                const selection = editor?.state.selection;
                const node = { type: "linkCard", attrs: card };
                if (selection instanceof NodeSelection)
                  editor
                    ?.chain()
                    .focus()
                    .insertContentAt(selection.to, node)
                    .run();
                else editor?.chain().focus().insertContent(node).run();
                setEmbed(false);
                return;
              }
              const embedded = {
                src: resolved.src,
                provider: resolved.provider,
              };
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
            {t("Link (YouTube, Vimeo, Loom, Spotify, Figma, CodePen oder jede andere Seite als Vorschaukarte)", "Link (YouTube, Vimeo, Loom, Spotify, Figma, CodePen or any other page as a preview card)")}
            <input
              autoFocus
              type="url"
              value={embedUrl}
              onChange={(e) => setEmbedUrl(e.target.value)}
            />
          </label>
          <button className="button primary">{t("Einbetten", "Embed")}</button>
        </form>
      </Modal>
      <Modal
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
        open={toggle}
        onClose={() => setToggle(false)}
        title={t("Aufklappbarer Block", "Toggle")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            editor
              ?.chain()
              .focus()
              .insertContent({
                type: "toggle",
                attrs: { title: toggleTitle || t("Details", "Details") },
                content: [{ type: "paragraph" }],
              })
              .run();
            setToggle(false);
          }}
        >
          <label>
            {t("Titel", "Title")}
            <input
              autoFocus
              value={toggleTitle}
              onChange={(e) => setToggleTitle(e.target.value)}
            />
          </label>
          <button className="button primary">{t("Einfügen", "Insert")}</button>
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
