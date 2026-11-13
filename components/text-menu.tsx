"use client";
// The menu for text: selecting text shows it above the selection – below it
// where above would cover the formatting toolbar or another bar at the top
// (#210, lib/text-menu-placement.ts) – a right click opens it at the pointer (Shift + right click keeps the browser's
// own menu). Whether selecting shows it is the person's "Menü bei
// Textauswahl" (#200, lib/text-menu-pref.ts): by default only for a
// selection made with a mouse, trackpad or keyboard – on a phone or tablet
// the system's selection menu and the toolbar docked on the keyboard
// (formatting, comment) take over. The right click (a long press where the
// browser reports it as one, e.g. Android) opens it in every mode.
// Reactions for the paragraph, quick formatting (bold, italic, code, link –
// the toolbar has all of it), calculating a selected
// expression (insert or copy the result), a comment, copying. "Umwandeln in" changes the type
// of the line (text, heading, list, quote, code) and keeps its text; it is
// offered on right-click, so the menu over a selection stays small. In the
// desktop app a right click on a misspelled word adds the spell checker's
// suggestions at the top (the app's own menu does not appear over this one).
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { desktopApp } from "@/lib/native-app";
import { pointerInput, showsMenuOnSelection, type SelectionInput } from "@/lib/text-menu-pref";
import { textMenuPref } from "@/lib/text-menu-pref-client";
import { wordAt } from "@/lib/spelling-word";
import { useLocale, useT } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  CalendarBlank,
  ChatCircle,
  Code,
  Copy,
  ChartLine,
  Equals,
  HighlighterCircle,
  LinkSimple,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
  TextT,
  TextHOne,
  TextHTwo,
  TextHThree,
  ListBullets,
  ListNumbers,
  CheckSquare,
  Quotes,
  CodeBlock,
  MathOperations,
  Note,
  Sparkle,
  TextAa,
  BookOpen,
  CaretDown,
  CaretRight,
  DotsThree,
  Function as FunctionIcon,
  Info,
  Palette,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextSuperscript,
  TextSubscript,
  EyeSlash,
  PencilLine,
  UsersThree,
  ArrowUp,
  ArrowDown,
  TextTSlash,
  Check,
} from "@phosphor-icons/react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { CellSelection } from "@tiptap/pm/tables";
import { blockToMath, blockToToggle } from "@/lib/block-turn";
import { highlightColors, textColors } from "@/lib/text-marks";
import { CLEARED_MARKS, currentTextBlock, sameKind, type TextBlockKind } from "@/lib/text-menu-turn";
import type { AiAvailability } from "./ai-context";
import { hasLatexText } from "@/lib/chat-paste";
import { latexToFormulas } from "@/lib/latex-convert";
import { reactionBlockAt, setReactions, parseReactions } from "@/lib/block-reactions";
import { pickTaskDue, taskAtSelection } from "@/lib/task-due-plugin";
import { mathActionResult, type MathAction } from "@/lib/math-solve";
import { showToast } from "./toast";
import { textMenuMarks, textMenuSide, type MenuRect } from "@/lib/text-menu-placement";

const reactions = ["👍", "❤️", "🎉", "😄", "👀", "✅", "🙏", "🔥"];
// For a selection: x its middle, y its top, bottom its bottom.
type Place = { x: number; y: number; bottom?: number; mode: "selection" | "context" };
// The space between a selection and the menu.
const GAP = 10;

// The editor's formatting toolbar, if it is shown (focus mode hides it).
function toolbarOf(editor: Editor): HTMLElement | null {
  const bar = editor.view.dom.closest(".editor-wrapper")?.querySelector<HTMLElement>(".editor-toolbar");
  if (!bar) return null;
  const r = bar.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? bar : null;
}
const rectOf = (el: Element): MenuRect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
// What a menu above the selection must not cover: the top of the visible
// area (the scrolled dialog or page, the keyboard-shifted view), the
// toolbar and the bars that stay at the top while the text scrolls.
function surroundings(editor: Editor) {
  let minTop = -Infinity;
  for (let el = editor.view.dom.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      minTop = el.getBoundingClientRect().top;
      break;
    }
  }
  const bars = [...document.querySelectorAll(".topbar, .modal-heading")]
    .map(rectOf)
    .filter((r) => r.right > r.left && r.bottom > r.top);
  const bar = toolbarOf(editor);
  return { minTop, toolbar: bar ? rectOf(bar) : null, bars };
}
// What the editor lends the text menu where no formatting toolbar is shown
// (#235: focus mode, or the toolbar hidden in the settings): the toolbar's
// rarer actions, offered in the menu's "…".
export type TextMenuTools = {
  inlineMath: () => void;
  suggesting: boolean;
  setSuggesting: (on: boolean) => void;
  authors: boolean;
  setAuthors: (on: boolean) => void;
  outline: () => void;
  moveBlock: (direction: -1 | 1) => void;
};
// A misspelled word under the pointer and what the spell checker suggests.
type Spelling = { word: string; from: number; to: number; suggestions: string[] };

