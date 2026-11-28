"use client";
// The order of the properties on a record page (#305) and their sections
// (#646): one arrangement per database, shared by everyone and independent
// of the views' columns (database.recordLayout, lib/record-layout.ts and
// lib/record-sections.ts). Those who may change the database's structure
// drag a property by its handle or click the handle for "Nach oben" /
// "Nach unten" / "In Abschnitt verschieben"; Alt + arrow up/down on the
// handle moves it right away, across the edge of a section too. With the
// layout settings open ("Layout anpassen") they add, rename, move and
// delete sections. Everyone else sees the properties in that arrangement
// and folds sections open and closed (remembered in this browser).
import { ArrowDown, ArrowUp, CaretRight, DotsSixVertical, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Field } from "@/lib/types";
import {
  addRecordSection,
  arrangementLayout,
  moveRecordProperty,
  moveRecordSection,
  newRecordSectionId,
  recordArrangement,
  removeRecordSection,
  renameRecordSection,
  RECORD_SECTION_NAME_MAX,
  sectionOfField,
  stepRecordProperty,
  type RecordArrangement,
  type RecordPropertyTarget,
  type RecordSection,
} from "@/lib/record-sections";
import { useT } from "./i18n";
import { Select } from "./select";
import { Modal } from "./ui";

const DRAG_TYPE = "application/x-flowplan-record-property";
const COLLAPSED_PREFIX = "flowplan.record-sections:";

export type RecordArrangementSave = { order: string[]; sections: RecordSection[] };

// The sections folded in this browser, per database.
function useCollapsedSections(databaseId: string): [Set<string>, (id: string, collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState<{ databaseId: string; ids: Set<string> }>({ databaseId, ids: new Set() });
  useEffect(() => {
    let ids: string[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_PREFIX + databaseId) || "[]");
      if (Array.isArray(raw)) ids = raw.filter((id): id is string => typeof id === "string");
    } catch {}
    setCollapsed({ databaseId, ids: new Set(ids) });
  }, [databaseId]);
  return [
    collapsed.databaseId === databaseId ? collapsed.ids : new Set(),
    (id, fold) => {
      const ids = new Set(collapsed.ids);
      if (fold) ids.add(id);
      else ids.delete(id);
      setCollapsed({ databaseId, ids });
      try {
        if (ids.size) localStorage.setItem(COLLAPSED_PREFIX + databaseId, JSON.stringify([...ids]));
        else localStorage.removeItem(COLLAPSED_PREFIX + databaseId);
      } catch {}
    },
  ];
}

