// Templates that come with Flowplan: shown in the "Vorlagen" dialog and in
// the public gallery (/templates), grouped by category. Documents are HTML
// in the editor's schema; databases bring fields, views and example
// entries. Dates in examples are relative ("@+3" = in three days) so they
// always look current. Client-safe: plain data only.
import type { Field, View } from "./types";
import type { TemplateCategory } from "./template-categories";

export type CatalogRow = { cells: Record<string, unknown>; content?: string };
export type CatalogTemplate = {
  name: string;
  category: Exclude<TemplateCategory, "">;
  description: string;
  icon: string;
  kind: "document" | "database";
  // Database templates: set up as a survey (lib/survey-server.ts).
  survey?: boolean;
  html?: string;
  fields?: Field[];
  views?: View[];
  rows?: CatalogRow[];
};

export const task = (text: string, done = false) =>
  `<li data-type="taskItem" data-checked="${done}"><label><input type="checkbox"${done ? " checked" : ""}></label><div><p>${text}</p></div></li>`;
export const tasks = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
export const callout = (html: string) => `<aside data-callout="true">${html}</aside>`;
export const toggle = (title: string, html: string) => `<details><summary>${title}</summary><div>${html}</div></details>`;
export const table = (rows: string[][]) =>
  `<table><tbody>${rows
    .map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th><p>${c}</p></th>` : `<td><p>${c}</p></td>`)).join("")}</tr>`)
    .join("")}</tbody></table>`;
export const view = (id: string, name: string, type: View["type"], extra: Partial<View> = {}): View =>
  ({ id, name, type, filters: [], sorts: [], ...extra }) as View;