export function TextMenu({
  editor,
  userId,
  editable,
  onLink,
  ai = "hidden",
  aiHint = "",
  onAi,
  tools,
}: {
  editor: Editor | null;
  userId: string;
  editable: boolean;
  onLink: () => void;
  // The writing assistant: hidden without the feature, disabled (with the
  // hint) on pages the AI may not read.
  ai?: AiAvailability;
  aiHint?: string;
  onAi?: () => void;
  // The toolbar's other actions, for the full menu (#235).
  tools?: TextMenuTools;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const locale = useLocale();
  const [place, setPlace] = useState<Place | null>(null);
  // Results for a selected calculation ("3/4 + 1/6", "(a + b)²", "2x = 8").
  const [calc, setCalc] = useState<MathAction[]>([]);
  // The selection as a function of x, for "Graph zeichnen".
  const [graph, setGraph] = useState<string | null>(null);
  // Vectors in the plane to draw ("(1; 2) + (3; 1)" → a⃗, b⃗ and the sum).
  const [arrows, setArrows] = useState<string[] | null>(null);
  // Formulas written as text in the selection (\[ … \], \( … \)).
  const [latex, setLatex] = useState(false);
  const [spelling, setSpelling] = useState<Spelling | null>(null);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPlace(null), []);
  useEffect(() => {
    if (!editor) return;
    // After selecting with the mouse or keyboard: above the selection.
    // The view exists only while the editor is mounted.
    const mounted = () => !editor.isDestroyed;
    // The input of the latest press or Shift + arrow (lib/text-menu-pref.ts
    // decides with it whether selecting shows the menu).
    const coarse = !!window.matchMedia?.("(pointer: coarse)").matches;
    let lastInput: SelectionInput = pointerInput(null, coarse);
    const onPointerDown = (event: PointerEvent) => {
      lastInput = pointerInput(event.pointerType, coarse);
    };
    const showForSelection = () => {
      if (!mounted()) return;
      if (!showsMenuOnSelection(textMenuPref(), lastInput)) return;
      const { empty, from, to } = editor.state.selection;
      if (empty || !editor.view.hasFocus()) return;
      // Selected table cells have their own menu (#240, components/table-controls.tsx).
      if (editor.state.selection instanceof CellSelection) return;
      if (!editor.state.doc.textBetween(from, to, " ").trim()) return;
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      setPlace({ x: (start.left + end.right) / 2, y: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), mode: "selection" });
    };
    // The browser reports a new selection shortly after the mouse or key is
    // released; the editor knows it only then.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(showForSelection, 40);
    };
    // In this editor (its element can be replaced while the editor lives).
    const inEditor = (event: Event) => mounted() && editor.view.dom.contains(event.target as Node);
    // Only for presses that began in the text: a click elsewhere (a dialog
    // button that hands the focus back, a block handle) selects no text.
    let pressedInEditor = false;
    const onMouseDown = (event: MouseEvent) => {
      pressedInEditor = inEditor(event);
    };
    // Not for clicks in the menu itself (it closes after an action).
    const onMouseUp = (event: MouseEvent) => {
      if (!pressedInEditor) return;
      pressedInEditor = false;
      if ((event.target as HTMLElement | null)?.closest?.(".text-menu")) return;
      later();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (inEditor(event) && event.shiftKey && event.key.startsWith("Arrow")) {
        lastInput = "keyboard";
        later();
      }
    };
    // The desktop app's spell checker: the word at a position, if misspelled.
    const misspelledAt = (pos: number): Spelling | null => {
      const checker = desktopApp()?.spelling;
      if (!checker) return null;
      const $pos = editor.state.doc.resolve(pos);
      if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null;
      // One character for every inline node, so offsets stay positions.
      const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "\ufffc");
      const found = wordAt(text, $pos.parentOffset);
      if (!found) return null;
      try {
        const result = checker.check(found.word);
        if (!result?.misspelled) return null;
        const start = $pos.start();
        return { word: found.word, from: start + found.start, to: start + found.end, suggestions: (result.suggestions || []).slice(0, 5) };
      } catch {
        return null;
      }
    };
    const onContext = (event: MouseEvent) => {
      if (event.shiftKey || !inEditor(event)) return;
      // Images, videos and embedded files keep the browser's own menu
      // (copy image, save image …).
      if ((event.target as HTMLElement | null)?.closest?.("img, video, audio, canvas, iframe, object, embed")) return;
      event.preventDefault();
      // Right click outside the selection moves the caret there first.
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const { from, to } = editor.state.selection;
      if (at && (at.pos < from || at.pos > to)) editor.commands.setTextSelection(at.pos);
      setSpelling(at && editableRef.current ? misspelledAt(at.pos) : null);
      setPlace({ x: event.clientX, y: event.clientY, mode: "context" });
    };
    const onSelection = () => {
      if (editor.state.selection.empty) setPlace((p) => (p?.mode === "selection" ? null : p));
    };
    // Touch: selecting by long press or dragging the handles sends no
    // mouseup; follow the document's selection once it settles.
    // Only a selection that changed: after an action the same one stays.
    let shown = "";
    const onSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !mounted() || !editor.view.dom.contains(sel.anchorNode)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!mounted()) return;
        const { from, to } = editor.state.selection;
        if (`${from}-${to}` === shown) return;
        shown = `${from}-${to}`;
        showForSelection();
      }, 250);
    };
    if (coarse) document.addEventListener("selectionchange", onSelectionChange);
    // On the document: layers over the text (block handles) may take the event.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("contextmenu", onContext);
    editor.on("selectionUpdate", onSelection);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("contextmenu", onContext);
      editor.off("selectionUpdate", onSelection);
      if (coarse) document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [editor]);
  useEffect(() => {
    if (!place) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // Its lists open beside it (components/text-menu.tsx subMenu).
      if (!menu.current?.contains(target) && !target?.closest?.(".text-menu-sub")) close();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && !(event.target as HTMLElement | null)?.closest?.(".text-menu-sub") && close();
    const typing = (event: KeyboardEvent) => {
      // Not for keys in the menu's own lists (their type-ahead).
      if (menu.current?.contains(event.target as Node) || (event.target as HTMLElement | null)?.closest?.(".text-menu-sub")) return;
      if (place.mode === "selection" && !event.shiftKey && event.key.length === 1) close();
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key);
    document.addEventListener("keydown", typing);
    // A selection menu follows its text; the right-click menu closes.
    const moved = () => {
      if (place.mode !== "selection" || !editor) return close();
      const { from, to, empty } = editor.state.selection;
      if (empty) return close();
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const y = Math.min(start.top, end.top);
      const x = (start.left + end.right) / 2;
      const bottom = Math.max(start.bottom, end.bottom);
      if (Math.abs(y - place.y) > 1 || Math.abs(x - place.x) > 1 || Math.abs(bottom - (place.bottom ?? bottom)) > 1)
        setPlace({ x, y, bottom, mode: "selection" });
    };
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", key);
      document.removeEventListener("keydown", typing);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", close);
    };
  }, [place, close, editor]);
  useEffect(() => {
    setCalc([]);
    setGraph(null);
    setArrows(null);
    setLatex(false);
    if (!place || !editor || !editable) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const text = editor.state.doc.textBetween(from, to, " ");
    if (hasLatexText(text)) setLatex(true);
    if (text.length > 300 || !/[\d)a-z]\s*[-+−*/×·÷:^²³=]|√|[([][^()[\]]*[;|,][^()[\]]*[)\]]/.test(text)) return;
    let current = true;
    void import("@/lib/math-solve").then(({ mathActions, functionExpression, plotVectors }) => {
      if (!current) return;
      setArrows(plotVectors(text, locale));
      setCalc(mathActions(text, locale).slice(0, 4));
      setGraph(/x/.test(text) && functionExpression(text, locale) ? text.trim().replace(/^(?:y|[a-zA-Z]\s*\(\s*x\s*\))\s*[=:]\s*/, "").replace(/=\s*$/, "") : null);
    });
    return () => {
      current = false;
    };
  }, [place, editor, editable, locale]);
  // Keep the menu on screen – the visible part of it, above the keyboard –
  // also when its content grows (calculations, a narrow phone).
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const shiftRef = useRef(shift);
  shiftRef.current = shift;
  useLayoutEffect(() => {
    const el = menu.current;
    if (!place || !el) {
      setShift((s) => (s.x || s.y ? { x: 0, y: 0 } : s));
      return;
    }
    const measure = () => {
      // Where the menu sits without a shift, from its layout size: the
      // opening animation scales it, so its on-screen box would mislead.
      const rect = { width: el.offsetWidth, height: el.offsetHeight };
      const left = place.mode === "selection" ? place.x - rect.width / 2 : place.x + 2;
      const top = place.mode === "selection" ? place.y - rect.height - GAP : place.y + 2;
      const vv = window.visualViewport;
      const minY = (vv?.offsetTop ?? 0) + 8;
      const maxX = (vv?.width ?? window.innerWidth) - 8;
      let maxY = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 8;
      const x = left < 8 || rect.width > maxX - 8 ? 8 - left : left + rect.width > maxX ? maxX - left - rect.width : 0;
      if (place.mode !== "selection" || !editor || editor.isDestroyed) {
        const y = top < minY ? minY - top : top + rect.height > maxY ? maxY - top - rect.height : 0;
        if (x !== shiftRef.current.x || y !== shiftRef.current.y) setShift({ x, y });
        return;
      }
      // Above the selection, or below it where above would cover the
      // toolbar, a bar at the top or leave the visible area (#210).
      const around = surroundings(editor);
      const bottom = place.bottom ?? place.y;
      // A toolbar docked at the bottom (on the phone's keyboard) ends the
      // room below.
      if (around.toolbar && around.toolbar.top >= bottom) maxY = Math.min(maxY, around.toolbar.top - 8);
      const side = textMenuSide({
        selection: { top: place.y, bottom },
        menu: { left: left + x, width: rect.width, height: rect.height },
        gap: GAP,
        minTop: Math.max(minY, around.minTop),
        toolbar: around.toolbar,
        bars: around.bars,
      });
      const at = side === "above" ? top : bottom + GAP;
      // Below and too tall for the room left: moved up as far as needed.
      const fit = side === "below" && at + rect.height > maxY ? Math.max(maxY - at - rect.height, minY - at) : 0;
      const y = at - top + fit;
      if (x !== shiftRef.current.x || y !== shiftRef.current.y) setShift({ x, y });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [place, editor]);
  if (!editor || !place) return null;
  const { from, to, empty } = editor.state.selection;
  const block = reactionBlockAt(editor.state.doc, from);
  const blockNode = block !== null ? editor.state.doc.nodeAt(block) : null;
  const mine = new Set(
    Object.entries(parseReactions(blockNode?.attrs.reactions) || {})
      .filter(([, ids]) => ids.includes(userId))
      .map(([emoji]) => emoji),
  );
  const task = editable ? taskAtSelection(editor.view) : null;
  // Underline, strikethrough and highlight only where the toolbar is not
  // shown (#210): it has them, and they keep their shortcuts. Without the
  // toolbar (focus mode, or hidden in the settings, #235) the menu is the
  // full set: "Umwandeln in", every mark, colour, formula, clearing, and
  // the toolbar's rarer actions in "…".
  const full = !toolbarOf(editor);
  const marks = new Set(textMenuMarks(!full));
  const run = (fn: () => void) => () => {
    fn();
    close();
  };
  const mark = (name: string, label: string, icon: React.ReactNode, toggle: () => void) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={editor.isActive(name)}
      aria-label={label}
      title={label}
      className={editor.isActive(name) ? "active" : ""}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggle()}
    >
      {icon}
    </button>
  );
  // Lists of the menu (Turn into, colour, "…") take the focus; what they
  // change is the selection the menu was opened for.
  const kept = { from, to };
  const chain = () => {
    const c = editor.chain().focus();
    return kept.to <= editor.state.doc.content.size ? c.setTextSelection(kept) : c;
  };
  const current = currentTextBlock(editor.state);
  const turnLabels: [TextBlockKind, string, React.ReactNode][] = [
    [{ type: "paragraph" }, t("Text", "Text"), <TextT key="t" size={16} />],
    [{ type: "heading", level: 1 }, t("Überschrift 1", "Heading 1"), <TextHOne key="1" size={16} />],
    [{ type: "heading", level: 2 }, t("Überschrift 2", "Heading 2"), <TextHTwo key="2" size={16} />],
    [{ type: "heading", level: 3 }, t("Überschrift 3", "Heading 3"), <TextHThree key="3" size={16} />],
    [{ type: "bulletList" }, t("Aufzählung", "Bulleted list"), <ListBullets key="b" size={16} />],
    [{ type: "orderedList" }, t("Nummerierte Liste", "Numbered list"), <ListNumbers key="o" size={16} />],
    [{ type: "taskList" }, t("Aufgabenliste", "Task list"), <CheckSquare key="k" size={16} />],
    [{ type: "toggle", heading: null }, t("Aufklappbarer Block", "Toggle"), <CaretRight key="g" size={16} />],
    [{ type: "blockquote" }, t("Zitat", "Quote"), <Quotes key="q" size={16} />],
    [{ type: "callout" }, t("Hinweis", "Callout"), <Info key="i" size={16} />],
    [{ type: "codeBlock" }, t("Code", "Code"), <CodeBlock key="c" size={16} />],
  ];
  const currentLabel = current ? turnLabels.find(([kind]) => sameKind(kind, current.kind))?.[1] || t("Text", "Text") : t("Text", "Text");
  // Out of the current type first (list, quote, heading), then into the
  // new one – as the right-click row does; a toggle and a formula through
  // lib/block-turn.ts like the block menu (#238).
  const turnInto = (kind: TextBlockKind) => {
    if (current && sameKind(kind, current.kind)) return;
    const c = chain();
    switch (kind.type) {
      case "paragraph":
        return c.clearNodes().run();
      case "heading":
        return c.clearNodes().setHeading({ level: kind.level as 1 | 2 | 3 }).run();
      case "bulletList":
        return c.clearNodes().toggleBulletList().run();
      case "orderedList":
        return c.clearNodes().toggleOrderedList().run();
      case "taskList":
        return c.clearNodes().toggleTaskList().run();
      case "blockquote":
        return c.clearNodes().toggleBlockquote().run();
      case "callout":
        return c.clearNodes().wrapIn("callout", { type: "note" }).run();
      case "codeBlock":
        return c.clearNodes().setCodeBlock().run();
      case "toggle": {
        const at = currentTextBlock(editor.state);
        if (at) c.command(({ tr }) => blockToToggle(tr, at.pos, null)).run();
        return;
      }
    }
  };
  const subMenu = (props: { label: string; trigger: React.ReactNode; className?: string; title?: string; children: React.ReactNode }) => (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button type="button" className={props.className} aria-label={props.label} title={props.title ?? props.label} onMouseDown={(e) => e.preventDefault()}>
          {props.trigger}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className="dropdown text-menu-sub"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {props.children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
  const subItem = (label: string, icon: React.ReactNode, action: () => void, active = false, key?: string) => (
    <Dropdown.Item
      key={key ?? label}
      className={`dropdown-item text-menu-sub-item${active ? " active" : ""}`}
      onSelect={() => {
        action();
        close();
      }}
    >
      {icon}
      <span>{label}</span>
      {active && <Check size={14} className="text-menu-sub-check" aria-hidden />}
    </Dropdown.Item>
  );
  return (
    <div
      ref={menu}
      className={`text-menu ${place.mode}`}
      role="menu"
      aria-label={t("Textmenü", "Text menu")}
      style={{
        left: place.x + shift.x,
        top: place.y + shift.y,
      }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
      }}
    >
      {editable && place.mode === "context" && spelling && (
        <div className="text-menu-calc text-menu-spelling" role="group" aria-label={t("Rechtschreibung", "Spelling")}>
          {spelling.suggestions.length ? (
            spelling.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                role="menuitem"
                title={t(`„${spelling.word}“ ersetzen`, `Replace “${spelling.word}”`)}
                onClick={run(() => {
                  // Only if the word is still there (the text may have changed).
                  if (editor.state.doc.textBetween(spelling.from, spelling.to) !== spelling.word) return;
                  // Typed over the word: its marks (bold, a link) stay.
                  editor.view.dispatch(editor.state.tr.insertText(suggestion, spelling.from, spelling.to));
                  editor.commands.focus();
                })}
              >
                <TextAa size={15} />
                <strong>{suggestion}</strong>
              </button>
            ))
          ) : (
            <span className="text-menu-note">{t("Keine Vorschläge", "No suggestions")}</span>
          )}
          <button type="button" role="menuitem" onClick={run(() => void desktopApp()?.spelling?.addWord(spelling.word))}>
            <BookOpen size={15} />
            <span>{t("Zum Wörterbuch hinzufügen", "Add to dictionary")}</span>
          </button>
        </div>
      )}
      {editable && block !== null && userId && (
        <div className="text-menu-reactions" role="group" aria-label={t("Auf den Absatz reagieren", "React to the paragraph")}>
          {reactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitemcheckbox"
              aria-checked={mine.has(emoji)}
              aria-label={t(`Mit ${emoji} reagieren`, `React with ${emoji}`)}
              className={mine.has(emoji) ? "active" : ""}
              onClick={run(() => setReactions(editor.view, block, emoji, userId))}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {editable && (
        <div className={`text-menu-format${full ? " full" : ""}`} role="group" aria-label={t("Formatieren", "Format")}>
          {full &&
            current &&
            subMenu({
              label: t(`Umwandeln in: ${currentLabel}`, `Turn into: ${currentLabel}`),
              title: t("Umwandeln in", "Turn into"),
              className: "text-menu-turn-button",
              trigger: (
                <>
                  <span>{currentLabel}</span>
                  <CaretDown size={11} weight="bold" aria-hidden />
                </>
              ),
              children: (
                <>
                  <Dropdown.Label className="text-menu-sub-label">{t("Umwandeln in", "Turn into")}</Dropdown.Label>
                  {turnLabels.map(([kind, label, icon]) => subItem(label, icon, () => turnInto(kind), sameKind(kind, current.kind)))}
                  <Dropdown.Item
                    className="dropdown-item text-menu-sub-item"
                    onSelect={() => {
                      const at = currentTextBlock(editor.state);
                      if (at) chain().command(({ tr }) => blockToMath(tr, at.pos)).run();
                      close();
                    }}
                  >
                    <MathOperations size={16} />
                    <span>{t("Formel", "Block equation")}</span>
                  </Dropdown.Item>
                </>
              ),
            })}
          {mark("bold", t("Fett", "Bold"), <TextB size={16} />, () => editor.chain().focus().toggleBold().run())}
          {mark("italic", t("Kursiv", "Italic"), <TextItalic size={16} />, () => editor.chain().focus().toggleItalic().run())}
          {marks.has("underline") &&
            mark("underline", t("Unterstrichen", "Underline"), <TextUnderline size={16} />, () => editor.chain().focus().toggleUnderline().run())}
          {marks.has("strike") &&
            mark("strike", t("Durchgestrichen", "Strikethrough"), <TextStrikethrough size={16} />, () => editor.chain().focus().toggleStrike().run())}
          {mark("code", "Code", <Code size={16} />, () => editor.chain().focus().toggleCode().run())}
          {marks.has("highlight") &&
            mark("highlight", t("Markieren", "Highlight"), <HighlighterCircle size={16} />, () => editor.chain().focus().toggleHighlight().run())}
          {full &&
            subMenu({
              label: t("Text- und Hintergrundfarbe", "Text and background colour"),
              title: t("Farbe", "Colour"),
              trigger: <Palette size={16} />,
              children: (
                <div className="color-menu">
                  <div className="color-menu-label">{t("Textfarbe", "Text colour")}</div>
                  <div className="color-swatches">
                    {textColors.map(([name, color]) => (
                      <Dropdown.Item
                        key={color}
                        className="color-swatch"
                        aria-label={t(`Textfarbe ${name}`, `Text colour ${name}`)}
                        title={name}
                        style={{ color }}
                        onSelect={() => {
                          chain().setTextColor(color).run();
                          close();
                        }}
                      >
                        A
                      </Dropdown.Item>
                    ))}
                  </div>
                  <div className="color-menu-label">{t("Hintergrund", "Background")}</div>
                  <div className="color-swatches">
                    {highlightColors.map(([name, color]) => (
                      <Dropdown.Item
                        key={color}
                        className="color-swatch"
                        aria-label={t(`Hintergrund ${name}`, `Background ${name}`)}
                        title={name}
                        style={{ background: color }}
                        onSelect={() => {
                          chain().setHighlight({ color }).run();
                          close();
                        }}
                      >
                        A
                      </Dropdown.Item>
                    ))}
                  </div>
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={() => {
                      chain().unsetTextColor().unsetHighlight().run();
                      close();
                    }}
                  >
                    {t("Farben entfernen", "Remove colours")}
                  </Dropdown.Item>
                </div>
              ),
            })}
          <button type="button" aria-label="Link" title="Link" onClick={run(onLink)}>
            <LinkSimple size={16} />
          </button>
          {full && tools && (
            <button
              type="button"
              aria-label={t("Inline-Formel", "Inline formula")}
              title={t("Inline-Formel", "Inline formula")}
              onClick={run(() => tools.inlineMath())}
            >
              <FunctionIcon size={16} />
            </button>
          )}
          {full && (
            <button
              type="button"
              aria-label={t("Formatierung entfernen", "Clear formatting")}
              title={t("Formatierung entfernen", "Clear formatting")}
              onClick={run(() => {
                let c = chain();
                for (const name of CLEARED_MARKS) if (editor.schema.marks[name]) c = c.unsetMark(name);
                c.run();
              })}
            >
              <TextTSlash size={16} />
            </button>
          )}
          {full &&
            tools &&
            subMenu({
              label: t("Weitere Formatierungen", "More formatting"),
              trigger: <DotsThree size={16} weight="bold" />,
              children: (
                <>
                  {subItem(t("Hochgestellt", "Superscript"), <TextSuperscript size={16} />, () => chain().toggleSuperscript().run(), editor.isActive("superscript"))}
                  {subItem(t("Tiefgestellt", "Subscript"), <TextSubscript size={16} />, () => chain().toggleSubscript().run(), editor.isActive("subscript"))}
                  {subItem(t("Verdecken (Spoiler)", "Hide (spoiler)"), <EyeSlash size={16} />, () => chain().toggleMark("spoiler").run(), editor.isActive("spoiler"))}
                  <Dropdown.Separator className="dropdown-separator" />
                  {subItem(t("Linksbündig", "Align left"), <TextAlignLeft size={16} />, () => chain().unsetTextAlign().run())}
                  {subItem(t("Zentrieren", "Centre"), <TextAlignCenter size={16} />, () => chain().setTextAlign("center").run(), editor.isActive({ textAlign: "center" }))}
                  {subItem(t("Rechtsbündig", "Align right"), <TextAlignRight size={16} />, () => chain().setTextAlign("right").run(), editor.isActive({ textAlign: "right" }))}
                  <Dropdown.Separator className="dropdown-separator" />
                  {subItem(t("Block nach oben", "Move block up"), <ArrowUp size={16} />, () => tools.moveBlock(-1))}
                  {subItem(t("Block nach unten", "Move block down"), <ArrowDown size={16} />, () => tools.moveBlock(1))}
                  <Dropdown.Separator className="dropdown-separator" />
                  {subItem(
                    tools.suggesting ? t("Vorschlagen beenden", "Stop suggesting") : t("Vorschlagen", "Suggest"),
                    <PencilLine size={16} />,
                    () => tools.setSuggesting(!tools.suggesting),
                    tools.suggesting,
                  )}
                  {subItem(t("Autoren anzeigen", "Show authors"), <UsersThree size={16} />, () => tools.setAuthors(!tools.authors), tools.authors)}
                  {subItem(t("Inhaltsverzeichnis", "Table of contents"), <ListBullets size={16} />, () => tools.outline())}
                </>
              ),
            })}
        </div>
      )}
      {editable && place.mode === "context" && !full && (
        <div className="text-menu-format text-menu-turn" role="group" aria-label={t("Umwandeln in", "Turn into")}>
          {(
            [
              ["paragraph", t("Text", "Text"), <TextT key="t" size={16} />, () => true, (c) => c],
              ["h1", t("Überschrift 1", "Heading 1"), <TextHOne key="1" size={16} />, () => editor.isActive("heading", { level: 1 }), (c) => c.setHeading({ level: 1 })],
              ["h2", t("Überschrift 2", "Heading 2"), <TextHTwo key="2" size={16} />, () => editor.isActive("heading", { level: 2 }), (c) => c.setHeading({ level: 2 })],
              ["h3", t("Überschrift 3", "Heading 3"), <TextHThree key="3" size={16} />, () => editor.isActive("heading", { level: 3 }), (c) => c.setHeading({ level: 3 })],
              ["bullet", t("Aufzählung", "Bulleted list"), <ListBullets key="b" size={16} />, () => editor.isActive("bulletList"), (c) => c.toggleBulletList()],
              ["ordered", t("Nummerierte Liste", "Numbered list"), <ListNumbers key="o" size={16} />, () => editor.isActive("orderedList"), (c) => c.toggleOrderedList()],
              ["task", t("Aufgabe", "Task"), <CheckSquare key="k" size={16} />, () => editor.isActive("taskList"), (c) => c.toggleTaskList()],
              ["quote", t("Zitat", "Quote"), <Quotes key="q" size={16} />, () => editor.isActive("blockquote"), (c) => c.toggleBlockquote()],
              ["code", t("Codeblock", "Code block"), <CodeBlock key="c" size={16} />, () => editor.isActive("codeBlock"), (c) => c.setCodeBlock()],
            ] as [string, string, React.ReactNode, () => boolean, (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>][]
          ).map(([key, label, icon, isActive, apply]) => {
            const plain = !["heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock"].some((n) => editor.isActive(n));
            const active = key === "paragraph" ? plain : isActive();
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                aria-label={t(`Umwandeln in ${label}`, `Turn into ${label}`)}
                title={label}
                className={active ? "active" : ""}
                onClick={run(() => {
                  if (active && key !== "paragraph") return;
                  // Out of the current type first (list, quote, heading), then into the new one.
                  apply(editor.chain().focus().clearNodes()).run();
                })}
              >
                {icon}
              </button>
            );
          })}
        </div>
      )}
      {editable && latex && (
        <div className="text-menu-calc" role="group" aria-label={t("Formeln", "Formulas")}>
          <button
            type="button"
            role="menuitem"
            title={t("\\[ … \\] und \\( … \\) als Formeln darstellen", "Show \\[ … \\] and \\( … \\) as formulas")}
            onClick={run(() => {
              const { from, to } = editor.state.selection;
              const tr = latexToFormulas(editor.state, from, to);
              if (tr) editor.view.dispatch(tr);
            })}
          >
            <MathOperations size={15} />
            <span>{t("In Formeln umwandeln", "Turn into formulas")}</span>
          </button>
        </div>
      )}
      {(calc.length > 0 || graph || arrows) && (
        <div className="text-menu-calc" role="group" aria-label={t("Rechnen", "Calculate")}>
          {graph && (
            <button
              type="button"
              role="menuitem"
              title={t("Funktionsgraph unter dem Absatz einfügen", "Insert a function graph below the paragraph")}
              onClick={run(() => {
                const $to = editor.state.doc.resolve(to);
                const after = $to.after(Math.max(1, $to.depth));
                editor
                  .chain()
                  .insertContentAt(after, { type: "functionPlot", attrs: { plot: JSON.stringify({ functions: [{ expr: graph, color: "#3b3fd8" }] }) } })
                  .run();
              })}
            >
              <ChartLine size={15} />
              <span>{t("Graph zeichnen", "Draw graph")}</span>
              <strong>{`f(x) = ${graph}`}</strong>
            </button>
          )}
          {arrows && (
            <button
              type="button"
              role="menuitem"
              title={t("Die Vektoren unter dem Absatz zeichnen", "Draw the vectors below the paragraph")}
              onClick={run(() => {
                const $to = editor.state.doc.resolve(to);
                const after = $to.after(Math.max(1, $to.depth));
                const colors = ["#3b3fd8", "#e03131", "#2f9e44", "#f08c00", "#9c36b5", "#1098ad"];
                editor
                  .chain()
                  .insertContentAt(after, { type: "functionPlot", attrs: { plot: JSON.stringify({ functions: arrows.map((expr, i) => ({ expr, color: colors[i % colors.length] })) }) } })
                  .run();
              })}
            >
              <ChartLine size={15} />
              <span>{t("Vektoren zeichnen", "Draw vectors")}</span>
              <strong>{arrows.length === 1 ? arrows[0] : t(`${arrows.length} Pfeile`, `${arrows.length} arrows`)}</strong>
            </button>
          )}
          {calc.map((action) => (
            // The row inserts the result after the selection; the button at
            // its end copies it (a sibling, so Tab reaches it and Enter on
            // either does only its own thing).
            <div key={action.kind + action.text} className="text-menu-calc-row">
              <button
                type="button"
                role="menuitem"
                title={t("Hinter der Auswahl einfügen", "Insert after the selection")}
                onClick={run(() => editor.view.dispatch(editor.state.tr.insertText(` ${action.text}`, to)))}
              >
                <Equals size={15} />
                <span>{action.label}</span>
                <strong>{mathActionResult(action)}</strong>
              </button>
              <button
                type="button"
                role="menuitem"
                className="text-menu-calc-copy"
                aria-label={t("Ergebnis kopieren", "Copy result")}
                title={t("Ergebnis kopieren", "Copy result")}
                onClick={() => {
                  const text = mathActionResult(action);
                  void navigator.clipboard
                    ?.writeText(text)
                    .then(() => showToast({ text: t("Kopiert", "Copied") }))
                    .catch(() => showToast({ text: t("Kopieren nicht möglich.", "Copying failed."), tone: "error" }));
                }}
              >
                <Copy size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="text-menu-actions" role="group">
        {editable && ai !== "hidden" && onAi && (
          <button
            type="button"
            role="menuitem"
            className="text-menu-ai"
            aria-disabled={ai === "blocked" || undefined}
            title={ai === "blocked" ? aiHint : t("KI-Schreibassistent", "AI writing assistant") + keyHints.suffix("Mod+J")}
            onClick={() => {
              if (ai === "blocked") return;
              close();
              onAi();
            }}
          >
            <Sparkle size={15} weight="fill" /> {t("KI", "AI")}
          </button>
        )}
        {task && (
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              // The picker opens where the menu was (read before it closes).
              pickTaskDue(editor.view, e.currentTarget);
              close();
            }}
          >
            <CalendarBlank size={15} /> {task.node.attrs.due ? t("Fälligkeit ändern", "Change due date") : t("Fälligkeit", "Due date")}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={run(() => editor.view.dom.dispatchEvent(new CustomEvent("comment-create")))}
        >
          <ChatCircle size={15} /> {t("Kommentieren", "Comment")}
        </button>
        {editable && editor.can().openFootnote() && (
          <button
            type="button"
            role="menuitem"
            title={t("Fußnote einfügen", "Insert footnote") + keyHints.suffix("Mod+Alt+F")}
            onClick={run(() => editor.commands.openFootnote())}
          >
            <Note size={15} /> {t("Fußnote", "Footnote")}
          </button>
        )}
        {!empty && (
          <button
            type="button"
            role="menuitem"
            onClick={run(() => void navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to, "\n")))}
          >
            <Copy size={15} /> {t("Kopieren", "Copy")}
          </button>
        )}
      </div>
    </div>
  );
}
