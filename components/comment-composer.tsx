"use client";
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
  createElement,
  type ReactNode,
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
} from "@phosphor-icons/react";
import {
  normalizeCommentContent,
  plainCommentContent,
  commentText,
  safeCommentLink,
  type CommentNode,
} from "@/lib/comment-content";
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
type MentionChoice = { id: string; name: string; email: string };
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
}: {
  body: string;
  content?: CommentNode | null;
  onChange: (body: string, content: CommentNode) => void;
  label: string;
  pageId: string;
  rowId?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  const listId = useId();
  const [error, setError] = useState(""),
    [mention, setMention] = useState<MentionRange | null>(null),
    [choices, setChoices] = useState<MentionChoice[]>([]),
    [choice, setChoice] = useState(0),
    [loading, setLoading] = useState(false),
    [link, setLink] = useState<string | null>(null),
    [, render] = useState(0);
  const live = useRef({ onChange, mention, choices, choice });
  live.current = { onChange, mention, choices, choice };
  const selectMention = useRef<(person: MentionChoice) => void>(() => {});
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        link: { openOnClick: false, isAllowedUri: safeCommentLink },
      }),
      Mention,
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
      handleKeyDown(view, event) {
        if (event.isComposing) return false;
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
      const next = normalizeCommentContent(editor.getJSON());
      live.current.onChange(commentText(next), next);
      setError("");
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
  selectMention.current = (person) => {
    const range = live.current.mention;
    if (!editor || !range || disabled) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: range.from, to: range.to }, [
        {
          type: "mention",
          attrs: { userId: person.id, label: person.name.slice(0, 200) },
        },
        { type: "text", text: " " },
      ])
      .run();
    setMention(null);
    setChoices([]);
  };
  useEffect(() => {
    if (!editor) return;
    const next = content || plainCommentContent(body);
    if (
      JSON.stringify(normalizeCommentContent(editor.getJSON())) !==
      JSON.stringify(next)
    )
      editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, body, content]);
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
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
      void fetch(
        `/api/threads/mentions?page=${pageId}${rowId ? `&row=${rowId}` : ""}&q=${encodeURIComponent(mention.query)}`,
        { signal: controller.signal, cache: "no-store" },
      )
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok)
            throw new Error(
              data.error || t("Personen konnten nicht geladen werden.", "People could not be loaded."),
            );
          if (!controller.signal.aborted) setChoices(data);
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
          aria-label={t("Person erwähnen", "Mention a person")}
          title={t("Person erwähnen (@)", "Mention a person (@)")}
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
      <EditorContent editor={editor} />
      {mention && (
        <div className="comment-mention-picker">
          {mention.manual && (
            <label>
              {t("Person suchen", "Search person")}
              <input
                aria-label={t("Person suchen", "Search person")}
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
            aria-label={t("Personen mit Seitenzugriff", "People with access to the page")}
          >
            {choices.map((person, index) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${person.id}`}
                aria-selected={choice === index}
                key={person.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectMention.current(person)}
              >
                <span>{person.name}</span>
                <small>{person.email}</small>
              </button>
            ))}
          </div>
          {loading ? (
            <p role="status">{t("Personen werden geladen …", "Loading people …")}</p>
          ) : !choices.length ? (
            <p role="status">{t("Keine berechtigte Person gefunden.", "No person with access found.")}</p>
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
        {body.length.toLocaleString("de-DE")} / 5.000 · ⌘/Strg+Enter zum Senden
      </small>
    </fieldset>
  );
}
export function CommentBody({
  content,
  body,
}: {
  content?: CommentNode | null;
  body: string;
}) {
  const t = useT();
  function render(node: CommentNode, index: number): ReactNode {
    let child: ReactNode =
      node.type === "text" ? node.text : (node.content || []).map(render);
    if (node.type === "mention")
      child = (
        <span
          className="comment-mention"
          data-comment-mention={node.attrs?.userId || undefined}
          title={
            node.attrs?.userId ? t("Erwähnte Person", "Mentioned person") : t("Historische Erwähnung", "Historic mention")
          }
        >
          @{node.attrs?.label}
        </span>
      );
    if (node.type === "hardBreak") child = <br />;
    for (const mark of node.marks || []) {
      if (mark.type === "link") {
        if (safeCommentLink(mark.attrs?.href))
          child = (
            <a href={mark.attrs.href} target="_blank" rel="noopener noreferrer">
              {child}
            </a>
          );
      } else {
        const tags = {
          bold: "strong",
          italic: "em",
          underline: "u",
          strike: "s",
          code: "code",
        };
        child = createElement(tags[mark.type] || "span", null, child);
      }
    }
    if (["text", "mention", "hardBreak"].includes(node.type))
      return <span key={index}>{child}</span>;
    if (node.type === "codeBlock")
      return (
        <pre key={index}>
          <code>{child}</code>
        </pre>
      );
    const tags: Record<string, string> = {
      doc: "div",
      paragraph: "p",
      blockquote: "blockquote",
      bulletList: "ul",
      orderedList: "ol",
      listItem: "li",
    };
    return createElement(
      tags[node.type] || "div",
      {
        key: index,
        ...(node.type === "orderedList" ? { start: node.attrs?.start } : {}),
      },
      child,
    );
  }
  return (
    <div className="comment-rich-body">
      {content ? render(content, 0) : <p>{body}</p>}
    </div>
  );
}
