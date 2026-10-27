"use client";
// The shape library: searchable sets of flowchart, BPMN, UML, ERD, org
// chart, network, cloud and wireframe shapes, plus the timeline element.
// A side panel next to the board (it stays open while shapes are added);
// on phones a sheet. Shapes are inserted with a click, Enter or by dragging
// them onto the board; arrow keys move between them.
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChartBarHorizontal, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import type { Point } from "@/lib/whiteboard-model";
import { isContainerShape, libraryDraft, librarySetNames, librarySetOrder, searchLibrary, type LibrarySetId } from "@/lib/whiteboard-shapes-library";
import { LibraryPreview } from "./library-shape";
import { timelineDraft } from "./timeline-item";
import type { BoardApi } from "./board-context";

export const LIBRARY_DRAG_TYPE = "application/x-flowplan-shape";
type T = (de: string, en: string) => string;

// Inserts a library shape (or "timeline"); large containers (pools,
// windows) go below everything else.
export function insertLibraryShape(board: BoardApi, id: string, t: T, at?: Point) {
  const draft = id === "timeline" ? timelineDraft(t) : libraryDraft(id, t);
  if (!draft) return null;
  const [item] = board.insertDrafts([draft], at);
  if (item && isContainerShape(id)) {
    const lowest = Math.min(0, ...board.items.map((i) => i.z || 0));
    board.transact(() => board.setProps(item.id, { z: lowest - 1 }));
  }
  return item;
}
// A shape dragged from the library onto the board; true when handled.
export function dropLibraryShape(board: BoardApi, e: DragEvent, at: Point, t: T) {
  const id = e.dataTransfer.getData(LIBRARY_DRAG_TYPE);
  if (!id) return false;
  e.preventDefault();
  insertLibraryShape(board, id, t, at);
  return true;
}

export function ShapeLibrary({ board, onClose }: { board: BoardApi; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [set, setSet] = useState<LibrarySetId | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchLibrary(query, t, set), [query, set, t]);
  const groups = librarySetOrder.map((id) => ({ id, shapes: results.filter((s) => s.set === id) })).filter((g) => g.shapes.length);
  const timelineMatches = !set && (!query.trim() || /zeit|time|road|plan|gantt|chrono/i.test(query));
  const add = (id: string) => {
    insertLibraryShape(board, id, t);
    if (board.dock) onClose();
  };
  // Arrow keys move between the shapes (rows follow the grid's layout).
  const navigate = (e: KeyboardEvent) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-shape]") || [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    e.preventDefault();
    const top = buttons[index].offsetTop;
    const columns = Math.max(1, buttons.filter((b) => b.offsetTop === top).length);
    const next =
      e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowDown" ? index + columns : e.key === "ArrowUp" ? index - columns : e.key === "Home" ? 0 : buttons.length - 1;
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  };
  const shapeButton = (id: string, name: [string, string], w: number, h: number) => (
    <button
      key={id}
      type="button"
      data-shape={id}
      className="wb-lib-shape"
      title={t(...name)}
      aria-label={t(...name)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBRARY_DRAG_TYPE, id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => add(id)}
    >
      {id === "timeline" ? <ChartBarHorizontal size={30} /> : <LibraryPreview id={id} w={w} h={h} />}
      <span>{t(...name)}</span>
    </button>
  );
  const body = (
    <>
      <div className="wb-lib-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          autoFocus={!board.dock}
          aria-label={t("Formen suchen", "Search shapes")}
          placeholder={t("Formen suchen, z. B. Entscheidung, Server, Button …", "Search shapes, e.g. decision, server, button …")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              grid.current?.querySelector<HTMLButtonElement>("button[data-shape]")?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              const first = timelineMatches && !results.length ? "timeline" : results[0]?.id;
              if (first) add(first);
            }
          }}
        />
      </div>
      <div className="wb-lib-sets" role="radiogroup" aria-label={t("Bibliothek", "Library")}>
        <button type="button" role="radio" aria-checked={!set} className={!set ? "active" : undefined} onClick={() => setSet(null)}>
          {t("Alle", "All")}
        </button>
        {librarySetOrder.map((id) => (
          <button key={id} type="button" role="radio" aria-checked={set === id} className={set === id ? "active" : undefined} onClick={() => setSet(set === id ? null : id)}>
            {t(...librarySetNames[id])}
          </button>
        ))}
      </div>
      <div className="wb-lib-results" ref={grid} onKeyDown={navigate}>
        {timelineMatches && (
          <section aria-label={t("Planung", "Planning")}>
            <h3>{t("Planung", "Planning")}</h3>
            <div className="wb-lib-grid">{shapeButton("timeline", ["Zeitleiste", "Timeline"], 1, 1)}</div>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-label={t(...librarySetNames[g.id])}>
            <h3>{t(...librarySetNames[g.id])}</h3>
            <div className="wb-lib-grid">{g.shapes.map((s) => shapeButton(s.id, s.name, s.w, s.h))}</div>
          </section>
        ))}
        {!groups.length && !timelineMatches && <p className="muted">{t("Keine passenden Formen.", "No matching shapes.")}</p>}
      </div>
      <p className="wb-lib-note muted">
        {t(
          "Alle Formen und Symbole sind für Flowplan gezeichnet (keine Herstellerlogos). Texte per Doppelklick bearbeiten; Abschnitte mit einer Zeile „--“ trennen.",
          "All shapes and icons are drawn for Flowplan (no vendor logos). Double-click to edit texts; separate compartments with a line “--”.",
        )}
      </p>
    </>
  );
  if (board.dock)
    return (
      <Modal open onClose={onClose} title={t("Formenbibliothek", "Shape library")} sheet className="wb-lib-sheet">
        {body}
      </Modal>
    );
  return (
    <div
      className="wb-library"
      role="dialog"
      aria-label={t("Formenbibliothek", "Shape library")}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="wb-lib-head">
        <strong>{t("Formenbibliothek", "Shape library")}</strong>
        <button type="button" aria-label={t("Formenbibliothek schließen", "Close shape library")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {body}
    </div>
  );
}
