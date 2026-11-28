// "So heißt das hier" / "What it's called here": per tool the terms people
// know and what they are called in Flowplan (components/onboarding.tsx,
// after "Woher kommst du?"; the documentation mirrors this list). Every
// Flowplan name is the one the interface uses (the English text is the key
// of the existing translations); where Flowplan has no counterpart the
// entry says so (`match: "none"`). Client-safe: plain data.
//
// match: "same" – the same idea under this name; "similar" – close, with
// a difference the note names; "none" – no counterpart (the note says what
// to do instead, or what the import makes of it).
import type { OnboardingSource } from "./getting-started-items";

type Text = { de: string; en: string };
export type GlossaryEntry = { theirs: string; ours: Text | null; match: "same" | "similar" | "none"; note?: Text };
export type GlossaryTool = Exclude<OnboardingSource, "fresh">;

// Flowplan's names, as in the interface.
const T = {
  workspace: { de: "Arbeitsbereich", en: "Workspace" },
  space: { de: "Bereich", en: "Space" },
  page: { de: "Seite", en: "Page" },
  subpages: { de: "Unterseiten", en: "Sub-pages" },
  database: { de: "Datenbank", en: "Database" },
  properties: { de: "Eigenschaften", en: "Properties" },
  relation: { de: "Relation", en: "Relation" },
  rollup: { de: "Rollup", en: "Rollup" },
  formula: { de: "Formel", en: "Formula" },
  synced: { de: "Synchronisierter Block", en: "Synced block" },
  toggle: { de: "Aufklappbarer Block", en: "Toggle" },
  callout: { de: "Callout", en: "Callout" },
  linked: { de: "Verknüpfte Datenbank", en: "Linked database" },
  whiteboard: { de: "Whiteboard", en: "Whiteboard" },
  collections: { de: "Sammlungen", en: "Collections" },
  journal: { de: "Journal", en: "Journal" },
  tags: { de: "Tags", en: "Tags" },
  templates: { de: "Vorlagen", en: "Templates" },
  favourites: { de: "Favoriten", en: "Favourites" },
  inbox: { de: "Posteingang", en: "Inbox" },
  comments: { de: "Kommentare", en: "Comments" },
  versions: { de: "Versionen", en: "Versions" },
  graph: { de: "Graph", en: "Graph" },
  trash: { de: "Papierkorb", en: "Trash" },
  automations: { de: "Automationen", en: "Automations" },
  clipper: { de: "Web-Clipper", en: "Web clipper" },
  frames: { de: "Rahmen", en: "Frames" },
  linkedFrom: { de: "Verlinkt von", en: "Linked from" },
  footnote: { de: "Fußnote", en: "Footnote" },
  suggest: { de: "Als Änderungsvorschlag einfügen", en: "Suggest as changes" },
  subtasks: { de: "Unteraufgaben", en: "Subtasks" },
  form: { de: "Formular", en: "Form" },
  workflowButton: { de: "Workflow-Knopf", en: "Workflow button" },
  extensions: { de: "Erweiterungen", en: "Extensions" },
  taskList: { de: "Aufgabenliste", en: "Task list" },
  search: { de: "Suchen", en: "Search" },
} satisfies Record<string, Text>;

// The same in every tool: typing "/" and "@".
export const SHARED_HABITS: Text[] = [
  { de: "„/“ in einer leeren Zeile öffnet alle Blöcke – wie gewohnt.", en: "“/” on an empty line opens all blocks – as you are used to." },
  { de: "„@“ erwähnt Seiten, Einträge, Personen und Daten; „[[“ verlinkt eine Seite.", en: "“@” mentions pages, records, people and dates; “[[” links a page." },
  { de: "Markdown-Kürzel wie #, - und [] funktionieren beim Tippen; „>“ macht einen aufklappbaren Block (oder ein Zitat, einstellbar).", en: "Markdown shortcuts such as #, - and [] work while typing; “>” makes a toggle (or a quote, as you choose)." },
];

