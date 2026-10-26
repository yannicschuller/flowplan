"use client";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { safeCollisionPadding } from "./safe-area";
import { matchedAlias, pageAliases } from "@/lib/aliases";
import { DocumentOutline, OutlineToggle, useOutlineOpen } from "./document-outline";
import { chatTextToHtml, looksLikeChatText, mathFromPastedHtml } from "@/lib/chat-paste";
import { serverMessage } from "@/lib/i18n-errors";
import { reveal } from "@/lib/motion";
import { nativeScan, nativeScanAvailable } from "@/lib/native-app";
import { useLocale, useT } from "./i18n";
import { TaskDue, pickTaskDue } from "@/lib/task-due-plugin";
import { CalcHint, calcHintShown } from "@/lib/calc-hint-plugin";
import { ImageAnnotator, type AnnotationResult } from "./image-annotator";
import { FunctionPlotView } from "./function-plot-view";
import { MetricView } from "./metric-view";
import { TicketRefs } from "@/lib/ticket-ref-plugin";
import {
  resolveSuggestions,
  suggestionGroups,
  Suggestion,
  SuggestChanges,
} from "@/lib/suggestions";
import { syncedBlockNode, type SyncedContext } from "./synced-block";
import { VoiceRecorder } from "./voice-recorder";
import { TextMenu } from "./text-menu";
import { AiWriter, blocksFromHtml, type AiWriterRequest } from "./ai-writer";
import { useAi, useAiAvailability, useAiBlockedHint } from "./ai-context";
import { AiActionsPanel, type AiActionsRequest } from "./ai-actions";
import { transcribeRecording } from "@/lib/transcribe-client";
import { transcriptHtml, transcriptText } from "@/lib/transcript";
import { canRecordInApp, recordInApp } from "@/lib/native-voice";
import type { Transcript } from "@/lib/transcribe";
import { aiTargetPlugin } from "@/lib/ai/target";
import { aiInsertedPlugin, aiInsertTransaction, aiMarkdownToHtml } from "@/lib/ai/insert";
import { registerAiInserter } from "@/lib/ai/editor-bridge";
import { BlockReactionAttribute, BlockReactions } from "@/lib/block-reactions";
import { whiteboardEmbedNode } from "./whiteboard/embed";
import { drawBlockNode } from "./ink/draw-block";
import { newDrawBlockId } from "@/lib/draw-block-node";
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
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Collaboration from "@tiptap/extension-collaboration";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { SlashMenu, type SlashItem } from "./slash-menu";
import { readSlashRecents, rememberSlashCommand, slashSections, type SlashSection } from "@/lib/slash-commands";
import type { SaveStatus } from "@/lib/save-status";
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
  Rows,
  ListBullets,
  ListNumbers,
  Books,
  CheckSquare,
  Quotes,
  Code,
  Image as ImageIcon,
  Table as TableIcon,
  PresentationChart,
  Scribble,
  ArrowUUpLeft,
  ArrowUUpRight,
  TextHOne,
  TextHTwo,
  TextHThree,
  Minus,
  Paperclip,
  Plus,
  Info,
  ChatCenteredText,
  WarningOctagon,
  Warning,
  Lightbulb,
  CaretRight,
  Function as FunctionIcon,
  TextAlignLeft,
  TextAlignCenter,
  ArrowsClockwise,
  Microphone,
  Scan,
  PencilLine,
  Check,
  X,
  CalendarBlank,
  PencilSimpleLine,
  ChartLine,
  UsersThree,
  Note,
  Sparkle,
  PuzzlePiece,
} from "@phosphor-icons/react";
import { PluginBlockView, pagePlugins, type PluginInfo } from "./plugin-block";
import { api, isTransient, Modal } from "./ui";
import { calloutDescriptions, calloutLabels } from "@/lib/callout-types";
import { pageLocationHash } from "@/lib/page-location";
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
  CALLOUT_TYPES,
  AnnotatedImage,
} from "@/lib/document-schema";
import { compressImage } from "@/lib/image-compress";
import { primePlaceholder } from "./image-placeholder";
import { imagePlaceholderView } from "./image-placeholder-view";
import { boardFileName } from "@/lib/whiteboard-import";
import { Authorship, authorshipKey, type AuthorShares } from "@/lib/authorship-plugin";
import { authorColor } from "@/lib/authorship";
import { BibliographyView, CitationView } from "./citation-views";
import { CitationDialog } from "./citation-dialog";
import { Footnote, footnoteText, MAX_FOOTNOTE, type FootnoteEdit } from "@/lib/footnotes";
import { BlockDirectionExtension } from "@/lib/text-direction";
import { ListTidy } from "@/lib/list-tidy";
import { MarkdownSourceView } from "./markdown-source";
import { idempotencyHeaders } from "@/lib/idempotency-key";
// The symbol a plugin's manifest names for a block type, as a menu icon.
function emojiIcon(symbol: string) {
  function Icon({ size = 18 }: { size?: number }) {
    return (
      <span className="plugin-slash-icon" style={{ fontSize: Math.round(size * 0.9) }} aria-hidden="true">
        {symbol}
      </span>
    );
  }
  return Icon;
}
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
  source = false,
  sourceNotice,
  onSourceClose,
}: {
  // "Als Markdown bearbeiten": the page as Markdown instead of the editor.
  source?: boolean;
  // Why the source can only be read (locked page …), if so.
  sourceNotice?: string;
  onSourceClose?: () => void;
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
  // Saving state as a key (lib/save-status.ts), put into words where shown.
  onStatus: (v: SaveStatus) => void;
  onError: (v: string) => void;
  onHtml: (v: string) => void;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const locale = useLocale();
  // The text the page came with shows at once (also a kept copy, see
  // lib/swr-cache.ts); the device's stored changes and the server's newer
  // ones merge into it as they arrive (applying a state twice is harmless).
  const doc = useMemo(() => {
    const created = new Y.Doc();
    try {
      if (state) Y.applyUpdate(created, from64(state), "remote");
    } catch {}
    return created;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, rowId]);
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
  // with its own search field). `from` is where the "/" sits; `sub` is the
  // entry whose second level (the callout kinds) is open.
  const [slash, setSlash] = useState<{
      from: number;
      mode: "inline" | "button";
      query: string;
      sub?: string | null;
    } | null>(null),
    [slashActive, setSlashActive] = useState(0),
    // Recently used blocks of this browser, shown first in the menu.
    [slashRecents, setSlashRecents] = useState<string[]>([]),
    [link, setLink] = useState(false),
    [linkUrl, setLinkUrl] = useState(""),
    [diagram, setDiagram] = useState<DiagramTarget | null>(null),
    [math, setMath] = useState<MathTarget | null>(null),
    // The image being marked up (position and its attributes).
    [annotate, setAnnotate] = useState<{ pos: number; src: string; original: string | null; annotations: string | null } | null>(null),
    [toggle, setToggle] = useState(false),
    // The note being written: an existing one (pos) or a new one at `at`.
    [footnote, setFootnote] = useState<{ pos: number | null; note: string; at: number; original: string } | null>(null),
    [toggleTitle, setToggleTitle] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const [outline, setOutline] = useOutlineOpen();
  const [tick, setTick] = useState(0);
  const [references, setReferences] = useState(false),
    [referenceQuery, setReferenceQuery] = useState(""),
    [embed, setEmbed] = useState(false),
    [embedUrl, setEmbedUrl] = useState("");
  const [boardPicker, setBoardPicker] = useState(false),
    [boardSearch, setBoardSearch] = useState("");
  const [voice, setVoice] = useState(false);
  const [citeOpen, setCiteOpen] = useState(false);
  // "Autoren anzeigen": who wrote what, as colours (lib/authorship.ts).
  const [authorsOn, setAuthorsOn] = useState(false),
    [authorPeople, setAuthorPeople] = useState<Record<string, string>>({}),
    [authorShares, setAuthorShares] = useState<AuthorShares["shares"]>([]);
  const authorFetch = useRef({ at: 0, unknown: "" });
  const authorSharesRef = useRef((_result: AuthorShares) => {});
  // The writing assistant (components/ai-writer.tsx): its panel and what it
  // works on. Hidden without the feature, disabled on pages the AI may not
  // read.
  const [aiRequest, setAiRequest] = useState<AiWriterRequest | null>(null);
  const aiWrite = useAiAvailability("write", pageId);
  const aiSummarize = useAiAvailability("summarize", pageId);
  // Tasks and summary from a meeting transcript (components/ai-actions.tsx).
  const aiActions = useAiAvailability("actions", pageId);
  const aiWorkspace = useAi().workspaceId;
  const [transcriptActions, setTranscriptActions] = useState<AiActionsRequest | null>(null);
  const aiBlockedHint = useAiBlockedHint();
  const aiWriteRef = useRef(aiWrite);
  aiWriteRef.current = aiWrite;
  // ⌘J, the text menu and /ki: the selection, else the current line, else
  // (an empty line) a free prompt.
  const openAi = useRef((_prompt?: boolean) => {});
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
  const openFootnote = useRef((_target: FootnoteEdit) => {});
  const slashState = useRef(slash);
  slashState.current = slash;
  const slashActiveRef = useRef(slashActive);
  slashActiveRef.current = slashActive;
  const slashItems = useRef<SlashItem[]>([]);
  // Block extensions of the workspace (lib/plugins.ts) for the block menu.
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => {
    if (!editable || !pageId) return;
    let live = true;
    void pagePlugins(pageId).then((list) => live && setPlugins(list));
    return () => {
      live = false;
    };
  }, [pageId, editable]);
  const pluginCommands = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.blocks.map((block) => ({
          plugin,
          block,
          icon: block.icon && !/[a-z0-9]/i.test(block.icon) ? emojiIcon(block.icon) : PuzzlePiece,
        })),
      ),
    [plugins],
  );
  const uploadFile = useRef(async (_file: File) => {});
  const slashPick = useRef((_index: number) => {});
  const slashBack = useRef(() => {});
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
      // Typing on leaves a second level: the matches cover every entry.
      setSlash({ ...menu, query, sub: null });
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
        ListTidy,
        TaskDue,
        CalcHint.configure({ locale }),
        TicketRefs.configure({ pageId }),
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
        // Uploaded images show their blurred placeholder while they load.
        AnnotatedImage.extend({
          addNodeView() {
            const render = this.parent?.();
            return imagePlaceholderView(render ? commentMarkedNodeView(render, "img") : null);
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
        FunctionPlotView,
        MetricView.configure({ pageId }),
        PluginBlockView.configure({ pageId, title: () => linkedContext.current?.pages.find((p) => p.id === pageId)?.title || "" }),
        Mention,
        Columns,
        Column,
        withPdfView(Media),
        LinkCard,
        linkedDatabaseNode(() => linkedContext.current),
        syncedBlockNode(() => syncedContext.current),
        whiteboardEmbedNode(),
        // Handwriting; the ink is stored per page (not in record documents).
        drawBlockNode({ pageId, enabled: !rowId }),
        Footnote.configure({ edit: (target) => openFootnote.current(target) }),
        BlockDirectionExtension.configure({ auto: true }),
        Collaboration.configure({ document: doc }),
        collaborationCursors({ pageId, rowId, generation }, liveId),
        inlineCommentExtension(generation),
        CitationView,
        BibliographyView,
        Authorship.configure({ onShares: (result) => authorSharesRef.current(result) }),
        // Marks the text the writing assistant works on (lib/ai/target.ts) and
        // briefly what it inserted (lib/ai/insert.ts).
        Extension.create({ name: "aiTarget", addProseMirrorPlugins: () => [aiTargetPlugin, aiInsertedPlugin] }),
      ],
      editorProps: {
        transformPasted: freshLinkedIds,
        // Formulas rendered with KaTeX on copied pages come back as LaTeX.
        transformPastedHTML: mathFromPastedHtml,
        attributes: {
          class: "document-editor",
          "aria-label": t("Dokumentinhalt", "Document content"),
        },
        // Images and files from the clipboard or dropped on the page are
        // uploaded and inserted where the caret is.
        handlePaste: (_view, event) => {
          const data = event.clipboardData;
          const files = [...(data?.files || [])];
          // Answers copied from ChatGPT & co. as text: formulas, lists and
          // tables formatted (rich HTML from a page goes the usual way).
          const plain = data?.getData("text/plain") || "";
          const rich = data?.getData("text/html") || "";
          if (
            editable &&
            !files.length &&
            plain &&
            !/<(p|li|table|h[1-6]|div|br)[\s>]|katex|<math/i.test(rich) &&
            _view.state.selection.$from.parent.type.name !== "codeBlock" &&
            looksLikeChatText(plain)
          ) {
            event.preventDefault();
            _view.pasteHTML(chatTextToHtml(plain));
            return true;
          }
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
        // Double-clicking a photo opens it for marking up.
        handleDoubleClickOn: (_view, pos, node) => {
          if (!editable || node.type.name !== "image") return false;
          setAnnotate({ pos, src: node.attrs.src, original: node.attrs.original, annotations: node.attrs.annotations });
          return true;
        },
        handleKeyDown: (_view, event) => {
          // ⌘J / Ctrl+J: the writing assistant for the selection or line.
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "j" &&
            editable &&
            aiWriteRef.current !== "hidden"
          ) {
            event.preventDefault();
            openAi.current();
            return true;
          }
          if (_view.state.selection.$from.parent.type.name === "codeBlock")
            return false;
          // Tab and Escape belong to a visible calculation hint ("3/4 =" also
          // opened the slash menu with its "/").
          if ((event.key === "Tab" || event.key === "Escape") && calcHintShown(_view.state)) {
            setSlash(null);
            return false;
          }
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
            // Right opens an entry's second level, Left returns from it.
            if (event.key === "ArrowRight" && !menu.sub && slashItems.current[slashActiveRef.current]?.children) {
              slashPick.current(slashActiveRef.current);
              return true;
            }
            if (event.key === "ArrowLeft" && menu.sub) {
              slashBack.current();
              return true;
            }
            // Escape closes the menu; the caret and the typed text stay.
            if (event.key === "Escape") {
              setSlash(null);
              return true;
            }
          }
          // The "/" stays in the text; what follows filters the menu.
          if (event.key === "/" && editable && _view.state.selection.empty) {
            setSlash({ from: _view.state.selection.from, mode: "inline", query: "" });
            setSlashActive(0);
            setSlashRecents(readSlashRecents());
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
          onStatus(navigator.onLine ? "unsaved" : "saved-offline");
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
  // Who wrote what: the people behind the sessions, from the server (only
  // for people who may read the page); this session counts as oneself.
  const loadAuthors = useCallback(async () => {
    if (!editor || editor.isDestroyed) return;
    authorFetch.current.at = Date.now();
    const params = new URLSearchParams({ page: pageId });
    if (rowId) params.set("row", rowId);
    const response = await fetch(`/api/document-authors?${params}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(serverMessage(data.error) || t("Autoren konnten nicht geladen werden.", "Authors could not be loaded."));
    const names: Record<string, string> = Object.fromEntries(
      (data.people as { id: string; name: string }[]).map((p) => [p.id, p.name]),
    );
    names[userId] ||= memberNames.current.get(userId) || t("Du", "You");
    setAuthorPeople(names);
    if (editor.isDestroyed) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(authorshipKey, {
        info: {
          clients: data.clients,
          self: { client: doc.clientID, userId },
          names,
          earlier: t("Früher geschrieben (vor der Aufzeichnung)", "Written earlier (before tracking)"),
        },
      }),
    );
  }, [editor, pageId, rowId, userId, doc]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!authorsOn) {
      if (authorshipKey.getState(editor.state)?.info)
        editor.view.dispatch(editor.state.tr.setMeta(authorshipKey, { info: null }));
      setAuthorShares([]);
      return;
    }
    loadAuthors().catch((e) => {
      setAuthorsOn(false);
      onError((e as Error).message);
    });
  }, [authorsOn, editor, loadAuthors]);
  authorSharesRef.current = ({ shares, unknown }) => {
    setAuthorShares(shares);
    // Sessions of others that arrived meanwhile: ask again (at most every 5 s).
    const key = [...unknown].sort().join(",");
    if (unknown.length && key !== authorFetch.current.unknown && Date.now() - authorFetch.current.at > 5000) {
      authorFetch.current.unknown = key;
      void loadAuthors().catch(() => {});
    }
  };
  // The page menu's "Autoren anzeigen".
  useEffect(() => {
    if (embedded || rowId) return;
    const toggle = (event: Event) => {
      if ((event as CustomEvent).detail === pageId) setAuthorsOn((on) => !on);
    };
    window.addEventListener("flowplan:authors", toggle);
    return () => window.removeEventListener("flowplan:authors", toggle);
  }, [pageId, rowId, embedded]);
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
          onStatus("saving");
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
        onStatus(dirty.current ? "unsaved" : "saved");
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
          onStatus("reloading");
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
      onStatus(!navigator.onLine ? "saved-offline" : away ? "retrying" : "failed");
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
      onStatus(navigator.onLine ? (editable ? "syncing" : "saved") : "saved-offline");
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
  async function importDrawing(file: File) {
    const host = pages.find((p) => p.id === pageId);
    if (!host) return;
    try {
      onStatus("importing");
      const form = new FormData();
      form.set("workspaceId", host.workspace_id);
      form.set("spaceId", host.space_id);
      if (!rowId) form.set("parentId", host.id);
      form.set("file", file);
      const r = await fetch("/api/whiteboards/import", { method: "POST", body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(serverMessage(data.error) || t("Import fehlgeschlagen.", "Import failed."));
      insertBoard(data.pageId);
    } catch (error) {
      onError((error as Error).message);
    }
  }
  openAi.current = (prompt = false) => {
    if (!editor || editor.isDestroyed || !editable || embedded) return;
    if (aiWriteRef.current === "blocked") return onError(aiBlockedHint);
    if (aiWriteRef.current !== "ok") return;
    const { from, to, empty, $from } = editor.state.selection;
    if (!prompt && !empty && editor.state.doc.textBetween(from, to, " ").trim())
      return setAiRequest({ kind: "selection", from, to });
    // The current line when it has text.
    if (!prompt && $from.parent.isTextblock && $from.parent.textContent.trim())
      return setAiRequest({ kind: "selection", from: $from.start(), to: $from.end() });
    setAiRequest({ kind: "prompt", from, to: from });
  };
  // Summaries from the side panel or a record's dialog land here.
  useEffect(() => {
    if (!editor || !editable || embedded) return;
    return registerAiInserter(pageId, rowId, (markdown, place) => {
      if (editor.isDestroyed) return false;
      const { from, to } = editor.state.selection;
      const tr = aiInsertTransaction(
        editor.state,
        blocksFromHtml(editor.schema, aiMarkdownToHtml(markdown)),
        place === "top" ? { from: 0, to: 0 } : { from, to },
        place === "top" ? "top" : "below",
      );
      if (!tr) return false;
      editor.view.dispatch(tr);
      editor.commands.focus();
      return true;
    });
  }, [editor, editable, embedded, pageId, rowId]);
  async function upload(original: File) {
    // Excalidraw and draw.io drawings become a new whiteboard shown here.
    if (
      boardFileName(original.name) ||
      (/\.(xml|svg)$/i.test(original.name) &&
        /mxfile|mxGraphModel/.test(await original.slice(0, 1_000_000).text()))
    )
      return importDrawing(original);
    // Photos shrink before upload; the alt text keeps the original name.
    const file = await compressImage(original);
    const form = new FormData();
    form.set("pageId", pageId);
    form.set("file", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: form, headers: idempotencyHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(serverMessage(data.error));
      primePlaceholder(data.url, data.placeholder);
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
  const calloutLabel = calloutLabels(t),
    calloutDescription = calloutDescriptions(t);
  // A voice note: the audio, below it the spoken words (from the server's
  // transcription, or from the app's on the device) and, when asked, the
  // AI's summary or tasks.
  const insertVoice = async (file: File, toText: boolean, summarize: boolean, actions: boolean, transcript: Transcript | null = null) => {
    await upload(file);
    if (!toText) return;
    onStatus("transcribing");
    try {
      // Long recordings go up in chunks (lib/transcribe-client.ts); the
      // app may have transcribed on the device already.
      const data = transcript || (await transcribeRecording(file, pageId));
      const speaker = (n: number) => t(`Sprecher ${n}`, `Speaker ${n}`);
      // With segments: a toggle with timestamps (and speakers, when the
      // service separated them) instead of plain paragraphs.
      const block = transcriptHtml(data, { title: t("Transkript", "Transcript"), speaker });
      if (block && editor && !editor.isDestroyed) {
        editor.chain().focus().insertContent(block).run();
        const at = editor.state.selection.from;
        if (summarize) setAiRequest({ kind: "transcript", from: at, to: at, text: transcriptText(data, speaker) });
        if (actions && aiWorkspace)
          setTranscriptActions({ instruction: t("Aufgaben und Zusammenfassung erzeugen", "Generate tasks and summary"), context: transcriptText(data, speaker), pageId, mode: "transcript" });
        return;
      }
      const paragraphs = String(data.text || "")
        .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (paragraphs.length) {
        editor
          ?.chain()
          .focus()
          .insertContent(paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })))
          .run();
        // The summary goes below the transcript, through the preview.
        if (summarize && editor && !editor.isDestroyed) {
          const at = editor.state.selection.from;
          setAiRequest({ kind: "transcript", from: at, to: at, text: paragraphs.join("\n\n") });
        }
        if (actions && aiWorkspace)
          setTranscriptActions({ instruction: t("Aufgaben und Zusammenfassung erzeugen", "Generate tasks and summary"), context: paragraphs.join("\n\n"), pageId, mode: "transcript" });
      } else onError(t("In der Aufnahme wurde keine Sprache erkannt.", "No speech was recognised in the recording."));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      onStatus("saved");
    }
  };
  // In the app the recording is native (lib/native-voice.ts).
  const recordVoice = async () => {
    const note = await recordInApp({ summarize: !embedded && aiSummarize === "ok", serverTranscription: transcription }, onError);
    if (note) await insertVoice(note.file, !!note.transcript || (note.text && transcription), note.summarize && aiSummarize === "ok", false, note.transcript);
  };
  // Every block of the "/" menu, with a stable id (remembered as recently
  // used) and its section. Second levels (the callout kinds) are reached
  // by choosing the entry or found directly when typing.
  const commands: SlashItem[] = [
    ...(aiWrite !== "hidden" && !embedded
      ? [
          {
            id: "ai",
            group: "ai" as const,
            name: t("KI-Assistent", "AI assistant"),
            keywords: ["ki", "ai", "assistent", "assistant", "schreiben", "write", "gpt"],
            description: aiWrite === "blocked" ? aiBlockedHint : t("Text von der KI schreiben lassen", "Let the AI write text") + keyHints.suffix("Mod+J"),
            icon: Sparkle,
            disabled: aiWrite === "blocked",
            run: () => openAi.current(true),
          },
        ]
      : []),
    {
      id: "text",
      group: "text",
      name: t("Text", "Text"),
      keywords: ["text", "p", "absatz", "paragraph"],
      description: t("Einfach losschreiben", "Just start writing"),
      icon: TextAlignLeft,
      run: () => editor?.chain().focus().setParagraph().run(),
    },
    {
      id: "h1",
      group: "text",
      name: t("Überschrift 1", "Heading 1"),
      keywords: ["h1", "#", "titel", "heading1"],
      description: t("Große Überschrift", "Large heading"),
      icon: TextHOne,
      run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      id: "h2",
      group: "text",
      name: t("Überschrift 2", "Heading 2"),
      keywords: ["h2", "##", "heading2"],
      description: t("Mittlere Überschrift", "Medium heading"),
      icon: TextHTwo,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: "h3",
      group: "text",
      name: t("Überschrift 3", "Heading 3"),
      keywords: ["h3", "###", "heading3"],
      description: t("Kleine Überschrift", "Small heading"),
      icon: TextHThree,
      run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      id: "todo",
      group: "lists",
      name: t("Aufgabenliste", "Task list"),
      keywords: ["todo", "aufgabe", "task", "checkbox", "[]"],
      description: t("Schritt für Schritt abhaken", "Tick off step by step"),
      icon: CheckSquare,
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      id: "bullets",
      group: "lists",
      name: t("Aufzählung", "Bulleted list"),
      keywords: ["ul", "liste", "bullet", "punkte", "-"],
      description: t("Eine Liste mit Punkten", "A list with bullets"),
      icon: ListBullets,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      id: "numbered",
      group: "lists",
      name: t("Nummerierte Liste", "Numbered list"),
      keywords: ["ol", "1.", "nummer", "numbered"],
      description: t("Eine geordnete Liste", "An ordered list"),
      icon: ListNumbers,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    // Before the quote block, so "/zitat" finds the citation first.
    {
      id: "citation",
      group: "blocks",
      name: t("Literaturzitat", "Citation"),
      keywords: ["zitat", "cite", "citation", "doi", "bibtex", "zotero", "literatur", "quelle", "source", "reference"],
      description: t("Quelle zitieren: DOI, BibTeX oder Zotero", "Cite a source: DOI, BibTeX or Zotero"),
      icon: Books,
      run: () => setCiteOpen(true),
    },
    {
      id: "bibliography",
      group: "blocks",
      name: t("Literaturverzeichnis", "Bibliography"),
      keywords: ["bibliography", "literatur", "references", "quellen", "bibliographie", "literaturliste"],
      description: t("Alle zitierten Werke als Liste", "All cited works as a list"),
      icon: Books,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertContent({ type: "bibliography", attrs: { title: t("Literaturverzeichnis", "References") } })
          .run(),
    },
    {
      id: "quote",
      group: "text",
      name: t("Zitat", "Quote"),
      keywords: ["quote", ">"],
      description: t("Einen Gedanken hervorheben", "Highlight a thought"),
      icon: Quotes,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    // One callout entry; its kinds (the five GitHub alerts) are the second
    // level. Inside a callout a kind changes the callout instead.
    {
      id: "callout",
      group: "blocks",
      name: t("Callout", "Callout"),
      keywords: ["callout", "hinweis", "note", "info", "alert", "admonition", "box"],
      description: t("Hervorgehobener Kasten: Hinweis, Tipp, Wichtig, Warnung oder Achtung", "Highlighted box: note, tip, important, warning or caution"),
      icon: Info,
      run: () => {},
      children: CALLOUT_TYPES.map((type) => ({
        id: `callout-${type}`,
        group: "blocks" as const,
        name: calloutLabel[type],
        keywords: {
          note: ["info", "note", "hinweis"],
          tip: ["tip", "tipp", "hint"],
          important: ["important", "wichtig"],
          warning: ["warning", "warnung"],
          caution: ["caution", "danger", "achtung", "gefahr"],
        }[type],
        description: calloutDescription[type],
        icon: { note: Info, tip: Lightbulb, important: ChatCenteredText, warning: Warning, caution: WarningOctagon }[type],
        run: () => {
          if (editor?.isActive("callout")) return void editor.chain().focus().updateAttributes("callout", { type }).run();
          // An empty paragraph (the placeholder invites typing), never sample text.
          editor
            ?.chain()
            .focus()
            .insertContent({ type: "callout", attrs: { type }, content: [{ type: "paragraph" }] })
            .run();
        },
      })),
    },
    {
      id: "toggle",
      group: "blocks",
      name: t("Aufklappbarer Block", "Toggle"),
      keywords: ["toggle", "details", "aufklappen"],
      description: t("Details ein- und ausblenden", "Show and hide details"),
      icon: CaretRight,
      run: () => setToggle(true),
    },
    {
      id: "code",
      group: "blocks",
      name: "Code",
      keywords: ["codeblock", "```"],
      description: t("Codeblock einfügen", "Insert a code block"),
      icon: Code,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    {
      id: "table",
      group: "blocks",
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
      id: "file",
      group: "media",
      name: t("Bild oder Datei", "Image or file"),
      keywords: ["bild", "image", "img", "datei", "file", "upload", "foto"],
      description: t("Datei vom Gerät hochladen", "Upload a file from your device"),
      icon: ImageIcon,
      run: () => uploadRef.current?.click(),
    },
    {
      id: "mermaid",
      group: "media",
      name: t("Mermaid-Diagramm", "Mermaid diagram"),
      keywords: ["mermaid", "diagramm", "flowchart", "chart"],
      description: t("Abläufe, Sequenzen und Beziehungen", "Flows, sequences and relationships"),
      icon: Code,
      run: () => setDiagram({ source: DEFAULT_DIAGRAM }),
    },
    {
      id: "math",
      group: "math",
      name: t("Formel", "Formula"),
      keywords: ["math", "latex", "katex", "tex"],
      description: t("Mathematischer Ausdruck", "Mathematical expression"),
      icon: FunctionIcon,
      run: () => setMath({ type: "mathBlock", expression: "" }),
    },
    {
      id: "inline-math",
      group: "math",
      name: t("Inline-Formel", "Inline formula"),
      keywords: ["inlinemath"],
      description: t("Mathematik direkt im Satz", "Math right inside a sentence"),
      icon: FunctionIcon,
      run: () => openInlineMath(),
    },
    {
      id: "plot",
      group: "math",
      name: t("Funktionsgraph", "Function graph"),
      keywords: ["graph", "plot", "funktion", "function", "kurve", "diagramm"],
      description: t("Funktionen von x zeichnen, live bearbeitbar", "Draw functions of x, editable live"),
      icon: ChartLine,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertContent({ type: "functionPlot", attrs: { plot: JSON.stringify({ functions: [{ expr: "x²", color: "#3b3fd8" }] }) } })
          .run(),
    },
    {
      id: "metric",
      group: "database",
      name: t("Kennzahl", "Metric"),
      keywords: ["metric", "kpi", "zahl", "anzahl", "summe", "dashboard"],
      description: t("Eine Zahl aus einer Datenbank, aktuell gehalten", "A number from a database, kept up to date"),
      icon: ChartLine,
      run: () => editor?.chain().focus().insertContent({ type: "metricBlock" }).run(),
    },
    {
      id: "dashboard",
      group: "database",
      name: t("Dashboard", "Dashboard"),
      keywords: ["dashboard", "kennzahlen", "metrics", "kpi", "übersicht", "overview"],
      description: t("Drei Kennzahlen nebeneinander, darunter Diagramme einbinden", "Three metrics side by side, embed charts below"),
      icon: ChartLine,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertContent([
            {
              type: "columns",
              content: [0, 1, 2].map(() => ({ type: "column", content: [{ type: "metricBlock" }, { type: "paragraph" }] })),
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: t(
                    "Diagramme: /Verknüpfte Datenbank einfügen und dort eine Diagramm-Ansicht wählen.",
                    "Charts: insert /Linked database and choose a chart view there.",
                  ),
                },
              ],
            },
          ])
          .run(),
    },
    {
      id: "fraction",
      group: "math",
      name: t("Bruch", "Fraction"),
      keywords: ["fraction", "bruch", "frac", "geteilt"],
      description: t("Zähler über Nenner, im Satz", "Numerator over denominator, inside a sentence"),
      icon: FunctionIcon,
      run: () => setMath({ type: "mathInline", expression: "\\frac{}{}" }),
    },
    {
      id: "footnote",
      group: "blocks",
      name: t("Fußnote", "Footnote"),
      keywords: ["fussnote", "footnote", "fn", "anmerkung", "quelle", "note"],
      description: t("Nummerierte Anmerkung am Seitenende", "Numbered note at the end of the page"),
      icon: Note,
      run: () => editor?.chain().focus().openFootnote().run(),
    },
    {
      id: "mention",
      group: "database",
      name: t("Seite, Eintrag oder Person erwähnen", "Mention a page, record or person"),
      keywords: ["mention", "link", "@", "seite", "person", "eintrag", "record"],
      description: t("Mit @ Wissen verknüpfen", "Connect knowledge with @"),
      icon: LinkIcon,
      run: () => setReferences(true),
    },
    ...(rowId
      ? []
      : [
          {
            id: "draw",
            group: "media" as const,
            name: t("Zeichnen", "Draw"),
            keywords: ["zeichnen", "draw", "dessin", "dessiner", "handschrift", "handwriting", "sketch", "skizze", "croquis", "stift", "pencil", "ink", "tinte", "scribble"],
            description: t("Handschrift und Skizzen mit Stift oder Finger", "Handwriting and sketches with a pen or finger"),
            icon: Scribble,
            run: () =>
              editor
                ?.chain()
                .focus()
                .command(({ tr, state }) => {
                  if (state.selection instanceof NodeSelection) tr.setSelection(Selection.near(tr.doc.resolve(state.selection.to)));
                  return true;
                })
                .insertContent([{ type: "drawBlock", attrs: { id: newDrawBlockId(), page: pageId, height: 300, paper: "lined" } }, { type: "paragraph" }])
                .run(),
          },
        ]),
    {
      id: "whiteboard",
      group: "media",
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
      id: "voice",
      group: "media",
      name: t("Sprachnotiz", "Voice note"),
      keywords: ["audio", "aufnahme", "mikrofon", "diktat", "voice", "sprache"],
      description: transcription ? t("Aufnehmen und als Text einfügen", "Record and insert as text") : t("Aufnehmen und als Audio einfügen", "Record and insert as audio"),
      icon: Microphone,
      run: () => (canRecordInApp() ? void recordVoice() : setVoice(true)),
    },
    {
      id: "synced",
      group: "advanced",
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
      id: "synced-insert",
      group: "advanced",
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
      id: "linked-database",
      group: "database",
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
      id: "columns",
      group: "blocks",
      name: t("Zwei Spalten", "Two columns"),
      keywords: ["spalten", "columns", "cols"],
      description: t("Inhalte nebeneinander", "Content side by side"),
      icon: TableIcon,
      run: () => {
        if (!editor) return;
        editor
          .chain()
          .focus()
          .insertContent({
            type: "columns",
            content: [
              { type: "column", content: [{ type: "paragraph" }] },
              { type: "column", content: [{ type: "paragraph" }] },
            ],
          })
          .run();
        // Writing starts in the left column, not where the insertion ended.
        const { $from } = editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--)
          if ($from.node(depth).type.name === "columns") {
            editor.commands.setTextSelection($from.before(depth) + 3);
            break;
          }
      },
    },
    {
      id: "embed",
      group: "media",
      name: t("Einbetten", "Embed"),
      keywords: ["embed", "youtube", "video", "figma", "loom"],
      description: t("YouTube, Vimeo, Loom, Spotify, Figma oder CodePen", "YouTube, Vimeo, Loom, Spotify, Figma or CodePen"),
      icon: ImageIcon,
      run: () => setEmbed(true),
    },
    {
      id: "spoiler",
      group: "text",
      name: t("Spoiler", "Spoiler"),
      keywords: ["verdecken", "versteckt", "hide", "geheim"],
      description: t("Text verdecken, bis jemand darauf klickt", "Hide text until someone clicks it"),
      icon: EyeSlash,
      run: () => editor?.chain().focus().toggleMark("spoiler").run(),
    },
    {
      id: "divider",
      group: "text",
      name: t("Trennlinie", "Divider"),
      keywords: ["hr", "divider", "linie", "---"],
      description: t("Inhalte voneinander trennen", "Separate content"),
      icon: Minus,
      run: () => editor?.chain().focus().setHorizontalRule().run(),
    },
    // In the iPhone and iPad app: the document scanner; the app adds the
    // PDF with its recognised text at the end of this page.
    ...(editable && nativeScanAvailable()
      ? [
          {
            id: "scan",
            group: "media",
            name: t("Dokument scannen", "Scan document"),
            keywords: ["scan", "scanner", "kamera", "camera", "pdf", "ocr", "beleg", "receipt"],
            description: t("Mit der Kamera, als durchsuchbares PDF", "With the camera, as a searchable PDF"),
            icon: Scan,
            run: () => nativeScan(pageId, rowId),
          } satisfies SlashItem,
        ]
      : []),
    ...pluginCommands.map(({ plugin, block, icon }): SlashItem => ({
      id: `plugin-${plugin.id}-${block.type}`,
      group: "extensions",
      name: block.label,
      keywords: [plugin.name, block.type, "plugin", "erweiterung", "extension"],
      description: block.description || `${plugin.name} ${plugin.version}`,
      icon,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "pluginBlock",
            attrs: { pluginId: plugin.id, blockType: block.type, label: block.label, data: "null", text: "" },
          })
          .run(),
    })),
  ];
  // The sections shown: a second level alone, or recents and groups
  // (filtered by the typed query). Arrow keys move over the flat list.
  const slashParent = slash?.sub ? commands.find((command) => command.id === slash.sub) || null : null;
  const slashSectionList: SlashSection<SlashItem>[] = !slash
    ? []
    : slashParent
      ? [{ group: slashParent.group || "blocks", items: slashParent.children || [] }]
      : slashSections(commands, slash.query, slashRecents);
  const slashMatches = slashSectionList.flatMap((section) => section.items);
  slashItems.current = slashMatches;
  // Runs a block command; typed "/…" text is removed first. An entry with a
  // second level opens it instead.
  slashPick.current = (index: number) => {
    const list = slashItems.current,
      item = list[Math.min(index, list.length - 1)],
      menu = slashState.current;
    if (!item || !menu || item.disabled) return;
    if (item.children) {
      setSlash({ ...menu, sub: item.id });
      setSlashActive(0);
      return;
    }
    setSlash(null);
    setSlashRecents(rememberSlashCommand(item.id));
    if (menu.mode === "inline" && editor) {
      const to = editor.state.selection.from;
      if (to > menu.from)
        editor.chain().focus().deleteRange({ from: menu.from, to }).run();
    } else editor?.commands.focus();
    item.run();
  };
  // Back from a second level to the entry that opened it.
  slashBack.current = () => {
    const menu = slashState.current;
    if (!menu?.sub) return;
    const parentIndex = slashSections(commands, menu.query, slashRecents)
      .flatMap((section) => section.items)
      .findIndex((item) => item.id === menu.sub);
    setSlash({ ...menu, sub: null });
    setSlashActive(Math.max(0, parentIndex));
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
  openFootnote.current = (target) => {
    if (!editor) return;
    setFootnote({ ...target, at: editor.state.selection.to, original: target.note });
  };
  // Saves the note being written: changes it, or adds the marker.
  function saveFootnote(remove = false) {
    if (!editor || !footnote) return;
    const note = footnoteText(footnote.note);
    if (footnote.pos === null) {
      if (note && !remove)
        editor
          .chain()
          .focus()
          .insertContentAt(Math.min(footnote.at, editor.state.doc.content.size), { type: "footnote", attrs: { note } })
          .run();
      setFootnote(null);
      return;
    }
    const current = editor.state.doc.nodeAt(footnote.pos);
    if (current?.type.name !== "footnote" || String(current.attrs.note || "") !== footnote.original) {
      onError(t("Die Fußnote wurde inzwischen geändert. Bitte erneut öffnen.", "The footnote was changed in the meantime. Please open it again."));
      setFootnote(null);
      return;
    }
    const tr = editor.state.tr;
    if (remove || !note) tr.delete(footnote.pos, footnote.pos + current.nodeSize);
    else tr.setNodeMarkup(footnote.pos, undefined, { ...current.attrs, note });
    editor.view.dispatch(tr);
    editor.commands.focus();
    setFootnote(null);
  }
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
  // Marks up the selected image (toolbar button).
  function annotateSelectedImage() {
    if (!editor) return;
    const { selection } = editor.state;
    const node = "node" in selection ? (selection as unknown as { node: { type: { name: string }; attrs: Record<string, string | null> } }).node : null;
    if (node?.type.name !== "image") return;
    setAnnotate({ pos: selection.from, src: node.attrs.src || "", original: node.attrs.original, annotations: node.attrs.annotations });
  }
  // Uploads the marked-up image and keeps original and markings on it.
  async function saveAnnotation(target: NonNullable<typeof annotate>, result: AnnotationResult) {
    const current = editor?.state.doc.nodeAt(target.pos);
    if (!editor || current?.type.name !== "image" || current.attrs.src !== target.src)
      throw new Error(t("Das Bild wurde inzwischen geändert. Bitte erneut öffnen.", "The image was changed in the meantime. Please open it again."));
    const form = new FormData();
    form.set("pageId", pageId);
    form.set("file", new File([result.blob], `${(current.attrs.alt || "bild").replace(/\.[a-z0-9]+$/i, "")}-markiert.${result.blob.type === "image/png" ? "png" : "jpg"}`, { type: result.blob.type }));
    const response = await fetch("/api/upload", { method: "POST", body: form, headers: idempotencyHeaders() });
    const data = await response.json();
    if (!response.ok) throw new Error(serverMessage(data.error));
    primePlaceholder(data.url, data.placeholder);
    // Without markings the original comes back.
    const attrs = result.shapes
      ? { ...current.attrs, src: data.url, original: result.original, annotations: result.shapes }
      : { ...current.attrs, src: result.original, original: null, annotations: null };
    editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, undefined, attrs));
  }
  const imageSelected = useEditorState({
    editor,
    selector: ({ editor: current }) => !!current?.isActive("image"),
  });
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
  // The mention dialog: what matches the typed text.
  const referenceTerm = referenceQuery.trim().toLowerCase();
  // Pages match by title or by an alias ("Chauffage · PAC").
  const referencePages = pages.flatMap((p): { page: Page; alias?: string }[] => {
    if (p.id === pageId) return [];
    if (!referenceTerm || p.title.toLowerCase().includes(referenceTerm)) return [{ page: p, alias: undefined }];
    const alias = matchedAlias(p.title, pageAliases(p), referenceTerm);
    return alias ? [{ page: p, alias }] : [];
  });
  const referenceMembers = members.filter((u) => !referenceTerm || u.name.toLowerCase().includes(referenceTerm));
  return (
    <div className={`editor-wrapper${embedded ? " embedded" : ""}${!embedded && outline ? " with-outline" : ""}`}>
      <div className={`document-writing-surface${suggesting && editable ? " suggesting" : ""}`}>
        {editable && !embedded && !source && (
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
            {imageSelected && (
              <button
                title={t("Bild markieren (Doppelklick)", "Mark up image (double-click)")}
                aria-label={t("Bild markieren", "Mark up image")}
                onClick={annotateSelectedImage}
              >
                <PencilSimpleLine />
              </button>
            )}
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
                <Dropdown.Content collisionPadding={safeCollisionPadding()}
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
              title={t("Verdecken (Spoiler)", "Hide (spoiler)") + (keyHints.keys("Mod+Alt+H") && ` · ${keyHints.keys("Mod+Alt+H")}`)}
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
              title={authorsOn ? t("Autoren ausblenden", "Hide authors") : t("Autoren anzeigen: Text nach Person einfärben", "Show authors: colour the text by person")}
              aria-label={t("Autoren anzeigen", "Show authors")}
              aria-pressed={authorsOn}
              className={authorsOn ? "active" : ""}
              onClick={() => setAuthorsOn(!authorsOn)}
            >
              <UsersThree />
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
                          reveal(node.nodeType === 1 ? (node as Element) : node.parentElement);
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
        {authorsOn && !embedded && (
          <aside className="author-legend" aria-label={t("Autoren", "Authors")}>
            <div className="author-legend-head">
              <strong>{t("Autoren", "Authors")}</strong>
              <button
                type="button"
                aria-label={t("Autoren ausblenden", "Hide authors")}
                onClick={() => setAuthorsOn(false)}
              >
                <X size={14} />
              </button>
            </div>
            {authorShares.length ? (
              <ul>
                {(() => {
                  const total = authorShares.reduce((sum, [, n]) => sum + n, 0) || 1;
                  return authorShares.map(([uid, chars]) => (
                    <li key={uid ?? "earlier"}>
                      <span
                        className={`author-swatch${uid ? "" : " earlier"}`}
                        style={uid ? { background: authorColor(uid, 0.6) } : undefined}
                        aria-hidden
                      />
                      <span className="author-name">
                        {uid ? authorPeople[uid] || t("Unbekannt", "Unknown") : t("früher", "earlier")}
                      </span>
                      <small>{Math.max(chars / total < 0.005 ? 0 : 1, Math.round((chars / total) * 100))} %</small>
                    </li>
                  ));
                })()}
              </ul>
            ) : (
              <p className="muted">{t("Noch kein Text.", "No text yet.")}</p>
            )}
            <p className="muted author-legend-note">
              {t(
                "Wer was geschrieben hat, wird erst seit Einführung dieser Anzeige aufgezeichnet. Älterer Text erscheint als „früher“.",
                "Who wrote what is only recorded since this view was introduced. Older text appears as “earlier”.",
              )}
            </p>
          </aside>
        )}
        {!embedded && !source && (outline || headings.length > 0) && (
          <OutlineToggle open={outline} count={headings.length} onToggle={() => setOutline(!outline)} />
        )}
        {!embedded && outline && <DocumentOutline editor={editor} headings={headings} onClose={() => setOutline(false)} />}
        {source && !embedded && editor && (
          <MarkdownSourceView
            editor={editor}
            pageId={pageId}
            editable={editable}
            notice={sourceNotice}
            onClose={() => onSourceClose?.()}
            onError={onError}
          />
        )}
        <div className="editor-content-holder" hidden={source && !embedded}>
          {embedded ? (
            <EditorContent editor={editor} />
          ) : (
            <DocumentBlockControls editor={editor}>
              <EditorContent editor={editor} />
            </DocumentBlockControls>
          )}
        </div>
        {editor?.isActive("table") && editable && (
          <div className="table-tools">
            <button onClick={() => editor.chain().focus().addRowAfter().run()}>
              {t("+ Zeile", "+ Row")}
            </button>
            <button
              onClick={() => editor.chain().focus().addColumnAfter().run()}
            >
              {t("+ Spalte", "+ Column")}
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
          sections={slashSectionList}
          active={Math.min(slashActive, Math.max(0, slashMatches.length - 1))}
          anchor={slashAnchor}
          search={slash.mode === "button" ? slash.query : undefined}
          parent={slashParent}
          onBack={() => slashBack.current()}
          onSearch={(query) => {
            setSlash({ ...slash, query, sub: null });
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
            } else if ((event.key === "Enter" || event.key === "Tab") && count) {
              event.preventDefault();
              slashPick.current(slashActive);
            } else if (event.key === "ArrowRight" && !slash.sub && slashMatches[slashActive]?.children) {
              event.preventDefault();
              slashPick.current(slashActive);
            } else if (event.key === "ArrowLeft" && slash.sub) {
              event.preventDefault();
              slashBack.current();
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
          ai={aiWrite}
          aiHint={aiBlockedHint}
          onAi={() => openAi.current()}
          onLink={() => {
            setLinkUrl(editor?.getAttributes("link").href || "");
            setLink(true);
          }}
        />
      )}
      {aiRequest && editor && !editor.isDestroyed && (
        <AiWriter
          key={`${aiRequest.kind}-${aiRequest.from}-${aiRequest.to}`}
          editor={editor}
          pageId={pageId}
          rowId={rowId}
          request={aiRequest}
          onClose={() => setAiRequest(null)}
        />
      )}
      <VoiceRecorder
        open={voice}
        transcription={transcription}
        summarize={embedded ? "hidden" : aiSummarize}
        summarizeHint={aiBlockedHint}
        actions={embedded || rowId ? "hidden" : aiActions}
        onClose={() => setVoice(false)}
        onInsert={(file, toText, summarize, actions) => {
          setVoice(false);
          void insertVoice(file, toText, summarize, actions);
        }}
      />
      {aiWorkspace && <AiActionsPanel workspaceId={aiWorkspace} request={transcriptActions} onClose={() => setTranscriptActions(null)} />}
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
      {citeOpen && (
        <CitationDialog
          open
          workspaceId={pages.find((p) => p.id === pageId)?.workspace_id || ""}
          onClose={() => setCiteOpen(false)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor?.commands.focus();
          }}
          onError={onError}
          onInsert={(item, locator) =>
            editor
              ?.chain()
              .focus()
              .insertContent({
                type: "citation",
                attrs: { key: item.id, item: JSON.stringify(item), locator },
              })
              .run()
          }
        />
      )}
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
      {annotate && (
        <ImageAnnotator
          src={annotate.src}
          original={annotate.original}
          annotations={annotate.annotations}
          onSave={(result) => saveAnnotation(annotate, result)}
          onClose={() => setAnnotate(null)}
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
        onClose={() => {
          setReferences(false);
          setReferenceQuery("");
        }}
        title={t("Seite, Eintrag oder Person erwähnen", "Mention a page, record or person")}
      >
        <div className="reference-list">
          <input
            className="input"
            autoFocus
            value={referenceQuery}
            onChange={(e) => setReferenceQuery(e.target.value)}
            placeholder={t("Suchen …", "Search …")}
            aria-label={t("Seiten, Einträge und Personen suchen", "Search pages, records and people")}
          />
          {referencePages.length > 0 && <h3>{t("Seiten", "Pages")}</h3>}
          {referencePages.map(({ page: p, alias }) => (
              <button
                key={p.id}
                onClick={() => {
                  editor
                    ?.chain()
                    .focus()
                    .insertContent({
                      type: "text",
                      // Found by an alias: the alias is the link text.
                      text: alias || p.title,
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
                {alias && <span className="alias-hit"> · {alias}</span>}
              </button>
            ))}
          <RecordReferences
            workspaceId={pages.find((p) => p.id === pageId)?.workspace_id}
            query={referenceQuery}
            exclude={rowId}
            onPick={(record) => {
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "text",
                  text: record.alias || record.title,
                  marks: [
                    {
                      type: "link",
                      attrs: { href: `/${pageLocationHash({ pageId: record.id, rowId: record.rowId })}` },
                    },
                  ],
                })
                .run();
              setReferences(false);
              setReferenceQuery("");
            }}
          />
          {referenceMembers.length > 0 && <h3>{t("Personen", "People")}</h3>}
          {referenceMembers.map((u) => (
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
        open={!!footnote}
        onClose={() => setFootnote(null)}
        title={footnote?.pos === null ? t("Fußnote einfügen", "Insert footnote") : t("Fußnote bearbeiten", "Edit footnote")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveFootnote();
          }}
        >
          <label>
            {t("Text der Fußnote", "Footnote text")}
            <textarea
              autoFocus
              rows={4}
              maxLength={MAX_FOOTNOTE}
              value={footnote?.note || ""}
              onChange={(e) => footnote && setFootnote({ ...footnote, note: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveFootnote();
                }
              }}
            />
          </label>
          <p className="muted">
            {t("Erscheint nummeriert unter „Fußnoten“ am Ende der Seite. Webadressen werden zu Links.", "Appears numbered under “Footnotes” at the end of the page. Web addresses become links.")}
          </p>
          <div className="modal-actions">
            {footnote?.pos !== null && (
              <button type="button" className="button" onClick={() => saveFootnote(true)}>
                {t("Fußnote entfernen", "Remove footnote")}
              </button>
            )}
            <button className="button primary">{footnote?.pos === null ? t("Einfügen", "Insert") : t("Speichern", "Save")}</button>
          </div>
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

type RecordHit = { id: string; rowId: string; title: string; pageTitle?: string; alias?: string };
// Records for the mention dialog: the workspace search (kind "row") finds
// them and leaves out what the person may not read.
function RecordReferences({
  workspaceId,
  query,
  exclude,
  onPick,
}: {
  workspaceId?: string;
  query: string;
  exclude?: string;
  onPick: (record: RecordHit) => void;
}) {
  const t = useT();
  const [hits, setHits] = useState<RecordHit[]>([]);
  const term = query.trim();
  useEffect(() => {
    if (!workspaceId || !term) {
      setHits([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      api<(RecordHit & { rowId?: string })[]>(
        `/api/search?workspace=${workspaceId}&kind=row&q=${encodeURIComponent(term)}`,
      )
        .then((found) => {
          if (!active) return;
          const seen = new Set<string>();
          setHits(
            found.filter((hit): hit is RecordHit => {
              if (!hit.rowId || hit.rowId === exclude || seen.has(hit.rowId)) return false;
              seen.add(hit.rowId);
              return true;
            }).slice(0, 20),
          );
        })
        .catch(() => active && setHits([]));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId, term, exclude]);
  return (
    <>
      <h3>{t("Einträge", "Records")}</h3>
      {!term && <p className="muted reference-hint">{t("Tippe, um Einträge aus Datenbanken zu finden.", "Type to find records in databases.")}</p>}
      {hits.map((hit) => (
        <button key={hit.rowId} onClick={() => onPick(hit)}>
          <Rows />
          <span>
            {hit.title || t("Ohne Titel", "Untitled")}
            {hit.alias && <span className="alias-hit"> · {hit.alias}</span>}
            {hit.pageTitle && <small className="muted"> · {hit.pageTitle}</small>}
          </span>
        </button>
      ))}
    </>
  );
}
