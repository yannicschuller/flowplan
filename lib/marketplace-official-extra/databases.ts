// Database templates of the marketplace (see ./types.ts): fields, views
// and a few neutral example records. Dates as "@+n" relative to the
// generator's reference day, only where a view needs them.
import { view } from "../template-catalog";
import type { View } from "../types";
import type { ExtraDatabase } from "./types";

const chart = (xField: string, yField: string, aggregate: string, kind = "bar") =>
  ({ chart: { kind, xField, yField, aggregate, dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true } }) as Partial<View>;

export const extraDatabases: ExtraDatabase[] = [
  // ---------------------------------------------------------------- Projekte
  {
    kind: "database",
    id: "bug-tracker",
    category: "projects",
    icon: "🐞",
    title: { de: "Fehler-Tracker", en: "Bug tracker" },
    tags: ["Bugs", "Fehler", "Qualität", "Software"],
    summary: {
      de: "Fehler mit Schweregrad, Status, Umgebung und Zuständigkeit – als Board, Tabelle und mit Formular für Meldungen.",
      en: "Bugs with severity, status, environment and owner – as a board, a table and with a form for reports.",
    },
    description: {
      de: "Fehlermeldungen an einem Ort.\n\n- Eigenschaften: **Nummer**, **Status**, **Schweregrad**, **Bereich**, **Umgebung**, **Version**, **Zuständig**\n- Ansichten: **Board** nach Status, **Offene nach Schweregrad**, **Meldeformular**\n- Jeder Eintrag enthält Schritte zum Nachstellen, erwartetes und tatsächliches Verhalten\n\nDas Formular kann öffentlich oder intern geteilt werden. Mit einem Workflow „Statuswechsel melden“ erfahren Meldende, wenn ihr Fehler behoben ist.",
      en: "Bug reports in one place.\n\n- properties: **number**, **status**, **severity**, **area**, **environment**, **version**, **owner**\n- views: **board** by status, **open by severity**, a **report form**\n- every record holds steps to reproduce, expected and actual behaviour\n\nThe form can be shared publicly or internally. With the “Notify on status change” workflow reporters learn when their bug is fixed.",
    },
    fields: [
      { id: "title", name: "Fehler", type: "text" },
      { id: "key", name: "Nr.", type: "id", prefix: "BUG" },
      { id: "status", name: "Status", type: "select", options: ["Neu", "Bestätigt", "In Arbeit", "Im Test", "Behoben", "Kein Fehler"] },
      { id: "severity", name: "Schweregrad", type: "select", options: ["Kritisch", "Hoch", "Mittel", "Niedrig"] },
      { id: "area", name: "Bereich", type: "select", options: ["Oberfläche", "Schnittstelle", "Daten", "Leistung", "Sicherheit"] },
      { id: "env", name: "Umgebung", type: "multiselect", options: ["Web", "iOS", "Android", "Desktop"] },
      { id: "version", name: "Version", type: "text" },
      { id: "assignee", name: "Zuständig", type: "person" },
      { id: "reported", name: "Gemeldet am", type: "created_at" },
    ],
    views: [
      view("board", "Board", "board", { groupBy: "status" }),
      view("open", "Offen nach Schweregrad", "table", {
        filters: [{ field: "status", op: "none_of", value: "", values: ["Behoben", "Kein Fehler"] }],
        sorts: [{ field: "severity", direction: "asc" }],
      } as Partial<View>),
      view("all", "Alle", "table"),
      view("form", "Fehler melden", "form"),
    ],
    rows: [
      {
        cells: { title: "Export bricht bei Dateien über 50 MB ab", status: "In Arbeit", severity: "Hoch", area: "Daten", env: ["Web"], version: "2.4.1" },
        content:
          "<h2>Schritte zum Nachstellen</h2><ol><li><p>Datei mit 60 MB hochladen</p></li><li><p>Exportieren wählen</p></li></ol><h2>Erwartet</h2><p>Export als ZIP.</p><h2>Tatsächlich</h2><p>Nach 30 Sekunden erscheint „Zeitüberschreitung“.</p>",
      },
      { cells: { title: "Datumsauswahl zeigt falsche Kalenderwoche", status: "Bestätigt", severity: "Mittel", area: "Oberfläche", env: ["Web", "Desktop"], version: "2.4.0" } },
      { cells: { title: "App stürzt beim Teilen aus der Galerie ab", status: "Neu", severity: "Kritisch", area: "Oberfläche", env: ["Android"], version: "2.4.1" } },
      { cells: { title: "Tippfehler im Bestätigungsdialog", status: "Behoben", severity: "Niedrig", area: "Oberfläche", env: ["Web"], version: "2.3.9" } },
    ],
  },
  {
    kind: "database",
    id: "risk-register",
    category: "projects",
    icon: "⚠️",
    title: { de: "Risikoregister", en: "Risk register" },
    tags: ["Risiko", "Projektmanagement", "Maßnahmen"],
    summary: {
      de: "Projektrisiken mit Wahrscheinlichkeit, Auswirkung, berechneter Risikozahl, Maßnahme, Verantwortlichen und Status.",
      en: "Project risks with likelihood, impact, a calculated risk score, mitigation, owner and status.",
    },
    description: {
      de: "Risiken früh erkennen und bewusst steuern.\n\n- **Wahrscheinlichkeit** und **Auswirkung** je 1–5, die **Risikozahl** rechnet eine Formel aus\n- **Strategie** (vermeiden, vermindern, übertragen, akzeptieren), **Maßnahme**, **Verantwortlich**, **Status**\n- Ansichten: **Nach Risikozahl**, **Board** nach Status, **Diagramm** je Kategorie\n\nIm Projekt-Regeltermin die Top 5 durchgehen; ab Risikozahl 15 gehört ein Risiko in den Statusbericht.",
      en: "Spot risks early and manage them deliberately.\n\n- **likelihood** and **impact** 1–5 each, a formula calculates the **risk score**\n- **strategy** (avoid, reduce, transfer, accept), **mitigation**, **owner**, **status**\n- views: **by risk score**, a **board** by status, a **chart** per category\n\nReview the top 5 in the regular project meeting; from a score of 15 a risk belongs in the status report.",
    },
    fields: [
      { id: "title", name: "Risiko", type: "text" },
      { id: "category", name: "Kategorie", type: "select", options: ["Termine", "Budget", "Technik", "Personal", "Recht", "Lieferanten"] },
      { id: "likelihood", name: "Wahrscheinlichkeit (1–5)", type: "number" },
      { id: "impact", name: "Auswirkung (1–5)", type: "number" },
      { id: "score", name: "Risikozahl", type: "formula", formula: 'prop("Wahrscheinlichkeit (1–5)") * prop("Auswirkung (1–5)")' },
      { id: "strategy", name: "Strategie", type: "select", options: ["Vermeiden", "Vermindern", "Übertragen", "Akzeptieren"] },
      { id: "mitigation", name: "Maßnahme", type: "text" },
      { id: "owner", name: "Verantwortlich", type: "person" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Bearbeitung", "Eingetreten", "Geschlossen"] },
    ],
    views: [
      view("table", "Nach Risikozahl", "table", { sorts: [{ field: "score", direction: "desc" }] } as Partial<View>),
      view("board", "Status", "board", { groupBy: "status" }),
      view("chart", "Risiken je Kategorie", "chart", chart("category", "score", "sum")),
    ],
    rows: [
      { cells: { title: "Schlüsselperson fällt während der Umsetzung aus", category: "Personal", likelihood: 2, impact: 5, strategy: "Vermindern", mitigation: "Wissen dokumentieren, Vertretung einarbeiten", status: "In Bearbeitung" } },
      { cells: { title: "Schnittstelle des Altsystems ist schlechter dokumentiert als angenommen", category: "Technik", likelihood: 4, impact: 3, strategy: "Vermindern", mitigation: "Technischen Prototyp in Woche 2", status: "Offen" } },
      { cells: { title: "Lieferzeit der Hardware verlängert sich", category: "Lieferanten", likelihood: 3, impact: 4, strategy: "Übertragen", mitigation: "Vertragsstrafe vereinbaren, zweiten Anbieter anfragen", status: "Offen" } },
      { cells: { title: "Lizenzkosten steigen im nächsten Jahr", category: "Budget", likelihood: 3, impact: 2, strategy: "Akzeptieren", mitigation: "Puffer im Budget", status: "Geschlossen" } },
    ],
  },
  // ---------------------------------------------------------------- Meetings
  {
    kind: "database",
    id: "action-items",
    category: "meetings",
    icon: "📌",
    title: { de: "Aufgaben aus Besprechungen", en: "Meeting action items" },
    tags: ["Aufgaben", "Besprechung", "Nachverfolgung"],
    summary: {
      de: "Alle vereinbarten Aufgaben aus Besprechungen an einem Ort: wer, was, bis wann, aus welchem Termin – mit Ansicht für Überfälliges.",
      en: "All action items agreed in meetings in one place: who, what, by when, from which meeting – with a view of what is overdue.",
    },
    description: {
      de: "Damit Vereinbarungen nicht im Protokoll verschwinden.\n\n- Eigenschaften: **Aufgabe**, **Verantwortlich**, **Fällig**, **Besprechung**, **Status**, **Priorität**\n- Ansichten: **Offen**, **Fällig bis heute**, **Nach Person**, **Kalender**\n\nIm nächsten Termin zuerst die Ansicht „Fällig bis heute“ öffnen. Mit der Eigenschaft „Besprechung“ lässt sich auch auf die Datenbank „Besprechungsprotokolle“ verknüpfen (Typ auf Relation ändern).",
      en: "So agreements do not disappear in the minutes.\n\n- properties: **task**, **owner**, **due**, **meeting**, **status**, **priority**\n- views: **open**, **due by today**, **by person**, **calendar**\n\nOpen the “due by today” view first in the next meeting. The “meeting” property can also link to the “meeting log” database (change its type to relation).",
    },
    fields: [
      { id: "title", name: "Aufgabe", type: "text" },
      { id: "owner", name: "Verantwortlich", type: "person" },
      { id: "due", name: "Fällig", type: "date" },
      { id: "meeting", name: "Besprechung", type: "select", options: ["Jour fixe", "Projekt-Regeltermin", "Kundentermin", "Retrospektive"] },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
      { id: "priority", name: "Priorität", type: "select", options: ["Hoch", "Normal"] },
    ],
    views: [
      view("open", "Offen", "table", { filters: [{ field: "status", op: "neq", value: "Erledigt" }], sorts: [{ field: "due", direction: "asc" }] } as Partial<View>),
      // Not done and due today or earlier (the last ten years).
      view("overdue", "Fällig bis heute", "table", {
        filters: [
          { field: "status", op: "neq", value: "Erledigt" },
          { field: "due", op: "in_relative", value: "past_days", days: 3650, timeZone: "Europe/Berlin" },
        ],
        sorts: [{ field: "due", direction: "asc" }],
      } as Partial<View>),
      view("people", "Nach Person", "board", { groupBy: "owner" }),
      view("calendar", "Kalender", "calendar", { dateField: "due" }),
    ],
    rows: [
      { cells: { title: "Angebot an den Kunden schicken", due: "@-1", meeting: "Kundentermin", status: "In Arbeit", priority: "Hoch" } },
      { cells: { title: "Raum für den Workshop buchen", due: "@+2", meeting: "Jour fixe", status: "Offen", priority: "Normal" } },
      { cells: { title: "Maßnahme aus der Retro: Code-Reviews innerhalb eines Tages", due: "@+7", meeting: "Retrospektive", status: "Offen", priority: "Normal" } },
      { cells: { title: "Protokoll verteilen", due: "@-3", meeting: "Projekt-Regeltermin", status: "Erledigt", priority: "Normal" } },
    ],
  },
  // ------------------------------------------------------------------ Wissen
  {
    kind: "database",
    id: "glossary",
    category: "knowledge",
    icon: "📖",
    title: { de: "Glossar", en: "Glossary" },
    tags: ["Glossar", "Begriffe", "Wiki", "Abkürzungen"],
    summary: {
      de: "Begriffe und Abkürzungen eines Teams mit Definition, Bereich, Synonymen und Quelle – als Liste und nach Bereich.",
      en: "A team's terms and abbreviations with definition, area, synonyms and source – as a list and by area.",
    },
    description: {
      de: "Eine gemeinsame Sprache für Team, Kunden und Neue.\n\n- Eigenschaften: **Begriff**, **Kurzdefinition**, **Bereich**, **Synonyme** (über die Alias-Eigenschaft auch per @ auffindbar), **Quelle**\n- Ansichten: **A–Z**, **Nach Bereich**\n- Die Seite eines Eintrags bietet Platz für Beispiele und Abgrenzungen\n\nTipp: Begriffe in anderen Seiten mit @ verlinken – so landet man von überall direkt bei der Definition.",
      en: "A shared language for the team, customers and newcomers.\n\n- properties: **term**, **short definition**, **area**, **synonyms** (findable with @ as aliases), **source**\n- views: **A–Z**, **by area**\n- each record's page has room for examples and distinctions\n\nTip: link terms in other pages with @ – then the definition is one click away from everywhere.",
    },
    fields: [
      { id: "title", name: "Begriff", type: "text" },
      { id: "definition", name: "Kurzdefinition", type: "text" },
      { id: "area", name: "Bereich", type: "select", options: ["Allgemein", "Technik", "Vertrieb", "Recht", "Finanzen"] },
      { id: "aliases", name: "Synonyme", type: "aliases" },
      { id: "source", name: "Quelle", type: "url" },
    ],
    views: [view("az", "A–Z", "table", { sorts: [{ field: "title", direction: "asc" }] } as Partial<View>), view("area", "Nach Bereich", "board", { groupBy: "area" }), view("list", "Liste", "list")],
    rows: [
      { cells: { title: "Definition of Done", definition: "Gemeinsame Liste, wann eine Aufgabe wirklich fertig ist.", area: "Technik", aliases: ["DoD"] }, content: "<h2>Beispiel</h2><ul><li><p>Code geprüft</p></li><li><p>Tests grün</p></li><li><p>Dokumentation aktualisiert</p></li></ul>" },
      { cells: { title: "Service Level Agreement", definition: "Vereinbarte Qualität einer Leistung, z. B. Reaktionszeiten.", area: "Vertrieb", aliases: ["SLA"] } },
      { cells: { title: "Auftragsverarbeitungsvertrag", definition: "Vertrag nach Art. 28 DSGVO, wenn ein Dienstleister personenbezogene Daten verarbeitet.", area: "Recht", aliases: ["AVV", "AV-Vertrag"] } },
      { cells: { title: "Deckungsbeitrag", definition: "Umsatz minus variable Kosten.", area: "Finanzen", aliases: ["DB"] } },
    ],
  },
  // ------------------------------------------------------------- Persönlich
  {
    kind: "database",
    id: "household-budget",
    category: "personal",
    icon: "💶",
    title: { de: "Haushaltsbuch", en: "Household budget" },
    tags: ["Finanzen", "Budget", "Ausgaben", "Haushalt"],
    summary: {
      de: "Einnahmen und Ausgaben nach Kategorie und Monat erfassen – mit Summen, Monatsdiagramm und Ansicht der Fixkosten.",
      en: "Track income and expenses by category and month – with totals, a monthly chart and a view of fixed costs.",
    },
    description: {
      de: "Den Überblick über das eigene Geld behalten.\n\n- Eigenschaften: **Posten**, **Betrag** (Ausgaben negativ), **Art**, **Kategorie**, **Monat**, **Fix**\n- Ansichten: **Diesen Monat** mit Summe, **Nach Kategorie** als Diagramm, **Fixkosten**\n\nEinmal im Monat Kontoauszüge durchgehen, oder Einträge unterwegs über das Formular anlegen.",
      en: "Keep an overview of your money.\n\n- properties: **item**, **amount** (expenses negative), **type**, **category**, **month**, **fixed**\n- views: **this month** with total, **by category** as a chart, **fixed costs**\n\nGo through the bank statements once a month, or add entries on the go with the form.",
    },
    fields: [
      { id: "title", name: "Posten", type: "text" },
      { id: "amount", name: "Betrag", type: "number", format: "eur" },
      { id: "type", name: "Art", type: "select", options: ["Einnahme", "Ausgabe"] },
      { id: "category", name: "Kategorie", type: "select", options: ["Gehalt", "Wohnen", "Lebensmittel", "Mobilität", "Versicherungen", "Freizeit", "Sparen", "Sonstiges"] },
      { id: "month", name: "Monat", type: "select", options: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"] },
      { id: "fixed", name: "Fixkosten", type: "checkbox" },
    ],
    views: [
      view("table", "Alle Buchungen", "table", { calculations: { amount: "sum" } } as Partial<View>),
      view("month", "Nach Monat", "board", { groupBy: "month", calculations: { amount: "sum" } } as Partial<View>),
      view("chart", "Ausgaben je Kategorie", "chart", { ...chart("category", "amount", "sum", "horizontal"), filters: [{ field: "type", op: "eq", value: "Ausgabe" }] } as Partial<View>),
      view("fixed", "Fixkosten", "table", { filters: [{ field: "fixed", op: "checked", value: "" }], calculations: { amount: "sum" } } as Partial<View>),
      view("form", "Schnell erfassen", "form"),
    ],
    rows: [
      { cells: { title: "Gehalt", amount: 2850, type: "Einnahme", category: "Gehalt", month: "Januar", fixed: true } },
      { cells: { title: "Miete", amount: -950, type: "Ausgabe", category: "Wohnen", month: "Januar", fixed: true } },
      { cells: { title: "Wocheneinkauf", amount: -86.4, type: "Ausgabe", category: "Lebensmittel", month: "Januar", fixed: false } },
      { cells: { title: "Monatskarte", amount: -58, type: "Ausgabe", category: "Mobilität", month: "Januar", fixed: true } },
      { cells: { title: "Sparplan", amount: -200, type: "Ausgabe", category: "Sparen", month: "Januar", fixed: true } },
    ],
  },
  {
    kind: "database",
    id: "recipe-collection",
    category: "personal",
    icon: "🍲",
    title: { de: "Rezeptsammlung", en: "Recipe collection" },
    tags: ["Rezepte", "Kochen", "Essen", "Wochenplan"],
    summary: {
      de: "Lieblingsrezepte mit Zutaten und Zubereitung, Gang, Ernährungsform, Zeit und Bewertung – als Galerie.",
      en: "Favourite recipes with ingredients and method, course, diet, time and rating – as a gallery.",
    },
    description: {
      de: "Die eigenen Rezepte an einem Ort statt in Lesezeichen und Zetteln.\n\n- Eigenschaften: **Gang**, **Ernährung**, **Zeit (min)**, **Portionen**, **Bewertung**, **Quelle**, **Schon gekocht**\n- Ansichten: **Galerie**, **Schnell (bis 30 min)**, **Nach Gang**\n- Jede Rezeptseite hat Zutaten als Checkliste und die Zubereitung in Schritten\n\nFotos in die Rezeptseite einfügen – die Galerie zeigt das erste Bild.",
      en: "Your recipes in one place instead of bookmarks and notes.\n\n- properties: **course**, **diet**, **time (min)**, **servings**, **rating**, **source**, **cooked before**\n- views: **gallery**, **quick (up to 30 min)**, **by course**\n- every recipe page has the ingredients as a checklist and the method in steps\n\nAdd photos to the recipe page – the gallery shows the first picture.",
    },
    fields: [
      { id: "title", name: "Rezept", type: "text" },
      { id: "course", name: "Gang", type: "select", options: ["Frühstück", "Vorspeise", "Hauptgericht", "Beilage", "Dessert", "Gebäck"] },
      { id: "diet", name: "Ernährung", type: "multiselect", options: ["Vegetarisch", "Vegan", "Glutenfrei", "Mit Fleisch", "Mit Fisch"] },
      { id: "minutes", name: "Zeit (min)", type: "number" },
      { id: "servings", name: "Portionen", type: "number" },
      { id: "rating", name: "Bewertung (1–5)", type: "number" },
      { id: "source", name: "Quelle", type: "url" },
      { id: "cooked", name: "Schon gekocht", type: "checkbox" },
    ],
    views: [
      view("gallery", "Galerie", "gallery"),
      view("quick", "Schnell (bis 30 min)", "table", { filters: [{ field: "minutes", op: "lte", value: "30" }], sorts: [{ field: "minutes", direction: "asc" }] } as Partial<View>),
      view("course", "Nach Gang", "board", { groupBy: "course" }),
    ],
    rows: [
      {
        cells: { title: "Linsen-Dal mit Spinat", course: "Hauptgericht", diet: ["Vegan"], minutes: 35, servings: 4, rating: 5, cooked: true },
        content:
          "<h2>Zutaten</h2>" +
          '<ul data-type="taskList">' +
          ["250 g rote Linsen", "1 Zwiebel, 2 Knoblauchzehen", "1 EL Currypulver", "400 ml Kokosmilch", "200 g Blattspinat"]
            .map((x) => `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>${x}</p></div></li>`)
            .join("") +
          "</ul><h2>Zubereitung</h2><ol><li><p>Zwiebel und Knoblauch anschwitzen, Curry kurz mitrösten.</p></li><li><p>Linsen, Kokosmilch und 500 ml Wasser zugeben, 20 Minuten köcheln.</p></li><li><p>Spinat unterheben, mit Salz und Zitrone abschmecken.</p></li></ol>",
      },
      { cells: { title: "Ofengemüse mit Feta", course: "Hauptgericht", diet: ["Vegetarisch"], minutes: 45, servings: 2, rating: 4, cooked: true } },
      { cells: { title: "Overnight Oats", course: "Frühstück", diet: ["Vegetarisch"], minutes: 5, servings: 1, rating: 4, cooked: true } },
      { cells: { title: "Zitronen-Tarte", course: "Dessert", diet: ["Vegetarisch"], minutes: 90, servings: 8, cooked: false } },
    ],
  },
  {
    kind: "database",
    id: "subscriptions",
    category: "personal",
    icon: "🔁",
    title: { de: "Abos und Verträge", en: "Subscriptions and contracts" },
    tags: ["Abos", "Verträge", "Kündigung", "Finanzen"],
    summary: {
      de: "Laufende Abos und Verträge mit Kosten pro Monat und Jahr, Laufzeit, Kündigungsfrist und nächstem Kündigungstermin.",
      en: "Running subscriptions and contracts with monthly and yearly costs, term, notice period and next cancellation date.",
    },
    description: {
      de: "Nie wieder eine Kündigungsfrist verpassen.\n\n- Eigenschaften: **Anbieter**, **Kategorie**, **Kosten pro Monat**, **Kosten pro Jahr** (Formel), **Kündbar bis**, **Kündigungsfrist**, **Kundennummer**, **Status**\n- Ansichten: **Aktiv** mit Summen, **Kalender** der Kündigungstermine, **Nach Kategorie**\n\nTipp: Mit dem Workflow „Erinnerung vor Fälligkeit“ auf „Kündbar bis“ kommt rechtzeitig eine Erinnerung.",
      en: "Never miss a notice period again.\n\n- properties: **provider**, **category**, **cost per month**, **cost per year** (formula), **cancel by**, **notice period**, **customer number**, **status**\n- views: **active** with totals, a **calendar** of cancellation dates, **by category**\n\nTip: the “Reminder before the due date” workflow on “cancel by” sends a reminder in time.",
    },
    fields: [
      { id: "title", name: "Abo / Vertrag", type: "text" },
      { id: "provider", name: "Anbieter", type: "text" },
      { id: "category", name: "Kategorie", type: "select", options: ["Streaming", "Software", "Mobilfunk und Internet", "Versicherung", "Sport", "Zeitung", "Strom und Gas"] },
      { id: "monthly", name: "Kosten pro Monat", type: "number", format: "eur" },
      { id: "yearly", name: "Kosten pro Jahr", type: "formula", formula: 'prop("Kosten pro Monat") * 12', format: "eur" },
      { id: "cancelBy", name: "Kündbar bis", type: "date" },
      { id: "notice", name: "Kündigungsfrist", type: "select", options: ["Monatlich", "1 Monat", "3 Monate", "Zum Laufzeitende"] },
      { id: "customer", name: "Kundennummer", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Aktiv", "Gekündigt", "Prüfen"] },
    ],
    views: [
      view("active", "Aktiv", "table", { filters: [{ field: "status", op: "neq", value: "Gekündigt" }], calculations: { monthly: "sum", yearly: "sum" } } as Partial<View>),
      view("calendar", "Kündigungstermine", "calendar", { dateField: "cancelBy" }),
      view("category", "Nach Kategorie", "board", { groupBy: "category" }),
    ],
    rows: [
      { cells: { title: "Video-Streaming", provider: "Anbieter A", category: "Streaming", monthly: 13.99, notice: "Monatlich", status: "Prüfen" } },
      { cells: { title: "Handyvertrag", provider: "Anbieter B", category: "Mobilfunk und Internet", monthly: 19.99, cancelBy: "@+45", notice: "3 Monate", status: "Aktiv" } },
      { cells: { title: "Fitnessstudio", provider: "Studio C", category: "Sport", monthly: 29.9, cancelBy: "@+20", notice: "1 Monat", status: "Aktiv" } },
      { cells: { title: "Hausratversicherung", provider: "Versicherung D", category: "Versicherung", monthly: 6.5, notice: "Zum Laufzeitende", status: "Aktiv" } },
    ],
  },
  {
    kind: "database",
    id: "job-search",
    category: "personal",
    icon: "🧳",
    title: { de: "Jobsuche", en: "Job search" },
    tags: ["Bewerbung", "Karriere", "Jobsuche"],
    summary: {
      de: "Die eigene Jobsuche als Pipeline: Stellen, Phase, Gehaltsrahmen, Ansprechperson, nächster Schritt und Notizen zu jedem Gespräch.",
      en: "Your own job search as a pipeline: openings, stage, salary range, contact, next step and notes on every conversation.",
    },
    description: {
      de: "Den Überblick über alle Bewerbungen behalten.\n\n- Eigenschaften: **Stelle**, **Unternehmen**, **Phase**, **Beworben am**, **Nächster Schritt**, **Gehaltsrahmen**, **Ort/Remote**, **Link zur Ausschreibung**, **Passung (1–5)**\n- Ansichten: **Pipeline** als Board, **Nächste Schritte** im Kalender, **Alle**\n- Pro Eintrag Platz für Notizen zur Vorbereitung und zu jedem Gespräch\n\nAbsagen nicht löschen – in der Phase „Abgeschlossen“ helfen sie bei der nächsten Suche.",
      en: "Keep track of every application.\n\n- properties: **position**, **company**, **stage**, **applied on**, **next step**, **salary range**, **location/remote**, **link to the posting**, **fit (1–5)**\n- views: a **pipeline** board, **next steps** in a calendar, **all**\n- room on every record for preparation notes and notes on each interview\n\nDo not delete rejections – in the “closed” stage they help with the next search.",
    },
    fields: [
      { id: "title", name: "Stelle", type: "text" },
      { id: "company", name: "Unternehmen", type: "text" },
      { id: "stage", name: "Phase", type: "select", options: ["Interessant", "Beworben", "Gespräch", "Aufgabe", "Angebot", "Abgeschlossen"] },
      { id: "applied", name: "Beworben am", type: "date" },
      { id: "next", name: "Nächster Schritt", type: "date" },
      { id: "salary", name: "Gehaltsrahmen", type: "text" },
      { id: "place", name: "Ort", type: "select", options: ["Vor Ort", "Hybrid", "Remote"] },
      { id: "link", name: "Ausschreibung", type: "url" },
      { id: "fit", name: "Passung (1–5)", type: "number" },
    ],
    views: [
      view("board", "Pipeline", "board", { groupBy: "stage" }),
      view("calendar", "Nächste Schritte", "calendar", { dateField: "next" }),
      view("table", "Alle", "table", { sorts: [{ field: "fit", direction: "desc" }] } as Partial<View>),
    ],
    rows: [
      {
        cells: { title: "Produktmanagerin", company: "Beispiel AG", stage: "Gespräch", applied: "@-12", next: "@+3", salary: "65–75 T€", place: "Hybrid", fit: 5 },
        content: "<h2>Vorbereitung</h2><ul><li><p>Produkt ausprobieren, drei Verbesserungsideen notieren</p></li><li><p>Fragen zum Team und zur Einarbeitung</p></li></ul><h2>Gespräch 1</h2><p>Eindruck, offene Punkte …</p>",
      },
      { cells: { title: "Teamleitung Support", company: "Muster GmbH", stage: "Beworben", applied: "@-5", place: "Vor Ort", fit: 3 } },
      { cells: { title: "UX-Researcher", company: "Studio Nord", stage: "Interessant", place: "Remote", fit: 4 } },
    ],
  },
  // --------------------------------------------------------------- Sonstiges
  {
    kind: "database",
    id: "vendor-directory",
    category: "other",
    icon: "🏭",
    title: { de: "Lieferanten und Dienstleister", en: "Vendors and service providers" },
    tags: ["Lieferanten", "Einkauf", "Verträge", "Dienstleister"],
    summary: {
      de: "Lieferanten und Dienstleister mit Leistung, Ansprechperson, Vertragsende, Jahreskosten, Bewertung und Auftragsverarbeitung.",
      en: "Vendors and service providers with service, contact, contract end, annual cost, rating and data processing agreement.",
    },
    description: {
      de: "Wer liefert was, zu welchen Bedingungen – und wer ist der Kontakt?\n\n- Eigenschaften: **Leistung**, **Kategorie**, **Ansprechperson**, **E-Mail**, **Telefon**, **Vertragsende**, **Jahreskosten**, **Bewertung**, **AVV vorhanden**, **Kritisch**\n- Ansichten: **Alle** mit Kostensumme, **Vertragsenden** im Kalender, **Fehlender AVV**\n\nDie Ansicht „Fehlender AVV“ zeigt Dienstleister mit personenbezogenen Daten ohne Vertrag zur Auftragsverarbeitung.",
      en: "Who supplies what, on which terms – and who is the contact?\n\n- properties: **service**, **category**, **contact**, **email**, **phone**, **contract end**, **annual cost**, **rating**, **DPA in place**, **critical**\n- views: **all** with a cost total, **contract ends** in a calendar, **missing DPA**\n\nThe “missing DPA” view lists providers handling personal data without a data processing agreement.",
    },
    fields: [
      { id: "title", name: "Firma", type: "text" },
      { id: "service", name: "Leistung", type: "text" },
      { id: "category", name: "Kategorie", type: "select", options: ["IT und Software", "Büro", "Marketing", "Logistik", "Beratung", "Facility"] },
      { id: "contact", name: "Ansprechperson", type: "text" },
      { id: "email", name: "E-Mail", type: "email" },
      { id: "phone", name: "Telefon", type: "phone" },
      { id: "end", name: "Vertragsende", type: "date" },
      { id: "cost", name: "Jahreskosten", type: "number", format: "eur" },
      { id: "rating", name: "Bewertung (1–5)", type: "number" },
      { id: "personal", name: "Personenbezogene Daten", type: "checkbox" },
      { id: "dpa", name: "AVV vorhanden", type: "checkbox" },
    ],
    views: [
      view("table", "Alle", "table", { calculations: { cost: "sum" } } as Partial<View>),
      view("calendar", "Vertragsenden", "calendar", { dateField: "end" }),
      view("dpa", "Fehlender AVV", "table", {
        filters: [
          { field: "personal", op: "checked", value: "" },
          { field: "dpa", op: "unchecked", value: "" },
        ],
      } as Partial<View>),
      view("category", "Nach Kategorie", "board", { groupBy: "category" }),
    ],
    rows: [
      { cells: { title: "Beispiel Hosting GmbH", service: "Server und Backups", category: "IT und Software", contact: "Support-Team", email: "support@example.com", end: "@+120", cost: 2400, rating: 4, personal: true, dpa: true } },
      { cells: { title: "Druckerei Muster", service: "Flyer und Visitenkarten", category: "Marketing", contact: "Frau Beispiel", email: "auftrag@example.org", cost: 900, rating: 5, personal: false, dpa: false } },
      { cells: { title: "Lohnbüro Nord", service: "Lohnabrechnung", category: "Beratung", contact: "Herr Muster", email: "kontakt@example.net", end: "@+300", cost: 3600, rating: 4, personal: true, dpa: false } },
    ],
  },
];
