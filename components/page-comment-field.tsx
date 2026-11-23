"use client";
// The field for a new page or record comment (#450): a plain field until
// it is used – a click, typing, dropping or pasting files – then the
// formatted composer (components/page-comment-form.tsx) loads in its place
// with what was typed or dropped. So pages and records open without the
// comment editor.
import dynamic from "next/dynamic";
import { useState, type DragEvent } from "react";
import { loadView } from "@/components/view-fallback";
import { useT } from "./i18n";

const PageCommentForm = dynamic(() => loadView(() => import("./page-comment-form")), { ssr: false });

export function PageCommentField({
  pageId,
  rowId,
  act,
  placeholder,
  submitLabel,
}: {
  pageId: string;
  rowId?: string;
  act: (body: Record<string, unknown>) => Promise<unknown>;
  placeholder: string;
  submitLabel?: string;
}) {
  const t = useT();
  const [start, setStart] = useState<{ text: string; files: File[] } | null>(null);
  if (start)
    return (
      <PageCommentForm pageId={pageId} rowId={rowId} act={act} submitLabel={submitLabel} initialText={start.text} initialFiles={start.files} />
    );
  const files = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    setStart({ text: "", files: [...event.dataTransfer.files] });
  };
  return (
    <div className="page-comment-field">
      <textarea
        aria-label={t("Kommentar", "Comment||noun")}
        placeholder={placeholder}
        rows={2}
        value=""
        onPointerDown={() => setStart({ text: "", files: [] })}
        onChange={(e) => setStart({ text: e.target.value, files: [] })}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={files}
        onPaste={(e) => {
          if (!e.clipboardData.files.length) return;
          e.preventDefault();
          setStart({ text: "", files: [...e.clipboardData.files] });
        }}
      />
    </div>
  );
}
