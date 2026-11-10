"use client";
// The tab "Inhalt" of the page overview: the notebook's table of contents –
// chapters, sub-chapters and sections the person marked ("Seite als
// Kapitel markieren" in a sheet's menu, a lasso selection "Als Überschrift
// ins Inhaltsverzeichnis" through addOutlineHeading, outline-api.ts) – and
// below it the bookmarked sheets with their titles. A tap jumps there;
// editors rename, nest (indent, outdent), reorder and remove entries, with
// buttons and keys (Alt + arrows move, Tab / Shift+Tab nest).
import { useState } from "react";
import { ArrowDown, ArrowUp, BookmarkSimple, PencilSimpleLine, Plus, TextIndent, TextOutdent, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { cleanTitle, OUTLINE_TITLE_MAX, outlineIndent, outlineMove, type OutlineEntry } from "@/lib/notebook-organize-model";
import type { NotebookSheet } from "@/lib/notebook";

export function NotebookOutline({
  sheets,
  outline,
  current,
  canEdit,
  onShow,
  onChange,
  onAddChapter,
}: {
  sheets: NotebookSheet[];
  outline: OutlineEntry[];
  current: string;
  canEdit: boolean;
  onShow: (sheetId: string, y?: number) => void;
  onChange: (next: OutlineEntry[]) => Promise<void> | void;
  onAddChapter: (sheetId: string) => void;
}) {
  const t = useT();
  const number = new Map(sheets.map((s, i) => [s.id, i + 1]));
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const bookmarks = sheets.filter((s) => s.bookmark);
  const save = (next: OutlineEntry[]) => {
    if (next !== outline) void onChange(next);
  };
  const rename = () => {
    if (!editing) return;
    const title = cleanTitle(editing.title, OUTLINE_TITLE_MAX);
    setEditing(null);
    if (title) save(outline.map((e) => (e.id === editing.id ? { ...e, title } : e)));
  };
  const keys = (event: React.KeyboardEvent, entry: OutlineEntry) => {
    if (!canEdit) return;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      save(outlineMove(outline, entry.id, event.key === "ArrowUp" ? -1 : 1));
    } else if (event.key === "Tab" && event.altKey) {
      event.preventDefault();
      save(outlineIndent(outline, entry.id, event.shiftKey ? -1 : 1));
    } else if (event.key === "F2") {
      event.preventDefault();
      setEditing({ id: entry.id, title: entry.title });
    }
  };
  return (
    <div className="notebook-outline">
      <section aria-labelledby="notebook-outline-heading">
        <div className="notebook-outline-head">
          <h3 id="notebook-outline-heading">{t("Inhaltsverzeichnis", "Table of contents")}</h3>
          {canEdit && current && (
            <button type="button" className="notebook-chip" onClick={() => onAddChapter(current)}>
              <Plus size={15} /> {t(`Blatt ${number.get(current) ?? 1} als Kapitel`, `Sheet ${number.get(current) ?? 1} as a chapter`)}
            </button>
          )}
        </div>
        {outline.length ? (
          <ol className="notebook-outline-list">
            {outline.map((entry, i) => (
              <li key={entry.id} className={`notebook-outline-entry level-${entry.level}`}>
                {editing?.id === entry.id ? (
                  <input
                    className="notebook-outline-input"
                    autoFocus
                    value={editing.title}
                    maxLength={OUTLINE_TITLE_MAX}
                    aria-label={t("Titel des Eintrags", "Title of the entry")}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    onBlur={rename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") rename();
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="notebook-outline-open"
                    onClick={() => onShow(entry.sheet, entry.y)}
                    onKeyDown={(e) => keys(e, entry)}
                    title={canEdit ? t("Springen; Alt+Pfeile verschieben, Alt+Tab rückt ein, F2 benennt um", "Jump; Alt+arrows move, Alt+Tab indents, F2 renames") : undefined}
                  >
                    <span className="notebook-outline-title">{entry.title}</span>
                    <span className="notebook-outline-page">{number.get(entry.sheet)}</span>
                  </button>
                )}
                {canEdit && editing?.id !== entry.id && (
                  <span className="notebook-outline-tools">
                    <button type="button" className="icon-button" aria-label={t(`${entry.title} umbenennen`, `Rename ${entry.title}`)} title={t("Umbenennen", "Rename")} onClick={() => setEditing({ id: entry.id, title: entry.title })}>
                      <PencilSimpleLine size={15} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t("Ausrücken", "Outdent")} title={t("Ausrücken", "Outdent")} disabled={entry.level === 0} onClick={() => save(outlineIndent(outline, entry.id, -1))}>
                      <TextOutdent size={15} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t("Einrücken", "Indent")} title={t("Einrücken", "Indent")} disabled={i === 0 || entry.level >= 2} onClick={() => save(outlineIndent(outline, entry.id, 1))}>
                      <TextIndent size={15} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t("Nach oben", "Move up")} title={t("Nach oben", "Move up")} onClick={() => save(outlineMove(outline, entry.id, -1))}>
                      <ArrowUp size={15} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t("Nach unten", "Move down")} title={t("Nach unten", "Move down")} onClick={() => save(outlineMove(outline, entry.id, 1))}>
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={t(`${entry.title} aus dem Inhalt entfernen`, `Remove ${entry.title} from the contents`)}
                      title={t("Aus dem Inhalt entfernen", "Remove from the contents")}
                      onClick={() => save(outline.filter((e) => e.id !== entry.id).map((e, n, list) => (n === 0 ? { ...e, level: 0 } : { ...e, level: Math.min(e.level, list[n - 1].level + 1) })))}
                    >
                      <Trash size={15} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="notebook-overview-empty">
            {canEdit
              ? t(
                  "Noch kein Inhalt. Markiere ein Blatt als Kapitel (Menü des Blatts) oder eine Auswahl mit dem Lasso als Überschrift.",
                  "No contents yet. Mark a sheet as a chapter (the sheet's menu) or a lasso selection as a heading.",
                )
              : t("Dieses Notizbuch hat noch kein Inhaltsverzeichnis.", "This notebook has no table of contents yet.")}
          </p>
        )}
      </section>
      <section aria-labelledby="notebook-bookmarks-heading">
        <h3 id="notebook-bookmarks-heading">{t("Lesezeichen", "Bookmarks")}</h3>
        {bookmarks.length ? (
          <ol className="notebook-outline-list">
            {bookmarks.map((sheet) => (
              <li key={sheet.id} className="notebook-outline-entry level-0">
                <button type="button" className="notebook-outline-open" onClick={() => onShow(sheet.id)}>
                  <BookmarkSimple size={15} weight="fill" className="notebook-outline-ribbon" aria-hidden="true" />
                  <span className="notebook-outline-title">{sheet.title || t(`Blatt ${number.get(sheet.id)}`, `Sheet ${number.get(sheet.id)}`)}</span>
                  <span className="notebook-outline-page">{number.get(sheet.id)}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="notebook-overview-empty">{t("Keine Lesezeichen.", "No bookmarks.")}</p>
        )}
      </section>
    </div>
  );
}
