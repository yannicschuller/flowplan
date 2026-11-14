// Names of the formatting toolbar's buttons and groups (#292,
// lib/toolbar-layout.ts) for the settings and a group's button.
import { TOOLBAR_GROUP_PRESETS, type GroupableItem, type ToolbarGroupPreset, type ToolbarItem } from "./toolbar-layout";

type T = (de: string, en: string) => string;

// The names the settings show; buttons that only show while they apply
// say when.
export function toolbarItemLabels(t: T): Record<ToolbarItem, string> {
  return {
    undo: t("Rückgängig", "Undo"),
    redo: t("Wiederholen", "Redo"),
    imageTools: t("Bild markieren und kopieren (bei ausgewähltem Bild)", "Mark up and copy image (with an image selected)"),
    bold: t("Fett", "Bold"),
    italic: t("Kursiv", "Italic"),
    underline: t("Unterstrichen", "Underline"),
    strike: t("Durchgestrichen", "Strikethrough"),
    highlight: t("Markieren", "Highlight"),
    comment: t("Kommentieren", "Comment"),
    color: t("Farbe", "Colour"),
    mediaWidth: t("Medienbreite (bei ausgewähltem Video oder Einbettung)", "Media width (with a video or embed selected)"),
    superscript: t("Hochgestellt", "Superscript"),
    subscript: t("Tiefgestellt", "Subscript"),
    spoiler: t("Verdecken (Spoiler)", "Hide (spoiler)"),
    suggest: t("Vorschlagen", "Suggest"),
    authors: t("Autoren anzeigen", "Show authors"),
    link: "Link",
    heading: t("Textstil (Text, Überschriften)", "Text style (text, headings)"),
    bulletList: t("Aufzählung", "Bulleted list"),
    orderedList: t("Nummerierte Liste", "Numbered list"),
    taskList: t("Aufgabenliste", "Task list"),
    taskDue: t("Fälligkeit setzen (in einer Aufgabe)", "Set due date (in a task)"),
    align: t("Ausrichtung", "Alignment"),
    blockUp: t("Block nach oben", "Move block up"),
    blockDown: t("Block nach unten", "Move block down"),
    outline: t("Inhaltsverzeichnis", "Table of contents"),
    inlineMath: t("Inline-Formel", "Inline formula"),
    addBlock: t("Block hinzufügen", "Add block"),
  };
}

export function toolbarPresetLabel(preset: ToolbarGroupPreset, t: T): string {
  return preset === "lists" ? t("Listen", "Lists") : t("Hoch-/Tiefgestellt & Durchgestrichen", "Superscript, subscript & strikethrough");
}

// A group's name: a preset's name, else the names of its buttons.
export function toolbarGroupLabel(group: readonly GroupableItem[], labelOf: (item: GroupableItem) => string, t: T): string {
  for (const preset of Object.keys(TOOLBAR_GROUP_PRESETS) as ToolbarGroupPreset[]) {
    const items: readonly string[] = TOOLBAR_GROUP_PRESETS[preset];
    if (group.length === items.length && group.every((item) => items.includes(item))) return toolbarPresetLabel(preset, t);
  }
  return group.map(labelOf).join(", ");
}
