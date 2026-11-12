"use client";
import { useT } from "./i18n";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowLineDown,
  ArrowLineUp,
  ArrowUp,
  ArrowBendDownRight,
  ArrowsClockwise,
  ArrowsLeftRight,
  ArrowsOutLineHorizontal,
  CaretRight,
  Check,
  CheckCircle,
  CheckSquare,
  Code,
  Copy,
  DotsThree,
  Info,
  Link as LinkIcon,
  ListBullets,
  Palette,
  Plus,
  Smiley,
  SmileyXEyes,
  Subtitles,
  SubtitlesSlash,
  ListNumbers,
  Quotes,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextT,
  Trash,
} from "@phosphor-icons/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { touchHold } from "./pointer-drag";
import { turnIntoToggle } from "@/lib/toggle-commands";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  BLOCK_SELECTION_META,
  BLOCK_MOVE_META,
  adjacentBlockTarget,
  blockRange,
  changeBlocks,
  columnBlocks,
  documentBlocks,
  hasLinkedBlocks,
  type DocumentBlock,
} from "@/lib/document-blocks";
import {
  captureBlockSelection,
  mapBlockSelection,
} from "@/lib/block-bookmarks";
import { applyBlockChange } from "@/lib/block-shortcuts";
import { foldedBlockPositions } from "@/lib/heading-folds-plugin";
import { CALLOUT_TYPES, MEDIA_WIDTHS, calloutType } from "@/lib/document-schema";
import {
  CALLOUT_COLORS,
  CALLOUT_COLOR_NAMES,
  calloutColor,
  calloutColorLabels,
  calloutIcon,
  calloutLabels,
} from "@/lib/callout-types";
import { Modal } from "./ui";
import EmojiPicker from "./emoji-picker";
import { TEXT_DIRECTION_TYPES, setBlockDirection, textDirection, type BlockDirection } from "@/lib/text-direction";
import { BlockMenu, type BlockMenuItem, type BlockMenuView } from "./block-menu";
import { CAPTION_KINDS, captionText } from "@/lib/block-captions";
import { editCaption } from "./block-captions-view";
import { useBlockHandlesAlways } from "@/lib/block-handle-prefs";
type Positioned = DocumentBlock & {
  left: number;
  top: number;
  width: number;
  height: number;
  handleTop: number;
  // Right-to-left blocks take their handle on the right.
  rtl: boolean;
  right: number;
  glide?: Animation;
  // Inside a callout or quote (#236): the block shares its first line with
  // the box, so its handle sits closer to its text, inside the box's
  // padding, and it has no "+" (that place is the box's handle).
  boxed: boolean;
};
// The glide a handle plays with its block, by handle.
const replays = new WeakMap<Element, { source: Animation; replay: Animation }>();
// Boxes whose first line is the first line of their content (a toggle has a
// title line of its own).
const BOXES = ["callout", "blockquote"];
// Handles sit on the middle of a block's first text line, so they stay
// aligned with large headings and indented list text alike.
function firstLineCenter(editor: Editor, block: DocumentBlock, rect: DOMRect, dom: HTMLElement) {
  // A toggle: the line of its title (its content may be closed).
  const summary = block.node.type.name === "toggle" ? dom.querySelector(":scope > summary") : null;
  if (summary) {
    const line = summary.getBoundingClientRect();
    if (line.height) return line.top + Math.min(line.height, 28) / 2;
  }
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
// The ⠿ of the handle, drawn (#226): the braille character sat about 3 px
// above the middle of its line box in every font, so the handle looked
// higher than the text it belongs to. Eight dots, symmetric around the
// centre of the box, which the flex button puts on its own centre.
function HandleDots() {
  return (
    <svg className="document-block-handle-dots" width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
      {[1.45, 5.15, 8.85, 12.55].flatMap((cy) => [1.45, 6.55].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.35" />))}
    </svg>
  );
}
type Drag = {
  pointer: number;
  x: number;
  y: number;
  active: boolean;
  // By touch only once the finger has held the handle (#166): a swipe over
  // it scrolls the document; mouse and pen at once.
  held: boolean;
  positions: number[];
  target?: number;
  // Dropping at the left or right edge of a block builds columns.
  column?: { pos: number; side: "left" | "right" };
  clientX: number;
  clientY: number;
};
// A whole list has no handle of its own: its items carry one each (like
// Notion); choosing all its items in the selection mode chooses the list.
const listContainers = ["bulletList", "orderedList", "taskList"];
const listItems = ["listItem", "taskItem"];
export function DocumentBlockControls({
  editor,
  children,
  allowLinkedCopies = true,
  onCopyLink,
}: {
  editor: Editor | null;
  children: ReactNode;
  allowLinkedCopies?: boolean;
  // "Link zum Block kopieren" (#88), for the block at this position.
  onCopyLink?: (pos: number) => void;
}) {
  const t = useT();
  const surface = useRef<HTMLDivElement>(null);
  const selected = useRef<number[]>([]);
  const bookmarks = useRef<Awaited<ReturnType<typeof captureBlockSelection>>>([]);
  function remember(positions: number[]) {
    selected.current = positions;
    bookmarks.current = editor ? captureBlockSelection(editor, positions) : [];
  }
  const dragging = useRef<Drag | null>(null);
  const holding = useRef<(() => void) | null>(null);
  useEffect(() => () => holding.current?.(), []);
  const geometry = useRef<Positioned[]>([]);
  const [blocks, setBlocks] = useState<Positioned[]>([]),
    [, setTick] = useState(0),
    [error, setError] = useState("");
  // The menu of a block (a click on its handle) and the selection mode
  // ("Select" in it): circles in place of the handles and a bar of actions.
  const [menu, setMenu] = useState<{ anchor: DOMRect; handle: HTMLElement | null; view: string } | null>(null),
    [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  // The callout whose own symbol is being chosen (block menu → Symbol).
  const [symbolFor, setSymbolFor] = useState<number | null>(null),
    [ownSymbol, setOwnSymbol] = useState("");
  const [pointerActive, setPointerActive] = useState(false);
  // Handles show only where they are wanted (#138): at the block under the
  // mouse, the block with the caret, a chosen block and a handle with
  // keyboard focus – or everywhere (Settings › Appearance › Editor).
  const handlesAlways = useBlockHandlesAlways();
  const [hovered, setHovered] = useState<number | null>(null);
  // The caret counts once the document has been in use (focused): a page
  // just opened shows no handle at its first block.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) setEngaged(true);
    const focus = () => setEngaged(true);
    editor.on("focus", focus);
    return () => {
      editor.off("focus", focus);
    };
  }, [editor]);
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
        const rtl = getComputedStyle(dom).direction === "rtl";
        const listRect = list instanceof HTMLElement ? list.getBoundingClientRect() : null;
        const left = listRect ? listRect.left : rect.left;
        return [
          {
            ...b,
            left: left - origin.left - dx,
            right: (listRect ? listRect.right : rect.right) - origin.left - dx,
            top: rect.top - origin.top - dy,
            width: rect.width,
            rtl,
            height: rect.height,
            handleTop: firstLineCenter(editor, b, rect, dom) - origin.top - 14 - dy,
            glide: glide?.animation,
            boxed: (() => {
              const $pos = editor.state.doc.resolve(b.pos);
              for (let d = $pos.depth; d > 0; d--) if (BOXES.includes($pos.node(d).type.name)) return true;
              return false;
            })(),
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
            t("Das Dokument wurde geändert. Bitte den Block erneut ziehen.", "The document has changed. Please drag the block again."),
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
  }
  // Not on touch screens: the keyboard would cover the page.
  function focusEditor() {
    if (!editor || pickingRef.current) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    editor.commands.focus();
  }
  function perform(action: "duplicate" | "delete" | "move", target?: number) {
    if (!editor?.isEditable) {
      setError(t("Das Dokument kann nicht bearbeitet werden.", "The document cannot be edited."));
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
          t("Verknüpfte Datenbanken können über Gastlinks nicht dupliziert werden.", "Linked databases cannot be duplicated via guest links."),
        );
      const tr = changeBlocks(editor.state, selected.current, action, target);
      dragging.current = null;
      setPointerActive(false);
      setDrop(null);
      applyBlockChange(editor, tr);
      setError("");
      focusEditor();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function placeBeside(target: number, side: "left" | "right") {
    if (!editor?.isEditable) {
      setError(t("Das Dokument kann nicht bearbeitet werden.", "The document cannot be edited."));
      return;
    }
    try {
      applyBlockChange(
        editor,
        columnBlocks(editor.state, selected.current, target, side),
      );
      setError("");
      focusEditor();
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
      held: event.pointerType !== "touch",
      // A folded heading takes its hidden section along.
      positions: foldedBlockPositions(editor.state, [...selected.current]),
    };
    setPointerActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = event.pointerId;
    holding.current?.();
    holding.current =
      event.pointerType !== "mouse"
        ? touchHold(event, () => {
            const drag = dragging.current;
            if (drag?.pointer === pointer) drag.held = true;
          })
        : null;
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.held) return;
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
      // One replay per handle and glide (a new measurement during the
      // glide must not stack another one).
      const previous = replays.get(handle);
      if (previous?.source === animation && previous.replay.playState !== "finished") continue;
      previous?.replay.cancel();
      const replay = handle.animate(
        effect
          .getKeyframes()
          .map(({ transform, offset, easing }) => ({ transform, offset, easing })),
        effect.getTiming(),
      );
      replays.set(handle, { source: animation, replay });
      // The same start time on the same timeline: the handle is in the same
      // frame of the glide as its block in every frame. A copied current
      // time could be a frame off when the page is busy (pending starts).
      const sync = () => {
        if (animation.startTime !== null && replay.playState !== "finished") replay.startTime = animation.startTime;
      };
      replay.currentTime = animation.currentTime;
      sync();
      if (animation.startTime === null) void animation.ready.then(sync, () => {});
    }
  }, [blocks]);
  const all = editor ? documentBlocks(editor.state.doc) : [];
  const byPos = new Map(all.map((b) => [b.pos, b]));
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
  // A chosen block, or one inside a chosen block (the items of a chosen list).
  function chosen(block: DocumentBlock) {
    for (let b: DocumentBlock | undefined = block; b; b = byPos.get(b.parentPos))
      if (selected.current.includes(b.pos)) return true;
    return false;
  }
  // All items of a list chosen: the list itself (it moves as a whole).
  function promote(positions: number[]) {
    for (;;) {
      const parent = byPos.get(byPos.get(positions[0])?.parentPos ?? -1);
      if (
        !parent ||
        !listContainers.includes(parent.node.type.name) ||
        all.filter((b) => b.parentPos === parent.pos).length !== positions.length
      )
        return positions;
      positions = [parent.pos];
    }
  }
  // A tap in the selection mode: the selection stays one run of
  // neighbouring blocks, so the actions always apply.
  function toggle(block: DocumentBlock) {
    let positions = [...selected.current];
    const container = positions.find(
      (pos) => pos !== block.pos && chosen(block) && byPos.get(block.parentPos)?.pos === pos,
    );
    if (container !== undefined)
      positions = all.filter((b) => b.parentPos === container).map((b) => b.pos);
    else if (!positions.includes(block.pos) && chosen(block)) positions = [];
    if (positions.includes(block.pos)) {
      const sorted = positions.sort((a, b) => a - b),
        at = sorted.indexOf(block.pos);
      positions = at === 0 ? sorted.slice(1) : sorted.slice(0, at);
    } else {
      const first = byPos.get(positions[0]);
      if (!first || first.parentPos !== block.parentPos) positions = [block.pos];
      else {
        const lo = Math.min(block.pos, ...positions),
          hi = Math.max(block.pos, ...positions);
        positions = all
          .filter((b) => b.parentPos === block.parentPos && b.pos >= lo && b.pos <= hi)
          .map((b) => b.pos);
      }
    }
    select(positions.length ? promote(positions) : []);
  }
  function openMenu(handle: HTMLElement, block?: DocumentBlock, view = "main") {
    if (menu?.handle === handle) return closeMenu();
    if (block) select([block.pos]);
    setMenu({ anchor: handle.getBoundingClientRect(), handle, view });
  }
  function closeMenu() {
    const handle = menu?.handle;
    setMenu(null);
    if (!pickingRef.current) {
      remember([]);
      setTick((t) => t + 1);
    }
    // Back to the handle when the menu closed without an action.
    requestAnimationFrame(() => {
      if (handle?.isConnected && (!document.activeElement || document.activeElement === document.body))
        handle.focus({ preventScroll: true });
    });
  }
  function startPicking() {
    pickingRef.current = true;
    setPicking(true);
    setError("");
  }
  function stopPicking() {
    pickingRef.current = false;
    setPicking(false);
    setMenu(null);
    select([]);
  }
  useEffect(() => {
    if (!picking) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) stopPicking();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  });
  // "Turn into": the current block takes another form. Runs on a text
  // selection inside the block, like the slash menu.
  function turnItems(block: DocumentBlock): BlockMenuItem[] {
    if (!editor) return [];
    const name = block.node.type.name,
      parent = byPos.get(block.parentPos)?.node.type.name;
    type Turn = [string, ReactNode, boolean, (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>];
    const run = (selection: number | { from: number; to: number }, change: Turn[3]) => () => {
      if (!editor.isEditable) return;
      if (change(editor.chain().setTextSelection(selection)).run()) focusEditor();
      else setError(t("Dieser Block lässt sich nicht so umwandeln.", "This block cannot be turned into that."));
    };
    const level = name === "heading" ? Number(block.node.attrs.level) : 0;
    let turns: Turn[] = [];
    let at: number | { from: number; to: number } = block.end - 1;
    if ((name === "paragraph" || name === "heading" || name === "codeBlock") && !listItems.includes(parent || ""))
      turns = [
        [t("Text", "Text"), <TextT key="i" />, name === "paragraph", (c) => c.setParagraph()],
        [t("Überschrift 1", "Heading 1"), <TextHOne key="i" />, level === 1, (c) => c.setHeading({ level: 1 })],
        [t("Überschrift 2", "Heading 2"), <TextHTwo key="i" />, level === 2, (c) => c.setHeading({ level: 2 })],
        [t("Überschrift 3", "Heading 3"), <TextHThree key="i" />, level === 3, (c) => c.setHeading({ level: 3 })],
        [t("Aufzählung", "Bulleted list"), <ListBullets key="i" />, false, (c) => c.setParagraph().toggleBulletList()],
        [t("Nummerierte Liste", "Numbered list"), <ListNumbers key="i" />, false, (c) => c.setParagraph().toggleOrderedList()],
        [t("Aufgabenliste", "Task list"), <CheckSquare key="i" />, false, (c) => c.setParagraph().toggleTaskList()],
        [t("Zitat", "Quote"), <Quotes key="i" />, false, (c) => c.wrapIn("blockquote")],
        [t("Hinweis", "Callout"), <Info key="i" />, false, (c) => c.wrapIn("callout", { type: "note" })],
        // Its text becomes the title (#230).
        ...(name === "paragraph"
          ? ([[t("Aufklappbarer Block", "Toggle"), <CaretRight key="i" />, false, (c) => c.command(({ tr }) => turnIntoToggle(tr, block.pos))]] as Turn[])
          : []),
        [t("Code", "Code"), <Code key="i" />, name === "codeBlock", (c) => c.setCodeBlock()],
      ];
    else if (listItems.includes(name)) {
      at = block.pos + 2;
      turns = [
        [t("Aufzählung", "Bulleted list"), <ListBullets key="i" />, parent === "bulletList", (c) => c.toggleBulletList()],
        [t("Nummerierte Liste", "Numbered list"), <ListNumbers key="i" />, parent === "orderedList", (c) => c.toggleOrderedList()],
        [t("Aufgabenliste", "Task list"), <CheckSquare key="i" />, parent === "taskList", (c) => c.toggleTaskList()],
        [t("Text", "Text"), <TextT key="i" />, false, (c) => c.liftListItem(name)],
        // The item's text becomes the title, its sub-list the content (#230).
        [t("Aufklappbarer Block", "Toggle"), <CaretRight key="i" />, false, (c) => c.command(({ tr }) => turnIntoToggle(tr, block.pos))],
      ];
    } else if (name === "blockquote" || name === "callout") {
      at = { from: block.pos + 2, to: block.end - 2 };
      turns = [
        [t("Text", "Text"), <TextT key="i" />, false, (c) => c.lift(name)],
        name === "blockquote"
          ? [t("Hinweis", "Callout"), <Info key="i" />, false, (c) => c.lift(name).wrapIn("callout", { type: "note" })]
          : [t("Zitat", "Quote"), <Quotes key="i" />, false, (c) => c.lift(name).wrapIn("blockquote")],
      ];
    }
    return turns.map(([label, icon, active, change]) => ({
      label,
      icon,
      checked: active,
      disabled: active,
      run: run(at, change),
    }));
  }
  // "Move below …": the headings of the page (and its start and end).
  function moveItems(): BlockMenuItem[] {
    if (!editor || !rangeValid) return [];
    const range = blockRange(editor.state.doc, selected.current);
    const fits = (target: number) => {
      if (target === range.from || target === range.to) return false;
      try {
        changeBlocks(editor.state, selected.current, "move", target);
        return true;
      } catch {
        return false;
      }
    };
    const items: BlockMenuItem[] = [];
    if (fits(0))
      items.push({ icon: <ArrowLineUp />, label: t("An den Anfang", "To the top"), run: () => perform("move", 0) });
    for (const b of all) {
      if (b.parentPos !== -1 || b.node.type.name !== "heading") continue;
      if (b.pos >= range.from && b.end <= range.to) continue;
      const level = Number(b.node.attrs.level) || 1;
      if (fits(b.end))
        items.push({
          icon: level === 1 ? <TextHOne /> : level === 2 ? <TextHTwo /> : <TextHThree />,
          label: b.node.textContent.trim().slice(0, 60) || t("Überschrift ohne Text", "Empty heading"),
          indent: Math.min(level, 3) - 1,
          run: () => perform("move", b.end),
        });
    }
    const end = editor.state.doc.content.size;
    if (fits(end))
      items.push({ icon: <ArrowLineDown />, label: t("Ans Ende", "To the end"), run: () => perform("move", end) });
    return items;
  }
  function menuViews(): Record<string, BlockMenuView> {
    const views: Record<string, BlockMenuView> = {};
    if (!editor) return views;
    const only = selected.current.length === 1 ? byPos.get(selected.current[0]) : undefined;
    const many = selected.current.length > 1;
    const items: BlockMenuItem[] = [
      { icon: <ArrowUp />, label: t("Nach oben", "Move up"), disabled: !up, run: () => shift(-1) },
      { icon: <ArrowDown />, label: t("Nach unten", "Move down"), disabled: !down, run: () => shift(1) },
      { icon: <ArrowBendDownRight />, label: t("Verschieben unter …", "Move below …"), disabled: !rangeValid, view: "move" },
      { icon: <Copy />, label: t("Duplizieren", "Duplicate"), disabled: !rangeValid || !copyAllowed, run: () => perform("duplicate") },
    ];
    views.move = {
      title: t("Verschieben unter …", "Move below …"),
      items: moveItems(),
      note: t("Überschriften der Seite", "Headings of the page"),
    };
    if (!views.move.items.length) views.move.note = t("Keine andere Stelle möglich.", "No other place available.");
    const turns = only ? turnItems(only) : [];
    if (turns.length) {
      items.push({ icon: <ArrowsClockwise />, label: t("Umwandeln in …", "Turn into …"), view: "turn" });
      views.turn = { title: t("Umwandeln in …", "Turn into …"), items: turns };
    }
    if (only?.node.type.name === "callout") {
      const labels = calloutLabels(t);
      items.push({ icon: <Info />, label: t("Hinweistyp", "Callout type"), view: "callout" });
      views.callout = {
        title: t("Hinweistyp", "Callout type"),
        items: CALLOUT_TYPES.map((type) => ({
          icon: <span className="block-menu-swatch" data-callout={type} aria-hidden />,
          label: labels[type],
          checked: calloutType(only.node.attrs.type) === type,
          run: () => setAttribute(only, { type }),
        })),
      };
      // Its own symbol and colour (issue #72); the kind stays its title.
      const icon = calloutIcon(only.node.attrs.icon),
        color = calloutColor(only.node.attrs.color),
        colorLabels = calloutColorLabels(t);
      items.push({ icon: <Smiley />, label: t("Symbol", "Symbol"), view: "calloutSymbol" });
      views.calloutSymbol = {
        title: t("Symbol", "Symbol"),
        items: [
          {
            icon: icon ? <span className="block-menu-emoji" aria-hidden>{icon}</span> : <Smiley />,
            label: icon ? t("Anderes Emoji oder Zeichen …", "Other emoji or character …") : t("Emoji oder Zeichen wählen …", "Choose emoji or character …"),
            run: () => {
              setOwnSymbol(icon || "");
              setSymbolFor(only.pos);
            },
          },
          {
            icon: <SmileyXEyes />,
            label: t("Symbol entfernen", "Remove symbol"),
            disabled: !icon,
            run: () => setAttribute(only, { icon: null }),
          },
        ],
        note: t("Ohne eigenes Symbol zeigt der Hinweis das Symbol seines Typs.", "Without a symbol of its own, the callout shows the icon of its type."),
      };
      items.push({ icon: <Palette />, label: t("Farbe", "Colour"), view: "calloutColor" });
      views.calloutColor = {
        title: t("Farbe", "Colour"),
        items: [
          {
            icon: <span className="block-menu-swatch" data-callout={calloutType(only.node.attrs.type)} aria-hidden />,
            label: t("Standard", "Default"),
            checked: !color,
            run: () => setAttribute(only, { color: null }),
          },
          ...CALLOUT_COLOR_NAMES.map((name) => ({
            icon: <span className="block-menu-swatch" style={{ background: CALLOUT_COLORS[name] }} aria-hidden />,
            label: colorLabels[name],
            checked: color === name,
            run: () => setAttribute(only, { color: name }),
          })),
        ],
      };
    }
    if (only?.node.type.name === "media") {
      items.push({ icon: <ArrowsOutLineHorizontal />, label: t("Breite", "Width"), view: "width" });
      views.width = {
        title: t("Breite", "Width"),
        items: MEDIA_WIDTHS.map((w) => ({
          icon: <ArrowsOutLineHorizontal />,
          label: `${w} %`,
          checked: Number(only.node.attrs.width || 100) === w,
          run: () => setAttribute(only, { width: w }),
        })),
      };
    }
    // Captions of images, tables and code (lib/block-captions.ts).
    if (only && CAPTION_KINDS[only.node.type.name]) {
      const caption = captionText(only.node.attrs.caption);
      // After the menu has closed (the sheet keeps the focus until then).
      const edit = () => setTimeout(() => editor && !editor.isDestroyed && editCaption(editor.view, only.pos), 60);
      items.push({ icon: <Subtitles />, label: caption ? t("Beschriftung bearbeiten", "Edit caption") : t("Beschriftung hinzufügen", "Add caption"), run: edit });
      if (only.node.attrs.caption !== null)
        items.push({ icon: <SubtitlesSlash />, label: t("Beschriftung entfernen", "Remove caption"), run: () => setAttribute(only, { caption: null }) });
      // The caption also as the image's description for screen readers.
      if (only.node.type.name === "image" && caption && caption !== only.node.attrs.alt)
        items.push({ icon: <Subtitles />, label: t("Beschriftung als Alternativtext", "Use caption as alt text"), run: () => setAttribute(only, { alt: caption }) });
    }
    // Text direction: automatic (by the text), left to right, right to left
    // – for the blocks and everything inside them.
    const turnable = all
      .filter((b) => selected.current.includes(b.pos))
      .filter((b) => {
        if (TEXT_DIRECTION_TYPES.includes(b.node.type.name)) return true;
        let inside = false;
        b.node.descendants((n) => {
          if (TEXT_DIRECTION_TYPES.includes(n.type.name)) inside = true;
          return !inside;
        });
        return inside;
      });
    if (turnable.length) {
      const values = new Set(turnable.map((b) => textDirection(b.node.attrs.dir) || ""));
      const value = values.size === 1 ? [...values][0] : "mixed";
      items.push({ icon: <ArrowsLeftRight />, label: t("Textrichtung", "Text direction"), view: "direction" });
      views.direction = {
        title: t("Textrichtung", "Text direction"),
        items: ([
          ["", t("Automatisch", "Automatic")],
          ["ltr", t("Links nach rechts", "Left to right")],
          ["rtl", t("Rechts nach links", "Right to left")],
        ] as const).map(([dir, label]) => ({
          icon: <ArrowsLeftRight />,
          label,
          checked: value === dir,
          run: () => setDirection(turnable, (dir || null) as BlockDirection | null),
        })),
      };
    }
    items.push("separator");
    // The link of a block, for every kind of block (#88).
    if (only && onCopyLink)
      items.push({ icon: <LinkIcon />, label: t("Link zum Block kopieren", "Copy link to block"), run: () => onCopyLink(only.pos) });
    if (!pickingRef.current)
      items.push({ icon: <CheckCircle />, label: t("Mehrere auswählen", "Select several"), run: startPicking });
    items.push({ icon: <Trash />, label: t("Löschen", "Delete"), danger: true, disabled: !rangeValid, run: () => perform("delete") });
    views.main = {
      title: many
        ? t(`${selected.current.length} Blöcke`, `${selected.current.length} blocks`)
        : only?.label || t("Block", "Block"),
      items,
      note: !copyAllowed
        ? t("Verknüpfte Datenbanken lassen sich nur im Arbeitsbereich duplizieren.", "Linked databases can only be duplicated in the workspace.")
        : undefined,
    };
    return views;
  }
  function setAttribute(block: DocumentBlock, attrs: Record<string, unknown>) {
    if (!editor?.isEditable) return;
    const tr = editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, ...attrs });
    editor.view.dispatch(tr.setMeta(BLOCK_SELECTION_META, [block.pos]));
    setTick((t) => t + 1);
  }
  // The chosen symbol for the callout of the symbol dialog (it may have
  // moved meanwhile: then it is looked up by its old place only if still a
  // callout there).
  function setSymbol(value: string) {
    const icon = calloutIcon(value),
      pos = symbolFor;
    setSymbolFor(null);
    if (!editor?.isEditable || !icon || pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== "callout") return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, icon }));
    setTick((t) => t + 1);
  }
  function setDirection(turnable: DocumentBlock[], direction: BlockDirection | null) {
    if (!editor?.isEditable) return;
    const tr = editor.state.tr;
    for (const block of turnable) setBlockDirection(tr, block.pos, direction);
    // A list whose items all go one way goes that way as a whole.
    const lists = new Set(
      turnable
        .filter((b) => listItems.includes(b.node.type.name))
        .map((b) => b.parentPos),
    );
    for (const pos of lists) {
      const list = tr.doc.nodeAt(pos);
      if (!list) continue;
      const dirs = new Set<string | null>();
      list.forEach((item) => dirs.add(textDirection(item.attrs.dir)));
      const shared = dirs.size === 1 ? [...dirs][0] : null;
      if ((list.attrs.dir ?? null) !== shared) tr.setNodeAttribute(pos, "dir", shared);
    }
    if (!tr.docChanged) return;
    editor.view.dispatch(tr.setMeta(BLOCK_SELECTION_META, [...selected.current]));
    setTick((t) => t + 1);
  }
  const visible = blocks.filter((block) => !listContainers.includes(block.node.type.name));
  // The block with the caret: the innermost one with a handle around it (a
  // selected block itself).
  // While a block is dragged the caret's handle stays where it was: the
  // dragged handle must not change under the finger.
  const caretBefore = useRef<number | null>(null);
  const caret = (() => {
    if (pointerActive) return caretBefore.current;
    if (!editor || !engaged) return null;
    const handled = new Set(visible.map((b) => b.pos));
    const selection = editor.state.selection;
    if (selection instanceof NodeSelection && handled.has(selection.from)) return selection.from;
    const { $from } = selection;
    for (let d = $from.depth; d > 0; d--) {
      const pos = $from.before(d);
      if (handled.has(pos)) return pos;
    }
    return null;
  })();
  caretBefore.current = caret;
  const isEmptyParagraph = (block: Positioned) => block.node.type.name === "paragraph" && block.node.childCount === 0;
  // An empty paragraph has a handle only while it has the caret (or is
  // chosen, or under the mouse: its "+" and ⠿ are how to fill it).
  const handles = handlesAlways
    ? visible
    : visible.filter((block) => !isEmptyParagraph(block) || block.pos === caret || block.pos === hovered || selected.current.includes(block.pos));
  // The block under the mouse (#236): anywhere on its row, the page margin
  // left of it included. The innermost block at the pointer's height wins;
  // inside a callout or quote only right of its handle, so the box's own
  // handle further left stays reachable. A gap between blocks keeps the one
  // before, and so does a pointer on a handle or "+".
  const hoverRef = useRef(hovered);
  hoverRef.current = hovered;
  useEffect(() => {
    if (!editor?.isEditable || picking) return;
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || dragging.current) return;
      const host = surface.current;
      if (!host) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".document-block-handle, .document-block-add")) return;
      const box = host.getBoundingClientRect();
      // The page column and its margin: inside the area that scrolls with
      // the page, not in the sidebar or a menu above it.
      const page = host.closest('[role="dialog"], main') || document.body;
      const inside =
        event.clientY >= box.top &&
        event.clientY <= box.bottom &&
        event.clientX >= box.left - 160 &&
        event.clientX <= box.right + 24 &&
        !!target &&
        page.contains(target) &&
        !target.closest('[role="menu"], .dropdown');
      if (!inside) {
        if (hoverRef.current !== null) setHovered(null);
        return;
      }
      const x = event.clientX - box.left,
        y = event.clientY - box.top;
      const under = geometry.current
        .filter(
          (b) =>
            !listContainers.includes(b.node.type.name) &&
            y >= b.top &&
            y <= b.top + b.height &&
            (!b.boxed || (b.rtl ? x <= b.right + 26 : x >= b.left - 26)),
        )
        .sort((a, b) => b.depth - a.depth)[0];
      if (under && under.pos !== hoverRef.current) setHovered(under.pos);
    };
    const leave = () => hoverRef.current !== null && setHovered(null);
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, [editor, picking]);
  // "+" (#236): an empty block below the block (⌥/Alt: above) with the "/"
  // menu open, as if "/" had been typed there. An empty paragraph itself
  // takes the "/".
  function addBlock(block: DocumentBlock, above: boolean) {
    if (!editor?.isEditable) return;
    const { state, view } = editor;
    const { schema } = state;
    const name = block.node.type.name;
    const tr = state.tr;
    let caretAt: number;
    if (name === "paragraph" && block.node.childCount === 0) caretAt = block.pos + 1;
    else {
      const item = listItems.includes(name);
      const paragraph = schema.nodes.paragraph.create();
      const node = item ? schema.nodes[name].create(null, paragraph) : paragraph;
      const at = above ? block.pos : block.end;
      const $at = state.doc.resolve(at);
      if (!$at.parent.canReplaceWith($at.index(), $at.index(), node.type)) {
        setError(t("Hier kann kein Block eingefügt werden.", "A block cannot be inserted here."));
        return;
      }
      tr.insert(at, node);
      caretAt = at + (item ? 2 : 1);
    }
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caretAt)).scrollIntoView());
    view.focus();
    const pos = view.state.selection.from;
    const insert = () => view.state.tr.insertText("/", pos, pos);
    if (!view.someProp("handleTextInput", (f) => f(view, pos, pos, "/", insert))) view.dispatch(insert());
    setError("");
  }
  const count = selected.current.length;
  // Chosen blocks are tinted: in the selection mode, and while the menu of
  // a block is open (#236), so it is clear what the menu applies to.
  const marked = picking || menu ? blocks.filter((b) => selected.current.includes(b.pos)) : [];
  const adding = !picking && hovered !== null && !pointerActive ? handles.find((b) => b.pos === hovered && !b.boxed) : undefined;
  return (
    <>
      <div
        ref={surface}
        className={`block-editor-surface ${editor?.isEditable ? "with-block-handles" : ""}${picking ? " picking-blocks" : ""}${blocks.some((block) => block.rtl) ? " with-rtl-blocks" : ""}`}
      >
        {children}
        {editor?.isEditable && (
          <div className={`block-handle-layer${handlesAlways ? " always-handles" : ""}`} aria-label={t("Blockgriffe", "Block handles")}>
            {marked.map((block) => (
              <div
                key={`picked-${block.pos}`}
                className={picking ? "document-block-picked" : "document-block-marked"}
                style={{ top: block.top - (picking ? 3 : 1), left: block.left - (picking ? 6 : 4), width: block.right - block.left + (picking ? 12 : 8), height: block.height + (picking ? 6 : 2) }}
                aria-hidden="true"
              />
            ))}
            {picking
              ? visible.map((block) => {
                  const on = chosen(block);
                  return (
                    <button
                      key={block.pos}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      data-block-pos={block.pos}
                      className={`document-block-pick${on ? " checked" : ""}`}
                      style={{
                        left: block.rtl ? block.right + 2 : Math.max(0, block.left - 25),
                        top: block.handleTop,
                      }}
                      aria-label={block.label}
                      onClick={() => toggle(block)}
                    >
                      {on && <Check size={12} weight="bold" aria-hidden />}
                    </button>
                  );
                })
              : handles.map((block) => (
              <button
                key={block.pos}
                type="button"
                data-block-pos={block.pos}
                // Near the left edge on phones: dragging a block is not the
                // swipe that opens the sidebar (components/drawer-swipe.ts).
                data-no-edge-swipe=""
                className={`document-block-handle${block.rtl ? " rtl" : ""}${block.boxed ? " boxed" : ""}${selected.current.includes(block.pos) ? " selected" : ""}${block.pos === caret ? " active" : ""}${block.pos === hovered ? " hovered" : ""}`}
                // Placed at the edge of the text; the gap to it is the
                // stylesheet's (wider with a mouse than on touch screens).
                style={{
                  left: block.rtl ? block.right : block.left,
                  top: block.handleTop,
                }}
                aria-label={t(`Blockaktionen: ${block.label}`, `Block actions: ${block.label}`)}
                aria-haspopup="menu"
                aria-expanded={!!menu && selected.current.includes(block.pos)}
                title={t("Ziehen zum Verschieben · Klicken für Menü", "Drag to move · Click to open menu")}
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
                        t("An dieser Position kann der Block nicht abgelegt werden.", "The block cannot be dropped at this position."),
                      );
                    // A drag selects only for its own duration; the moved
                    // block's handle must not stay highlighted afterwards.
                    remember([]);
                    setTick((t) => t + 1);
                  } else openMenu(event.currentTarget, block);
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
                  // Keyboard (Enter, Space): no pointer events before it.
                  if (event.detail === 0) openMenu(event.currentTarget, block);
                }}
              >
                <HandleDots />
              </button>
            ))}
            {adding && (
              <button
                key={`add-${adding.pos}`}
                type="button"
                // Reached by the keyboard with ↵ and "/" in the text instead.
                tabIndex={-1}
                className={`document-block-add${adding.rtl ? " rtl" : ""}`}
                style={{ left: adding.rtl ? adding.right : adding.left, top: adding.handleTop }}
                aria-label={t(`Block darunter einfügen: ${adding.label}`, `Add a block below: ${adding.label}`)}
                title={t("Klicken: Block darunter einfügen · ⌥-Klick: darüber", "Click to add a block below · ⌥-click to add above")}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => addBlock(adding, event.altKey)}
              >
                <Plus size={15} weight="bold" aria-hidden />
              </button>
            )}
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
      {!picking && error && (
        <p role="status" className="block-action-message">
          {error}
        </p>
      )}
      {menu && editor && (
        <BlockMenu
          key={`${menu.view}-${menu.anchor.top}-${menu.anchor.left}`}
          anchor={menu.anchor}
          views={menuViews()}
          initial={menu.view}
          owner={menu.handle}
          onClose={closeMenu}
        />
      )}
      {symbolFor !== null && editor && (
        <Modal
          open
          sheet
          title={t("Symbol des Hinweises", "Callout symbol")}
          onClose={() => setSymbolFor(null)}
        >
          <EmojiPicker
            allowSymbols={false}
            selected={calloutIcon(editor.state.doc.nodeAt(symbolFor)?.attrs.icon) || undefined}
            onSelect={async (emoji) => setSymbol(emoji)}
          />
          <form
            className="callout-symbol-own"
            onSubmit={(event) => {
              event.preventDefault();
              setSymbol(ownSymbol);
            }}
          >
            <label htmlFor="callout-symbol-own">{t("Oder ein eigenes Zeichen", "Or a character of your own")}</label>
            <div className="callout-symbol-own-row">
              <input
                id="callout-symbol-own"
                value={ownSymbol}
                maxLength={32}
                placeholder={t("z. B. ★, →, ✓", "e.g. ★, →, ✓")}
                onChange={(event) => setOwnSymbol(event.target.value)}
              />
              <button type="submit" className="button" disabled={!calloutIcon(ownSymbol)}>
                {t("Übernehmen", "Apply")}
              </button>
            </div>
          </form>
          {ownSymbol.trim() && !calloutIcon(ownSymbol) && (
            <p className="muted" role="status">
              {t("Nur ein einzelnes Emoji oder Symbolzeichen – keine Buchstaben, Ziffern, Satzzeichen oder Leerzeichen.", "Only a single emoji or symbol character – no letters, digits, punctuation or spaces.")}
            </p>
          )}
        </Modal>
      )}
      {picking &&
        editor?.isEditable &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="block-select-bar" role="toolbar" aria-label={t("Ausgewählte Blöcke", "Selected blocks")}>
            <span className="block-select-count" aria-live="polite">
              {error ||
                (count
                  ? count === 1
                    ? t("1 Block", "1 block")
                    : t(`${count} Blöcke`, `${count} blocks`)
                  : t("Kreise antippen zum Auswählen", "Tap the circles to select"))}
            </span>
            <div className="block-select-actions">
              <button type="button" className="icon-button" disabled={!up} aria-label={t("Nach oben", "Move up")} title={t("Nach oben", "Move up")} onClick={() => shift(-1)}>
                <ArrowUp size={18} />
              </button>
              <button type="button" className="icon-button" disabled={!down} aria-label={t("Nach unten", "Move down")} title={t("Nach unten", "Move down")} onClick={() => shift(1)}>
                <ArrowDown size={18} />
              </button>
              <button type="button" className="icon-button" disabled={!rangeValid || !copyAllowed} aria-label={t("Duplizieren", "Duplicate")} title={t("Duplizieren", "Duplicate")} onClick={() => perform("duplicate")}>
                <Copy size={18} />
              </button>
              <button type="button" className="icon-button" disabled={!rangeValid} aria-label={t("Verschieben unter …", "Move below …")} title={t("Verschieben unter …", "Move below …")} aria-haspopup="menu" onClick={(e) => openMenu(e.currentTarget, undefined, "move")}>
                <ArrowBendDownRight size={18} />
              </button>
              <button type="button" className="icon-button danger" disabled={!rangeValid} aria-label={t("Löschen", "Delete")} title={t("Löschen", "Delete")} onClick={() => perform("delete")}>
                <Trash size={18} />
              </button>
              <button type="button" className="icon-button" disabled={!rangeValid} aria-label={t("Weitere Aktionen", "More actions")} title={t("Weitere Aktionen", "More actions")} aria-haspopup="menu" onClick={(e) => openMenu(e.currentTarget)}>
                <DotsThree size={18} weight="bold" />
              </button>
            </div>
            <button type="button" className="button primary block-select-done" onClick={stopPicking}>
              {t("Fertig", "Done")}
            </button>
          </div>,
          // Inside the shell: above its tab bar on phones; in a record's
          // dialog inside the dialog, so it takes clicks there (#232).
          editor.view.dom.closest<HTMLElement>('[role="dialog"]') || document.querySelector(".app-shell") || document.body,
        )}
    </>
  );
}