export const MIGRATION_GLOSSARY: Record<GlossaryTool, GlossaryEntry[]> = {
  notion: [
    { theirs: "Workspace", ours: T.workspace, match: "same" },
    { theirs: "Teamspace", ours: T.space, match: "same", note: { de: "Bereiche sind für ein Team oder privat.", en: "Spaces are for a team or private." } },
    { theirs: "Page", ours: T.page, match: "same", note: { de: "Seiten lassen sich beliebig tief verschachteln.", en: "Pages nest as deep as you like." } },
    { theirs: "Database", ours: T.database, match: "same", note: { de: "Tabelle, Board, Kalender, Galerie, Liste, Zeitleiste, Formular, Diagramm und Feed als Ansichten.", en: "Table, board, calendar, gallery, list, timeline, form, chart and feed as views." } },
    { theirs: "Linked view of database", ours: T.linked, match: "same" },
    { theirs: "Relation / Rollup", ours: { de: "Relation / Rollup", en: "Relation / Rollup" }, match: "same", note: { de: "Relationen werden mit den importierten Einträgen verbunden. Rollups kommen aus dem Export als Text, über die Notion-API als Rollup.", en: "Relations are connected to the imported records. Rollups come as text from the export, as rollups through the Notion API." } },
    { theirs: "Formula", ours: T.formula, match: "same", note: { de: "Der Export bringt nur die Ergebnisse als Text; über die Notion-API werden Formeln übernommen, die Flowplan lesen kann.", en: "The export brings only the results as text; through the Notion API, formulas Flowplan can read are carried over." } },
    { theirs: "Synced block", ours: T.synced, match: "same" },
    { theirs: "Toggle / toggle heading", ours: T.toggle, match: "same" },
    { theirs: "Callout", ours: T.callout, match: "same" },
    { theirs: "Database templates", ours: T.templates, match: "same", note: { de: "Einen Eintrag als Vorlage speichern, mit Platzhaltern wie {{Heute}}.", en: "Save a record as a template, with placeholders like {{Today}}." } },
    { theirs: "Database automations", ours: T.automations, match: "same" },
    { theirs: "Buttons", ours: T.workflowButton, match: "similar", note: { de: "Ein Knopf im Dokument startet einen Workflow.", en: "A button in the document starts a workflow." } },
    { theirs: "Sub-items", ours: T.subtasks, match: "same" },
    { theirs: "Inbox / Updates", ours: T.inbox, match: "same" },
    { theirs: "Page history", ours: T.versions, match: "same" },
    { theirs: "Publish / Sites", ours: { de: "Im Web veröffentlichen", en: "Publish on the web" }, match: "similar", note: { de: "Seiten einzeln veröffentlichen, mit oder ohne Unterseiten; keine eigenen Websites mit Navigation.", en: "Publish pages one by one, with or without sub-pages; no separate websites with navigation." } },
    { theirs: "Notion Calendar / Mail", ours: null, match: "none", note: { de: "Keine eigenen Apps dafür – Datenbanken haben eine Kalenderansicht und lassen sich als Kalender abonnieren.", en: "No separate apps for this – databases have a calendar view and can be subscribed to as a calendar." } },
  ],
  affine: [
    { theirs: "Workspace", ours: T.workspace, match: "same" },
    { theirs: "Doc / Page mode", ours: T.page, match: "same" },
    { theirs: "Edgeless mode", ours: T.whiteboard, match: "similar", note: { de: "In Flowplan ist ein Whiteboard eine eigene Seite, kein zweiter Modus desselben Dokuments; der Import macht daraus Whiteboards.", en: "In Flowplan a whiteboard is a page of its own, not a second mode of the same document; the import turns it into whiteboards." } },
    { theirs: "Frame (Edgeless)", ours: T.frames, match: "same", note: { de: "Auch für Präsentationen.", en: "Also for presentations." } },
    { theirs: "Collections", ours: T.collections, match: "similar", note: { de: "Sammlungen sind gespeicherte Suchen in der Seitenleiste; der Import legt AFFiNE-Sammlungen als Seiten mit Links an.", en: "Collections are saved searches in the sidebar; the import creates AFFiNE collections as pages with links." } },
    { theirs: "Folders (Organize)", ours: T.subpages, match: "similar", note: { de: "Ordner werden zu Seiten, unter denen ihre Dokumente liegen.", en: "Folders become pages with their documents below them." } },
    { theirs: "Journals", ours: T.journal, match: "same" },
    { theirs: "Database block", ours: T.database, match: "same" },
    { theirs: "Doc properties", ours: T.properties, match: "same" },
    { theirs: "Tags", ours: T.tags, match: "same" },
    { theirs: "Linked doc", ours: { de: "Seitenlink (@ oder [[)", en: "Page link (@ or [[)" }, match: "same" },
    { theirs: "Templates", ours: T.templates, match: "same" },
    { theirs: "Favorites", ours: T.favourites, match: "same" },
    { theirs: "Trash", ours: T.trash, match: "same" },
  ],
  obsidian: [
    { theirs: "Vault", ours: T.space, match: "similar", note: { de: "Ein Tresor wird ein Seitenbaum in einem Bereich; mehrere Tresore passen in einen Arbeitsbereich.", en: "A vault becomes a page tree in a space; several vaults fit into one workspace." } },
    { theirs: "Note", ours: T.page, match: "same" },
    { theirs: "Folder", ours: T.subpages, match: "similar", note: { de: "Ein Ordner wird eine Seite mit seinen Notizen als Unterseiten.", en: "A folder becomes a page with its notes as sub-pages." } },
    { theirs: "[[Wikilinks]]", ours: { de: "Seitenlink ([[ oder @)", en: "Page link ([[ or @)" }, match: "same", note: { de: "Links folgen Umbenennungen.", en: "Links follow renames." } },
    { theirs: "Backlinks", ours: T.linkedFrom, match: "same" },
    { theirs: "Graph view", ours: T.graph, match: "same" },
    { theirs: "Daily notes", ours: T.journal, match: "same" },
    { theirs: "Canvas", ours: T.whiteboard, match: "similar", note: { de: "Canvas-Dateien werden beim Import Whiteboards; Texte, Notizen als Karten, Bilder, Links, Gruppen und Verbindungen bleiben.", en: "Canvas files become whiteboards on import; texts, notes as cards, images, links, groups and connections stay." } },
    { theirs: "Callouts (> [!note])", ours: T.callout, match: "same" },
    { theirs: "Properties (frontmatter)", ours: T.properties, match: "same" },
    { theirs: "#tags", ours: T.tags, match: "same" },
    { theirs: "Embeds (![[…]])", ours: T.synced, match: "similar", note: { de: "Eingebettete Bilder und Dateien bleiben; eine Notiz in eine andere einbetten geht mit einem synchronisierten Block.", en: "Embedded images and files stay; to embed one note in another, use a synced block." } },
    { theirs: "Community plugins", ours: T.extensions, match: "similar", note: { de: "Obsidian-Plugins laufen nicht in Flowplan; Erweiterungen gibt es im Marketplace.", en: "Obsidian plugins do not run in Flowplan; extensions are in the marketplace." } },
    { theirs: "Local files", ours: null, match: "none", note: { de: "Flowplan speichert auf dem Server, nicht als Markdown-Dateien; Export als Markdown jederzeit möglich, offline auf Wunsch.", en: "Flowplan stores on the server, not as Markdown files; export as Markdown at any time, offline on request." } },
  ],
  evernote: [
    { theirs: "Notebook", ours: T.page, match: "similar", note: { de: "Ein Notizbuch wird eine Seite mit seinen Notizen als Unterseiten.", en: "A notebook becomes a page with its notes as sub-pages." } },
    { theirs: "Stack", ours: T.space, match: "similar", note: { de: "Gruppiere Notizbücher in einem Bereich oder unter einer Seite.", en: "Group notebooks in a space or below a page." } },
    { theirs: "Note", ours: T.page, match: "same" },
    { theirs: "Tags", ours: T.tags, match: "same" },
    { theirs: "Shortcuts", ours: T.favourites, match: "same" },
    { theirs: "Tasks", ours: T.taskList, match: "same", note: { de: "Aufgabenlisten in Seiten; was dir zugewiesen ist, sammelt „Meine Aufgaben“.", en: "Task lists in pages; what is assigned to you is collected in “My tasks”." } },
    { theirs: "Reminders", ours: { de: "Erinnerung", en: "Reminder" }, match: "similar", note: { de: "Erinnerungen hängen an Daten und Fälligkeiten.", en: "Reminders belong to dates and due dates." } },
    { theirs: "Web Clipper", ours: T.clipper, match: "same" },
    { theirs: "Spaces", ours: T.space, match: "same" },
    { theirs: "Search in images and PDFs", ours: T.search, match: "same", note: { de: "Die Volltextsuche findet auch Text in PDFs und Bildern.", en: "Full-text search also finds text in PDFs and images." } },
  ],
  confluence: [
    { theirs: "Space", ours: T.space, match: "same" },
    { theirs: "Page / page tree", ours: T.page, match: "same" },
    { theirs: "Blog post", ours: null, match: "none", note: { de: "Keine eigene Blog-Art – nimm eine Datenbank mit Datum und Feed-Ansicht.", en: "No separate blog type – use a database with a date and a feed view." } },
    { theirs: "Info / note / warning panel", ours: T.callout, match: "same" },
    { theirs: "Expand macro", ours: T.toggle, match: "same" },
    { theirs: "Macros", ours: { de: "Blöcke (/)", en: "Blocks (/)" }, match: "similar", note: { de: "Info-, Code- und Aufklapp-Makros werden zu Blöcken; was andere Makros zeigen, kommt als normaler Inhalt oder fehlt.", en: "Info, code and expand macros become blocks; what other macros show comes as plain content or is missing." } },
    { theirs: "Labels", ours: T.tags, match: "same" },
    { theirs: "Page restrictions", ours: { de: "Rechte (Teilen)", en: "Permissions (Share)" }, match: "same" },
    { theirs: "Page history", ours: T.versions, match: "same" },
    { theirs: "Inline comments", ours: T.comments, match: "same" },
    { theirs: "Whiteboards", ours: T.whiteboard, match: "same" },
    { theirs: "Jira issue macro", ours: null, match: "none", note: { de: "Kein Jira-Makro; Jira-Vorgänge lassen sich als CSV in eine Datenbank importieren.", en: "No Jira macro; Jira issues can be imported as CSV into a database." } },
  ],
  gdocs: [
    { theirs: "Document", ours: T.page, match: "same" },
    { theirs: "Folder (Drive)", ours: T.subpages, match: "similar", note: { de: "Ordner werden zu Seiten mit den Dokumenten darunter.", en: "Folders become pages with the documents below them." } },
    { theirs: "Suggesting / Track changes", ours: T.suggest, match: "same" },
    { theirs: "Comments", ours: T.comments, match: "same" },
    { theirs: "Version history", ours: T.versions, match: "same" },
    { theirs: "Footnotes", ours: T.footnote, match: "same" },
    { theirs: "Smart chips (@)", ours: { de: "@-Erwähnungen", en: "@ mentions" }, match: "same" },
    { theirs: "Page setup / print layout", ours: { de: "Drucken / PDF", en: "Print / PDF" }, match: "similar", note: { de: "Seiten fließen am Bildschirm; Papierformat, Seitenzahlen und Seitenumbrüche gibt es beim Drucken.", en: "Pages flow on screen; paper size, page numbers and page breaks come with printing." } },
    { theirs: "Google Sheets / Excel", ours: T.database, match: "similar", note: { de: "Eine Datenbank hat Eigenschaften je Spalte und Formeln je Eintrag, aber keine freien Zellformeln.", en: "A database has properties per column and formulas per record, but no free cell formulas." } },
    { theirs: "Google Forms", ours: T.form, match: "same" },
  ],
  bookstack: [
    { theirs: "Shelf", ours: T.page, match: "similar", note: { de: "Ein Regal wird eine Seite mit seinen Büchern als Unterseiten; ein Buch in mehreren Regalen kommt einmal unter das erste.", en: "A shelf becomes a page with its books as sub-pages; a book on several shelves comes once, below the first." } },
    { theirs: "Book", ours: T.page, match: "similar", note: { de: "Ein Buch wird eine Seite mit seiner Beschreibung als Text und Kapiteln und Seiten darunter.", en: "A book becomes a page with its description as text and chapters and pages below it." } },
    { theirs: "Chapter", ours: T.subpages, match: "similar", note: { de: "Ein Kapitel wird eine Unterseite des Buchs mit seinen Seiten darunter.", en: "A chapter becomes a sub-page of the book with its pages below it." } },
    { theirs: "Page", ours: T.page, match: "same", note: { de: "Seiten lassen sich beliebig tief verschachteln.", en: "Pages nest as deep as you like." } },
    { theirs: "Tags (name: value)", ours: T.tags, match: "similar", note: { de: "Ein Tag mit Wert wird ein Tag „Name: Wert“.", en: "A tag with a value becomes a tag “name: value”." } },
    { theirs: "Callouts", ours: T.callout, match: "same" },
    { theirs: "Attachments", ours: { de: "Dateien", en: "Files" }, match: "same", note: { de: "Dateien kommen als Anhang auf die Seite; Link-Anhänge bleiben Links.", en: "Files come as attachments on the page; link attachments stay links." } },
    { theirs: "Image gallery / Diagrams.net", ours: { de: "Bilder", en: "Images" }, match: "similar", note: { de: "Bilder und gezeichnete Diagramme kommen als Bilder auf ihre Seite; ein Diagramm zeichnest du in Flowplan auf einem Whiteboard.", en: "Images and drawn diagrams come as images on their page; in Flowplan you draw a diagram on a whiteboard." } },
    { theirs: "Revisions", ours: T.versions, match: "same", note: { de: "Frühere Fassungen aus BookStack werden nicht übernommen; Flowplan legt ab dem Import eigene Versionen an.", en: "Earlier revisions from BookStack are not imported; Flowplan keeps its own versions from the import on." } },
    { theirs: "Page templates", ours: T.templates, match: "similar", note: { de: "Vorlagen aus BookStack kommen als normale Seiten; speichere eine Seite in Flowplan als Vorlage.", en: "Templates from BookStack come as normal pages; save a page as a template in Flowplan." } },
    { theirs: "Roles & permissions", ours: { de: "Rechte (Teilen)", en: "Permissions (Share)" }, match: "similar", note: { de: "Rechte werden nicht übernommen; du teilst Bereiche und Seiten in Flowplan neu.", en: "Permissions are not imported; you share spaces and pages in Flowplan again." } },
    { theirs: "Comments", ours: T.comments, match: "same", note: { de: "Kommentare aus BookStack werden nicht übernommen.", en: "Comments from BookStack are not imported." } },
    { theirs: "Recycle bin", ours: T.trash, match: "same" },
  ],
};

export const glossaryFor = (tool: GlossaryTool | null) => (tool ? MIGRATION_GLOSSARY[tool] : []);
