// Names of the formatting toolbar's buttons and groups (#292,
// lib/toolbar-layout.ts) for the settings and a group's button.
import { TOOLBAR_GROUP_PRESETS, type GroupableItem, type ToolbarBlock, type ToolbarGroupPreset, type ToolbarItem } from "./toolbar-layout";

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
    indent: t("Einrücken", "Indent"),
    outdent: t("Ausrücken", "Outdent"),
    outline: t("Inhaltsverzeichnis", "Table of contents"),
    inlineMath: t("Inline-Formel", "Inline formula"),
    addBlock: t("Block hinzufügen", "Add block"),
    ...toolbarBlockLabels(t),
  };
}

// The blocks of the "/" menu by the names they have there
// (components/editor.tsx, `commands`).
export function toolbarBlockLabels(t: T): Record<ToolbarBlock, string> {
  return {
    "block:ai": t("KI-Assistent", "AI assistant"),
    "block:text": t("Text", "Text"),
    "block:h1": t("Überschrift 1", "Heading 1"),
    "block:h2": t("Überschrift 2", "Heading 2"),
    "block:h3": t("Überschrift 3", "Heading 3"),
    "block:h4": t("Überschrift 4", "Heading 4"),
    "block:quote": t("Zitat", "Quote"),
    "block:divider": t("Trennlinie", "Divider"),
    "block:page-break": t("Seitenumbruch", "Page break"),
    "block:citation": t("Literaturzitat", "Citation"),
    "block:bibliography": t("Literaturverzeichnis", "Bibliography"),
    "block:callout": t("Callout", "Callout"),
    "block:toggle": t("Aufklappbarer Block", "Toggle"),
    "block:code": "Code",
    "block:table": t("Tabelle", "Table"),
    "block:columns": t("Zwei Spalten", "Two columns"),
    "block:tabs": t("Tabs", "Tabs"),
    "block:footnote": t("Fußnote", "Footnote"),
    "block:file": t("Bild oder Datei", "Image or file"),
    "block:embed": t("Einbetten", "Embed"),
    "block:mermaid": t("Mermaid-Diagramm", "Mermaid diagram"),
    "block:drawio": t("draw.io-Diagramm", "draw.io diagram"),
    "block:draw": t("Zeichnen", "Draw"),
    "block:whiteboard": t("Whiteboard", "Whiteboard"),
    "block:meet": t("Besprechung", "Meeting"),
    "block:voice": t("Sprachnotiz", "Voice note"),
    "block:scan": t("Dokument scannen", "Scan document"),
    "block:math": t("Formel", "Formula"),
    "block:plot": t("Funktionsgraph", "Function graph"),
    "block:fraction": t("Bruch", "Fraction"),
    "block:metric": t("Kennzahl", "Metric"),
    "block:dashboard": t("Dashboard", "Dashboard"),
    "block:mention": t("Seite, Eintrag oder Person erwähnen", "Mention a page, record or person"),
    "block:linked-database": t("Verknüpfte Datenbank", "Linked database"),
    "block:synced": t("Synchronisierter Block", "Synced block"),
    "block:synced-insert": t("Synchronisierten Block einfügen", "Insert synced block"),
    "block:workflow-button": t("Workflow-Knopf", "Workflow button"),
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