export const templateCatalog: Record<string, CatalogTemplate> = {
  // ---------------------------------------------------------------- Projekte
  project: {
    name: "Projektplanung",
    category: "projects",
    icon: "🚀",
    kind: "database",
    description: "Aufgaben mit Status, Zeitraum, Aufwand und Timeline für ein Projekt.",
    fields: [
      { id: "title", name: "Aufgabe", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Nicht begonnen", "In Arbeit", "Erledigt"] },
      { id: "priority", name: "Priorität", type: "select", options: ["Hoch", "Mittel", "Niedrig"] },
      { id: "start", name: "Start", type: "date" },
      { id: "date", name: "Fällig am", type: "date" },
      { id: "assignee", name: "Verantwortlich", type: "person" },
      { id: "effort", name: "Aufwand (h)", type: "number" },
    ],
    views: [
      view("table", "Alle Aufgaben", "table"),
      view("board", "Board", "board", { groupBy: "status" }),
      view("timeline", "Timeline", "timeline", { dateField: "start", endDateField: "date" }),
      view("calendar", "Kalender", "calendar", { dateField: "date" }),
    ],
    rows: [
      { cells: { title: "Projektziel und Erfolgskriterien festlegen", status: "Erledigt", priority: "Hoch", start: "@-6", date: "@-4", effort: 4 }, content: "<h2>Ergebnis</h2><p>Ein Satz, der beschreibt, woran wir Erfolg messen.</p>" },
      { cells: { title: "Meilensteine planen", status: "In Arbeit", priority: "Hoch", start: "@-2", date: "@+3", effort: 6 } },
      { cells: { title: "Umsetzung Phase 1", status: "Nicht begonnen", priority: "Mittel", start: "@+3", date: "@+14", effort: 24 } },
      { cells: { title: "Projektabschluss dokumentieren", status: "Nicht begonnen", priority: "Niedrig", start: "@+14", date: "@+16", effort: 3 } },
    ],
  },
  roadmap: {
    name: "Produkt-Roadmap",
    category: "projects",
    icon: "🎯",
    kind: "database",
    description: "Themen nach Quartal und Status, mit Board und Timeline für die Planung.",
    fields: [
      { id: "title", name: "Thema", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Idee", "Geplant", "In Arbeit", "Ausgeliefert"] },
      { id: "quarter", name: "Quartal", type: "select", options: ["Q1", "Q2", "Q3", "Q4"] },
      { id: "area", name: "Bereich", type: "multiselect", options: ["Design", "Produkt", "Technik", "Marketing"] },
      { id: "start", name: "Start", type: "date" },
      { id: "end", name: "Ende", type: "date" },
      { id: "impact", name: "Wirkung (1–5)", type: "number" },
    ],
    views: [
      view("board", "Nach Status", "board", { groupBy: "status" }),
      view("quarters", "Nach Quartal", "board", { groupBy: "quarter" }),
      view("timeline", "Timeline", "timeline", { dateField: "start", endDateField: "end" }),
      view("table", "Tabelle", "table"),
    ],
    rows: [
      { cells: { title: "Neues Onboarding", status: "In Arbeit", quarter: "Q3", area: ["Design", "Produkt"], start: "@-10", end: "@+20", impact: 5 } },
      { cells: { title: "Mobile App", status: "Geplant", quarter: "Q4", area: ["Technik"], start: "@+25", end: "@+80", impact: 4 } },
      { cells: { title: "Preisseite überarbeiten", status: "Idee", quarter: "Q4", area: ["Marketing"], impact: 3 } },
      { cells: { title: "Dunkles Design", status: "Ausgeliefert", quarter: "Q2", area: ["Design"], start: "@-60", end: "@-30", impact: 2 } },
    ],
  },
  sprint: {
    name: "Sprint-Board",
    category: "projects",
    icon: "⚡",
    kind: "database",
    description: "Kanban für zweiwöchige Sprints mit Story Points und Verantwortlichen.",
    fields: [
      { id: "title", name: "Story", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Backlog", "Bereit", "In Arbeit", "Review", "Fertig"] },
      { id: "points", name: "Story Points", type: "number" },
      { id: "assignee", name: "Verantwortlich", type: "person" },
      { id: "type", name: "Art", type: "select", options: ["Feature", "Bug", "Technik"] },
    ],
    views: [
      view("board", "Sprint", "board", { groupBy: "status" }),
      view("table", "Backlog", "table", { sorts: [{ field: "points", direction: "desc" }] } as Partial<View>),
      view("chart", "Punkte je Status", "chart", {
        chart: { kind: "bar", xField: "status", yField: "points", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Als Nutzerin möchte ich mich per SSO anmelden", status: "In Arbeit", points: 5, type: "Feature" } },
      { cells: { title: "Absturz beim Export großer Dateien", status: "Review", points: 3, type: "Bug" } },
      { cells: { title: "Suche nach Tags filtern", status: "Bereit", points: 2, type: "Feature" } },
      { cells: { title: "Abhängigkeiten aktualisieren", status: "Backlog", points: 1, type: "Technik" } },
      { cells: { title: "Leere Zustände gestalten", status: "Fertig", points: 2, type: "Feature" } },
    ],
  },
  brief: {
    name: "Projektsteckbrief",
    category: "projects",
    icon: "📋",
    kind: "document",
    description: "Ziel, Umfang, Beteiligte und Risiken eines Projekts auf einer Seite.",
    html:
      "<h2>Worum geht es?</h2><p>Ein, zwei Sätze zum Problem und warum es jetzt wichtig ist.</p>" +
      callout("<p><strong>Ziel:</strong> Was ist am Ende anders? Woran messen wir es?</p>") +
      "<h2>Umfang</h2><h3>Dazu gehört</h3><ul><li><p>…</p></li></ul><h3>Nicht dazu gehört</h3><ul><li><p>…</p></li></ul>" +
      "<h2>Beteiligte</h2>" +
      table([["Rolle", "Person", "Aufgabe"], ["Verantwortlich", "", "Entscheidet und berichtet"], ["Team", "", "Setzt um"], ["Beratend", "", "Wird gefragt"]]) +
      "<h2>Meilensteine</h2><ol><li><p>Start</p></li><li><p>Zwischenstand</p></li><li><p>Abschluss</p></li></ol>" +
      "<h2>Risiken</h2>" +
      table([["Risiko", "Wahrscheinlichkeit", "Gegenmaßnahme"], ["", "", ""]]),
  },
  // ---------------------------------------------------------------- Meetings
  meeting: {
    name: "Meeting-Notizen",
    category: "meetings",
    icon: "👥",
    kind: "document",
    description: "Agenda, Entscheidungen und Aufgaben einer Besprechung.",
    html:
      "<h2>Besprechung</h2><p><strong>Datum:</strong> </p><p><strong>Teilnehmende:</strong> </p><h2>Ziel</h2><p>Was möchten wir in dieser Besprechung erreichen?</p><h2>Agenda</h2><ol><li><p>Aktueller Stand</p></li><li><p>Offene Fragen</p></li><li><p>Nächste Schritte</p></li></ol><h2>Entscheidungen</h2><p>Halte fest, was entschieden wurde und warum.</p><h2>Aufgaben</h2>" +
      tasks(task("Aufgabe, Verantwortliche und Termin festlegen")),
  },
  oneOnOne: {
    name: "1:1-Gespräch",
    category: "meetings",
    icon: "💬",
    kind: "document",
    description: "Regelmäßiges Gespräch zwischen zwei Personen: Stimmung, Themen, Vereinbarungen.",
    html:
      callout("<p>Tipp: Ein Dokument für alle Gespräche – neue Termine oben einfügen, dann bleibt der Verlauf sichtbar.</p>") +
      "<h2>Gespräch vom …</h2><h3>Wie geht es dir?</h3><p></p><h3>Themen von dir</h3><ul><li><p></p></li></ul><h3>Themen von mir</h3><ul><li><p></p></li></ul><h3>Feedback</h3><p>Was läuft gut? Was können wir anders machen?</p><h3>Vereinbarungen</h3>" +
      tasks(task("")) +
      toggle("Frühere Gespräche", "<p>Ältere Notizen hierher verschieben.</p>"),
  },
  retro: {
    name: "Retrospektive",
    category: "meetings",
    icon: "🔄",
    kind: "document",
    description: "Rückblick auf einen Sprint oder ein Projekt mit Maßnahmen.",
    html:
      "<h2>Rückblick: Sprint …</h2><p><strong>Zeitraum:</strong> </p>" +
      '<div data-columns="true"><div data-column="true"><h3>Was lief gut?</h3><ul><li><p></p></li></ul></div><div data-column="true"><h3>Was lief nicht gut?</h3><ul><li><p></p></li></ul></div></div>' +
      "<h3>Was lernen wir daraus?</h3><p></p><h2>Maßnahmen</h2>" +
      tasks(task("Maßnahme mit Verantwortlicher Person")) +
      callout("<p>Beim nächsten Mal zuerst prüfen: Wurden die Maßnahmen der letzten Retrospektive umgesetzt?</p>"),
  },
  meetingLog: {
    name: "Besprechungsprotokolle",
    category: "meetings",
    icon: "📅",
    kind: "database",
    description: "Alle Besprechungen als Datenbank – mit Kalender und Protokoll je Termin.",
    fields: [
      { id: "title", name: "Besprechung", type: "text" },
      { id: "date", name: "Datum", type: "date" },
      { id: "type", name: "Art", type: "select", options: ["Team", "Kunde", "Planung", "1:1"] },
      { id: "people", name: "Teilnehmende", type: "person" },
      { id: "done", name: "Protokoll fertig", type: "checkbox" },
    ],
    views: [
      view("calendar", "Kalender", "calendar", { dateField: "date" }),
      view("feed", "Protokolle", "feed"),
      view("table", "Alle", "table"),
    ],
    rows: [
      { cells: { title: "Wochenstart", date: "@-3", type: "Team", done: true }, content: "<h2>Entscheidungen</h2><ul><li><p>Release am Donnerstag</p></li></ul>" },
      { cells: { title: "Abstimmung mit Kunde", date: "@+1", type: "Kunde", done: false } },
      { cells: { title: "Quartalsplanung", date: "@+8", type: "Planung", done: false } },
    ],
  },
  // ----------------------------------------------------------------- Wissen
  wiki: {
    name: "Team-Wiki",
    category: "knowledge",
    icon: "📘",
    kind: "document",
    description: "Startseite für Wissen, Abläufe und Ansprechpersonen eines Teams.",
    html:
      "<h2>Willkommen im Team</h2><p>Hier findest du das Wissen, das wir für unsere tägliche Zusammenarbeit brauchen.</p><h2>Unser Auftrag</h2><p>Beschreibe, wofür dein Team verantwortlich ist.</p><h2>Zusammenarbeit</h2><h3>Kommunikation</h3><p>Welche Kanäle nutzen wir? Wann ist eine Antwort erforderlich?</p><h3>Entscheidungen</h3><p>Wie treffen und dokumentieren wir Entscheidungen?</p><h2>Wichtige Kontakte</h2>" +
      table([["Thema", "Ansprechperson"], ["Onboarding", ""], ["Prozesse", ""]]) +
      "<h2>Wissenssammlung</h2><p>Erstelle Unterseiten für Prozesse, Projekte und häufige Fragen. Verknüpfe sie mit @.</p>",
  },
  howto: {
    name: "Anleitung",
    category: "knowledge",
    icon: "🔧",
    kind: "document",
    description: "Schritt-für-Schritt-Anleitung mit Voraussetzungen, Befehlen und Fehlerbehebung.",
    html:
      "<p>Kurz: wofür ist diese Anleitung, und wer braucht sie?</p>" +
      callout("<p><strong>Voraussetzungen:</strong> Zugang zu …, Rolle …</p>") +
      "<h2>Schritte</h2><ol><li><p>Ersten Schritt beschreiben.</p></li><li><p>Zweiten Schritt beschreiben.</p></li><li><p>Ergebnis prüfen.</p></li></ol>" +
      '<pre><code class="language-bash"># Beispielbefehl\ndocker compose up -d</code></pre>' +
      "<h2>Häufige Probleme</h2>" +
      toggle("Fehlermeldung „…“", "<p>Ursache und Lösung.</p>") +
      toggle("Es passiert nichts", "<p>Prüfen, ob …</p>"),
  },
  decisions: {
    name: "Entscheidungsprotokoll",
    category: "knowledge",
    icon: "⚖️",
    kind: "database",
    description: "Wichtige Entscheidungen mit Begründung, Status und Datum nachvollziehbar sammeln.",
    fields: [
      { id: "title", name: "Entscheidung", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Vorgeschlagen", "Entschieden", "Verworfen", "Ersetzt"] },
      { id: "date", name: "Datum", type: "date" },
      { id: "owner", name: "Entschieden von", type: "person" },
      { id: "area", name: "Bereich", type: "select", options: ["Technik", "Produkt", "Organisation"] },
    ],
    views: [view("table", "Alle Entscheidungen", "table", { sorts: [{ field: "date", direction: "desc" }] } as Partial<View>), view("board", "Nach Status", "board", { groupBy: "status" })],
    rows: [
      {
        cells: { title: "SQLite statt Postgres", status: "Entschieden", date: "@-30", area: "Technik" },
        content: "<h2>Kontext</h2><p>Eine Instanz pro Organisation, wenig Betriebsaufwand gewünscht.</p><h2>Entscheidung</h2><p>SQLite mit Litestream-Sicherung.</p><h2>Folgen</h2><p>Kein horizontales Skalieren; dafür ein Container.</p>",
      },
      { cells: { title: "Wöchentlicher Release-Rhythmus", status: "Vorgeschlagen", date: "@-2", area: "Organisation" } },
    ],
  },
  faq: {
    name: "FAQ",
    category: "knowledge",
    icon: "❓",
    kind: "document",
    description: "Häufige Fragen zum Aufklappen – schnell zu durchsuchen und zu pflegen.",
    html:
      "<p>Antworten auf die Fragen, die immer wieder kommen. Fehlt etwas? Kommentiere die Seite.</p><h2>Allgemein</h2>" +
      toggle("Wo finde ich …?", "<p>…</p>") +
      toggle("Wen frage ich bei …?", "<p>…</p>") +
      "<h2>Technik</h2>" +
      toggle("Wie bekomme ich Zugang zu …?", "<p>…</p>") +
      toggle("Was tun, wenn … nicht funktioniert?", "<p>…</p>"),
  },
  // -------------------------------------------------------- Planung & Ziele
  okr: {
    name: "OKR-Ziele",
    category: "planning",
    icon: "🏁",
    kind: "database",
    description: "Ziele und Schlüsselergebnisse mit Fortschritt, Verantwortlichen und Quartal.",
    fields: [
      { id: "title", name: "Schlüsselergebnis", type: "text" },
      { id: "objective", name: "Ziel", type: "select", options: ["Kundschaft begeistern", "Schneller ausliefern", "Team wachsen lassen"] },
      { id: "progress", name: "Fortschritt", type: "number", format: "percent" },
      { id: "quarter", name: "Quartal", type: "select", options: ["Q1", "Q2", "Q3", "Q4"] },
      { id: "owner", name: "Verantwortlich", type: "person" },
    ],
    views: [
      view("board", "Nach Ziel", "board", { groupBy: "objective" }),
      view("table", "Alle", "table"),
      view("chart", "Fortschritt", "chart", {
        chart: { kind: "horizontal", xField: "objective", yField: "progress", aggregate: "average", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Zufriedenheit (NPS) von 30 auf 45", objective: "Kundschaft begeistern", progress: 0.6, quarter: "Q3" } },
      { cells: { title: "Antwortzeit im Support unter 4 Stunden", objective: "Kundschaft begeistern", progress: 0.8, quarter: "Q3" } },
      { cells: { title: "Release alle zwei Wochen", objective: "Schneller ausliefern", progress: 0.4, quarter: "Q3" } },
      { cells: { title: "Zwei neue Kolleginnen eingearbeitet", objective: "Team wachsen lassen", progress: 0.5, quarter: "Q3" } },
    ],
  },
  quarter: {
    name: "Quartalsplanung",
    category: "planning",
    icon: "📅",
    kind: "document",
    description: "Rückblick, Schwerpunkte, Kapazität und Risiken für die nächsten drei Monate.",
    html:
      "<h2>Rückblick auf das letzte Quartal</h2><ul><li><p>Erreicht: …</p></li><li><p>Nicht erreicht, weil …</p></li></ul><h2>Schwerpunkte</h2><ol><li><p>…</p></li><li><p>…</p></li><li><p>…</p></li></ol>" +
      callout("<p>Höchstens drei Schwerpunkte. Alles andere ist ausdrücklich <em>nicht</em> Ziel dieses Quartals.</p>") +
      "<h2>Kapazität</h2>" +
      table([["Person", "Verfügbar (Tage)", "Davon Schwerpunkte"], ["", "", ""]]) +
      "<h2>Risiken und Abhängigkeiten</h2><ul><li><p></p></li></ul>",
  },
  content: {
    name: "Content-Kalender",
    category: "planning",
    icon: "📣",
    kind: "database",
    description: "Beiträge für Blog und Social Media planen – im Kalender und nach Kanal.",
    fields: [
      { id: "title", name: "Beitrag", type: "text" },
      { id: "date", name: "Veröffentlichung", type: "date" },
      { id: "channel", name: "Kanal", type: "multiselect", options: ["Blog", "Newsletter", "LinkedIn", "Instagram"] },
      { id: "status", name: "Status", type: "select", options: ["Idee", "Entwurf", "Freigabe", "Veröffentlicht"] },
      { id: "author", name: "Autor·in", type: "person" },
      { id: "link", name: "Link", type: "url" },
    ],
    views: [
      view("calendar", "Kalender", "calendar", { dateField: "date" }),
      view("board", "Status", "board", { groupBy: "status" }),
      view("table", "Alle", "table"),
    ],
    rows: [
      { cells: { title: "Fünf Tipps für bessere Meetings", date: "@+2", channel: ["Blog", "LinkedIn"], status: "Freigabe" } },
      { cells: { title: "Monatsrückblick", date: "@+9", channel: ["Newsletter"], status: "Entwurf" } },
      { cells: { title: "Blick hinter die Kulissen", date: "@+5", channel: ["Instagram"], status: "Idee" } },
    ],
  },
  budget: {
    name: "Budgetplanung",
    category: "planning",
    icon: "💶",
    kind: "database",
    description: "Posten mit Plan, Ist und automatisch berechneter Abweichung in Euro.",
    fields: [
      { id: "title", name: "Posten", type: "text" },
      { id: "category", name: "Kategorie", type: "select", options: ["Personal", "Software", "Reisen", "Marketing"] },
      { id: "plan", name: "Plan", type: "number", format: "eur" },
      { id: "actual", name: "Ist", type: "number", format: "eur" },
      { id: "delta", name: "Abweichung", type: "formula", formula: 'prop("Ist") - prop("Plan")', format: "eur" },
    ],
    views: [
      view("table", "Übersicht", "table", { calculations: { plan: "sum", actual: "sum", delta: "sum" } } as Partial<View>),
      view("chart", "Plan und Ist", "chart", {
        chart: { kind: "bar", xField: "category", yField: "plan", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true, measures: [{ field: "actual", aggregate: "sum" }] },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Lizenzen", category: "Software", plan: 2400, actual: 2150 } },
      { cells: { title: "Konferenz", category: "Reisen", plan: 1800, actual: 2100 } },
      { cells: { title: "Kampagne Herbst", category: "Marketing", plan: 5000, actual: 3200 } },
      { cells: { title: "Werkstudierende", category: "Personal", plan: 12000, actual: 12000 } },
    ],
  },
  // --------------------------------------------------------------- Persönlich
  tasks: {
    name: "Aufgabenliste",
    category: "personal",
    icon: "✅",
    kind: "database",
    description: "Persönliche Aufgaben mit Priorität, Fälligkeit, Board und Kalender.",
    fields: [
      { id: "title", name: "Aufgabe", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Nicht begonnen", "In Arbeit", "Erledigt"] },
      { id: "priority", name: "Priorität", type: "select", options: ["Hoch", "Mittel", "Niedrig"] },
      { id: "date", name: "Fällig am", type: "date" },
      { id: "assignee", name: "Verantwortlich", type: "person" },
    ],
    views: [view("table", "Alle Aufgaben", "table"), view("board", "Board", "board", { groupBy: "status" }), view("calendar", "Kalender", "calendar", { dateField: "date" }), view("list", "Liste", "list")],
    rows: [{ cells: { title: "Prioritäten für diese Woche festlegen", status: "Nicht begonnen", priority: "Hoch", date: "@+1" } }],
  },
  reading: {
    name: "Leseliste",
    category: "personal",
    icon: "📚",
    kind: "database",
    description: "Bücher und Artikel mit Status, Bewertung und Notizen – als Galerie.",
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "author", name: "Autor·in", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Will ich lesen", "Lese ich", "Gelesen"] },
      { id: "rating", name: "Bewertung (1–5)", type: "number" },
      { id: "type", name: "Art", type: "select", options: ["Buch", "Artikel", "Podcast"] },
    ],
    views: [view("gallery", "Galerie", "gallery"), view("board", "Status", "board", { groupBy: "status" }), view("table", "Tabelle", "table")],
    rows: [
      { cells: { title: "Deep Work", author: "Cal Newport", status: "Gelesen", rating: 4, type: "Buch" }, content: "<h2>Notizen</h2><ul><li><p>Tiefe Arbeit braucht feste Zeiten.</p></li></ul>" },
      { cells: { title: "Shape Up", author: "Ryan Singer", status: "Lese ich", type: "Buch" } },
      { cells: { title: "Die Kunst des klaren Denkens", author: "Rolf Dobelli", status: "Will ich lesen", type: "Buch" } },
    ],
  },
  habits: {
    name: "Gewohnheiten-Tracker",
    category: "personal",
    icon: "🌱",
    kind: "database",
    description: "Ein Eintrag pro Tag, Gewohnheiten abhaken und den Anteil sehen.",
    fields: [
      { id: "title", name: "Tag", type: "text" },
      { id: "date", name: "Datum", type: "date" },
      { id: "sport", name: "Sport", type: "checkbox" },
      { id: "read", name: "Gelesen", type: "checkbox" },
      { id: "water", name: "Genug getrunken", type: "checkbox" },
      { id: "mood", name: "Stimmung (1–5)", type: "number" },
    ],
    views: [
      view("table", "Tage", "table", { sorts: [{ field: "date", direction: "desc" }], calculations: { sport: "percent_checked", read: "percent_checked", water: "percent_checked", mood: "average" } } as Partial<View>),
      view("calendar", "Kalender", "calendar", { dateField: "date" }),
    ],
    rows: [
      { cells: { title: "Montag", date: "@-2", sport: true, read: true, water: false, mood: 4 } },
      { cells: { title: "Dienstag", date: "@-1", sport: false, read: true, water: true, mood: 3 } },
      { cells: { title: "Heute", date: "@+0", sport: false, read: false, water: false } },
    ],
  },
  travel: {
    name: "Reiseplanung",
    category: "personal",
    icon: "✈️",
    kind: "document",
    description: "Reiseroute, Packliste, Unterkünfte und Budget in einem Dokument.",
    html:
      "<h2>Reise nach …</h2><p><strong>Zeitraum:</strong> </p>" +
      table([["Tag", "Ort", "Plan"], ["1", "", ""], ["2", "", ""], ["3", "", ""]]) +
      '<div data-columns="true"><div data-column="true"><h3>Packliste</h3>' +
      tasks(task("Ausweis"), task("Ladekabel"), task("Reiseapotheke")) +
      '</div><div data-column="true"><h3>Vor der Abreise</h3>' +
      tasks(task("Unterkunft bestätigen"), task("Tickets speichern"), task("Pflanzen gießen lassen")) +
      "</div></div>" +
      "<h2>Unterkünfte</h2><ul><li><p></p></li></ul><h2>Budget</h2><p>Geplant: … € · Ausgegeben: … €</p>",
  },
  // --------------------------------------------------------------- Sonstiges
  crm: {
    name: "Kontakte & Kunden",
    category: "other",
    icon: "📇",
    kind: "database",
    description: "Einfaches CRM: Kontakte mit Firma, Phase, nächstem Schritt und Wert.",
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "company", name: "Firma", type: "text" },
      { id: "stage", name: "Phase", type: "select", options: ["Kontakt", "Gespräch", "Angebot", "Gewonnen", "Verloren"] },
      { id: "value", name: "Wert", type: "number", format: "eur" },
      { id: "email", name: "E-Mail", type: "email" },
      { id: "next", name: "Nächster Schritt", type: "date" },
    ],
    views: [
      view("board", "Pipeline", "board", { groupBy: "stage" }),
      view("table", "Alle Kontakte", "table", { calculations: { value: "sum" } } as Partial<View>),
      view("chart", "Wert je Phase", "chart", {
        chart: { kind: "bar", xField: "stage", yField: "value", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Mara Klein", company: "Nordlicht GmbH", stage: "Angebot", value: 8400, email: "mara@example.com", next: "@+2" } },
      { cells: { title: "Jonas Weber", company: "Studio Weber", stage: "Gespräch", value: 3200, email: "jonas@example.com", next: "@+5" } },
      { cells: { title: "Aylin Demir", company: "Demir & Partner", stage: "Gewonnen", value: 12000, email: "aylin@example.com" } },
    ],
  },
  hiring: {
    name: "Bewerbungen",
    category: "other",
    icon: "💼",
    kind: "database",
    description: "Bewerbungsprozess als Board – vom Eingang bis zur Zusage, mit Formular.",
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "role", name: "Stelle", type: "select", options: ["Design", "Entwicklung", "Vertrieb"] },
      { id: "stage", name: "Phase", type: "select", options: ["Eingang", "Erstgespräch", "Aufgabe", "Zweitgespräch", "Zusage", "Absage"] },
      { id: "email", name: "E-Mail", type: "email" },
      { id: "cv", name: "Lebenslauf", type: "files" },
      { id: "date", name: "Eingegangen", type: "date" },
    ],
    views: [view("board", "Prozess", "board", { groupBy: "stage" }), view("table", "Alle", "table"), view("form", "Bewerbungsformular", "form")],
    rows: [
      { cells: { title: "Lena Hoffmann", role: "Design", stage: "Erstgespräch", email: "lena@example.com", date: "@-5" } },
      { cells: { title: "Tim Berger", role: "Entwicklung", stage: "Eingang", email: "tim@example.com", date: "@-1" } },
    ],
  },
  survey: {
    name: "Umfrage",
    category: "other",
    icon: "📊",
    kind: "database",
    description: "Umfrage mit Builder: Sterne, NPS, Skalen, Matrix, Bedingungen – öffentlich teilbar, mit Auswertung.",
    survey: true,
    fields: [{ id: "title", name: "Antwort", type: "text" }],
    views: [view("survey", "Umfrage", "form"), view("table", "Antworten", "table")],
    rows: [],
  },
  inventory: {
    name: "Inventar",
    category: "other",
    icon: "📦",
    kind: "database",
    description: "Geräte und Material mit Ort, Zustand, Anzahl und Wert.",
    fields: [
      { id: "title", name: "Gegenstand", type: "text" },
      { id: "location", name: "Ort", type: "select", options: ["Büro", "Lager", "Homeoffice"] },
      { id: "condition", name: "Zustand", type: "select", options: ["Neu", "Gut", "Reparatur"] },
      { id: "count", name: "Anzahl", type: "number" },
      { id: "price", name: "Stückpreis", type: "number", format: "eur" },
      { id: "total", name: "Gesamtwert", type: "formula", formula: 'prop("Anzahl") * prop("Stückpreis")', format: "eur" },
    ],
    views: [view("table", "Bestand", "table", { calculations: { count: "sum", total: "sum" } } as Partial<View>), view("board", "Nach Ort", "board", { groupBy: "location" })],
    rows: [
      { cells: { title: "Laptop", location: "Büro", condition: "Gut", count: 6, price: 1200 } },
      { cells: { title: "Monitor 27 Zoll", location: "Büro", condition: "Neu", count: 8, price: 320 } },
      { cells: { title: "Beamer", location: "Lager", condition: "Reparatur", count: 1, price: 650 } },
    ],
  },
  event: {
    name: "Eventplanung",
    category: "other",
    icon: "🎉",
    kind: "document",
    description: "Checkliste, Ablauf und Zuständigkeiten für eine Veranstaltung.",
    html:
      "<h2>Veranstaltung</h2><p><strong>Datum und Ort:</strong> </p><p><strong>Gäste:</strong> etwa … Personen</p>" +
      "<h2>Ablauf</h2>" +
      table([["Uhrzeit", "Programmpunkt", "Zuständig"], ["18:00", "Einlass", ""], ["18:30", "Begrüßung", ""], ["19:00", "Essen", ""]]) +
      "<h2>Checkliste</h2><h3>Vier Wochen vorher</h3>" +
      tasks(task("Ort buchen"), task("Einladungen verschicken")) +
      "<h3>Eine Woche vorher</h3>" +
      tasks(task("Teilnahmen bestätigen"), task("Catering festlegen")) +
      "<h3>Am Tag</h3>" +
      tasks(task("Aufbau"), task("Technik prüfen")) +
      callout("<p>Notfallkontakte und Zugänge für den Veranstaltungsort hier eintragen.</p>"),
  },
};

export type TemplateKey = keyof typeof templateCatalog;
export const templateKeys = Object.keys(templateCatalog) as [TemplateKey, ...TemplateKey[]];

// "@+3" → date in three days (YYYY-MM-DD), relative to `today`.
export function resolveCatalogDates(cells: Record<string, unknown>, today = new Date()) {
  return Object.fromEntries(
    Object.entries(cells).map(([key, value]) => {
      const match = typeof value === "string" ? /^@([+-]\d+)$/.exec(value) : null;
      if (!match) return [key, value];
      const date = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + Number(match[1])));
      return [key, date.toISOString().slice(0, 10)];
    }),
  );
}
