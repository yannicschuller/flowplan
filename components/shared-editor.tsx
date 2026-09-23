"use client";
import { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import {
  mathNodeViews,
  MathEditorDialog,
  type MathTarget,
} from "./math-editor";
import { documentExtensions, Media } from "@/lib/document-schema";
import {
  mermaidNodeView,
  DiagramEditorDialog,
  type DiagramTarget,
} from "./mermaid-editor";
import { DEFAULT_DIAGRAM } from "@/lib/mermaid-source";
import { DocumentBlockControls } from "./document-block-controls";
import { BlockShortcuts } from "@/lib/block-shortcuts";
import { EditableCodeBlock } from "./code-block";
export default function SharedEditor({
  html,
  onChange,
  disabled,
}: {
  html: string;
  onChange: (html: string) => void;
  disabled: boolean;
}) {
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
          e.name === "media"
            ? Media.extend({
                renderHTML: ({ node }) => {
                  const { src, kind } = node.attrs;
                  if (
                    ["audio", "video"].includes(kind) &&
                    /^\/api\/share\/[\w-]+\/files\/[\w-]+$/.test(src)
                  )
                    return [kind, { src, controls: true, preload: "metadata" }];
                  if (
                    kind === "embed" &&
                    /^https:\/\/www.youtube-nocookie.com\/embed\/[\w-]+$/.test(
                      src,
                    )
                  )
                    return [
                      "iframe",
                      {
                        src,
                        title: "Video",
                        sandbox:
                          "allow-scripts allow-same-origin allow-presentation",
                        loading: "lazy",
                      },
                    ];
                  return ["p", {}, "Medium nicht verfügbar"];
                },
              })
            : e,
        ),
    ],
    content: html,
    editable: !disabled,
    editorProps: {
      attributes: {
        "aria-label": "Geteilten Inhalt bearbeiten",
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
        aria-label="Textformatierung"
      >
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          Fett
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          Kursiv
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          Überschrift
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          Liste
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        >
          Checkliste
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => setMath({ type: "mathInline", expression: "" })}
        >
          Inline-Formel
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => setDiagram({ source: DEFAULT_DIAGRAM })}
        >
          Mermaid-Diagramm
        </button>
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
