"use client";
// The alignment and block style menus of the formatting toolbar (#278): the
// button shows what the text at the caret is now (its alignment icon,
// "Text" or "H1" …), the menu the choices with their shortcuts. Radix menus
// as the toolbar's colour menu: arrow keys, Enter, Escape, screen readers
// hear "menu" and the checked entry. Used by the app's toolbar
// (components/editor.tsx) and the one of shared pages
// (components/shared-editor.tsx).
import { useRef, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  CaretDown,
  Check,
  TextAlignCenter,
  TextAlignJustify,
  TextAlignLeft,
  TextAlignRight,
  TextHFour,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextT,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { safeCollisionPadding } from "./safe-area";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import {
  ALIGNMENTS,
  ALIGN_SHORTCUTS,
  BLOCK_STYLES,
  alignmentAt,
  blockStyleAt,
  blockStyleShort,
  blockStyleShortcut,
  type Alignment,
  type BlockStyle,
} from "@/lib/toolbar-format";

const ALIGN_ICONS: Record<Alignment, ReactNode> = {
  left: <TextAlignLeft />,
  center: <TextAlignCenter />,
  right: <TextAlignRight />,
  justify: <TextAlignJustify />,
};
const STYLE_ICONS: Record<string, ReactNode> = {
  paragraph: <TextT />,
  1: <TextHOne />,
  2: <TextHTwo />,
  3: <TextHThree />,
  4: <TextHFour />,
};

// One menu of the toolbar: a button with the current value and a caret,
// radio entries with icon, name and shortcut.
function FormatMenu<V extends string>({
  editor,
  label,
  current,
  trigger,
  className,
  entries,
  visibleText,
  onChoose,
}: {
  editor: Editor | null;
  label: string;
  current: V | null;
  trigger: ReactNode;
  className: string;
  entries: { value: V; label: string; icon: ReactNode; shortcut?: string; disabled?: boolean }[];
  /** The text the button shows, if any (not an icon). */
  visibleText?: string;
  onChoose: (value: V, selection: { from: number; to: number } | null) => void;
}) {
  const hints = useKeyboardHints();
  // The menu takes the focus; the choice applies to the text that was
  // selected when it opened (on phones the selection may be gone by then).
  const selection = useRef<{ from: number; to: number } | null>(null);
  const currentEntry = entries.find((entry) => entry.value === current);
  const name = currentEntry ? `${label}: ${currentEntry.label}` : label;
  // A text on the button ("H2") must be part of its accessible name
  // (WCAG 2.5.3, label in name), so voice control finds it by what it shows.
  const accessible = visibleText && !name.includes(visibleText) ? `${visibleText} – ${name}` : name;
  return (
    <Dropdown.Root
      onOpenChange={(open) => {
        if (open && editor) {
          const { from, to } = editor.state.selection;
          selection.current = { from, to };
        }
      }}
    >
      <Dropdown.Trigger asChild>
        <button type="button" className={`toolbar-menu-button ${className}`} title={name} aria-label={accessible} disabled={!editor?.isEditable}>
          {trigger}
          <CaretDown className="toolbar-menu-caret" weight="bold" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          collisionPadding={safeCollisionPadding()}
          className="dropdown toolbar-format-menu"
          sideOffset={6}
          align="start"
          aria-label={label}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <Dropdown.RadioGroup value={current ?? ""}>
            {entries.map((entry) => {
              const keys = entry.shortcut ? hints.keys(entry.shortcut) : "";
              return (
                <Dropdown.RadioItem
                  key={entry.value}
                  value={entry.value}
                  disabled={entry.disabled}
                  className="dropdown-item toolbar-format-item"
                  aria-keyshortcuts={entry.shortcut ? entry.shortcut.replace(/Mod/g, hints.mac ? "Meta" : "Control") : undefined}
                  onSelect={() => onChoose(entry.value, selection.current)}
                >
                  {entry.icon}
                  <span>{entry.label}</span>
                  {keys && (
                    <kbd className="block-menu-shortcut" aria-hidden>
                      {keys}
                    </kbd>
                  )}
                  <Dropdown.ItemIndicator className="toolbar-format-check">
                    <Check size={14} aria-hidden />
                  </Dropdown.ItemIndicator>
                </Dropdown.RadioItem>
              );
            })}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

// Back to the text, the remembered selection restored.
const chainAt = (editor: Editor, selection: { from: number; to: number } | null) => {
  const chain = editor.chain().focus();
  if (!selection) return chain;
  const size = editor.state.doc.content.size;
  return chain.setTextSelection({ from: Math.min(selection.from, size), to: Math.min(selection.to, size) });
};

export function AlignMenu({ editor }: { editor: Editor | null }) {
  const t = useT();
  const current = useEditorState({ editor, selector: ({ editor: e }) => (e ? alignmentAt(e.state) : null) }) ?? null;
  const names: Record<Alignment, string> = {
    left: t("Linksbündig", "Align left"),
    center: t("Zentriert", "Centred"),
    right: t("Rechtsbündig", "Align right"),
    justify: t("Blocksatz", "Justified"),
  };
  return (
    <FormatMenu<Alignment>
      editor={editor}
      label={t("Ausrichtung", "Alignment")}
      current={current}
      className="toolbar-align-menu"
      trigger={ALIGN_ICONS[current ?? "left"]}
      entries={ALIGNMENTS.map((value) => ({ value, label: names[value], icon: ALIGN_ICONS[value], shortcut: ALIGN_SHORTCUTS[value], disabled: current === null }))}
      onChoose={(value, selection) => {
        if (!editor) return;
        // Left is no alignment of its own: the default, also in RTL text.
        const chain = chainAt(editor, selection);
        (value === "left" ? chain.unsetTextAlign() : chain.setTextAlign(value)).run();
      }}
    />
  );
}

export function HeadingMenu({ editor }: { editor: Editor | null }) {
  const t = useT();
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            current: blockStyleAt(e.state),
            // A list item's first line stays text: headings are not allowed there.
            heading: e.can().setHeading({ level: 1 }) || e.isActive("heading"),
          }
        : { current: null, heading: false },
    equalityFn: (a, b) => a?.current === b?.current && a?.heading === b?.heading,
  });
  const current = state?.current ?? null;
  const shown = blockStyleShort(current) === "Text" ? t("Text", "Text") : blockStyleShort(current);
  const names = (style: BlockStyle) => (style === "paragraph" ? t("Text", "Text") : t(`Überschrift ${style}`, `Heading ${style}`));
  return (
    <FormatMenu<string>
      editor={editor}
      label={t("Textstil", "Text style")}
      current={current === null ? null : String(current)}
      className="toolbar-heading-menu"
      visibleText={shown}
      trigger={<span className="toolbar-menu-text">{shown}</span>}
      entries={BLOCK_STYLES.map((style) => ({
        value: String(style),
        label: names(style),
        icon: STYLE_ICONS[String(style)],
        shortcut: blockStyleShortcut(style),
        disabled: style !== "paragraph" && !state?.heading,
      }))}
      onChoose={(value, selection) => {
        if (!editor) return;
        const chain = chainAt(editor, selection);
        if (value === "paragraph") chain.setParagraph().run();
        else chain.setHeading({ level: Number(value) as 1 | 2 | 3 | 4 }).run();
      }}
    />
  );
}