export function RecordPropertyList({
  databaseId,
  fields: given,
  allFields,
  order,
  sections,
  arrange,
  editSections = false,
  save,
  render,
}: {
  databaseId: string;
  // The properties shown, in the record page's order.
  fields: Field[];
  // All fields of the database (the title first), for the stored order.
  allFields: Field[];
  order: string[] | undefined;
  sections?: RecordSection[];
  // May the person change the order?
  arrange: boolean;
  // The layout settings are open: sections are added, renamed, moved and
  // deleted here.
  editSections?: boolean;
  save: (layout: RecordArrangementSave) => Promise<unknown>;
  render: (field: Field) => ReactNode;
}) {
  const t = useT();
  const [dragging, setDragging] = useState<string | null>(null),
    [drop, setDrop] = useState<{ id: string; place: "before" | "after" } | null>(null),
    [moving, setMoving] = useState<string | null>(null),
    [status, setStatus] = useState(""),
    [renaming, setRenaming] = useState<string | null>(null),
    [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useCollapsedSections(databaseId);
  // Moves show at once and are saved one after another, each with the
  // whole arrangement, so quick presses add up; the last one saved stays.
  const [pending, setPending] = useState<RecordArrangement | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()),
    sent = useRef(0);
  const arrangement = pending ?? recordArrangement(allFields, { order, sections });
  const byId = new Map(given.map((f) => [f.id, f]));
  const shownIds = new Set(byId.keys());
  const shown = (ids: string[]) => ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const groups: { section: RecordSection | null; fields: Field[] }[] = [
    { section: null, fields: shown(arrangement.top) },
    ...arrangement.sections.map((section) => ({ section, fields: shown(section.fields) })),
  ];

  function commit(next: RecordArrangement | null) {
    if (!next) return false;
    setPending(next);
    const mine = ++sent.current;
    const layout = arrangementLayout(next);
    queue.current = queue.current
      .then(() => save(layout))
      .catch(() => {})
      .finally(() => {
        if (sent.current === mine) setPending(null);
      });
    return true;
  }
  // Where a property is now, for the live region and the move dialog.
  function positionText(a: RecordArrangement, fieldId: string, now: boolean) {
    const section = sectionOfField(a, fieldId);
    const ids = (section === null ? a.top : a.sections.find((s) => s.id === section)?.fields || []).filter((id) => shownIds.has(id));
    const name = byId.get(fieldId)?.name || "";
    const at = ids.indexOf(fieldId) + 1;
    const inSection = section ? a.sections.find((s) => s.id === section)?.name : null;
    if (inSection)
      return now
        ? t(`„${name}“ ist jetzt an Position ${at} von ${ids.length} im Abschnitt „${inSection}“.`, `“${name}” is now at position ${at} of ${ids.length} in the section “${inSection}”.`)
        : t(`„${name}“ ist an Position ${at} von ${ids.length} im Abschnitt „${inSection}“.`, `“${name}” is at position ${at} of ${ids.length} in the section “${inSection}”.`);
    return now
      ? t(`„${name}“ ist jetzt an Position ${at} von ${ids.length}.`, `“${name}” is now at position ${at} of ${ids.length}.`)
      : t(`„${name}“ ist an Position ${at} von ${ids.length}.`, `“${name}” is at position ${at} of ${ids.length}.`);
  }
  function move(fieldId: string, next: RecordArrangement | null) {
    if (!commit(next)) return;
    // The handle keeps the focus where the property moved (moving a node
    // in the DOM loses it).
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches(".record-property-handle")
      ? document.activeElement.closest(".row-properties")
      : null;
    setStatus(positionText(next!, fieldId, true));
    if (focused)
      requestAnimationFrame(() =>
        focused.querySelector<HTMLElement>(`[data-property="${CSS.escape(fieldId)}"] > .record-property-handle`)?.focus(),
      );
  }
  const moveTo = (fieldId: string, to: RecordPropertyTarget) => move(fieldId, moveRecordProperty(arrangement, fieldId, to));
  const step = (fieldId: string, direction: -1 | 1) => move(fieldId, stepRecordProperty(arrangement, fieldId, direction, shownIds));
  const placeOf = (e: DragEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2 ? "before" : "after";
  };
  const dragOver = (e: DragEvent<HTMLElement>, id: string) => {
    if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const place = placeOf(e);
    if (drop?.id !== id || drop.place !== place) setDrop({ id, place });
  };
  const dragLeave = (e: DragEvent<HTMLElement>, id: string) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null) && drop?.id === id) setDrop(null);
  };
  const dropped = (e: DragEvent<HTMLElement>) => {
    const source = e.dataTransfer.getData(DRAG_TYPE) || dragging;
    setDrop(null);
    setDragging(null);
    if (!source) return null;
    e.preventDefault();
    return source;
  };
  const dropClass = (id: string) => (drop?.id === id ? ` drop-${drop.place}` : "");

  function property(f: Field) {
    if (!arrange) return <Fragment key={f.id}>{render(f)}</Fragment>;
    return (
      <div
        key={f.id}
        className={`row-property-sortable${dragging === f.id ? " dragging" : ""}${dropClass(f.id)}`}
        data-property={f.id}
        onDragOver={(e) => dragOver(e, f.id)}
        onDragLeave={(e) => dragLeave(e, f.id)}
        onDrop={(e) => {
          const source = dropped(e);
          if (source) moveTo(source, { target: f.id, place: placeOf(e) });
        }}
      >
        <button
          type="button"
          className="icon-button record-property-handle"
          draggable
          aria-label={t(`„${f.name}“ verschieben`, `Move “${f.name}”`)}
          title={t(
            "Ziehen oder klicken für Nach oben / Nach unten · Alt + Pfeil hoch/runter",
            "Drag or click for Move up / Move down · Alt + arrow up/down",
          )}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          data-no-edge-swipe=""
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, f.id);
            e.dataTransfer.effectAllowed = "move";
            const row = e.currentTarget.parentElement;
            if (row) e.dataTransfer.setDragImage(row, 12, 12);
            setDragging(f.id);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDrop(null);
          }}
          onClick={() => setMoving(f.id)}
          onKeyDown={(e) => {
            if (!e.altKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            step(f.id, e.key === "ArrowUp" ? -1 : 1);
          }}
        >
          <DotsSixVertical size={15} aria-hidden="true" />
        </button>
        {render(f)}
      </div>
    );
  }

  function sectionBlock(section: RecordSection, fields: Field[], index: number) {
    // Readers do not see a section without a property shown; editors see
    // it with a note, to drop properties into.
    if (!fields.length && !arrange) return null;
    const folded = collapsed.has(section.id);
    const bodyId = `record-section-${databaseId}-${section.id}`;
    const headingKey = `section:${section.id}`;
    return (
      <section key={section.id} className="record-section" data-section={section.id} aria-label={section.name}>
        <div
          className={`record-section-heading${dropClass(headingKey)}`}
          onDragOver={arrange ? (e) => dragOver(e, headingKey) : undefined}
          onDragLeave={arrange ? (e) => dragLeave(e, headingKey) : undefined}
          onDrop={
            arrange
              ? (e) => {
                  const source = dropped(e);
                  if (!source) return;
                  // The upper half: the end of the group above; the lower
                  // half: the start of this section.
                  if (placeOf(e) === "after") moveTo(source, { section: section.id, place: "start" });
                  else moveTo(source, { section: index === 0 ? null : arrangement.sections[index - 1].id, place: "end" });
                }
              : undefined
          }
        >
          {renaming === section.id ? (
            <SectionNameInput
              initial={section.name}
              label={t("Name des Abschnitts", "Section name")}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null && commit(renameRecordSection(arrangement, section.id, name)))
                  setStatus(t(`Abschnitt umbenannt in „${name.trim()}“.`, `Section renamed to “${name.trim()}”.`));
              }}
            />
          ) : (
            <h3>
              <button
                type="button"
                className="record-section-toggle"
                aria-expanded={!folded}
                aria-controls={bodyId}
                onClick={() => setCollapsed(section.id, !folded)}
              >
                <CaretRight size={13} weight="bold" aria-hidden="true" className="record-section-caret" />
                <span className="record-section-name">{section.name}</span>
                {folded && fields.length > 0 && <span className="record-section-count">{fields.length}</span>}
              </button>
            </h3>
          )}
          {arrange && editSections && renaming !== section.id && (
            <span className="record-section-tools">
              <button
                type="button"
                className="icon-button"
                aria-label={t(`Abschnitt „${section.name}“ umbenennen`, `Rename section “${section.name}”`)}
                title={t("Umbenennen", "Rename")}
                onClick={() => setRenaming(section.id)}
              >
                <PencilSimple size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t(`Abschnitt „${section.name}“ nach oben`, `Move section “${section.name}” up`)}
                title={t("Nach oben", "Move up")}
                disabled={index === 0}
                onClick={() => {
                  if (commit(moveRecordSection(arrangement, section.id, index - 1)))
                    setStatus(t(`Abschnitt „${section.name}“ ist jetzt an Position ${index} von ${arrangement.sections.length}.`, `Section “${section.name}” is now at position ${index} of ${arrangement.sections.length}.`));
                }}
              >
                <ArrowUp size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t(`Abschnitt „${section.name}“ nach unten`, `Move section “${section.name}” down`)}
                title={t("Nach unten", "Move down")}
                disabled={index >= arrangement.sections.length - 1}
                onClick={() => {
                  if (commit(moveRecordSection(arrangement, section.id, index + 1)))
                    setStatus(t(`Abschnitt „${section.name}“ ist jetzt an Position ${index + 2} von ${arrangement.sections.length}.`, `Section “${section.name}” is now at position ${index + 2} of ${arrangement.sections.length}.`));
                }}
              >
                <ArrowDown size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t(`Abschnitt „${section.name}“ löschen`, `Delete section “${section.name}”`)}
                title={t("Abschnitt löschen – die Eigenschaften kommen nach oben", "Delete section – its properties move to the top")}
                onClick={() => {
                  if (commit(removeRecordSection(arrangement, section.id)))
                    setStatus(t(`Abschnitt „${section.name}“ gelöscht, seine Eigenschaften stehen jetzt oben.`, `Section “${section.name}” deleted, its properties are now at the top.`));
                }}
              >
                <Trash size={15} aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
        <div id={bodyId} className="record-section-body" hidden={folded}>
          {fields.map(property)}
          {!fields.length && (
            <p
              className={`record-section-empty muted${dropClass(`empty:${section.id}`)}`}
              onDragOver={(e) => dragOver(e, `empty:${section.id}`)}
              onDragLeave={(e) => dragLeave(e, `empty:${section.id}`)}
              onDrop={(e) => {
                const source = dropped(e);
                if (source) moveTo(source, { section: section.id, place: "end" });
              }}
            >
              {t(
                "Noch keine sichtbare Eigenschaft – zieh eine hierher oder nutze „In Abschnitt verschieben“ an ihrem Griff.",
                "No visible property yet – drag one here or use “Move to section” on its handle.",
              )}
            </p>
          )}
        </div>
      </section>
    );
  }

  const movingField = moving ? byId.get(moving) : undefined;
  const movingSection = movingField ? sectionOfField(arrangement, movingField.id) : undefined;
  const movingGroup = movingField ? groups.find((g) => (g.section?.id ?? null) === movingSection)?.fields || [] : [];
  const movingIndex = movingField ? movingGroup.indexOf(movingField) : -1;
  return (
    <>
      {groups[0].fields.map(property)}
      {groups.slice(1).map((g, index) => sectionBlock(g.section!, g.fields, index))}
      {arrange && editSections && (
        adding ? (
          <div className="record-section-add">
            <SectionNameInput
              initial=""
              label={t("Name des neuen Abschnitts", "Name of the new section")}
              onDone={(name) => {
                setAdding(false);
                if (name === null) return;
                if (commit(addRecordSection(arrangement, newRecordSectionId(arrangement.sections), name)))
                  setStatus(t(`Abschnitt „${name.trim()}“ hinzugefügt.`, `Section “${name.trim()}” added.`));
              }}
            />
          </div>
        ) : (
          <button type="button" className="text-button record-section-add" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" /> {t("Abschnitt", "Section")}
          </button>
        )
      )}
      {arrange && (
        <p role="status" className="sr-only">
          {status}
        </p>
      )}
      {arrange && (
        <Modal open={!!movingField} onClose={() => setMoving(null)} title={t("Eigenschaft verschieben", "Move property")}>
          <p aria-live="polite">{movingField && positionText(arrangement, movingField.id, false)}</p>
          <p className="muted">
            {t(
              "Die Reihenfolge gilt für alle Einträge dieser Datenbank und für alle, die sie öffnen. Spalten in Tabellen und anderen Ansichten bleiben, wie sie sind.",
              "The order applies to all records of this database and to everyone who opens them. Columns in tables and other views stay as they are.",
            )}
          </p>
          {movingField && arrangement.sections.length > 0 && (
            <label className="record-section-choice">
              {t("In Abschnitt verschieben", "Move to section")}
              <Select
                value={movingSection ?? ""}
                onChange={(e) => moveTo(movingField.id, { section: e.target.value || null, place: "end" })}
              >
                <option value="">{t("Ohne Abschnitt (oben)", "No section (at the top)")}</option>
                {arrangement.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {movingField && (
            <div className="row-move-actions">
              <button
                type="button"
                className="button"
                disabled={movingIndex <= 0}
                onClick={() => moveTo(movingField.id, { section: movingSection ?? null, place: "start" })}
              >
                {t("An den Anfang", "To the top")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!stepRecordProperty(arrangement, movingField.id, -1, shownIds)}
                onClick={() => step(movingField.id, -1)}
              >
                {t("Nach oben", "Move up")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!stepRecordProperty(arrangement, movingField.id, 1, shownIds)}
                onClick={() => step(movingField.id, 1)}
              >
                {t("Nach unten", "Move down")}
              </button>
              <button
                type="button"
                className="button"
                disabled={movingIndex >= movingGroup.length - 1}
                onClick={() => moveTo(movingField.id, { section: movingSection ?? null, place: "end" })}
              >
                {t("Ans Ende", "To the end")}
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

// The name of a section, typed in place: Enter or leaving the field keeps
// it, Escape (or nothing typed) leaves it as it was.
function SectionNameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name !== null && name.trim() && name.trim() !== initial ? name : null);
  };
  return (
    <input
      className="record-section-input"
      aria-label={label}
      placeholder={t("Abschnitt, z. B. „Kontakt“", "Section, e.g. “Contact”")}
      value={value}
      maxLength={RECORD_SECTION_NAME_MAX}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}
