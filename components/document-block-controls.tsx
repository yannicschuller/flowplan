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
  ArrowsDownUp,
  ArrowsLeftRight,
  ArrowsOutLineHorizontal,
  CaretCircleRight,
  CaretRight,
  ChatCircle,
  Check,
  CheckCircle,
  CheckSquare,
  Code,
  Columns,
  Copy,
  CopySimple,
  DotsThree,
  FileText,
  Info,
  Link as LinkIcon,
  ListBullets,
  MathOperations,
  Palette,
  Plus,
  Scissors,
  Smiley,
  SmileyXEyes,
  Sparkle,
  Subtitles,
  SubtitlesSlash,
  ListNumbers,
  Quotes,
  TextHFour,
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
import { blockToMath, blockToToggle, blocksToColumns, colorable, setBlockColors, toggleToBlock, type TitleBlock } from "@/lib/block-turn";
import { BLOCK_COLOR_NAMES, blockColor, blockColorLabels, type BlockColorName } from "@/lib/block-colors";
import type { Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import * as pmView from "@tiptap/pm/view";
import type { ResolvedPos, Slice } from "@tiptap/pm/model";
import {
  BLOCK_SELECTION_META,
  BLOCK_MOVE_META,
  adjacentBlockTarget,
  blockRange,
  changeBlocks,
  columnBlocks,
  documentBlocks,
  blockTypeName,
  emptyBlockNear,
  hasLinkedBlocks,
  MAX_COLUMNS,
  type DocumentBlock,
} from "@/lib/document-blocks";
import {
  captureBlockSelection,
  mapBlockSelection,
} from "@/lib/block-bookmarks";
import { applyBlockChange } from "@/lib/block-shortcuts";
import { nestBlocks } from "@/lib/toggle-nesting";
import { isToggleClosed, markToggleScope, toggleKey } from "@/lib/toggle-view";
import { foldedBlockPositions } from "@/lib/heading-folds-plugin";
import { dropContainer } from "@/lib/drop-container";
import { CALLOUT_TYPES, MEDIA_WIDTHS, calloutType, toggleHeading } from "@/lib/document-schema";
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
import { BlockMenu, usePhone, type BlockMenuClose, type BlockMenuItem, type BlockMenuView } from "./block-menu";
import { showToast } from "./toast";
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
  // Inside a callout, quote or column (#236, #261): the block shares its
  // first line with the box, so its handle sits closer to its text, inside
  // the box's padding, and it has no "+" (that place is the box's handle).
  boxed: boolean;
  // A paragraph or heading indented with Tab (#246): how far its text
  // starts from its edge; the handle sits there (#255).
  indent: number;
};
// ProseMirror's own reading of pasted HTML and text (what a paste in the
// editor does), for pasting copied blocks after chosen ones (#237). Exported
// by prosemirror-view, though not in its types.
const parseFromClipboard = (pmView as unknown as {
  __parseFromClipboard: (view: Editor["view"], text: string, html: string | null, plainText: boolean, $context: ResolvedPos) => Slice | null;
}).__parseFromClipboard;
// The glide a handle plays with its block, by handle.
const replays = new WeakMap<Element, { source: Animation; replay: Animation }>();
// Boxes whose first line is the first line of their content (a toggle has a
// title line of its own); their blocks take the pointer only right of the
// box's handle. A meeting (#252) too: its handle sits at its header. And
// a column (#261): the handle of the whole layout and its "+" (a block
// below the columns) sat under the handle of the first block inside.
const BOXES = ["callout", "blockquote", "meeting", "column"];
// A block inside a closed toggle has no handle (#252): Chrome still lays out
// the content of a closed <details> and reports its rectangles, so the
// handle of a hidden block showed up over the visible blocks below. Closed
// is the toggle's state (also restored after a reload) or its element.
function inClosedToggle(editor: Editor, pos: number) {
  const $pos = editor.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name !== "toggle") continue;
    const at = $pos.before(d);
    if (isToggleClosed(editor.state, at)) return true;
    const dom = editor.view.nodeDOM(at);
    if (dom instanceof HTMLElement && ((dom instanceof HTMLDetailsElement && !dom.open) || dom.classList.contains("toggle-closed"))) return true;
  }
  return false;
}
// Handles sit on the middle of a block's first text line, so they stay
// aligned with large headings and indented list text alike.
function firstLineCenter(editor: Editor, block: DocumentBlock, rect: DOMRect, dom: HTMLElement) {
  // A toggle: the line of its title (its content may be closed).
  // A meeting (#252): the row of its title, not the first line of its summary.
  const summary =
    block.node.type.name === "toggle"
      ? dom.querySelector(":scope > summary")
      : block.node.type.name === "meeting"
        ? dom.querySelector(".meeting-head-row") || dom.querySelector(".meeting-title")
        : null;
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
  // ⌥/Alt held: a copy is dropped, the blocks stay (#239).
  copy?: boolean;
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
  onTurnIntoPage,
  onAskAi,
  comments = false,
}: {
  editor: Editor | null;
  children: ReactNode;
  allowLinkedCopies?: boolean;
  // "Link zum Block kopieren" (#88), for the block at this position.
  onCopyLink?: (pos: number) => void;
  // "Umwandeln in → Seite" (#238): the blocks become a sub-page, a link to
  // it takes their place.
  onTurnIntoPage?: (positions: number[]) => Promise<void>;
  // "KI fragen" (#238) for the text from `from` to `to`.
  onAskAi?: (from: number, to: number) => void;
  // "Kommentieren" (#238): the editor has inline comments.
  comments?: boolean;
}) {
  const t = useT();
  const phone = usePhone();
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
  type Box = { top: number; left: number; width: number; height: number };
  const [drop, setDrop] = useState<{
    top: number;
    left: number;
    width: number;
    height?: number;
    // The block that receives the drop, tinted (#255).
    container?: Box | null;
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
        if (inClosedToggle(editor, b.pos)) return [];
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
            indent: b.node.attrs.indent ? parseFloat(getComputedStyle(dom).paddingInlineStart) || 0 : 0,
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
    // Neither in the selection modes: the keys stay with the chosen blocks.
    if (!editor || pickingRef.current || selectingRef.current) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    editor.commands.focus();
  }
  function perform(action: "duplicate" | "delete" | "move" | "copy", target?: number) {
    if (!editor?.isEditable) {
      setError(t("Das Dokument kann nicht bearbeitet werden.", "The document cannot be edited."));
      return;
    }
    try {
      const range = blockRange(editor.state.doc, selected.current);
      if (
        (action === "duplicate" || action === "copy") &&
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
  // Where the receiving block of a drop is on the surface (#255).
  function containerBox(target: number): Box | null {
    const host = surface.current;
    if (!editor || !host) return null;
    const found = dropContainer(editor.state.doc, target);
    const dom = found && editor.view.nodeDOM(found.pos);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect(),
      origin = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { top: rect.top - origin.top, left: rect.left - origin.left, width: rect.width, height: rect.height };
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
    // The boundary next to the pointer first (with the levels there, see
    // below); when the blocks cannot go there (e.g. at the edge of a task
    // list), the nearest one that works.
    const place = (valid: { block: Positioned; after: boolean }) => {
      const gap = valid.after ? valid.block.end : valid.block.pos;
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
      // The level by the pointer's horizontal position (#239): every block
      // that ends at this gap is a level (a nested list item, the item around
      // its list, a toggle …), plus "inside" the innermost one when it takes
      // children (a list item, an open toggle). Further right goes deeper,
      // further left out to the parent's level; the line is indented to it.
      const fits = (target: number) => {
        try {
          changeBlocks(editor.state, drag.positions, "move", target);
          return true;
        } catch {
          return false;
        }
      };
      const doc = editor.state.doc;
      const endsAt = (pos: number) => {
        for (let p = pos; p < gap; ) {
          const $p = doc.resolve(p);
          if ($p.depth === 0 || p !== $p.end()) return false;
          p = $p.after();
        }
        return true;
      };
      const right = Math.max(valid.block.left + valid.block.width, ...(neighbour ? [neighbour.left + neighbour.width] : []));
      type Level = { target: number; line: number; min: number };
      const levels: Level[] = [];
      const ending = available
        .filter((b) => !listContainers.includes(b.node.type.name) && b.end <= gap && endsAt(b.end))
        .sort((a, b) => b.depth - a.depth);
      const inner = ending[0];
      if (inner && ["listItem", "taskItem", "toggle"].includes(inner.node.type.name) && inner.end - 1 !== gap) {
        // Its children start where its text starts (a list item's bullet and
        // a toggle's arrow come before).
        const child = geometry.current.find((b) => b.parentPos === inner.pos || byPos.get(b.parentPos)?.parentPos === inner.pos);
        const line = child ? child.left : inner.left + 26;
        const open = inner.node.type.name !== "toggle" || !!editor.view.nodeDOM(inner.pos) && (editor.view.nodeDOM(inner.pos) as HTMLDetailsElement).open !== false;
        if (open) levels.push({ target: inner.end - 1, line, min: line + 28 });
      }
      // A level reaches left over its own handle: dragging by a handle keeps
      // the level of its block until the pointer moves clearly further left.
      for (const b of ending) levels.push({ target: b.end, line: b.left, min: b.left - 40 });
      if (!levels.some((level) => level.target === gap)) levels.push({ target: gap, line: valid.block.left, min: -Infinity });
      const usable = levels.filter((level) => fits(level.target));
      const chosen = usable.find((level) => x >= level.min) || usable[usable.length - 1];
      return chosen ? { target: chosen.target, top, left: chosen.line, width: Math.max(40, right - chosen.line) } : null;
    };
    for (const candidate of candidates) {
      const placed = place(candidate);
      if (!placed) continue;
      drag.target = placed.target;
      setDrop({ top: placed.top, left: placed.left, width: placed.width, container: containerBox(placed.target) });
      return;
    }
    drag.target = undefined;
    setDrop(null);
  }
  function pointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    block: Positioned,
  ) {
    if (!editor?.isEditable || event.button !== 0) return;
    event.preventDefault();
    // ⇧-click on a handle (#237): the selection reaches to this block.
    if (event.shiftKey && event.pointerType === "mouse") {
      extendTo(block.pos);
      return;
    }
    // Dragging a chosen block moves all chosen blocks.
    if (!selected.current.includes(block.pos)) {
      if (selectingRef.current) endSelection(false);
      select([block.pos]);
    }
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
  // ⌥/Alt while dragging: the cursor shows a copy.
  function copying(drag: Drag, alt: boolean) {
    drag.copy = alt;
    document.documentElement.classList.toggle("dragging-blocks-copy", alt && drag.active);
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    copying(drag, event.altKey);
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
    const key = (event: KeyboardEvent) => {
      if (event.key === "Alt" && dragging.current) copying(dragging.current, event.type === "keydown");
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      document.documentElement.classList.remove("dragging-blocks-copy");
    };
  }, [pointerActive]);
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
  // The menu was opened by a click on a handle, which chose its block
  // (#264): the choice ends with the menu, unless Esc closed it.
  const menuChose = useRef(false);
  function openMenu(handle: HTMLElement, block?: DocumentBlock, view = "main") {
    if (menu?.handle === handle) return closeMenu();
    // A handle of chosen blocks (#237): the menu for all of them. Another
    // handle chooses its block, like Notion (#264): the keys (⇧↑/↓, ⌘A,
    // Esc) act on the chosen blocks once the menu is closed with Esc.
    if (block && !(selectingRef.current && selected.current.includes(block.pos))) {
      if (pickingRef.current) select([block.pos]);
      else {
        startSelection([block.pos], block.pos, block.pos, false);
        menuChose.current = true;
      }
    }
    setMenu({ anchor: handle.getBoundingClientRect(), handle, view });
  }
  function closeMenu(reason?: BlockMenuClose) {
    const handle = menu?.handle;
    const chose = menuChose.current;
    menuChose.current = false;
    setMenu(null);
    if (selectingRef.current) {
      // "Select several" in the menu: the circles take over the choice.
      if (pickingRef.current) {
        selectingRef.current = false;
        setSelecting(false);
        anchorRef.current = headRef.current = null;
        return;
      }
      // Esc: the blocks stay chosen and the keys act on them (#264). Not in
      // the sheet of a phone, where a tap beside it closes it the same way.
      if (reason === "escape" && !phone) {
        requestAnimationFrame(() => focusTarget.current?.focus({ preventScroll: true }));
        return;
      }
      if (chose) {
        endSelection(false);
        // After an action back to the text, as before (#236): the keys
        // (⌘Z for the action) go to the editor again.
        if (reason === "select") focusEditor();
      } else {
        // Chosen with the keyboard or the mouse before ("/"): they stay.
        requestAnimationFrame(() => {
          if (selectingRef.current && (!document.activeElement || document.activeElement === document.body))
            focusTarget.current?.focus({ preventScroll: true });
        });
        return;
      }
    } else if (!pickingRef.current) {
      remember([]);
      setTick((t) => t + 1);
    }
    if (reason === "select") return;
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
  // Choosing blocks with the mouse and the keyboard (#237), like Notion:
  // a rectangle dragged from the page margin or empty space, Esc in a block,
  // ⌘A twice, ⇧-click on a handle. The chosen blocks are tinted (no circles,
  // nothing moves); the keyboard acts on all of them. The selection mode
  // with circles and a bar (above) stays for touch screens.
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  selectingRef.current = selecting;
  // The block the selection started at and the one it reaches to.
  const anchorRef = useRef<number | null>(null);
  const headRef = useRef<number | null>(null);
  const focusTarget = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  function startSelection(positions: number[], anchor = positions[0], head = positions[positions.length - 1], focus = true) {
    if (!editor || !positions.length) return;
    select(positions);
    anchorRef.current = anchor;
    headRef.current = head;
    selectingRef.current = true;
    setSelecting(true);
    // No caret while blocks are chosen: the keys act on the blocks.
    // (The text selection itself stays: the editor keeps track of it, and
    // a later click into the text must not find it changed behind its back.)
    if (editor.view.hasFocus()) (editor.view.dom as HTMLElement).blur();
    // Nor its highlight (#264): only the tint shows what is chosen.
    const dom = window.getSelection();
    if (dom?.rangeCount && dom.anchorNode && editor.view.dom.contains(dom.anchorNode)) dom.removeAllRanges();
    // (A menu opened with the choice takes the focus itself.)
    if (focus) requestAnimationFrame(() => focusTarget.current?.focus({ preventScroll: true }));
  }
  function endSelection(caret: boolean) {
    const first = selected.current.length ? Math.min(...selected.current) : null;
    menuChose.current = false;
    selectingRef.current = false;
    setSelecting(false);
    anchorRef.current = headRef.current = null;
    select([]);
    if (caret && editor && !editor.isDestroyed && first !== null && first <= editor.state.doc.content.size) {
      try {
        editor.chain().focus().setTextSelection(Math.min(first + 1, editor.state.doc.content.size)).scrollIntoView().run();
      } catch {}
    }
  }
  // The blocks with a handle, in document order.
  const handled = () =>
    editor ? documentBlocks(editor.state.doc).filter((b) => !listContainers.includes(b.node.type.name)) : [];
  // From the anchor to `head`: the run of neighbours on one level that
  // holds both (an outer block where they lie at different levels).
  function between(anchor: number, head: number): { positions: number[]; head: number } | null {
    if (!editor) return null;
    const blocks = documentBlocks(editor.state.doc);
    const byPosition = new Map(blocks.map((b) => [b.pos, b]));
    const chain = (pos: number) => {
      const list: DocumentBlock[] = [];
      for (let b = byPosition.get(pos); b; b = byPosition.get(b.parentPos)) list.unshift(b);
      return list;
    };
    const a = chain(anchor),
      h = chain(head);
    if (!a.length || !h.length) return null;
    let depth = 0;
    while (depth < a.length && depth < h.length && a[depth].pos === h[depth].pos) depth++;
    // One inside the other: the outer one.
    if (depth === a.length || depth === h.length) {
      const outer = a[depth - 1];
      return { positions: promote([outer.pos]), head: outer.pos };
    }
    const from = a[depth],
      to = h[depth];
    const lo = Math.min(from.pos, to.pos),
      hi = Math.max(from.pos, to.pos);
    const positions = blocks.filter((b) => b.parentPos === from.parentPos && b.pos >= lo && b.pos <= hi).map((b) => b.pos);
    // A list's items whole: the list.
    return { positions: promote(positions), head: to.pos };
  }
  function extendTo(pos: number) {
    const anchor = anchorRef.current ?? selected.current[0] ?? pos;
    const run = between(anchor, pos);
    if (run) startSelection(run.positions, anchor, run.head);
  }
  // ↑/↓: the block before or after the selection; ⇧: the selection grows
  // to the neighbour on the head's level (or its outer block at an edge).
  function step(direction: -1 | 1, extend: boolean) {
    if (!editor || !selected.current.length) return;
    const blocks = handled();
    const range = (() => {
      try {
        return blockRange(editor.state.doc, selected.current);
      } catch {
        return null;
      }
    })();
    if (!extend || !range) {
      const lo = Math.min(...selected.current);
      const hi = range ? range.to : Math.max(...selected.current) + 1;
      const next = direction < 0 ? blocks.filter((b) => b.pos < lo).at(-1) : blocks.find((b) => b.pos >= hi);
      if (next) startSelection([next.pos]);
      scrollToBlock(next?.pos);
      return;
    }
    const head = headRef.current ?? (direction < 0 ? range.from : range.blocks.at(-1)!.pos);
    const all = documentBlocks(editor.state.doc);
    const current = all.find((b) => b.pos === head);
    if (!current) return;
    const siblings = all.filter((b) => b.parentPos === current.parentPos);
    const index = siblings.findIndex((b) => b.pos === current.pos);
    const next = siblings[index + direction];
    const target = next ? next.pos : current.parentPos >= 0 ? current.parentPos : null;
    if (target === null) return;
    extendTo(target);
    scrollToBlock(target);
  }
  function scrollToBlock(pos?: number) {
    if (!editor || pos === undefined) return;
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "nearest" });
  }
  // The chosen blocks as a slice, for the clipboard.
  function chosenSlice() {
    if (!editor) return null;
    try {
      const range = blockRange(editor.state.doc, selected.current);
      return editor.state.doc.slice(range.from, range.to);
    } catch {
      return null;
    }
  }
  // The chosen blocks as the clipboard holds them: HTML that the editor
  // reads back as the same blocks (also in another page), and plain text
  // for other apps.
  function clipboardData() {
    const slice = chosenSlice();
    if (!editor || !slice) return null;
    const { dom, text } = editor.view.serializeForClipboard(slice);
    return { html: dom.innerHTML, text };
  }
  // "Kopieren" and "Ausschneiden" in the block menu and the bar of the
  // selection mode (#263): what ⌘C and ⌘X do with chosen blocks.
  function toClipboard(cut: boolean) {
    if (!editor) return;
    const data = clipboardData();
    if (!data) return;
    if (cut && !editor.isEditable) return;
    const count = selected.current.length;
    const done = () => {
      showToast({
        text: cut
          ? count === 1
            ? t("1 Block ausgeschnitten", "1 block cut")
            : t(`${count} Blöcke ausgeschnitten`, `${count} blocks cut`)
          : count === 1
            ? t("1 Block kopiert", "1 block copied")
            : t(`${count} Blöcke kopiert`, `${count} blocks copied`),
      });
      if (!cut) return;
      // The choice ends (as after ⌘X); the caret goes where they were.
      const positions = [...selected.current];
      if (selectingRef.current) endSelection(false);
      remember(positions);
      perform("delete");
      if (pickingRef.current) select([]);
      else remember([]);
      setTick((n) => n + 1);
    };
    // The copy event of the click itself (synchronous, works in every
    // browser and the apps' web views) …
    let written = false;
    const write = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.clipboardData.clearData();
      event.clipboardData.setData("text/html", data.html);
      event.clipboardData.setData("text/plain", data.text);
      written = true;
    };
    document.addEventListener("copy", write, true);
    try {
      document.execCommand("copy");
    } catch {
    } finally {
      document.removeEventListener("copy", write, true);
    }
    if (written) return done();
    // … else the asynchronous clipboard.
    const failed = () => setError(t("Die Zwischenablage ist nicht verfügbar.", "The clipboard is not available."));
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return failed();
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([data.html], { type: "text/html" }),
          "text/plain": new Blob([data.text], { type: "text/plain" }),
        }),
      ])
      .then(done, failed);
  }
  // Tab / ⇧Tab: what the keys do in the text, for the text of all chosen
  // blocks (lists nest, paragraphs and headings indent); the same blocks
  // stay chosen.
  function indent(out: boolean) {
    if (!editor?.isEditable) return;
    let range;
    try {
      range = blockRange(editor.state.doc, selected.current);
    } catch {
      return;
    }
    // Into the toggle before them, out of the one around them (#246): any
    // blocks, code and tables too; they stay chosen where they went.
    const nested = nestBlocks(editor.state, range.from, range.to, out);
    if (nested) {
      // A closed toggle opens (as with the caret in the text).
      applyBlockChange(editor, nested.into.length ? nested.tr.setMeta(toggleKey, { open: nested.into }) : nested.tr);
      (editor.view.dom as HTMLElement).blur();
      startSelection(nested.positions);
      return;
    }
    const marks = captureBlockSelection(editor, selected.current);
    const from = Selection.findFrom(editor.state.doc.resolve(range.from), 1, true),
      to = Selection.findFrom(editor.state.doc.resolve(range.to), -1, true);
    if (!from || !to) return;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.between(from.$from, to.$to)));
    editor.commands.keyboardShortcut(out ? "Shift-Tab" : "Tab");
    const positions = marks.map((mark) => mark.pos).filter((pos) => editor.state.doc.nodeAt(pos));
    (editor.view.dom as HTMLElement).blur();
    startSelection(positions.length ? positions : selected.current);
  }
  // The functions of the latest render, for the listeners below.
  const live = useRef({ startSelection, endSelection, bandBlocks, handled });
  live.current = { startSelection, endSelection, bandBlocks, handled };
  // Nothing left chosen (deleted, moved away by someone else): the
  // selection ends.
  useEffect(() => {
    if (selecting && !band && !selected.current.length) endSelection(false);
  });
  const keyActions = useRef<(event: KeyboardEvent) => void>(() => {});
  keyActions.current = (event: KeyboardEvent) => {
    if (!editor || !selectingRef.current) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    const done = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (menu) {
      // ⇧↑/↓ while the menu is open (#264): it closes, the choice grows.
      if ((key === "ArrowUp" || key === "ArrowDown") && event.shiftKey && !mod && !event.altKey && !pickingRef.current) {
        done();
        menuChose.current = false;
        setMenu(null);
        step(key === "ArrowUp" ? -1 : 1, true);
        requestAnimationFrame(() => focusTarget.current?.focus({ preventScroll: true }));
      }
      // Esc before the focus reached the menu: the menu closes (not the
      // record dialog around it, which hears Esc before the menu).
      const inMenu = event.target instanceof Element && event.target.closest("[data-layer], [role='menu']");
      if (key === "Escape" && !inMenu) {
        done();
        closeMenu("escape");
      }
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'] [role='dialog']")) return;
    if (key === "Escape") {
      done();
      endSelection(false);
      // Back to the text where the selection was.
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const direction = key === "ArrowUp" ? -1 : 1;
      done();
      if (mod && event.shiftKey) return shift(direction);
      return step(direction, event.shiftKey);
    }
    if (key === "Enter" && !mod) {
      done();
      return endSelection(true);
    }
    if (!editor.isEditable) return;
    if (key === "Delete" || key === "Backspace") {
      done();
      const first = Math.min(...selected.current);
      perform("delete");
      endSelection(false);
      editor.chain().focus().setTextSelection(Math.max(0, Math.min(first, editor.state.doc.content.size))).run();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === "d") {
      done();
      return perform("duplicate");
    }
    if (mod && !event.shiftKey && key.toLowerCase() === "a") {
      done();
      const top = documentBlocks(editor.state.doc).filter((b) => b.parentPos === -1).map((b) => b.pos);
      return startSelection(top);
    }
    if (key === "Tab") {
      done();
      return indent(event.shiftKey);
    }
    if ((key === "/" && !mod) || (mod && key === "/")) {
      done();
      const handle = surface.current?.querySelector<HTMLElement>(`.document-block-handle[data-block-pos="${Math.min(...selected.current)}"]`);
      if (handle) setMenu({ anchor: handle.getBoundingClientRect(), handle, view: "main" });
    }
  };
  // While blocks are chosen: their keys, the clipboard, and a click into
  // the text (or elsewhere) ends it.
  useEffect(() => {
    if (!selecting || !editor) return;
    const keydown = (event: KeyboardEvent) => keyActions.current(event);
    const copy = (event: ClipboardEvent, cut: boolean) => {
      if (menu || !selectingRef.current || !event.clipboardData) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const data = clipboardData();
      if (!data) return;
      event.preventDefault();
      event.clipboardData.clearData();
      event.clipboardData.setData("text/html", data.html);
      event.clipboardData.setData("text/plain", data.text);
      if (cut && editor.isEditable) {
        const first = Math.min(...selected.current);
        perform("delete");
        endSelection(false);
        editor.chain().focus().setTextSelection(Math.max(0, Math.min(first, editor.state.doc.content.size))).run();
      }
    };
    const onCopy = (event: ClipboardEvent) => copy(event, false);
    const onCut = (event: ClipboardEvent) => copy(event, true);
    // ⌘V: the copied blocks after the chosen ones.
    const onPaste = (event: ClipboardEvent) => {
      if (menu || !selectingRef.current || !editor.isEditable || !event.clipboardData) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      let range;
      try {
        range = blockRange(editor.state.doc, selected.current);
      } catch {
        return;
      }
      event.preventDefault();
      const html = event.clipboardData.getData("text/html"),
        text = event.clipboardData.getData("text/plain");
      const $at = editor.state.doc.resolve(range.to);
      const slice = parseFromClipboard(editor.view, text, html || null, false, $at);
      if (!slice) return;
      const tr = editor.state.tr.replaceRange(range.to, range.to, slice);
      endSelection(false);
      applyBlockChange(editor, tr.scrollIntoView());
      editor.commands.focus();
    };
    const down = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".document-block-handle, .document-block-add, [role='menu'], .block-menu-sheet, .block-select-band")) return;
      // Inside the text: the caret goes there (the editor does that).
      endSelection(false);
    };
    const blur = () => {};
    window.addEventListener("keydown", keydown, true);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("pointerdown", down, true);
    const focus = () => selectingRef.current && endSelection(false);
    editor.on("focus", focus);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("pointerdown", down, true);
      editor.off("focus", focus);
      void blur;
    };
  }, [selecting, editor, menu]);
  // Esc in a block chooses the block; ⌘A where the whole document is
  // already selected chooses all blocks. Only when nothing else took the
  // key (the "/" menu, a calculation hint, a dialog's own Esc).
  useEffect(() => {
    if (!editor?.isEditable) return;
    const host = surface.current;
    if (!host) return;
    // Esc after every other handler of the editor (the "/" menu, a
    // calculation hint …): a plugin of the lowest priority. ProseMirror
    // itself marks every Esc as handled, so a DOM listener cannot tell.
    const escapeKey = new PluginKey("blockSelectionEscape");
    editor.registerPlugin(
      new Plugin({
        key: escapeKey,
        props: {
          handleKeyDown(view, event) {
            if (event.key !== "Escape" || event.isComposing || event.shiftKey || selectingRef.current || pickingRef.current) return false;
            // A click just before may not have reached the editor's selection yet.
            (view as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
            const blocks = live.current.handled();
            const known = new Set(blocks.map((b) => b.pos));
            const { selection } = view.state;
            // Where the caret is on screen (the editor's own selection can
            // lag behind a click that just moved it).
            let $at = selection.$from;
            const dom = window.getSelection();
            if (dom?.anchorNode && dom.isCollapsed && view.dom.contains(dom.anchorNode))
              try {
                $at = view.state.doc.resolve(view.posAtDOM(dom.anchorNode, dom.anchorOffset));
              } catch {}
            let pos: number | null =
              selection instanceof NodeSelection && known.has(selection.from) && $at.pos === selection.from ? selection.from : null;
            for (let d = $at.depth; pos === null && d > 0; d--) if (known.has($at.before(d))) pos = $at.before(d);
            if (pos === null) return false;
            live.current.startSelection([pos]);
            return true;
          },
        },
      }),
    );
    // ⌘A (#264, like Notion): first the text of the block with the caret,
    // then all blocks of the page – only their tint, no text highlight.
    const all = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "a") return;
      const target = event.target instanceof Element ? event.target : null;
      if (selectingRef.current || !target || !editor.view.dom.contains(target)) return;
      // Fields inside a block (a caption, a code editor) keep their own ⌘A.
      if (target.closest("input, textarea, select") || target.closest("[contenteditable]") !== editor.view.dom) return;
      const { selection } = editor.state;
      const { $from, $to } = selection;
      event.preventDefault();
      event.stopPropagation();
      if (selection instanceof TextSelection && $from.parent.isTextblock && $from.sameParent($to)) {
        const start = $from.start(),
          end = $from.end();
        if (selection.from > start || selection.to < end) {
          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start, end)));
          return;
        }
      }
      live.current.startSelection(documentBlocks(editor.state.doc).filter((b) => b.parentPos === -1).map((b) => b.pos));
    };
    host.addEventListener("keydown", all, true);
    return () => {
      host.removeEventListener("keydown", all, true);
      if (!editor.isDestroyed) editor.unregisterPlugin(escapeKey);
    };
  }, [editor]);
  // The rectangle: pressed with the mouse in the page margin or empty space
  // (not on text, a control or a menu) and dragged; every block it touches
  // is chosen while dragging. A rectangle inside one container (a list, a
  // toggle, a callout) chooses the blocks inside it.
  useEffect(() => {
    if (!editor?.isEditable || picking) return;
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
      const host = surface.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!host || !target || menu) return;
      const page = host.closest('[role="dialog"], main');
      if (!page?.contains(target)) return;
      if (editor.view.dom.contains(target)) return;
      if (
        target.closest(
          "button, a, input, textarea, select, label, summary, [role='button'], [role='menu'], [role='dialog'] [role='dialog'], [contenteditable], .dropdown, .editor-toolbar, [draggable='true'], .page-header, .row-document-heading",
        )
      )
        return;
      const box = host.getBoundingClientRect();
      // Beside or below the document, not far above it.
      if (event.clientY < box.top - 24) return;
      const startX = event.clientX,
        startY = event.clientY;
      let active = false;
      const move = (e: PointerEvent) => {
        if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        if (!active) {
          active = true;
          document.documentElement.classList.add("selecting-blocks-band");
        }
        e.preventDefault();
        const left = Math.min(startX, e.clientX),
          top = Math.min(startY, e.clientY),
          width = Math.abs(e.clientX - startX),
          height = Math.abs(e.clientY - startY);
        setBand({ left, top, width, height });
        const positions = live.current.bandBlocks({ left, top, right: left + width, bottom: top + height });
        if (positions.length) live.current.startSelection(positions);
        else if (selectingRef.current) {
          select([]);
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        document.documentElement.classList.remove("selecting-blocks-band");
        setBand(null);
        if (active && !selected.current.length) live.current.endSelection(false);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [editor, picking, menu]);
  // The blocks the rectangle (window coordinates) touches: its height
  // decides; the outermost level it covers more than one block of, or
  // the blocks inside the one container it lies in.
  function bandBlocks(rect: { left: number; top: number; right: number; bottom: number }) {
    const host = surface.current;
    if (!host || !editor) return [];
    const origin = host.getBoundingClientRect();
    const top = rect.top - origin.top,
      bottom = rect.bottom - origin.top;
    // Only rectangles that reach the column of the text or its margin.
    if (rect.right < origin.left - 200 || rect.left > origin.right + 200) return [];
    const touched = geometry.current.filter((b) => b.top < bottom && b.top + b.height > top);
    let level = touched.filter((b) => b.depth === 0);
    for (;;) {
      if (level.length !== 1) break;
      const only = level[0];
      const inside = touched.filter((b) => b.parentPos === only.pos);
      if (!inside.length) break;
      // The rectangle on the container's own first line (a toggle's title,
      // the start of a callout): the container itself.
      const firstInside = Math.min(...geometry.current.filter((b) => b.parentPos === only.pos).map((b) => b.top));
      if (!listContainers.includes(only.node.type.name) && top < firstInside) break;
      level = inside;
    }
    const positions = level.map((b) => b.pos).sort((a, b) => a - b);
    if (!positions.length) return [];
    // One run of neighbours (blocks hidden in between count too).
    const parent = level[0].parentPos;
    const lo = positions[0],
      hi = positions[positions.length - 1];
    return promote(
      documentBlocks(editor.state.doc)
        .filter((b) => b.parentPos === parent && b.pos >= lo && b.pos <= hi)
        .map((b) => b.pos),
    );
  }
  // "Turn into" (#238): the current block takes another form. Text blocks
  // change through the editor's commands on a text selection inside the
  // block, like the slash menu; toggles, equations, columns and pages
  // through lib/block-turn.ts. Each entry finds its English name in the
  // search as well.
  function turnItems(block: DocumentBlock): BlockMenuItem[] {
    if (!editor) return [];
    const name = block.node.type.name,
      parent = byPos.get(block.parentPos)?.node.type.name;
    type Change = (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>;
    type Turn = { label: string; en: string; icon: ReactNode; active?: boolean; change: Change; shortcut?: string };
    const failed = () => setError(t("Dieser Block lässt sich nicht so umwandeln.", "This block cannot be turned into that."));
    const run = (selection: number | { from: number; to: number }, change: Change) => () => {
      if (!editor.isEditable) return;
      if (change(editor.chain().setTextSelection(selection)).run()) focusEditor();
      else failed();
    };
    const level = name === "heading" ? Number(block.node.attrs.level) : 0;
    const toggleLevel = name === "toggle" ? toggleHeading(block.node.attrs.heading) : null;
    const headingIcons = [<TextHOne key="i" />, <TextHTwo key="i" />, <TextHThree key="i" />, <TextHFour key="i" />];
    const headingTurns = (change: (n: number) => Change, active: (n: number) => boolean): Turn[] =>
      [1, 2, 3, 4].map((n) => ({
        label: t(`Überschrift ${n}`, `Heading ${n}`),
        en: `heading ${n} h${n} überschrift`,
        icon: headingIcons[n - 1],
        active: active(n),
        change: change(n),
        shortcut: `Mod+Alt+${n}`,
      }));
    const toggleTurns = (active: (n: number | null) => boolean): Turn[] => [
      { label: t("Aufklappbarer Block", "Toggle"), en: "toggle list aufklappbar", icon: <CaretRight key="i" />, active: active(null), change: (c) => c.command(({ tr }) => blockToToggle(tr, block.pos, null)) },
      ...[1, 2, 3, 4].map((n) => ({
        label: t(`Aufklappbare Überschrift ${n}`, `Toggle heading ${n}`),
        en: `toggle heading ${n} aufklappbar überschrift`,
        icon: <CaretCircleRight key="i" />,
        active: active(n),
        change: ((c) => c.command(({ tr }) => blockToToggle(tr, block.pos, n))) as Change,
      })),
    ];
    let turns: Turn[] = [];
    let at: number | { from: number; to: number } = block.end - 1;
    const textLike = name === "paragraph" || name === "heading" || name === "codeBlock";
    if (textLike && !listItems.includes(parent || ""))
      turns = [
        { label: t("Text", "Text"), en: "text paragraph absatz", icon: <TextT key="i" />, active: name === "paragraph", change: (c) => c.setParagraph(), shortcut: "Mod+Alt+0" },
        ...headingTurns((n) => (c) => c.setHeading({ level: n as 1 | 2 | 3 | 4 }), (n) => level === n),
        { label: t("Aufzählung", "Bulleted list"), en: "bulleted list bullet", icon: <ListBullets key="i" />, change: (c) => c.setParagraph().toggleBulletList(), shortcut: "Mod+Shift+8" },
        { label: t("Nummerierte Liste", "Numbered list"), en: "numbered list ordered", icon: <ListNumbers key="i" />, change: (c) => c.setParagraph().toggleOrderedList(), shortcut: "Mod+Shift+7" },
        { label: t("Aufgabenliste", "Task list"), en: "task list todo checkbox", icon: <CheckSquare key="i" />, change: (c) => c.setParagraph().toggleTaskList(), shortcut: "Mod+Shift+9" },
        // Its text becomes the title (#230).
        ...(name !== "codeBlock" ? toggleTurns(() => false) : []),
        { label: t("Zitat", "Quote"), en: "quote blockquote", icon: <Quotes key="i" />, change: (c) => c.wrapIn("blockquote"), shortcut: "Mod+Shift+B" },
        { label: t("Hinweis", "Callout"), en: "callout note", icon: <Info key="i" />, change: (c) => c.wrapIn("callout", { type: "note" }) },
        { label: t("Code", "Code"), en: "code", icon: <Code key="i" />, active: name === "codeBlock", change: (c) => c.setCodeBlock(), shortcut: "Mod+Alt+C" },
        { label: t("Formel", "Block equation"), en: "block equation math formula latex", icon: <MathOperations key="i" />, change: (c) => c.command(({ tr }) => blockToMath(tr, block.pos)) },
      ];
    else if (listItems.includes(name)) {
      at = block.pos + 2;
      turns = [
        { label: t("Text", "Text"), en: "text paragraph", icon: <TextT key="i" />, change: (c) => c.liftListItem(name) },
        { label: t("Aufzählung", "Bulleted list"), en: "bulleted list bullet", icon: <ListBullets key="i" />, active: parent === "bulletList", change: (c) => c.toggleBulletList(), shortcut: "Mod+Shift+8" },
        { label: t("Nummerierte Liste", "Numbered list"), en: "numbered list ordered", icon: <ListNumbers key="i" />, active: parent === "orderedList", change: (c) => c.toggleOrderedList(), shortcut: "Mod+Shift+7" },
        { label: t("Aufgabenliste", "Task list"), en: "task list todo", icon: <CheckSquare key="i" />, active: parent === "taskList", change: (c) => c.toggleTaskList(), shortcut: "Mod+Shift+9" },
        // The item's text becomes the title, its sub-list the content (#230).
        ...toggleTurns(() => false),
      ];
    } else if (name === "blockquote" || name === "callout") {
      at = { from: block.pos + 2, to: block.end - 2 };
      turns = [
        { label: t("Text", "Text"), en: "text paragraph", icon: <TextT key="i" />, change: (c) => c.lift(name) },
        name === "blockquote"
          ? { label: t("Hinweis", "Callout"), en: "callout note", icon: <Info key="i" />, change: (c) => c.lift(name).wrapIn("callout", { type: "note" }) }
          : { label: t("Zitat", "Quote"), en: "quote blockquote", icon: <Quotes key="i" />, change: (c) => c.lift(name).wrapIn("blockquote") },
      ];
    } else if (name === "toggle") {
      // A toggle into another block (#244): its title becomes the block's
      // text, its content follows on the same level.
      const into = (kind: TitleBlock): Change => (c) => c.command(({ tr }) => toggleToBlock(tr, block.pos, kind));
      turns = [
        { label: t("Text", "Text"), en: "text paragraph", icon: <TextT key="i" />, change: into({ type: "paragraph" }) },
        ...headingTurns((n) => into({ type: "heading", level: n }), () => false).map((turn) => ({ ...turn, shortcut: undefined })),
        { label: t("Aufzählung", "Bulleted list"), en: "bulleted list bullet", icon: <ListBullets key="i" />, change: into({ type: "bulletList" }) },
        { label: t("Nummerierte Liste", "Numbered list"), en: "numbered list ordered", icon: <ListNumbers key="i" />, change: into({ type: "orderedList" }) },
        { label: t("Aufgabenliste", "Task list"), en: "task list todo", icon: <CheckSquare key="i" />, change: into({ type: "taskList" }) },
        ...toggleTurns((n) => n === toggleLevel),
        { label: t("Zitat", "Quote"), en: "quote blockquote", icon: <Quotes key="i" />, change: into({ type: "blockquote" }) },
        { label: t("Hinweis", "Callout"), en: "callout note", icon: <Info key="i" />, change: into({ type: "callout" }) },
        { label: t("Code", "Code"), en: "code", icon: <Code key="i" />, change: into({ type: "codeBlock" }) },
        { label: t("Formel", "Block equation"), en: "block equation math formula", icon: <MathOperations key="i" />, change: into({ type: "mathBlock" }) },
      ];
    }
    const items: BlockMenuItem[] = turns.map(({ label, en, icon, active, change, shortcut }) => ({
      label,
      icon,
      keywords: en,
      shortcut: active ? undefined : shortcut,
      checked: !!active,
      disabled: !!active,
      // A toggle is changed by its position, not through a text selection.
      run:
        name === "toggle"
          ? () => {
              if (!editor.isEditable) return;
              if (change(editor.chain()).run()) focusEditor();
              else failed();
            }
          : run(at, change),
    }));
    return items;
  }
  // "Turn into" for one or more blocks: a page and columns.
  function wholeTurnItems(): BlockMenuItem[] {
    if (!editor || !rangeValid) return [];
    const items: BlockMenuItem[] = [];
    const range = blockRange(editor.state.doc, selected.current);
    if (onTurnIntoPage && !range.blocks.some((b) => hasLinkedBlocks(b.node)))
      items.push({
        icon: <FileText />,
        label: t("Seite", "Page"),
        keywords: "page sub-page subpage unterseite",
        run: () => {
          const positions = [...selected.current];
          void onTurnIntoPage(positions).catch((e: Error) => setError(e.message));
        },
      });
    const columnsFit = (count: number) => {
      try {
        return blocksToColumns(editor.state.tr, range.from, range.to, count);
      } catch {
        return false;
      }
    };
    for (let count = 2; count <= MAX_COLUMNS; count++)
      if (columnsFit(count))
        items.push({
          icon: <Columns />,
          label: t(`${count} Spalten`, `${count} columns`),
          keywords: `${count} columns spalten`,
          run: () => {
            if (!editor.isEditable) return;
            const tr = editor.state.tr;
            if (!blocksToColumns(tr, range.from, range.to, count))
              return setError(t("Diese Blöcke lassen sich nicht in Spalten setzen.", "These blocks cannot be put into columns."));
            applyBlockChange(editor, tr.scrollIntoView());
            focusEditor();
          },
        });
    return items;
  }
  // "Farbe" (#238): text or background colour of the blocks, ten each.
  function colorItems(blocks: DocumentBlock[]): BlockMenuItem[] {
    const labels = blockColorLabels(t);
    const values = new Set<string | null>();
    for (const b of blocks)
      if (["bulletList", "orderedList", "taskList"].includes(b.node.type.name)) b.node.forEach((item) => values.add(blockColor(item.attrs.blockColor)));
      else values.add(blockColor(b.node.attrs.blockColor));
    const current = values.size === 1 ? [...values][0] : undefined;
    const paint = (value: string | null) => () => {
      if (!editor?.isEditable) return;
      const tr = editor.state.tr;
      if (!setBlockColors(tr, blocks.map((b) => b.pos), value)) return;
      editor.view.dispatch(tr.setMeta(BLOCK_SELECTION_META, [...selected.current]));
      setTick((n) => n + 1);
    };
    const entry = (value: string | null, background: boolean): BlockMenuItem => {
      const name = value?.replace("-background", "") as BlockColorName | undefined;
      return {
        icon: (
          <span className={`block-menu-color${background ? " background" : ""}`} data-block-color-swatch={name || "default"} aria-hidden>
            A
          </span>
        ),
        label: name ? labels[name] : t("Standard", "Default"),
        ariaLabel: background ? (name ? t(`${labels[name]} (Hintergrund)`, `${labels[name]} background`) : t("Standardhintergrund", "Default background")) : undefined,
        keywords: `${name || "default"} ${background ? "background hintergrund" : "text colour color farbe"}`,
        checked: current === value,
        run: paint(value),
      };
    };
    return [
      { heading: t("Textfarbe", "Text colour") },
      entry(null, false),
      ...BLOCK_COLOR_NAMES.map((name) => entry(name, false)),
      { heading: t("Hintergrund", "Background") },
      entry(null, true),
      ...BLOCK_COLOR_NAMES.map((name) => entry(`${name}-background`, true)),
    ];
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
    const chosenBlocks = all.filter((b) => selected.current.includes(b.pos));
    const items: BlockMenuItem[] = [];
    // "Turn into": the block types (one block), then a page and columns.
    const turns = [...(only ? turnItems(only) : []), ...wholeTurnItems()];
    if (turns.length) {
      items.push({ icon: <ArrowsClockwise />, label: t("Umwandeln in …", "Turn into …"), keywords: "turn into convert umwandeln", view: "turn" });
      views.turn = { title: t("Umwandeln in …", "Turn into …"), items: turns };
    }
    // Block colours (#238): text and background, for the blocks that take one.
    if (chosenBlocks.length && chosenBlocks.every((b) => colorable(b.node))) {
      items.push({ icon: <Palette />, label: t("Farbe", "Colour"), keywords: "colour color farbe background hintergrund", view: "blockColor" });
      views.blockColor = { title: t("Farbe", "Colour"), items: colorItems(chosenBlocks) };
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
    // Moving: on phones on this level (no shortcuts there, dragging needs
    // a hold); with a mouse in a flyout, next to their shortcuts (#238).
    const moves: BlockMenuItem[] = [
      { icon: <ArrowUp />, label: t("Nach oben", "Move up"), keywords: "move up", disabled: !up, run: () => shift(-1), shortcut: "Mod+Shift+ArrowUp" },
      { icon: <ArrowDown />, label: t("Nach unten", "Move down"), keywords: "move down", disabled: !down, run: () => shift(1), shortcut: "Mod+Shift+ArrowDown" },
      { icon: <ArrowBendDownRight />, label: t("Verschieben unter …", "Move below …"), keywords: "move below", disabled: !rangeValid, view: "move" },
    ];
    views.move = {
      title: t("Verschieben unter …", "Move below …"),
      items: moveItems(),
      note: t("Überschriften der Seite", "Headings of the page"),
    };
    if (!views.move.items.length) views.move.note = t("Keine andere Stelle möglich.", "No other place available.");
    items.push("separator");
    // Copy and cut (#263): as ⌘C and ⌘X on chosen blocks.
    items.push({
      icon: <CopySimple />,
      label: t("Kopieren", "Copy"),
      keywords: "copy kopieren clipboard zwischenablage",
      disabled: !rangeValid,
      run: () => toClipboard(false),
      shortcut: "Mod+C",
    });
    items.push({
      icon: <Scissors />,
      label: t("Ausschneiden", "Cut"),
      keywords: "cut ausschneiden clipboard zwischenablage",
      disabled: !rangeValid || !editor.isEditable,
      run: () => toClipboard(true),
      shortcut: "Mod+X",
    });
    items.push({
      icon: <Copy />,
      label: t("Duplizieren", "Duplicate"),
      keywords: "duplicate copy",
      disabled: !rangeValid || !copyAllowed,
      run: () => perform("duplicate"),
      shortcut: "Mod+D",
    });
    if (phone) items.push(...moves);
    else {
      items.push({ icon: <ArrowsDownUp />, label: t("Verschieben", "Move"), keywords: "move", view: "moveTo" });
      views.moveTo = { title: t("Verschieben", "Move"), items: moves };
    }
    // An empty block below or above (#261): what "+" beside the handle
    // does, also on touch screens (no "+" there) and for every kind of
    // block.
    if (only && editor.isEditable) {
      items.push({
        icon: <Plus />,
        label: t("Block darunter einfügen", "Add block below"),
        keywords: "add insert new block below darunter einfügen neu",
        run: () => setTimeout(() => editor && !editor.isDestroyed && addBlock(only, false), 60),
      });
      items.push({
        icon: <ArrowLineUp />,
        label: t("Block darüber einfügen", "Add block above"),
        keywords: "add insert new block above darüber einfügen neu",
        run: () => setTimeout(() => editor && !editor.isDestroyed && addBlock(only, true), 60),
      });
    }
    // Comment on the block and ask the AI about it (#238).
    const target = only && editor.isEditable ? only : undefined;
    if (target && comments)
      items.push({
        icon: <ChatCircle />,
        label: t("Kommentieren", "Comment"),
        keywords: "comment kommentar",
        shortcut: "Mod+Alt+M",
        run: () => commentOn(target),
      });
    if (target && onAskAi && target.node.textContent.trim())
      items.push({
        icon: <Sparkle />,
        label: t("KI fragen", "Ask AI"),
        keywords: "ask ai ki assistant",
        shortcut: "Mod+J",
        run: () => {
          const { from, to } = textRange(target);
          setTimeout(() => editor && !editor.isDestroyed && onAskAi(from, to), 60);
        },
      });
    items.push("separator");
    // The link of a block, for every kind of block (#88).
    if (only && onCopyLink)
      items.push({ icon: <LinkIcon />, label: t("Link zum Block kopieren", "Copy link to block"), keywords: "copy link", shortcut: "Mod+Shift+L", run: () => onCopyLink(only.pos) });
    if (!pickingRef.current)
      items.push({ icon: <CheckCircle />, label: t("Mehrere auswählen", "Select several"), keywords: "select several multiple", run: startPicking });
    items.push({ icon: <Trash />, label: t("Löschen", "Delete"), keywords: "delete remove", danger: true, disabled: !rangeValid, run: () => perform("delete") });
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
  // The kind of the chosen block over its menu (#253), or how many.
  function menuHeading() {
    const count = selected.current.length;
    if (count > 1) return t(`${count} Blöcke`, `${count} blocks`);
    const only = count === 1 ? byPos.get(selected.current[0]) : undefined;
    if (!only || !editor) return undefined;
    return blockTypeName(only.node, editor.state.doc.resolve(only.pos).parent);
  }
  // The text of a block (its first text block), for comments and the AI.
  function textRange(block: DocumentBlock) {
    let from = block.pos + 1,
      to = block.end - 1;
    if (!block.node.isTextblock) {
      let found = false;
      block.node.descendants((node, offset) => {
        if (found) return false;
        if (node.isTextblock) {
          found = true;
          from = block.pos + 1 + offset + 1;
          to = from + node.content.size;
        }
        return !found;
      });
    }
    return { from, to };
  }
  // Comment on a block: its text (or the block itself) selected, then the
  // editor's own "comment" (components/inline-comments.tsx).
  function commentOn(block: DocumentBlock) {
    if (!editor) return;
    setTimeout(() => {
      if (editor.isDestroyed) return;
      const chain = editor.chain().focus();
      const { from, to } = textRange(block);
      if (block.node.textContent.trim() && to > from) chain.setTextSelection({ from, to });
      else if (NodeSelection.isSelectable(block.node)) chain.setNodeSelection(block.pos);
      else chain.setTextSelection(from);
      chain.run();
      editor.view.dom.dispatchEvent(new CustomEvent("comment-create"));
    }, 60);
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
  // The toggle tinted while its handle is under the mouse (#246).
  const scoped = useRef<HTMLElement | null>(null);
  useEffect(() => () => scoped.current?.classList.remove("toggle-scope"), []);
  useEffect(() => {
    if (!editor?.isEditable || picking) return;
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || dragging.current) return;
      const host = surface.current;
      if (!host) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".document-block-handle, .document-block-add")) return;
      // Off the handle (also when it went away under the mouse): untinted.
      if (scoped.current && !target?.closest(".document-block-handle")) {
        scoped.current.classList.remove("toggle-scope");
        scoped.current = null;
      }
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
    // Typing hides the handle (#255, like Notion) until the mouse moves again.
    const typing = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || ["Shift", "Control", "Alt", "Meta", "CapsLock", "Escape", "Tab"].includes(event.key)) return;
      leave();
    };
    const dom = editor.view.dom;
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    dom.addEventListener("keydown", typing);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      dom.removeEventListener("keydown", typing);
    };
  }, [editor, picking]);
  // "+" (#236): an empty block below the block (⌥/Alt: above) with the "/"
  // menu open, as if "/" had been typed there. An empty paragraph itself
  // takes the "/".
  function addBlock(block: DocumentBlock, above: boolean) {
    if (!editor?.isEditable) return;
    const { view } = editor;
    // Every kind of block, tables, images and embeds too (#261).
    const placed = emptyBlockNear(editor.state, block, above);
    if (!placed) {
      setError(t("Hier kann kein Block eingefügt werden.", "A block cannot be inserted here."));
      return;
    }
    const { tr, caret } = placed;
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView());
    view.focus();
    const pos = view.state.selection.from;
    const insert = () => view.state.tr.insertText("/", pos, pos);
    if (!view.someProp("handleTextInput", (f) => f(view, pos, pos, "/", insert))) view.dispatch(insert());
    setError("");
  }
  const count = selected.current.length;
  // Chosen blocks are tinted: in the selection mode, and while the menu of
  // a block is open (#236), so it is clear what the menu applies to.
  const marked = picking || menu || selecting ? blocks.filter((b) => selected.current.includes(b.pos)) : [];
  const adding = !picking && hovered !== null && !pointerActive ? handles.find((b) => b.pos === hovered && !b.boxed) : undefined;
  return (
    <>
      <div
        ref={surface}
        className={`block-editor-surface ${editor?.isEditable ? "with-block-handles" : ""}${picking ? " picking-blocks" : ""}${blocks.some((block) => block.rtl) ? " with-rtl-blocks" : ""}`}
      >
        {children}
        {editor?.isEditable && (
          <div className={`block-handle-layer${handlesAlways ? " always-handles" : ""}${selecting ? " selecting-blocks" : ""}`} aria-label={t("Blockgriffe", "Block handles")}>
            {/* Takes the focus while blocks are chosen (#237): the keys act on
                them; screen readers hear how many and what the keys do. */}
            <div
              ref={focusTarget}
              tabIndex={-1}
              className="block-selection-focus"
              role="group"
              aria-label={
                !selecting
                  ? undefined
                  : selected.current.length === 1
                    ? t("1 Block ausgewählt. Pfeiltasten wählen andere Blöcke, Entf löscht, Esc beendet die Auswahl.", "1 block selected. Arrow keys choose other blocks, Delete deletes, Esc ends the selection.")
                    : t(
                        `${selected.current.length} Blöcke ausgewählt. Pfeiltasten wählen andere Blöcke, Entf löscht, Esc beendet die Auswahl.`,
                        `${selected.current.length} blocks selected. Arrow keys choose other blocks, Delete deletes, Esc ends the selection.`,
                      )
              }
            />
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
                        left: block.rtl ? block.right - block.indent + 2 : Math.max(0, block.left + block.indent - 25),
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
                  left: block.rtl ? block.right - block.indent : block.left + block.indent,
                  top: block.handleTop,
                }}
                aria-label={t(`Blockaktionen: ${block.label}`, `Block actions: ${block.label}`)}
                aria-haspopup="menu"
                aria-expanded={!!menu && selected.current.includes(block.pos)}
                title={t("Ziehen zum Verschieben · Klicken für Menü", "Drag to move · Click to open menu")}
                onPointerDown={(event) => pointerDown(event, block)}
                onPointerMove={pointerMove}
                // A toggle's handle shows what belongs to it (#246).
                onPointerEnter={(event) => {
                  if (event.pointerType === "touch" || !editor || block.node.type.name !== "toggle") return;
                  scoped.current?.classList.remove("toggle-scope");
                  scoped.current = markToggleScope(editor.view, block.pos);
                }}
                onPointerLeave={() => {
                  scoped.current?.classList.remove("toggle-scope");
                  scoped.current = null;
                }}
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
                  document.documentElement.classList.remove("dragging-blocks-copy");
                  if (active) {
                    if (column) placeBeside(column.pos, column.side);
                    else if (target !== undefined) perform(event.altKey || drag.copy ? "copy" : "move", target);
                    else
                      setError(
                        t("An dieser Position kann der Block nicht abgelegt werden.", "The block cannot be dropped at this position."),
                      );
                    // A drag selects only for its own duration; the moved
                    // block's handle must not stay highlighted afterwards.
                    if (selectingRef.current) endSelection(false);
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
                style={{ left: adding.rtl ? adding.right - adding.indent : adding.left + adding.indent, top: adding.handleTop }}
                aria-label={t(`Block darunter einfügen: ${adding.label}`, `Add a block below: ${adding.label}`)}
                title={t("Klicken: Block darunter einfügen · ⌥-Klick: darüber", "Click to add a block below · ⌥-click to add above")}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => addBlock(adding, event.altKey)}
              >
                <Plus size={15} weight="bold" aria-hidden />
              </button>
            )}
            {band &&
              typeof document !== "undefined" &&
              createPortal(<div className="block-select-band" style={band} aria-hidden="true" />, document.body)}
            {drop?.container && (
              <div className="document-block-drop-container" style={drop.container} aria-hidden="true" />
            )}
            {drop && (
              <div
                className="document-block-drop"
                style={{ top: drop.top, left: drop.left, width: drop.width, height: drop.height }}
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
          searchable={menu.view === "main"}
          flyouts
          // Left of the handle (#253), right of it for right-to-left blocks.
          placement={menu.handle?.classList.contains("rtl") ? "beside" : "before"}
          heading={menuHeading()}
          anchor={menu.anchor}
          views={menuViews()}
          initial={menu.view}
          owner={menu.handle}
          onClose={(reason) => closeMenu(reason)}
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
              <button type="button" className="icon-button" disabled={!rangeValid} aria-label={t("Kopieren", "Copy")} title={t("Kopieren", "Copy")} onClick={() => toClipboard(false)}>
                <CopySimple size={18} />
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
