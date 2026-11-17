// Where people come from (components/onboarding.tsx, step "Woher kommst
// du?"): per tool where to find its export, what to choose here and which
// existing import takes it. Client-safe: plain data. The terms of each tool
// are in lib/migration-glossary.ts (same ids).
//
// The import routes are the ones of Settings → Import & Export, nothing of
// their own: "zip" is POST /api/import/zip (lib/zip-import.ts: Markdown,
// CSV and Notion's HTML export), "source" POST /api/import/source
// (lib/importers: AFFiNE, Confluence, Evernote, Google Docs, Word, Obsidian)
// as a background job (components/import-client.ts); "bookstack" is no
// file but BookStack's API with an API token (POST /api/import/bookstack,
// components/import-bookstack.tsx, #329).
//
// Adding a source: one entry below. A source that is not a file – such as
// an import through the Notion API with an integration token – gets a
// route kind of its own (e.g. { kind: "notion-api" }), its panel in
// components/onboarding-import.tsx (the switch on `route.kind` there) and,
// for the term table, the glossary of the tool it reads (`glossary`).
import type { OnboardingSource } from "./getting-started-items";

type Text = { de: string; en: string };
export type ImportRoute =
  | { kind: "zip" }
  | { kind: "source"; source: "auto" | "affine" | "confluence" | "evernote" | "gdocs" | "obsidian" | "word" }
  | { kind: "bookstack" };

export type MigrationSource = {
  id: Exclude<OnboardingSource, "fresh">;
  // The tool's own name (not translated).
  name: string;
  route: ImportRoute;
  // The file picker's types (routes with a file).
  accept?: string;
  // Where the export (or the token) is, step by step (menu paths in the
  // tool's English UI).
  steps: Text[];
  // What to pick (or enter) here.
  file: Text;
  // Which glossary of lib/migration-glossary.ts applies (default: id).
  glossary?: Exclude<OnboardingSource, "fresh">;
};

