"use client";
// The order of the properties on a record page (#305): one order per
// database, shared by everyone and independent of the views' columns
// (database.recordLayout, lib/record-layout.ts). Those who may change the
// database's structure drag a property by its handle or click the handle
// for "Nach oben" / "Nach unten"; Alt + arrow up/down on the handle moves
// it right away. Everyone else sees the properties in that order.
import { DotsSixVertical } from "@phosphor-icons/react";
import { Fragment, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Field } from "@/lib/types";
import { moveRecordField } from "@/lib/record-layout";
import { useT } from "./i18n";
import { Modal } from "./ui";

const DRAG_TYPE = "application/x-flowplan-record-property";

export function RecordPropertyList({
  fields: given,
  allFields,
  order,
  arrange,
  save,
  render,
}: {
  // The properties shown, in the record page's order.
  fields: Field[];
  // All fields of the database (the title first), for the stored order.
  allFields: Field[];
  order: string[] | undefined;
  // May the person change the order?
  arrange: boolean;
  save: (order: string[]) => Promise<unknown>;
  render: (field: Field) => ReactNode;
}) {
  const t = useT();
  const [dragging, setDragging] = useState<string | null>(null),
    [drop, setDrop] = useState<{ id: string; place: "before" | "after" } | null>(null),
    [moving, setMoving] = useState<string | null>(null),
    [status, setStatus] = useState("");
  // Moves show at once and are saved one after another, each with the
  // whole order, so quick presses add up; the last one saved stays.
  const [pending, setPending] = useState<string[] | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()),
    sent = useRef(0);
  const fields = pending ? [...given].sort((a, b) => pending.indexOf(a.id) - pending.indexOf(b.id)) : given;
  if (!arrange) return <>{fields.map((f) => <Fragment key={f.id}>{render(f)}</Fragment>)}</>;
  function move(fieldId: string, targetId: string | undefined, place: "before" | "after") {
    if (!targetId) return;
    const next = moveRecordField(allFields, pending ?? order, fieldId, targetId, place);
    if (!next) return;
    setPending(next);
    const mine = ++sent.current;
    queue.current = queue.current
      .then(() => save(next))
      .catch(() => {})
      .finally(() => {
        if (sent.current === mine) setPending(null);
      });
    // The handle keeps the focus where the property moved (moving a node
    // in the DOM loses it).
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches(".record-property-handle")
      ? document.activeElement.closest(".row-properties")
      : null;
    const shown = next.filter((id) => fields.some((f) => f.id === id));
    const name = fields.find((f) => f.id === fieldId)?.name || "";
    setStatus(
      t(
        `„${name}“ ist jetzt an Position ${shown.indexOf(fieldId) + 1} von ${shown.length}.`,
        `“${name}” is now at position ${shown.indexOf(fieldId) + 1} of ${shown.length}.`,
      ),
    );
    if (focused)
      requestAnimationFrame(() =>
        focused.querySelector<HTMLElement>(`[data-property="${CSS.escape(fieldId)}"] > .record-property-handle`)?.focus(),
      );
  }
  const neighbour = (fieldId: string, step: number) => fields[fields.findIndex((f) => f.id === fieldId) + step]?.id;
  const placeOf = (e: DragEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2 ? "before" : "after";
  };
  const movingField = fields.find((f) => f.id === moving);
  const movingIndex = movingField ? fields.indexOf(movingField) : -1;
  return (
    <>
      {fields.map((f) => (
        <div
          key={f.id}
          className={`row-property-sortable${dragging === f.id ? " dragging" : ""}${drop?.id === f.id ? ` drop-${drop.place}` : ""}`}
          data-property={f.id}
          onDragOver={(e) => {
            if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const place = placeOf(e);
            if (drop?.id !== f.id || drop.place !== place) setDrop({ id: f.id, place });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && drop?.id === f.id) setDrop(null);
          }}
          onDrop={(e) => {
            const source = e.dataTransfer.getData(DRAG_TYPE) || dragging;
            setDrop(null);
            setDragging(null);
            if (!source) return;
            e.preventDefault();
            move(source, f.id, placeOf(e));
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
              const up = e.key === "ArrowUp";
              move(f.id, neighbour(f.id, up ? -1 : 1), up ? "before" : "after");
            }}
          >
            <DotsSixVertical size={15} aria-hidden="true" />
          </button>
          {render(f)}
        </div>
      ))}
      <p role="status" className="sr-only">
        {status}
      </p>
      <Modal
        open={!!movingField}
        onClose={() => setMoving(null)}
        title={t("Eigenschaft verschieben", "Move property")}
      >
        <p aria-live="polite">
          {movingField &&
            t(
              `„${movingField.name}“ ist an Position ${movingIndex + 1} von ${fields.length}.`,
              `“${movingField.name}” is at position ${movingIndex + 1} of ${fields.length}.`,
            )}
        </p>
        <p className="muted">
          {t(
            "Die Reihenfolge gilt für alle Einträge dieser Datenbank und für alle, die sie öffnen. Spalten in Tabellen und anderen Ansichten bleiben, wie sie sind.",
            "The order applies to all records of this database and to everyone who opens them. Columns in tables and other views stay as they are.",
          )}
        </p>
        {movingField && (
          <div className="row-move-actions">
            <button
              type="button"
              className="button"
              disabled={movingIndex <= 0}
              onClick={() => move(movingField.id, fields[0]?.id, "before")}
            >
              {t("An den Anfang", "To the top")}
            </button>
            <button
              type="button"
              className="button"
              disabled={movingIndex <= 0}
              onClick={() => move(movingField.id, neighbour(movingField.id, -1), "before")}
            >
              {t("Nach oben", "Move up")}
            </button>
            <button
              type="button"
              className="button"
              disabled={movingIndex >= fields.length - 1}
              onClick={() => move(movingField.id, neighbour(movingField.id, 1), "after")}
            >
              {t("Nach unten", "Move down")}
            </button>
            <button
              type="button"
              className="button"
              disabled={movingIndex >= fields.length - 1}
              onClick={() => move(movingField.id, fields.at(-1)?.id, "after")}
            >
              {t("Ans Ende", "To the end")}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
