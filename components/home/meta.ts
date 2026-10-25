// What each start page widget is called, its symbol and what it shows (the
// widget gallery of the editor and the default headings).
import {
  ChartLineUp,
  CheckSquare,
  Clock,
  Eye,
  Folder,
  Gauge,
  HandWaving,
  HardDrives,
  Lightning,
  LinkSimple,
  Notebook,
  NotePencil,
  Pulse,
  PushPin,
  Repeat,
  Star,
  Table,
  Timer,
  Tray,
  Bell,
  CalendarBlank,
  type Icon,
} from "@phosphor-icons/react";
import type { HomeWidget, HomeWidgetKind } from "@/lib/home-layout-schema";

type Text = { de: string; en: string };
export type WidgetGroup = "overview" | "plan" | "write" | "tools";
export const widgetMeta: Record<HomeWidgetKind, { icon: Icon; name: Text; description: Text; group: WidgetGroup; adminOnly?: true; single?: true }> = {
  greeting: {
    icon: HandWaving,
    name: { de: "Begrüßung", en: "Greeting" },
    description: { de: "Dein Name, das Datum und ein Satz für den Tag.", en: "Your name, the date and a line for the day." },
    group: "overview",
    single: true,
  },
  recent: {
    icon: Clock,
    name: { de: "Zuletzt bearbeitet", en: "Recently edited" },
    description: { de: "Seiten, an denen zuletzt gearbeitet wurde, oder die du zuletzt geöffnet hast.", en: "Pages edited lately, or the ones you opened last." },
    group: "overview",
  },
  quick: {
    icon: Lightning,
    name: { de: "Was hast du heute vor?", en: "What are you up to today?" },
    description: { de: "Schnellstarts für eine neue Seite, eine Notiz oder ein Projekt.", en: "Quick starts for a new page, a note or a project." },
    group: "write",
  },
  pages: {
    icon: Folder,
    name: { de: "In deinem Arbeitsbereich", en: "In your workspace" },
    description: { de: "Die obersten Seiten aller oder eines Bereichs.", en: "The top-level pages of all spaces or one." },
    group: "overview",
  },
  favorites: {
    icon: Star,
    name: { de: "Favoriten", en: "Favourites" },
    description: { de: "Seiten und Einträge mit Stern.", en: "Starred pages and records." },
    group: "overview",
  },
  tasks: {
    icon: CheckSquare,
    name: { de: "Meine Aufgaben", en: "My tasks" },
    description: { de: "Fällige Aufgaben zum Abhaken – deine oder die einer Datenbankansicht.", en: "Due tasks to tick off – yours or those of a database view." },
    group: "plan",
  },
  inbox: {
    icon: Bell,
    name: { de: "Posteingang", en: "Inbox" },
    description: { de: "Erwähnungen, Kommentare und Zuweisungen.", en: "Mentions, comments and assignments." },
    group: "overview",
  },
  journal: {
    icon: Notebook,
    name: { de: "Journal heute", en: "Journal today" },
    description: { de: "Der heutige Eintrag mit Serie – und schnell ein paar Zeilen dazuschreiben.", en: "Today's entry with your streak – and a few quick lines to add." },
    group: "write",
  },
  calendar: {
    icon: CalendarBlank,
    name: { de: "Termine", en: "Agenda" },
    description: { de: "Die nächsten Tage aus Kalenderansichten und verbundenen Kalendern.", en: "The next days from calendar views and connected calendars." },
    group: "plan",
  },
  database: {
    icon: Table,
    name: { de: "Datenbankansicht", en: "Database view" },
    description: { de: "Eine Ansicht als kompakte Liste, Tabelle oder Board.", en: "A view as a compact list, table or board." },
    group: "plan",
  },
  pinned: {
    icon: PushPin,
    name: { de: "Angeheftete Seite", en: "Pinned page" },
    description: { de: "Eine Seite mit Vorschau und Unterseiten.", en: "One page with a preview and its sub pages." },
    group: "write",
  },
  capture: {
    icon: Tray,
    name: { de: "Schnell erfassen", en: "Quick capture" },
    description: { de: "Eine Idee in die Erfassungsdatenbank schreiben.", en: "Write an idea into the capture database." },
    group: "write",
  },
  focus: {
    icon: Timer,
    name: { de: "Fokus & Zeit", en: "Focus & time" },
    description: { de: "Fokuszeit starten, laufende Zeiterfassung und Stunden dieser Woche.", en: "Start a focus session, the running timer and this week's hours." },
    group: "tools",
  },
  habits: {
    icon: Repeat,
    name: { de: "Gewohnheiten", en: "Habits" },
    description: { de: "Die Gewohnheiten von heute zum Abhaken.", en: "Today's habits to tick off." },
    group: "plan",
  },
  counter: {
    icon: Gauge,
    name: { de: "Zähler", en: "Counter" },
    description: { de: "Anzahl, Summe oder Durchschnitt einer Ansicht mit Verlauf.", en: "Count, sum or average of a view with its history." },
    group: "plan",
  },
  notes: {
    icon: NotePencil,
    name: { de: "Notizzettel", en: "Scratchpad" },
    description: { de: "Ein kleiner Zettel nur für dich, auf allen Geräten.", en: "A small note just for you, on all devices." },
    group: "write",
  },
  activity: {
    icon: Pulse,
    name: { de: "Aktivität", en: "Activity" },
    description: { de: "Wer zuletzt was im Arbeitsbereich geändert hat.", en: "Who changed what in the workspace lately." },
    group: "overview",
  },
  stats: {
    icon: ChartLineUp,
    name: { de: "Diese Woche", en: "This week" },
    description: { de: "Bearbeitete Seiten, erledigte Einträge, offene Aufgaben, erfasste Zeit.", en: "Pages edited, records completed, open tasks, time tracked." },
    group: "overview",
  },
  links: {
    icon: LinkSimple,
    name: { de: "Links", en: "Links" },
    description: { de: "Deine Lesezeichen an einem Ort.", en: "Your bookmarks in one place." },
    group: "tools",
  },
  instance: {
    icon: HardDrives,
    name: { de: "Instanz-Status", en: "Instance status" },
    description: { de: "Backups, Fehlerquote, Hintergrunddienste und Speicher – für die Administration.", en: "Backups, error rate, background workers and storage – for administrators." },
    group: "tools",
    adminOnly: true,
  },
};
export const groupNames: Record<WidgetGroup, Text> = {
  overview: { de: "Überblick", en: "Overview" },
  plan: { de: "Planen", en: "Plan" },
  write: { de: "Schreiben & erfassen", en: "Write & capture" },
  tools: { de: "Werkzeuge", en: "Tools" },
};
export const viewedName: Text = { de: "Zuletzt angesehen", en: "Recently viewed" };

type T = (de: string, en: string) => string;
// The heading a widget shows: its own title, else the kind's name.
export function widgetName(widget: HomeWidget, t: T) {
  const own = (widget.config as { title?: string }).title?.trim();
  if (own) return own;
  if (widget.kind === "recent" && widget.config.mode === "viewed") return t(viewedName.de, viewedName.en);
  const name = widgetMeta[widget.kind].name;
  return t(name.de, name.en);
}
export function widgetIcon(widget: HomeWidget) {
  return widget.kind === "recent" && widget.config.mode === "viewed" ? Eye : widgetMeta[widget.kind].icon;
}
