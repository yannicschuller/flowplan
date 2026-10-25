"use client";
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import type * as Y from "yjs";
import {
  mathNodeViews,
  MathEditorDialog,
  type MathTarget,
} from "./math-editor";
import { documentExtensions, Media, widthStyle } from "@/lib/document-schema";
import { DrawBlock } from "@/lib/draw-block-node";
import { BlockDirectionExtension } from "@/lib/text-direction";
import {
  mermaidNodeView,
  DiagramEditorDialog,
  type DiagramTarget,
} from "./mermaid-editor";
import { DEFAULT_DIAGRAM } from "@/lib/mermaid-source";
import { DocumentBlockControls } from "./document-block-controls";
import { BlockShortcuts } from "@/lib/block-shortcuts";
import { EditableCodeBlock } from "./code-block";
import { embedProvider } from "@/lib/embed-providers";
import { guestCursors } from "@/lib/guest-cursors";
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
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      EditableCodeBlock,
      BlockShortcuts,
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
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  return (
    <div className="shared-rich-editor">
      <div
        className="shared-actions"
        role="toolbar"
        aria-label={t("Textformatierung", "Text formatting")}
      >
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          {t("Fett", "Bold")}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          {t("Kursiv", "Italic")}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          {t("Überschrift", "Heading")}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          {t("Liste", "List")}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        >
          {t("Checkliste", "Checklist")}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => setMath({ type: "mathInline", expression: "" })}
        >
          {t("Inline-Formel", "Inline formula")}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => setDiagram({ source: DEFAULT_DIAGRAM })}
        >
          {t("Mermaid-Diagramm", "Mermaid diagram")}
        </button>
        {upload && (
          <label className={`button${disabled ? " disabled" : ""}`}>
            {t("Datei einfügen", "Insert file")}
            <input
              type="file"
              hidden
              aria-label={t("Datei einfügen", "Insert file")}
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
              disabled={disabled}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const result = await upload(file);
                if (!result || !editor) return;
                if (result.mime.startsWith("image/"))
                  editor
                    .chain()
                    .focus()
                    .setImage({ src: result.url, alt: result.name })
                    .run();
                else
                  editor
                    .chain()
                    .focus()
                    .insertContent({
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: result.name,
                          marks: [
                            { type: "link", attrs: { href: result.url } },
                          ],
                        },
                      ],
                    })
                    .run();
              }}
            />
          </label>
        )}
      </div>
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
