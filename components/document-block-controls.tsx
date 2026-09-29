"use client";
import { Select } from "./select";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  BLOCK_SELECTION_META,
  BLOCK_MOVE_META,
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
  handleTop: number;
  glide?: Animation;
};
// Handles sit on the middle of a block's first text line, so they stay
// aligned with large headings and indented list text alike.
function firstLineCenter(editor: Editor, block: DocumentBlock, rect: DOMRect) {
  let text = block.node.isTextblock ? block.pos : -1;
  if (text < 0 && !block.node.isAtom)
    block.node.descendants((node, offset) => {
      if (text >= 0) return false;
      if (node.isTextblock) text = block.pos + 1 + offset;
      return !node.isAtom;
    });
  if (text >= 0)
    try {
      const line = editor.view.coordsAtPos(text + 1);
      if (line.bottom > line.top && line.top >= rect.top - 1)
        return (line.top + line.bottom) / 2;
    } catch {}
  return rect.top + Math.min(rect.height, 28) / 2;
}
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
// A whole list has no handle of its own: its items carry one each (like
// Notion); moving the entire list stays available in "Blöcke verwalten".
const listContainers = ["bulletList", "orderedList", "taskList"];
const listItems = ["listItem", "taskItem"];
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
      frame = requestAnimationFrame(measure);
    };
    const measure = () => {
      const host = surface.current;
      if (!host || editor.isDestroyed) return;
      // Moved blocks and their neighbours glide into place with Web
      // Animations. Handles are placed at the final positions and play the
      // same animation, so both move as one.
      const gliding = new Map<Element, Animation>();
      for (const a of editor.view.dom.getAnimations?.({ subtree: true }) ?? []) {
        const target = (a.effect as KeyframeEffect | null)?.target;
        if (
          target &&
          !("animationName" in a) &&
          !("transitionProperty" in a) &&
          a.playState === "running"
        )
          gliding.set(target, a);
      }
      const glideOf = (dom: HTMLElement) => {
        for (
          let el: HTMLElement | null = dom;
          el && el !== editor.view.dom;
          el = el.parentElement
        ) {
          const animation = gliding.get(el);
          if (animation) {
            const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
            return { animation, x: m.m41, y: m.m42 };
          }
        }
      };
      const origin = host.getBoundingClientRect();
      const next = documentBlocks(editor.state.doc).flatMap((b) => {
        const dom = editor.view.nodeDOM(b.pos);
        if (!(dom instanceof HTMLElement)) return [];
        const rect = dom.getBoundingClientRect();
        if (!rect.height || !rect.width) return [];
        const glide = glideOf(dom),
          dx = glide?.x ?? 0,
          dy = glide?.y ?? 0;
        // List items take their handle in line with the other blocks, left
        // of the bullet or checkbox, not on top of it.
        const list = listItems.includes(b.node.type.name)
          ? editor.view.nodeDOM(b.parentPos)
          : null;
        const left =
          list instanceof HTMLElement
            ? list.getBoundingClientRect().left
            : rect.left;
        return [
          {
            ...b,
            left: left - origin.left - dx,
            top: rect.top - origin.top - dy,
            width: rect.width,
            height: rect.height,
            handleTop: firstLineCenter(editor, b, rect) - origin.top - 14 - dy,
            glide: glide?.animation,
          },
        ];
      });
      geometry.current = next;
      // During a glide the handles must start in this very frame.
      if (gliding.size) flushSync(() => setBlocks(next));
      else setBlocks(next);
    };
    const transaction = ({ transaction: tr }: { transaction: Transaction }) => {
      // The slide starts right after this dispatch; measuring before the
      // next frame lets the handles glide from its very first frame.
      if (tr.getMeta(BLOCK_MOVE_META))
        queueMicrotask(() => {
          cancelAnimationFrame(frame);
          if (!editor.isDestroyed) measure();
        });
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
    const after = y > target.top + target.height / 2;
    // The boundary next to the pointer first; when the blocks cannot go
    // there (e.g. at the edge of a task list), the nearest one that works.
    const candidates = [
      { block: target, after },
      ...available
        .flatMap((b) => [
          { block: b, after: false, y: b.top },
          { block: b, after: true, y: b.top + b.height },
        ])
        .sort((a, b) => Math.abs(y - a.y) - Math.abs(y - b.y))
        .slice(0, 12),
    ];
    const valid = candidates.find(({ block, after }) => {
      try {
        changeBlocks(
          editor.state,
          drag.positions,
          "move",
          after ? block.end : block.pos,
        );
        return true;
      } catch {
        return false;
      }
    });
    if (!valid) {
      drag.target = undefined;
      setDrop(null);
      return;
    }
    drag.target = valid.after ? valid.block.end : valid.block.pos;
    // "After one block" and "before the next" are the same place: the line
    // always sits in the middle of the gap between them, so it does not
    // jump while the pointer crosses the gap.
    const edge = valid.after
      ? valid.block.top + valid.block.height
      : valid.block.top;
    const neighbour = geometry.current.find((b) =>
      valid.after ? b.pos === valid.block.end : b.end === valid.block.pos,
    );
    const top = neighbour
      ? valid.after
        ? (edge + neighbour.top) / 2
        : (neighbour.top + neighbour.height + edge) / 2
      : edge;
    setDrop({
      top,
      left: valid.block.left,
      width: valid.block.width,
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
  useLayoutEffect(() => {
    const layer = surface.current?.querySelector(".block-handle-layer");
    if (!layer) return;
    for (const block of blocks) {
      const animation = block.glide;
      if (!animation || animation.playState !== "running") continue;
      const handle = layer.querySelector(`[data-block-pos="${block.pos}"]`);
      const effect = animation.effect as KeyframeEffect | null;
      if (!(handle instanceof HTMLElement) || !effect) continue;
      const replay = handle.animate(
        effect
          .getKeyframes()
          .map(({ transform, offset, easing }) => ({ transform, offset, easing })),
        effect.getTiming(),
      );
      replay.currentTime = animation.currentTime;
    }
  }, [blocks]);
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
            {blocks
              .filter((block) => !listContainers.includes(block.node.type.name))
              .map((block) => (
              <button
                key={block.pos}
                type="button"
                data-block-pos={block.pos}
                className={`document-block-handle ${selected.current.includes(block.pos) ? "selected" : ""}`}
                style={{
                  left: Math.max(0, block.left - 25),
                  top: block.handleTop,
                }}
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
                    // A drag selects only for its own duration; the moved
                    // block's handle must not stay highlighted afterwards.
                    if (!open) {
                      remember([]);
                      setTick((t) => t + 1);
                    }
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
              <Select
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
              </Select>
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
          <Select
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
          </Select>
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
