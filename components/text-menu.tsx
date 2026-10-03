"use client";
// The menu for text: selecting text shows it above the selection, a right
// click opens it at the pointer (Shift + right click keeps the browser's
// own menu). Reactions for the paragraph, formatting, a comment, copying.
import { useT } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  CalendarBlank,
  ChatCircle,
  Code,
  Copy,
  HighlighterCircle,
  LinkSimple,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
} from "@phosphor-icons/react";
import { reactionBlockAt, setReactions, parseReactions } from "@/lib/block-reactions";
import { pickTaskDue, taskAtSelection } from "@/lib/task-due-plugin";

const reactions = ["👍", "❤️", "🎉", "😄", "👀", "✅", "🙏", "🔥"];
type Place = { x: number; y: number; mode: "selection" | "context" };

export function TextMenu({
  editor,
  userId,
  editable,
  onLink,
}: {
  editor: Editor | null;
  userId: string;
  editable: boolean;
  onLink: () => void;
}) {
  const t = useT();
  const [place, setPlace] = useState<Place | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPlace(null), []);
  useEffect(() => {
    if (!editor) return;
    // After selecting with the mouse or keyboard: above the selection.
    const showForSelection = () => {
      const { empty, from, to } = editor.state.selection;
      if (empty || !editor.view.hasFocus()) return;
      if (!editor.state.doc.textBetween(from, to, " ").trim()) return;
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      setPlace({ x: (start.left + end.right) / 2, y: Math.min(start.top, end.top), mode: "selection" });
    };
    // The browser reports a new selection shortly after the mouse or key is
    // released; the editor knows it only then.
    const later = () => setTimeout(showForSelection, 40);
    // In this editor (its element can be replaced while the editor lives).
    const inEditor = (event: Event) => editor.view.dom.contains(event.target as Node);
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
      if (inEditor(event) && event.shiftKey && event.key.startsWith("Arrow")) later();
    };
    const onContext = (event: MouseEvent) => {
      if (event.shiftKey || !inEditor(event)) return;
      event.preventDefault();
      // Right click outside the selection moves the caret there first.
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const { from, to } = editor.state.selection;
      if (at && (at.pos < from || at.pos > to)) editor.commands.setTextSelection(at.pos);
      setPlace({ x: event.clientX, y: event.clientY, mode: "context" });
    };
    const onSelection = () => {
      if (editor.state.selection.empty) setPlace((p) => (p?.mode === "selection" ? null : p));
    };
    // On the document: layers over the text (block handles) may take the event.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("contextmenu", onContext);
    editor.on("selectionUpdate", onSelection);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("contextmenu", onContext);
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor]);
  useEffect(() => {
    if (!place) return;
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && close();
    const typing = (event: KeyboardEvent) => {
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
      if (Math.abs(y - place.y) > 1 || Math.abs(x - place.x) > 1) setPlace({ x, y, mode: "selection" });
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
  // Keep the menu on screen.
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!place || !menu.current) return setShift({ x: 0, y: 0 });
    const rect = menu.current.getBoundingClientRect();
    const x = rect.left < 8 ? 8 - rect.left : rect.right > window.innerWidth - 8 ? window.innerWidth - 8 - rect.right : 0;
    const y = rect.top < 8 ? (place.mode === "selection" ? rect.height + 44 : 8 - rect.top) : rect.bottom > window.innerHeight - 8 ? window.innerHeight - 8 - rect.bottom : 0;
    setShift({ x, y });
  }, [place]);
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
        <div className="text-menu-format" role="group" aria-label={t("Formatieren", "Format")}>
          {mark("bold", t("Fett", "Bold"), <TextB size={16} />, () => editor.chain().focus().toggleBold().run())}
          {mark("italic", t("Kursiv", "Italic"), <TextItalic size={16} />, () => editor.chain().focus().toggleItalic().run())}
          {mark("underline", t("Unterstrichen", "Underline"), <TextUnderline size={16} />, () => editor.chain().focus().toggleUnderline().run())}
          {mark("strike", t("Durchgestrichen", "Strikethrough"), <TextStrikethrough size={16} />, () => editor.chain().focus().toggleStrike().run())}
          {mark("highlight", t("Markieren", "Highlight"), <HighlighterCircle size={16} />, () => editor.chain().focus().toggleHighlight().run())}
          {mark("code", "Code", <Code size={16} />, () => editor.chain().focus().toggleCode().run())}
          <button type="button" aria-label="Link" title="Link" onClick={run(onLink)}>
            <LinkSimple size={16} />
          </button>
        </div>
      )}
      <div className="text-menu-actions" role="group">
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
