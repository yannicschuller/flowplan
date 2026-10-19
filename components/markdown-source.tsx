"use client";
// "Als Markdown bearbeiten": the page as Markdown in a plain text field.
// "Übernehmen" puts the converted text in place of the editor's content as
// one change (undo takes it back), after the server kept the page's current
// state as a version. Blocks without a Markdown form stand in the text as
// <!-- flowplan:block N … --> and come back unchanged; a marker removed from
// the text removes its block, after asking.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useT } from "./i18n";
import { api } from "./ui";
import { flushOpenDocuments } from "@/lib/document-flush";

type Source = {
  markdown: string;
  blocks: { html: string; label: string }[];
  lossy: string[];
  // The editor's content the text was made from.
  html: string;
};

export function MarkdownSourceView({
  editor,
  pageId,
  editable,
  notice,
  onClose,
  onError,
}: {
  editor: Editor;
  pageId: string;
  editable: boolean;
  notice?: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState<Source | null>(null),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    // Someone changed the page since the text was made.
    [changed, setChanged] = useState(false),
    // Kept blocks the text no longer names, waiting for a yes.
    [missing, setMissing] = useState<string[] | null>(null),
    [failed, setFailed] = useState("");
  const field = useRef<HTMLTextAreaElement>(null),
    gutter = useRef<HTMLDivElement>(null);
  // Only the latest request counts (a slower earlier one must not replace
  // what is already being edited).
  const ticket = useRef(0);
  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setFailed("");
    setMissing(null);
    try {
      const html = editor.getHTML();
      const result = await api<Omit<Source, "html">>("/api/command", { action: "document.markdown", pageId, html });
      if (mine !== ticket.current) return;
      setSource({ ...result, html });
      setText(result.markdown);
      setChanged(false);
    } catch (error) {
      if (mine === ticket.current) setFailed((error as Error).message);
    }
  }, [editor, pageId]);
  useEffect(() => {
    void load();
  }, [load]);
  // Changes of others arrive in the (hidden) editor meanwhile.
  useEffect(() => {
    if (!source) return;
    const update = () => setChanged(editor.getHTML() !== source.html);
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor, source]);
  const edited = !!source && text !== source.markdown;
  async function apply(confirmed: boolean) {
    if (!source || !editable || busy) return;
    // Checked again right before: the page may have changed meanwhile.
    if (editor.getHTML() !== source.html && !changed) {
      setChanged(true);
      return;
    }
    setBusy(true);
    try {
      const request = {
        action: "document.markdown.apply",
        pageId,
        markdown: text,
        blocks: source.blocks.map((block) => block.html),
      };
      if (!confirmed) {
        const check = await api<{ missing: number[] }>("/api/command", { ...request, check: true });
        if (check.missing.length) {
          setMissing(check.missing.map((index) => source.blocks[index]?.label || "?"));
          return;
        }
      }
      // What is open goes to the server first, so the version holds it.
      await flushOpenDocuments();
      const result = await api<{ html: string }>("/api/command", request);
      editor.chain().setContent(result.html, { emitUpdate: true }).run();
      onClose();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const lines = text.split("\n").length;
  const readOnly = !editable || !source;
  return (
    <section className="markdown-source" aria-label={t("Markdown-Quelltext", "Markdown source")}>
      <div className="markdown-source-head">
        <strong>{editable ? t("Als Markdown bearbeiten", "Edit as Markdown") : t("Markdown-Ansicht", "Markdown view")}</strong>
        <span className="markdown-source-actions">
          <button
            type="button"
            className="button compact"
            disabled={!source}
            onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}
          >
            {t("Kopieren", "Copy")}
          </button>
          <button type="button" className="button compact" onClick={onClose}>
            {edited ? t("Verwerfen", "Discard") : t("Schließen", "Close")}
          </button>
          {editable && (
            <button
              type="button"
              className="button compact primary"
              disabled={!source || busy || !edited}
              title={t("Übernehmen (⌘↵)", "Apply (⌘↵)")}
              onClick={() => void apply(false)}
            >
              {changed ? t("Trotzdem übernehmen", "Apply anyway") : t("Übernehmen", "Apply")}
            </button>
          )}
        </span>
      </div>
      {notice && <p className="markdown-source-note">{notice}</p>}
      {!editable && !notice && (
        <p className="markdown-source-note">{t("Du kannst diese Seite nur lesen.", "You can only read this page.")}</p>
      )}
      {editable && source && (
        <p className="markdown-source-note muted">
          {source.blocks.length > 0
            ? t(
                "Blöcke ohne Markdown-Form (z. B. Einbettungen, Whiteboards, verknüpfte Datenbanken, synchronisierte Blöcke, Spalten) stehen als <!-- flowplan:block … --> im Text: verschieben oder löschen geht, ändern nicht. ",
                "Blocks without a Markdown form (e.g. embeds, whiteboards, linked databases, synced blocks, columns) are in the text as <!-- flowplan:block … -->: you can move or delete them, not change them. ",
              )
            : ""}
          {source.lossy.length > 0
            ? t(`Beim Übernehmen gehen verloren: ${source.lossy.join(", ")}. `, `Lost when applying: ${source.lossy.join(", ")}. `)
            : ""}
          {t("Vor dem Übernehmen wird eine Version gespeichert; Rückgängig nimmt die Änderung zurück.", "A version is saved before applying; Undo takes the change back.")}
        </p>
      )}
      {changed && (
        <div className="markdown-source-warning" role="alert">
          <span>
            {t(
              "Die Seite wurde inzwischen geändert. Übernehmen ersetzt auch diese Änderungen.",
              "The page has been changed in the meantime. Applying also replaces these changes.",
            )}
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (!edited || confirm(t("Den Text neu laden? Deine Änderungen hier gehen verloren.", "Reload the text? Your changes here will be lost.")))
                void load();
            }}
          >
            {t("Neu laden", "Reload")}
          </button>
        </div>
      )}
      {missing && (
        <div className="markdown-source-warning" role="alert">
          <span>
            {t("Diese Blöcke fehlen im Text und werden entfernt:", "These blocks are missing from the text and will be removed:")}{" "}
            <strong>{missing.join(", ")}</strong>
          </span>
          <span className="markdown-source-actions">
            <button type="button" className="button compact" onClick={() => setMissing(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button compact danger" disabled={busy} onClick={() => void apply(true)}>
              {t("Entfernen und übernehmen", "Remove and apply")}
            </button>
          </span>
        </div>
      )}
      {failed && (
        <p className="markdown-source-warning" role="alert">
          {failed}
        </p>
      )}
      <div className="markdown-source-editor">
        <div className="markdown-source-lines" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <textarea
          ref={field}
          className="markdown-source-text"
          aria-label={t("Markdown", "Markdown")}
          spellCheck={false}
          wrap="off"
          readOnly={readOnly}
          value={source ? text : t("Wird geladen …", "Loading …")}
          onChange={(event) => {
            setText(event.target.value);
            setMissing(null);
          }}
          onScroll={(event) => {
            if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void apply(false);
            }
            if (event.key === "Escape" && !edited) onClose();
          }}
        />
      </div>
    </section>
  );
}
