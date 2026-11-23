"use client";
// Writing a comment or reply (page, record and text comments, #314/#450):
// formatting, "@" for people and for pages and records, attachments (button,
// drag & drop, paste) and previews of the first links.
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { serverMessage } from "@/lib/server-message";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Node, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  useEffect,
  useRef,
  useState,
  useId,
} from "react";
import {
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  Code,
  ListBullets,
  ListNumbers,
  Quotes,
  Link,
  At,
  Paperclip,
} from "@phosphor-icons/react";
import {
  normalizeCommentContent,
  plainCommentContent,
  commentText,
  safeCommentLink,
  MAX_COMMENT_ATTACHMENTS,
  MAX_COMMENT_PREVIEWS,
  type CommentAttachment,
  type CommentLinkPreview,
  type CommentNode,
} from "@/lib/comment-content";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import { CommentFiles, CommentPreviews } from "./comment-body";
import { PageIcon } from "./ui";
import { shownPageIcon } from "@/lib/page-link-icons";
export { CommentBody } from "./comment-body";
import { AutoLinkRules } from "@/lib/auto-link-plugin";
import { EmojiSuggest, useEmojiSuggest } from "./emoji-suggest";
const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { userId: { default: null }, label: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "span[data-comment-mention]",
      getAttrs: (el) => ({
        userId:
          (el as HTMLElement).getAttribute("data-comment-mention") || null,
        label: (el as HTMLElement).textContent?.replace(/^@/, ""),
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "span",
    {
      "data-comment-mention": node.attrs.userId || "",
      class: "comment-mention",
    },
    "@" + node.attrs.label,
  ],
});
// A page or record named with "@" (#450); shown as its title, stored by id.
const PageMention = Node.create({
  name: "pageMention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { pageId: { default: null }, rowId: { default: null }, label: { default: "" }, noAccess: { default: false } };
  },
  parseHTML: () => [
    {
      tag: "span[data-comment-page]",
      getAttrs: (el) => ({
        pageId: (el as HTMLElement).getAttribute("data-comment-page"),
        rowId: (el as HTMLElement).getAttribute("data-comment-row") || null,
        label: (el as HTMLElement).textContent || "",
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "span",
    {
      "data-comment-page": node.attrs.pageId || "",
      ...(node.attrs.rowId ? { "data-comment-row": node.attrs.rowId } : {}),
      class: `comment-page-mention${node.attrs.noAccess ? " no-access" : ""}`,
    },
    node.attrs.noAccess ? "🔒" : node.attrs.label || "…",
  ],
});
type PersonChoice = { id: string; name: string; email: string };
type PageChoice = { pageId: string; rowId?: string; title: string; icon: string; kind: string; pageTitle?: string };
type MentionChoice = ({ kind: "person" } & PersonChoice) | ({ kind: "page"; id: string; pageKind: string } & Omit<PageChoice, "kind">);
// The http(s) links of a comment, in order (for the previews).
function contentLinks(node: CommentNode, out: string[] = []) {
  for (const mark of node.marks || [])
    if (mark.type === "link" && /^https?:/i.test(mark.attrs?.href || "") && !out.includes(mark.attrs!.href)) out.push(mark.attrs!.href);
  node.content?.forEach((c) => contentLinks(c, out));
  return out;
}
const withoutAttrs = (node: CommentNode): CommentNode => {
  const { attrs: _attrs, ...rest } = node;
  void _attrs;
  return rest;
};
type MentionRange = {
  from: number;
  to: number;
  query: string;
  manual: boolean;
};
export function CommentComposer({
  body,
  content,
  onChange,
  label,
  pageId,
  rowId,
  autoFocus = false,
  disabled = false,
  attachments = true,
  initialFiles,
}: {
  body: string;
  content?: CommentNode | null;
  onChange: (body: string, content: CommentNode) => void;
  label: string;
  pageId: string;
  rowId?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  // Files can be attached (#450); off where uploads are not possible.
  attachments?: boolean;
  // Files to attach right away (dropped on the field before it opened).
  initialFiles?: File[];
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const listId = useId();
  const [error, setError] = useState(""),
    [mention, setMention] = useState<MentionRange | null>(null),
    [choices, setChoices] = useState<MentionChoice[]>([]),
    [choice, setChoice] = useState(0),
    [loading, setLoading] = useState(false),
    [link, setLink] = useState<string | null>(null),
    [, render] = useState(0);
  // Attachments and link previews live in the doc node's attrs (#450).
  const files = content?.attrs?.attachments || [],
    previews = content?.attrs?.previews || [];
  const [uploading, setUploading] = useState<string[]>([]);
  const dismissed = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const live = useRef({ onChange, mention, choices, choice, files, previews, content });
  live.current = { onChange, mention, choices, choice, files, previews, content };
  // The editor's text with the current attachments and previews.
  const emit = (doc: CommentNode, next: { files?: CommentAttachment[]; previews?: CommentLinkPreview[] } = {}) => {
    const attachments = next.files ?? live.current.files,
      shown = next.previews ?? live.current.previews;
    const value: CommentNode = {
      ...withoutAttrs(doc),
      ...(attachments.length || shown.length
        ? { attrs: { ...(attachments.length ? { attachments } : {}), ...(shown.length ? { previews: shown } : {}) } }
        : {}),
    };
    live.current.content = value;
    live.current.files = attachments;
    live.current.previews = shown;
    live.current.onChange(commentText(value), value);
  };
  const selectMention = useRef<(person: MentionChoice) => void>(() => {});
  // Emoji suggestions after ":" (#388), as in the document.
  const emojiSuggest = useEmojiSuggest();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        link: { openOnClick: false, isAllowedUri: safeCommentLink },
      }),
      Mention,
      PageMention,
      // The workspace's automatic links (#202), as long as comments allow them.
      AutoLinkRules.configure({ allow: safeCommentLink }),
      emojiSuggest.extension,
      Extension.create({
        name: "commentLimits",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              filterTransaction(transaction) {
                if (!transaction.docChanged) return true;
                try {
                  normalizeCommentContent(transaction.doc.toJSON());
                  return true;
                } catch (e) {
                  queueMicrotask(() => setError((e as Error).message));
                  return false;
                }
              },
            }),
          ];
        },
      }),
    ],
    immediatelyRender: false,
    content: content || plainCommentContent(body),
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "comment-input",
        role: "textbox",
        "aria-autocomplete": "list",
        "aria-expanded": mention ? "true" : "false",
        ...(mention ? { "aria-controls": listId } : {}),
        ...(mention && choices[choice]
          ? { "aria-activedescendant": `${listId}-${choices[choice].id}` }
          : {}),
        "aria-label": label,
        "aria-multiline": "true",
      },
      // Files dropped or pasted into the text become attachments (#450).
      handlePaste(_view, event) {
        const pasted = [...(event.clipboardData?.files || [])];
        if (!pasted.length || !attachments) return false;
        void upload.current(pasted);
        return true;
      },
      handleDrop(_view, event) {
        const dropped = [...((event as DragEvent).dataTransfer?.files || [])];
        if (!dropped.length || !attachments) return false;
        event.preventDefault();
        void upload.current(dropped);
        return true;
      },
      handleKeyDown(view, event) {
        if (event.isComposing) return false;
        // The emoji row after ":" (#388) takes its keys first.
        if (emojiSuggest.controller.keyDown(view, event)) return true;
        const state = live.current;
        if (
          state.mention &&
          ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
        ) {
          if (event.key === "Escape") {
            setMention(null);
            return true;
          }
          if (state.choices.length && event.key === "Enter") {
            selectMention.current(
              state.choices[state.choice] || state.choices[0],
            );
            return true;
          }
          if (
            state.choices.length &&
            ["ArrowDown", "ArrowUp"].includes(event.key)
          ) {
            setChoice(
              (n) =>
                (n +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  state.choices.length) %
                state.choices.length,
            );
            return true;
          }
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          view.dom.closest("form")?.requestSubmit();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => {
      editor.view.dom.classList.remove("tiptap");
      if (autoFocus) editor.commands.focus("end");
    },
    onUpdate: ({ editor }) => {
      emit(normalizeCommentContent(editor.getJSON()));
      setError("");
    },
    onMount: ({ editor }) => {
      editor.view.dom.classList.remove("tiptap");
    },
    onTransaction: ({ editor, transaction }) => {
      render((n) => n + 1);
      const pending = live.current.mention;
      if (pending?.manual) {
        if (
          transaction.docChanged ||
          (editor.isFocused &&
            (editor.state.selection.from !== pending.from ||
              editor.state.selection.to !== pending.to))
        )
          setMention(null);
        return;
      }
      const { $from, empty } = editor.state.selection;
      const match =
        empty &&
        /(?:^|\s)@([\p{L}\p{N} ._-]{0,80})$/u.exec(
          $from.parent.textBetween(0, $from.parentOffset, "", "\uFFFC"),
        );
      setMention(
        match
          ? {
              from: $from.pos - match[1].length - 1,
              to: $from.pos,
              query: match[1],
              manual: false,
            }
          : null,
      );
    },
  });
  selectMention.current = (picked) => {
    const range = live.current.mention;
    if (!editor || !range || disabled) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: range.from, to: range.to }, [
        picked.kind === "page"
          ? { type: "pageMention", attrs: { pageId: picked.pageId, rowId: picked.rowId || null, label: (picked.title || "").slice(0, 200) } }
          : { type: "mention", attrs: { userId: picked.id, label: picked.name.slice(0, 200) } },
        { type: "text", text: " " },
      ])
      .run();
    setMention(null);
    setChoices([]);
  };
  useEffect(() => {
    if (!editor) return;
    const next = withoutAttrs(content || plainCommentContent(body));
    if (
      JSON.stringify(withoutAttrs(normalizeCommentContent(editor.getJSON()))) !==
      JSON.stringify(next)
    )
      editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, body, content]);
  // Uploads go one after the other to the comment's page (POST /api/upload,
  // purpose=comment): the same checks and limits as every upload.
  const upload = useRef<(picked: File[]) => Promise<void>>(async () => {});
  upload.current = async (picked: File[]) => {
    if (!editor || disabled || !picked.length) return;
    const room = MAX_COMMENT_ATTACHMENTS - live.current.files.length - uploading.length;
    if (picked.length > room) {
      setError(t(`Höchstens ${MAX_COMMENT_ATTACHMENTS} Anhänge pro Kommentar.`, `At most ${MAX_COMMENT_ATTACHMENTS} attachments per comment.`));
      picked = picked.slice(0, Math.max(0, room));
    }
    for (const file of picked) {
      setUploading((now) => [...now, file.name]);
      try {
        const form = new FormData();
        form.set("pageId", pageId);
        if (rowId) form.set("rowId", rowId);
        form.set("purpose", "comment");
        form.set("file", file);
        const response = await fetch("/api/upload", { method: "POST", body: form, headers: idempotencyHeaders() });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(serverMessage(data.error) || t("Die Datei konnte nicht hochgeladen werden.", "The file could not be uploaded."));
        const attachment: CommentAttachment = { src: data.url, name: data.name || file.name, mime: data.mime || file.type, size: file.size };
        if (!editor.isDestroyed) emit(normalizeCommentContent(editor.getJSON()), { files: [...live.current.files, attachment] });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((now) => {
          const at = now.indexOf(file.name);
          return at < 0 ? now : [...now.slice(0, at), ...now.slice(at + 1)];
        });
      }
    }
  };
  const started = useRef(false);
  useEffect(() => {
    if (!editor || started.current || !initialFiles?.length || !attachments) return;
    started.current = true;
    void upload.current(initialFiles);
  }, [editor, initialFiles, attachments]);
  const removeFile = (index: number) => {
    if (!editor) return;
    emit(normalizeCommentContent(editor.getJSON()), { files: live.current.files.filter((_, i) => i !== index) });
  };
  // Previews of the first links (#450): what GET /api/embed finds for them
  // (server-side and SSRF-safe, lib/oembed.ts); a removed one stays away.
  const links = contentLinks(content || plainCommentContent(body)).join("\n");
  useEffect(() => {
    if (!editor) return;
    const wanted = links ? links.split("\n").filter((url) => !dismissed.current.has(url)).slice(0, MAX_COMMENT_PREVIEWS) : [];
    const kept = live.current.previews.filter((p) => wanted.includes(p.url));
    if (kept.length !== live.current.previews.length) emit(normalizeCommentContent(editor.getJSON()), { previews: kept });
    const missing = wanted.filter((url) => !kept.some((p) => p.url === url));
    if (!missing.length) return;
    let active = true;
    const timer = setTimeout(async () => {
      const found: CommentLinkPreview[] = [];
      for (const url of missing) {
        try {
          const response = await fetch(`/api/embed?url=${encodeURIComponent(url)}`, { cache: "no-store" });
          if (!response.ok) continue;
          const card = await response.json();
          let host = url;
          try {
            host = new URL(url).hostname;
          } catch {}
          found.push(
            card.kind === "card"
              ? { url, title: String(card.title || ""), site: String(card.provider || host), description: String(card.description || ""), image: String(card.image || "") }
              : { url, title: String(card.provider || host), site: host, description: "", image: "" },
          );
        } catch {}
      }
      if (!active || editor.isDestroyed || !found.length) return;
      const now = contentLinks(normalizeCommentContent(editor.getJSON()));
      const next = [...live.current.previews, ...found.filter((p) => now.includes(p.url) && !live.current.previews.some((q) => q.url === p.url))]
        .sort((a, b) => now.indexOf(a.url) - now.indexOf(b.url))
        .slice(0, MAX_COMMENT_PREVIEWS);
      try {
        emit(normalizeCommentContent(editor.getJSON()), { previews: normalizeCommentContent({ type: "doc", content: [{ type: "paragraph" }], attrs: { previews: next } }).attrs?.previews || [] });
      } catch {}
    }, 700);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, links]);
  const removePreview = (url: string) => {
    if (!editor) return;
    dismissed.current.add(url);
    emit(normalizeCommentContent(editor.getJSON()), { previews: live.current.previews.filter((p) => p.url !== url) });
  };
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  // Not a document editor: without tiptap's class (its styles and the
  // document's lookups), also when the view is mounted again later.
  useEffect(() => {
    try {
      if (editor && !editor.isDestroyed) editor.view.dom.classList.remove("tiptap");
    } catch {}
  });
  useEffect(() => {
    if (!mention) {
      setChoices([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setChoice(0);
    setChoices([]);
    const timeout = setTimeout(() => {
      controller.abort();
      setLoading(false);
      setError(t("Die Personensuche hat zu lange gedauert. Bitte erneut suchen.", "The person search took too long. Please search again."));
    }, 8000);
    const timer = setTimeout(() => {
      const query = `page=${pageId}${rowId ? `&row=${rowId}` : ""}&q=${encodeURIComponent(mention.query)}`;
      const load = async <T,>(path: string, failed: string) => {
        const r = await fetch(`${path}?${query}`, { signal: controller.signal, cache: "no-store" });
        const data = await r.json();
        if (!r.ok) throw new Error(serverMessage(data.error) || failed);
        return data as T;
      };
      // People with access, then pages and records the author may read (#450).
      void Promise.all([
        load<PersonChoice[]>("/api/threads/mentions", t("Personen konnten nicht geladen werden.", "People could not be loaded.")),
        load<PageChoice[]>("/api/threads/pages", t("Seiten konnten nicht geladen werden.", "Pages could not be loaded.")).catch(() => [] as PageChoice[]),
      ])
        .then(([people, pages]) => {
          if (!controller.signal.aborted)
            setChoices([
              ...people.map((p) => ({ kind: "person" as const, ...p })),
              ...pages.map(({ kind, ...p }) => ({ ...p, kind: "page" as const, pageKind: kind, id: p.rowId ? `${p.pageId}-${p.rowId}` : p.pageId })),
            ]);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
          clearTimeout(timeout);
        });
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(timeout);
    };
  }, [mention?.query, !!mention, pageId, rowId]);
  const actions = editor
    ? [
        {
          name: t("Fett", "Bold"),
          icon: TextB,
          active: editor.isActive("bold"),
          run: () => editor.chain().focus().toggleBold().run(),
        },
        {
          name: t("Kursiv", "Italic"),
          icon: TextItalic,
          active: editor.isActive("italic"),
          run: () => editor.chain().focus().toggleItalic().run(),
        },
        {
          name: t("Unterstreichen", "Underline"),
          icon: TextUnderline,
          active: editor.isActive("underline"),
          run: () => editor.chain().focus().toggleUnderline().run(),
        },
        {
          name: t("Durchstreichen", "Strikethrough"),
          icon: TextStrikethrough,
          active: editor.isActive("strike"),
          run: () => editor.chain().focus().toggleStrike().run(),
        },
        {
          name: t("Inline-Code", "Inline code"),
          icon: Code,
          active: editor.isActive("code"),
          run: () => editor.chain().focus().toggleCode().run(),
        },
        {
          name: t("Aufzählung", "Bulleted list"),
          icon: ListBullets,
          active: editor.isActive("bulletList"),
          run: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          name: t("Nummerierte Liste", "Numbered list"),
          icon: ListNumbers,
          active: editor.isActive("orderedList"),
          run: () => editor.chain().focus().toggleOrderedList().run(),
        },
        {
          name: t("Zitat", "Quote"),
          icon: Quotes,
          active: editor.isActive("blockquote"),
          run: () => editor.chain().focus().toggleBlockquote().run(),
        },
        {
          name: t("Codeblock", "Code block"),
          icon: Code,
          active: editor.isActive("codeBlock"),
          run: () => editor.chain().focus().toggleCodeBlock().run(),
        },
      ]
    : [];
  return (
    <fieldset className="comment-composer" disabled={disabled}>
      <span className="comment-input-label">{label}</span>
      <div
        className="comment-format-tools"
        role="toolbar"
        aria-label={`${label}: Formatierung`}
      >
        {actions.map(({ name, icon: Icon, active, run }) => (
          <button
            type="button"
            key={name}
            aria-label={t(`Kommentar: ${name}`, `Comment: ${name}`)}
            title={name}
            aria-pressed={active}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={run}
          >
            <Icon />
          </button>
        ))}
        <button
          type="button"
          aria-label={t("Kommentar: Link", "Comment: link")}
          title="Link"
          disabled={!editor || disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setMention(null);
            setLink(editor?.getAttributes("link").href || "");
          }}
        >
          <Link />
        </button>
        <button
          type="button"
          aria-label={t("Person oder Seite erwähnen", "Mention a person or page")}
          title={t("Person oder Seite erwähnen (@)", "Mention a person or page (@)")}
          disabled={!editor || disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (editor) {
              setLink(null);
              const { from, to } = editor.state.selection;
              setMention({ from, to, query: "", manual: true });
            }
          }}
        >
          <At />
        </button>
        {attachments && (
          <>
            <button
              type="button"
              aria-label={t("Datei anhängen", "Attach file")}
              title={t("Dateien oder Bilder anhängen (auch per Ziehen oder Einfügen)", "Attach files or images (also by dragging or pasting)")}
              disabled={!editor || disabled || files.length + uploading.length >= MAX_COMMENT_ATTACHMENTS}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label={t("Dateien zum Anhängen", "Files to attach")}
              onChange={(e) => {
                const picked = [...(e.target.files || [])];
                e.target.value = "";
                void upload.current(picked);
              }}
            />
          </>
        )}
      </div>
      {link !== null && (
        <div className="comment-link-editor">
          <label>
            {t("Linkadresse", "Link address")}
            <input
              aria-label={t("Kommentar-Linkadresse", "Comment link address")}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") e.preventDefault();
                if (e.key === "Escape") setLink(null);
              }}
            />
          </label>
          <button
            type="button"
            className="button compact"
            onClick={() => {
              if (!editor) return;
              if (!safeCommentLink(link)) {
                setError(
                  t("Bitte einen gültigen HTTP-, HTTPS- oder E-Mail-Link eingeben.", "Please enter a valid HTTP, HTTPS or e-mail link."),
                );
                return;
              }
              const chain = editor.chain().focus();
              if (editor.state.selection.empty && !editor.isActive("link"))
                chain.insertContent({
                  type: "text",
                  text: link,
                  marks: [{ type: "link", attrs: { href: link } }],
                });
              else chain.extendMarkRange("link").setLink({ href: link });
              chain.run();
              setLink(null);
              setError("");
            }}
          >
            {t("Link übernehmen", "Apply link")}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              editor?.chain().focus().extendMarkRange("link").unsetLink().run();
              setLink(null);
            }}
          >
            {t("Link entfernen", "Remove link")}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setLink(null)}
          >
            {t("Abbrechen", "Cancel")}
          </button>
        </div>
      )}
      <div
        className="comment-drop"
        onDragOver={(e) => {
          if (attachments && !disabled && e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!attachments || disabled || !e.dataTransfer.files.length || e.defaultPrevented) return;
          e.preventDefault();
          void upload.current([...e.dataTransfer.files]);
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <EmojiSuggest suggest={emojiSuggest} />
      {(files.length > 0 || uploading.length > 0) && <CommentFiles files={files} pending={uploading} onRemove={disabled ? undefined : removeFile} />}
      {previews.length > 0 && <CommentPreviews previews={previews} onRemove={disabled ? undefined : removePreview} />}
      {/* Sending waits for the uploads: the form does not submit meanwhile. */}
      <input
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        value=""
        readOnly={!uploading.length}
        required={uploading.length > 0}
        onChange={() => {}}
        ref={(el) => el?.setCustomValidity(uploading.length ? t("Bitte warte, bis die Anhänge hochgeladen sind.", "Please wait until the attachments are uploaded.") : "")}
      />
      {mention && (
        <div className="comment-mention-picker">
          {mention.manual && (
            <label>
              {t("Person oder Seite suchen", "Search person or page")}
              <input
                aria-label={t("Person oder Seite suchen", "Search person or page")}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={
                  choices[choice]
                    ? `${listId}-${choices[choice].id}`
                    : undefined
                }
                value={mention.query}
                autoFocus
                onChange={(e) =>
                  setMention({
                    ...mention,
                    query: e.target.value.slice(0, 100),
                  })
                }
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (
                    choices.length &&
                    ["ArrowDown", "ArrowUp"].includes(e.key)
                  ) {
                    e.preventDefault();
                    setChoice(
                      (n) =>
                        (n +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          choices.length) %
                        choices.length,
                    );
                  }
                  if (e.key === "Escape") {
                    setMention(null);
                    editor?.commands.focus();
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (choices[choice]) selectMention.current(choices[choice]);
                  }
                }}
              />
            </label>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label={t("Personen und Seiten", "People and pages")}
          >
            {choices.map((item, index) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${item.id}`}
                aria-selected={choice === index}
                key={`${item.kind}-${item.id}`}
                className={item.kind === "page" ? "comment-mention-page" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectMention.current(item)}
              >
                {item.kind === "page" ? (
                  <>
                    <span>
                      <PageIcon name={shownPageIcon(item.icon, item.rowId ? "record" : item.pageKind)} size={14} />
                      {item.title || t("Ohne Titel", "Untitled")}
                    </span>
                    <small>{item.pageTitle || (item.rowId ? t("Eintrag", "Record") : t("Seite", "Page"))}</small>
                  </>
                ) : (
                  <>
                    <span>{item.name}</span>
                    <small>{item.email}</small>
                  </>
                )}
              </button>
            ))}
          </div>
          {loading ? (
            <p role="status">{t("Personen und Seiten werden geladen …", "Loading people and pages …")}</p>
          ) : !choices.length ? (
            <p role="status">{t("Keine Person oder Seite gefunden.", "No person or page found.")}</p>
          ) : null}
          <button
            type="button"
            className="text-button"
            onClick={() => setMention(null)}
          >
            {t("Erwähnung abbrechen", "Cancel mention")}
          </button>
        </div>
      )}
      {error && (
        <p className="inline-comment-error" role="alert">
          {error}
        </p>
      )}
      <small className="comment-input-hint">
        {body.length.toLocaleString(LOCALE_TAG)} / 5.000
        {keyHints.visible && ` · ${t(`${keyHints.keys("Mod+Enter")} zum Senden`, `${keyHints.keys("Mod+Enter")} to send`)}`}
      </small>
    </fieldset>
  );
}
