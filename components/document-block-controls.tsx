"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  BLOCK_SELECTION_META,
  adjacentBlockTarget,
  blockRange,
  changeBlocks,
  columnBlocks,
  documentBlocks,
  hasLinkedBlocks,
  selectedDocumentBlock,
  type DocumentBlock,
} from "@/lib/document-blocks";
import {
  captureBlockSelection,
  mapBlockSelection,
} from "@/lib/block-bookmarks";
import { applyBlockChange } from "@/lib/block-shortcuts";
import { MEDIA_WIDTHS } from "@/lib/document-schema";
import { Modal } from "./ui";
type Positioned = DocumentBlock & {
  left: number;
  top: number;
  width: number;
  height: number;
};
type Drag = {
  pointer: number;
  x: number;
  y: number;
  active: boolean;
  positions: number[];
  target?: number;
  // Dropping at the left or right edge of a block builds columns.
  column?: { pos: number; side: "left" | "right" };
  clientX: number;
  clientY: number;
};
export function DocumentBlockControls({
  editor,
  children,
  allowLinkedCopies = true,
}: {
  editor: Editor | null;
  children: ReactNode;
  allowLinkedCopies?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const selected = useRef<number[]>([]);
  const bookmarks = useRef<ReturnType<typeof captureBlockSelection>>([]);
  function remember(positions: number[]) {
    selected.current = positions;
    bookmarks.current = editor ? captureBlockSelection(editor, positions) : [];
  }
  const dragging = useRef<Drag | null>(null);
  const geometry = useRef<Positioned[]>([]);
  const [blocks, setBlocks] = useState<Positioned[]>([]),
    [open, setOpen] = useState(false),
    [, setTick] = useState(0),
    [error, setError] = useState(""),
    [destination, setDestination] = useState("");
  const [pointerActive, setPointerActive] = useState(false);
  const [drop, setDrop] = useState<{
    top: number;
    left: number;
    width: number;
    height?: number;
  } | null>(null);
  useEffect(() => {
    if (!editor || !surface.current) return;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const host = surface.current;
        if (!host || editor.isDestroyed) return;
        const origin = host.getBoundingClientRect();
        const next = documentBlocks(editor.state.doc).flatMap((b) => {
          const dom = editor.view.nodeDOM(b.pos);
          if (!(dom instanceof HTMLElement)) return [];
          const rect = dom.getBoundingClientRect();
          if (!rect.height || !rect.width) return [];
          return [
            {
              ...b,
              left: rect.left - origin.left,
              top: rect.top - origin.top,
              width: rect.width,
              height: rect.height,
            },
          ];
        });
        geometry.current = next;
        setBlocks(next);
      });
    };
    const transaction = ({ transaction: tr }: { transaction: Transaction }) => {
      if (tr.docChanged) {
        if (dragging.current) {
          dragging.current = null;
          setPointerActive(false);
          setDrop(null);
          setError(
            "Das Dokument wurde geändert. Bitte den Block erneut ziehen.",
          );
        }
        const explicit = tr.getMeta(BLOCK_SELECTION_META) as
          number[] | undefined;
        if (explicit) remember(explicit);
        else {
          bookmarks.current = mapBlockSelection(editor, tr, bookmarks.current);
          selected.current = bookmarks.current.map((bookmark) => bookmark.pos);
        }
        setTick((t) => t + 1);
      }
      refresh();
    };
    const resize = new ResizeObserver(refresh);
    resize.observe(editor.view.dom);
    resize.observe(surface.current);
    // Images and diagram previews can change height without a document transaction.
    const mutation = new MutationObserver(refresh);
    mutation.observe(editor.view.dom, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    editor.on("transaction", transaction);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    const cancelDrag = () => {
      dragging.current = null;
      setPointerActive(false);
      setDrop(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelDrag();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancelDrag);
    refresh();
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancelDrag);
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      editor.off("transaction", transaction);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      dragging.current = null;
    };
  }, [editor]);
  function select(positions: number[]) {
    remember(positions);
    setTick((t) => t + 1);
    setError("");
    setDestination("");
  }
  function perform(action: "duplicate" | "delete" | "move", target?: number) {
    if (!editor?.isEditable) {
      setError("Das Dokument kann nicht bearbeitet werden.");
      return;
    }
    try {
      const range = blockRange(editor.state.doc, selected.current);
      if (
        action === "duplicate" &&
        !allowLinkedCopies &&
        range.blocks.some((b) => hasLinkedBlocks(b.node))
      )
        throw new Error(
          "Verknüpfte Datenbanken können über Gastlinks nicht dupliziert werden.",
        );
      const tr = changeBlocks(editor.state, selected.current, action, target);
      dragging.current = null;
      setPointerActive(false);
      setDrop(null);
      applyBlockChange(editor, tr);
      setError("");
      setDestination("");
      if (!open) editor.commands.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function placeBeside(target: number, side: "left" | "right") {
    if (!editor?.isEditable) {
      setError("Das Dokument kann nicht bearbeitet werden.");
      return;
    }
    try {
      applyBlockChange(
        editor,
        columnBlocks(editor.state, selected.current, target, side),
      );
      setError("");
      editor.commands.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function shift(direction: -1 | 1) {
    if (!editor) return;
    try {
      const target = adjacentBlockTarget(
        editor.state,
        selected.current,
        direction,
      );
      if (target !== undefined) perform("move", target);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function locate(clientX: number, clientY: number) {
    const drag = dragging.current,
      host = surface.current;
    if (!drag || !host || !editor) return;
    const box = host.getBoundingClientRect(),
      x = clientX - box.left,
      y = clientY - box.top;
    if (
      clientX < box.left - 10 ||
      clientX > box.right + 10 ||
      clientY < box.top - 16 ||
      clientY > box.bottom + 16
    ) {
      drag.target = undefined;
      setDrop(null);
      return;
    }
    let range;
    try {
      range = blockRange(editor.state.doc, drag.positions);
    } catch {
      return;
    }
    const available = geometry.current.filter(
      (b) => b.end <= range.from || b.pos >= range.to,
    );
    const under = available
      .filter(
        (b) =>
          y >= b.top &&
          y <= b.top + b.height &&
          x >= b.left - 26 &&
          x <= b.left + b.width + 16,
      )
      .sort((a, b) => b.depth - a.depth);
    const target =
      under[0] ||
      available.reduce<Positioned | undefined>(
        (best, b) =>
          !best ||
          Math.min(Math.abs(y - b.top), Math.abs(y - b.top - b.height)) <
            Math.min(
              Math.abs(y - best.top),
              Math.abs(y - best.top - best.height),
            )
            ? b
            : best,
        undefined,
      );
    if (!target) {
      drag.target = undefined;
      drag.column = undefined;
      setDrop(null);
      return;
    }
    // Side zones of the block under the pointer place the blocks beside it.
    // Narrow edge strips, so ordinary drops over a block stay unaffected.
    const fromLeft = x - target.left,
      fromRight = target.left + target.width - x;
    const side =
      under[0] && fromRight >= 0 && fromRight < 48
        ? "right"
        : under[0] && fromLeft >= 0 && fromLeft < 24
          ? "left"
          : null;
    if (side) {
      try {
        columnBlocks(editor.state, drag.positions, target.pos, side);
        drag.column = { pos: target.pos, side };
        drag.target = undefined;
        setDrop({
          top: target.top,
          left:
            side === "right" ? target.left + target.width - 3 : target.left - 1,
          width: 4,
          height: target.height,
        });
        return;
      } catch {}
    }
    drag.column = undefined;
    const after = y > target.top + target.height / 2,
      boundary = after ? target.end : target.pos;
    try {
      changeBlocks(editor.state, drag.positions, "move", boundary);
    } catch {
      drag.target = undefined;
      setDrop(null);
      return;
    }
    drag.target = boundary;
    setDrop({
      top: after ? target.top + target.height : target.top,
      left: target.left,
      width: target.width,
    });
  }
  function pointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    block: Positioned,
  ) {
    if (!editor?.isEditable || event.button !== 0) return;
    event.preventDefault();
    if (!selected.current.includes(block.pos)) select([block.pos]);
    dragging.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      active: false,
      positions: [...selected.current],
    };
    setPointerActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5)
      drag.active = true;
    if (drag.active) {
      event.preventDefault();
      locate(event.clientX, event.clientY);
    }
  }
  useEffect(() => {
    if (!pointerActive) return;
    let frame = 0;
    const scroll = () => {
      const drag = dragging.current;
      if (drag?.active && surface.current) {
        let element: HTMLElement | null = surface.current.parentElement;
        while (
          element &&
          !(
            element.scrollHeight > element.clientHeight + 1 &&
            /(auto|scroll)/.test(getComputedStyle(element).overflowY)
          )
        )
          element = element.parentElement;
        const rect = element?.getBoundingClientRect(),
          top = rect?.top || 0,
          bottom = rect?.bottom || innerHeight;
        const delta =
          drag.clientY < top + 55 ? -12 : drag.clientY > bottom - 55 ? 12 : 0;
        if (delta) {
          if (element) element.scrollTop += delta;
          else window.scrollBy(0, delta);
          locate(drag.clientX, drag.clientY);
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [editor, pointerActive]);
  const all = editor ? documentBlocks(editor.state.doc) : [];
  let rangeValid = false,
    up = false,
    down = false,
    copyAllowed = true;
  if (editor && selected.current.length)
    try {
      const range = blockRange(editor.state.doc, selected.current);
      rangeValid = true;
      up =
        adjacentBlockTarget(editor.state, selected.current, -1) !== undefined;
      down =
        adjacentBlockTarget(editor.state, selected.current, 1) !== undefined;
      copyAllowed =
        allowLinkedCopies || !range.blocks.some((b) => hasLinkedBlocks(b.node));
    } catch {}
  return (
    <>
      {editor?.isEditable && (
        <button
          className="text-button block-manager-trigger"
          type="button"
          onClick={() => {
            const block = selectedDocumentBlock(editor.state);
            if (!selected.current.length && block) select([block.pos]);
            setOpen(true);
          }}
        >
          ⠿ Blöcke verwalten
        </button>
      )}
      <div
        ref={surface}
        className={`block-editor-surface ${editor?.isEditable ? "with-block-handles" : ""}`}
      >
        {children}
        {editor?.isEditable && (
          <div className="block-handle-layer" aria-label="Blockgriffe">
            {blocks.map((block) => (
              <button
                key={block.pos}
                type="button"
                className={`document-block-handle ${selected.current.includes(block.pos) ? "selected" : ""}`}
                style={{ left: Math.max(0, block.left - 25), top: block.top }}
                aria-label={`Blockaktionen: ${block.label}`}
                title="Ziehen oder Blockaktionen öffnen"
                onPointerDown={(event) => pointerDown(event, block)}
                onPointerMove={pointerMove}
                onPointerUp={(event) => {
                  const drag = dragging.current;
                  if (!drag || drag.pointer !== event.pointerId) return;
                  const active = drag.active,
                    target = drag.target,
                    column = drag.column;
                  dragging.current = null;
                  setPointerActive(false);
                  setDrop(null);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  if (active) {
                    if (column) placeBeside(column.pos, column.side);
                    else if (target !== undefined) perform("move", target);
                    else
                      setError(
                        "An dieser Position kann der Block nicht abgelegt werden.",
                      );
                  } else setOpen(true);
                }}
                onPointerCancel={() => {
                  dragging.current = null;
                  setPointerActive(false);
                  setDrop(null);
                }}
                onLostPointerCapture={() => {
                  dragging.current = null;
                  setPointerActive(false);
                  setDrop(null);
                }}
                onClick={(event) => {
                  if (event.detail === 0) {
                    select([block.pos]);
                    setOpen(true);
                  }
                }}
              >
                ⠿
              </button>
            ))}
            {drop && (
              <div
                className="document-block-drop"
                style={drop}
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>
      {!open && error && (
        <p role="status" className="block-action-message">
          {error}
        </p>
      )}
      <Modal
        open={open}
        title="Blöcke verwalten"
        onClose={() => setOpen(false)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor?.commands.focus();
        }}
      >
        <p className="muted">
          Wähle einen Block oder mehrere benachbarte Blöcke derselben Ebene.
        </p>
        <div className="document-block-list">
          {all.map((block) => (
            <label
              key={block.pos}
              style={{ paddingLeft: 8 + block.depth * 12 }}
            >
              <input
                type="checkbox"
                aria-label={block.label}
                checked={selected.current.includes(block.pos)}
                onChange={(event) =>
                  select(
                    event.target.checked
                      ? [...selected.current, block.pos]
                      : selected.current.filter((pos) => pos !== block.pos),
                  )
                }
              />
              <span>{block.label}</span>
            </label>
          ))}
        </div>
        {(() => {
          // Videos and embeds take a width in percent of the column.
          const only =
            selected.current.length === 1
              ? all.find((b) => b.pos === selected.current[0])
              : undefined;
          if (!editor || only?.node.type.name !== "media") return null;
          return (
            <label className="block-media-width">
              Breite
              <select
                aria-label="Medienbreite"
                disabled={!editor.isEditable}
                value={String(only.node.attrs.width || 100)}
                onChange={(event) => {
                  const tr = editor.state.tr.setNodeMarkup(
                    only.pos,
                    undefined,
                    {
                      ...only.node.attrs,
                      width: Number(event.target.value),
                    },
                  );
                  editor.view.dispatch(
                    tr.setMeta(BLOCK_SELECTION_META, [only.pos]),
                  );
                  setTick((t) => t + 1);
                }}
              >
                {MEDIA_WIDTHS.map((w) => (
                  <option key={w} value={w}>
                    {w} %
                  </option>
                ))}
              </select>
            </label>
          );
        })()}
        {selected.current.length > 0 && !rangeValid && (
          <p role="status">
            Die Auswahl muss aus benachbarten Blöcken derselben Ebene bestehen.
          </p>
        )}
        <div className="block-action-buttons">
          <button
            className="button"
            type="button"
            disabled={!editor?.isEditable || !up}
            onClick={() => shift(-1)}
          >
            Nach oben
          </button>
          <button
            className="button"
            type="button"
            disabled={!editor?.isEditable || !down}
            onClick={() => shift(1)}
          >
            Nach unten
          </button>
          <button
            className="button"
            type="button"
            disabled={!editor?.isEditable || !rangeValid || !copyAllowed}
            onClick={() => perform("duplicate")}
          >
            Duplizieren
          </button>
          <button
            className="button"
            type="button"
            disabled={!editor?.isEditable || !rangeValid}
            onClick={() => perform("delete")}
          >
            Löschen
          </button>
        </div>
        {!copyAllowed && (
          <p className="muted">
            Verknüpfte Datenbanken lassen sich nur im Arbeitsbereich
            duplizieren.
          </p>
        )}
        <label>
          Zielposition
          <select
            aria-label="Block-Zielposition"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          >
            <option value="">Position auswählen …</option>
            {all.flatMap((b) => [
              <option key={`before-${b.pos}`} value={b.pos}>
                Vor: {b.label}
              </option>,
              <option key={`after-${b.pos}`} value={b.end}>
                Nach: {b.label}
              </option>,
            ])}
          </select>
        </label>
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={() => setOpen(false)}
          >
            Fertig
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!editor?.isEditable || !rangeValid || destination === ""}
            onClick={() => perform("move", Number(destination))}
          >
            Verschieben
          </button>
        </div>
        {error && (
          <p role="alert" className="math-validation">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