export const MIGRATION_SOURCES: MigrationSource[] = [
  {
    id: "notion",
    name: "Notion",
    route: { kind: "zip" },
    accept: ".zip,application/zip",
    steps: [
      {
        de: "In Notion: Settings → Workspace → General → „Export all workspace content“ (oder für eine Seite: ••• → Export).",
        en: "In Notion: Settings → Workspace → General → “Export all workspace content” (or for one page: ••• → Export).",
      },
      {
        de: "Format „HTML“, Inhalt „Everything“, „Include subpages“ und „Create folders for subpages“ an, Dateien und Bilder mit exportieren.",
        en: "Format “HTML”, content “Everything”, “Include subpages” and “Create folders for subpages” on, include files and images.",
      },
      {
        de: "Notion schickt dir einen Link per E-Mail. Lade die ZIP-Datei herunter – nicht entpacken.",
        en: "Notion e-mails you a link. Download the ZIP file – do not unpack it.",
      },
    ],
    file: {
      de: "Die ZIP-Datei des Exports, höchstens 100 MB. Ein großer Export aus mehreren Teil-ZIPs in einer ZIP geht auch.",
      en: "The export's ZIP file, at most 100 MB. A large export made of several part ZIPs inside one ZIP works too.",
    },
  },
  {
    id: "affine",
    name: "AFFiNE",
    route: { kind: "source", source: "affine" },
    accept: ".affine,.zip,application/zip",
    steps: [
      {
        de: "Ganzer Arbeitsbereich: in AFFiNE (Desktop-App) Settings → Workspace → „Export workspace“ – das ergibt eine .affine-Datei.",
        en: "Whole workspace: in AFFiNE (desktop app) Settings → Workspace → “Export workspace” – this gives an .affine file.",
      },
      {
        de: "Oder einzelne Dokumente: ••• → Export → „Snapshot“ (ZIP).",
        en: "Or single documents: ••• → Export → “Snapshot” (ZIP).",
      },
    ],
    file: {
      de: "Die .affine-Datei (mit Ordnern, Sammlungen, Datenbanken, Whiteboards und Journal) oder die Snapshot-ZIP.",
      en: "The .affine file (with folders, collections, databases, whiteboards and journal) or the snapshot ZIP.",
    },
  },
  {
    id: "obsidian",
    name: "Obsidian",
    route: { kind: "source", source: "obsidian" },
    accept: ".zip,application/zip",
    steps: [
      {
        de: "Obsidian hat keinen Export: Den Ordner deines Tresors (Vault) im Dateimanager als ZIP komprimieren.",
        en: "Obsidian has no export: compress your vault's folder as a ZIP in the file manager.",
      },
      {
        de: "Unterordner werden zum Seitenbaum; versteckte Ordner wie .obsidian werden übersprungen.",
        en: "Sub-folders become the page tree; hidden folders such as .obsidian are skipped.",
      },
    ],
    file: {
      de: "Die ZIP des Tresors. [[Wikilinks]], eingebettete Bilder, Callouts, Tags und Ordner werden übernommen.",
      en: "The vault's ZIP. [[Wikilinks]], embedded images, callouts, tags and folders come along.",
    },
  },
  {
    id: "evernote",
    name: "Evernote",
    route: { kind: "source", source: "evernote" },
    accept: ".enex,.zip,application/zip",
    steps: [
      {
        de: "In Evernote (Desktop-App): Rechtsklick auf ein Notizbuch → „Export notebook…“ → Format ENEX.",
        en: "In Evernote (desktop app): right-click a notebook → “Export notebook…” → format ENEX.",
      },
      {
        de: "Mehrere Notizbücher: jedes einzeln exportieren und die .enex-Dateien zusammen als ZIP packen.",
        en: "Several notebooks: export each one and pack the .enex files together as a ZIP.",
      },
    ],
    file: { de: "Eine .enex-Datei oder eine ZIP mit mehreren.", en: "One .enex file or a ZIP with several." },
  },
  {
    id: "confluence",
    name: "Confluence",
    route: { kind: "source", source: "confluence" },
    accept: ".zip,application/zip",
    steps: [
      {
        de: "Im Bereich: Space settings → „Export space“ → HTML (oder XML).",
        en: "In the space: Space settings → “Export space” → HTML (or XML).",
      },
      { de: "„Normal export“ mit allen Seiten wählen und die ZIP herunterladen.", en: "Choose “Normal export” with all pages and download the ZIP." },
    ],
    file: { de: "Die ZIP des Bereichsexports.", en: "The space export's ZIP." },
  },
  {
    id: "gdocs",
    name: "Google Docs / Word",
    route: { kind: "source", source: "auto" },
    accept: ".zip,.docx,.html,.htm,application/zip",
    steps: [
      {
        de: "Google Docs: takeout.google.com → nur „Drive“ auswählen → Format für Dokumente „DOCX“ oder „HTML“ → Export als ZIP.",
        en: "Google Docs: takeout.google.com → select only “Drive” → format for documents “DOCX” or “HTML” → export as ZIP.",
      },
      { de: "Ein einzelnes Dokument: Datei → Herunterladen → Microsoft Word (.docx).", en: "A single document: File → Download → Microsoft Word (.docx)." },
      {
        de: "Word: das Dokument als .docx speichern; mehrere als ZIP (Ordner werden zu Seiten).",
        en: "Word: save the document as .docx; several as a ZIP (folders become pages).",
      },
    ],
    file: { de: "Die Takeout-ZIP, eine .docx- oder HTML-Datei oder eine ZIP mit .docx-Dateien.", en: "The Takeout ZIP, a .docx or HTML file, or a ZIP with .docx files." },
  },
  {
    id: "bookstack",
    name: "BookStack",
    route: { kind: "bookstack" },
    steps: [
      {
        de: "In BookStack: dein Profil → „Access & Security“ → „API Tokens“ → „Create Token“ (ältere Versionen: Profil bearbeiten → API Tokens).",
        en: "In BookStack: your profile → “Access & Security” → “API Tokens” → “Create Token” (older versions: edit profile → API Tokens).",
      },
      {
        de: "Deine Rolle braucht die Berechtigung „Access system API“ (Settings → Roles). Token-ID und Token-Secret kopieren – das Secret zeigt BookStack nur einmal.",
        en: "Your role needs the permission “Access system API” (Settings → Roles). Copy the token ID and token secret – BookStack shows the secret only once.",
      },
    ],
    file: {
      de: "Die Adresse deiner BookStack-Instanz, Token-ID und Token-Secret. Regale, Bücher, Kapitel und Seiten mit Bildern, Anhängen und Tags werden übernommen.",
      en: "The address of your BookStack instance, the token ID and token secret. Shelves, books, chapters and pages with images, attachments and tags come along.",
    },
  },
];

export const migrationSource = (id: OnboardingSource | null) => MIGRATION_SOURCES.find((s) => s.id === id) ?? null;
