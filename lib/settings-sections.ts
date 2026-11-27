// The settings and the administration as one list of areas, groups and
// sections (docs/settings-architecture.md). This file is plain data – no
// React – so routing, tests and the search can use it; the components that
// render a section are attached in components/settings/registry.tsx.
//
// Every section has a stable id: it is the address of the section
// (#settings/<id>, #settings/instance/<id>) and must not change once released. Texts are
// { de, en } pairs (French and further languages come from locales/ via
// `npm run i18n`).
//
// Levels (#294, lib/settings-level.ts): every personal setting (area
// "settings") has a level – "beginner" (Einsteiger), "normal" or "expert"
// (Experte). A person sees the settings up to their level; the search finds
// all of them. The rule for a new setting: give its section a `level` (none
// means "beginner"), and give an entry a `level` when it differs from its
// section's. Beginner is what everyone needs on day one (language, theme,
// name, password, passkeys, the basics of notifications and capture);
// normal most appearance, editor and workspace options; expert tokens,
// webhooks, developer and advanced options, toolbar layout, anything
// experimental. The panel marks the setting's row or card with the same
// anchor (SettingRow anchor / SettingGroup id, components/settings-ui.tsx),
// which takes the level from here; rows without an entry take their card's,
// else the section's (or say `level` themselves). Administration sections
// (area "admin") have no level: admins see all of them.
// tests/settings-level.test.ts checks that every level is valid.
import { entryLevel, sectionMinLevel, type SettingsLevel } from "./settings-level";

export type SettingsArea = "settings" | "admin";
export type Text = { de: string; en: string };

// A single setting inside a section, for the search ("Passkeys" finds
// Konto & Sicherheit). `anchor` is the id of an element in the section the
// result scrolls to (#settings/account/passkeys); without it the section
// opens at the top.
export type SettingsEntry = { title: Text; keywords?: Text; anchor?: string; level?: SettingsLevel };

export type SectionMeta = {
  id: string;
  area: SettingsArea;
  group: string;
  // Phosphor icon name, resolved in components/settings/registry.tsx.
  icon: string;
  title: Text;
  description: Text;
  keywords: Text;
  entries?: SettingsEntry[];
  // The level of the section and, by default, of its entries (#294).
  level?: SettingsLevel;
};

export type GroupMeta = { id: string; area: SettingsArea; title: Text };

// The groups in the order of the landing page. The workspace group shows the
// workspace's name ("Arbeitsbereich „Team“"): its title has {name}.
export const SETTINGS_GROUPS: GroupMeta[] = [
  { id: "personal", area: "settings", title: { de: "Persönlich", en: "Personal" } },
  { id: "connections", area: "settings", title: { de: "Verbindungen", en: "Connections" } },
  { id: "workspace", area: "settings", title: { de: "Arbeitsbereich", en: "Workspace" } },
  { id: "help", area: "settings", title: { de: "Hilfe & Info", en: "Help & info" } },
  { id: "people", area: "admin", title: { de: "Personen", en: "People" } },
  { id: "data", area: "admin", title: { de: "Daten", en: "Data" } },
  { id: "services", area: "admin", title: { de: "Dienste", en: "Services" } },
  { id: "security", area: "admin", title: { de: "Sicherheit", en: "Security" } },
  { id: "operations", area: "admin", title: { de: "Betrieb", en: "Operations" } },
];

export const SETTINGS_SECTIONS: SectionMeta[] = [
  // ---------------------------------------------------------------- personal
  {
    // Storage and AI in one place (components/settings/user/usage.tsx):
    // what applies, where it comes from, and the instance's link for more.
    // "Deine Grenzen" (Konto & Sicherheit) and "KI-Kontingent" (KI) lived
    // elsewhere before 0.11.3: LEGACY_ANCHORS leads their addresses here.
    id: "usage",
    area: "settings",
    level: "beginner",
    group: "personal",
    icon: "Gauge",
    title: { de: "Speicher & KI", en: "Storage & AI" },
    description: { de: "Wie viel Speicher und KI du hast, was davon belegt ist und woher es kommt.", en: "How much storage and AI you have, how much is used and where it comes from." },
    keywords: {
      de: "speicher speicherplatz kontingent ki-kontingent ki limit limits grenze grenzen deine grenzen upload hochladen dateigröße tarif plan abo mehr speicher arbeitsbereiche tokens modell voll belegt",
      en: "storage space quota ai quota ai limit limits your limits upload file size plan tariff subscription more storage workspaces tokens model full used",
    },
    entries: [
      { title: { de: "Speicher", en: "Storage" }, keywords: { de: "speicherplatz belegt voll dateien bilder", en: "space used full files images" }, anchor: "storage" },
      { title: { de: "Größte Datei beim Hochladen", en: "Largest upload" }, keywords: { de: "upload hochladen dateigröße", en: "upload file size" }, anchor: "upload" },
      { title: { de: "Eigene Arbeitsbereiche", en: "Own workspaces" }, keywords: { de: "anzahl grenze", en: "number limit" }, anchor: "workspaces" },
      {
        title: { de: "KI-Kontingent", en: "AI quota" },
        keywords: { de: "kontingent limit grenze tokens kosten übrig verbraucht zurückgesetzt", en: "quota limit tokens cost left used remaining reset" },
        anchor: "ai",
      },
      { title: { de: "Deine KI-Modelle", en: "Your AI models" }, keywords: { de: "modell modelle anbieter", en: "model models provider" }, anchor: "models" },
      { title: { de: "Mehr Speicher oder KI?", en: "More storage or AI?" }, keywords: { de: "tarif plan abo upgrade erweitern", en: "plan tariff subscription upgrade extend" }, anchor: "more" },
    ],
  },
  {
    id: "account",
    area: "settings",
    level: "beginner",
    group: "personal",
    icon: "UserCircle",
    title: { de: "Konto & Sicherheit", en: "Account & security" },
    description: { de: "Profil, Anmeldung, angemeldete Geräte und Verschlüsselung.", en: "Profile, sign-in, signed-in devices and encryption." },
    keywords: { de: "profil name anzeigename passwort passkey zwei-faktor 2fa authenticator sitzungen geräte abmelden verschlüsselung e2ee konto löschen", en: "profile name display name password passkey two-factor 2fa authenticator sessions devices sign out encryption e2ee delete account" },
    entries: [
      { title: { de: "Anzeigename", en: "Display name" }, keywords: { de: "profil name", en: "profile name" }, anchor: "profile" },
      { title: { de: "E-Mail-Adresse ändern", en: "Change e-mail address" }, keywords: { de: "email mail adresse ändern", en: "email mail address change" }, anchor: "email" },
      { title: { de: "Anmeldemethoden", en: "Sign-in methods" }, keywords: { de: "sso oidc verbinden trennen single sign-on passwort entfernen", en: "sso oidc connect disconnect link single sign-on remove password" }, anchor: "sign-in-methods", level: "normal" },
      { title: { de: "Passwort ändern", en: "Change password" }, anchor: "password" },
      { title: { de: "Passkeys", en: "Passkeys" }, anchor: "passkeys" },
      { title: { de: "Zwei-Faktor-Anmeldung", en: "Two-factor sign-in" }, keywords: { de: "2fa authenticator code wiederherstellungscodes", en: "2fa authenticator code recovery codes" }, anchor: "two-factor" },
      { title: { de: "Angemeldete Geräte", en: "Signed-in devices" }, keywords: { de: "sitzungen abmelden", en: "sessions sign out" }, anchor: "sessions" },
      { title: { de: "Ende-zu-Ende-Verschlüsselung", en: "End-to-end encryption" }, keywords: { de: "e2ee schlüssel passphrase wiederherstellungsschlüssel", en: "e2ee key passphrase recovery key" }, anchor: "encryption", level: "expert" },
      {
        title: { de: "Notfallzugriff", en: "Emergency access" },
        keywords: { de: "vertrauensperson notfall zugriff erbe angehörige wartezeit anfragen ablehnen", en: "trusted contact emergency access legacy relatives waiting period request deny" },
        anchor: "emergency",
        level: "normal",
      },
      {
        title: { de: "Nachricht bei Inaktivität", en: "Inactivity message" },
        keywords: {
          de: "totmannschalter lebenszeichen inaktivität nachricht angehörige familie notiz empfänger ich bin da",
          en: "dead man's switch sign of life inactivity message relatives family note recipients i'm here",
        },
        anchor: "deadman",
        level: "normal",
      },
      { title: { de: "Konto löschen", en: "Delete account" }, anchor: "delete-account" },
    ],
  },
  {
    id: "security",
    area: "settings",
    level: "normal",
    group: "personal",
    icon: "ShieldCheck",
    title: { de: "Sicherheitscheck", en: "Security check" },
    description: { de: "Wie gut dein Konto geschützt ist, was du geteilt hast und deine letzten Anmeldungen.", en: "How well your account is protected, what you shared and your latest sign-ins." },
    keywords: {
      de: "sicherheit sicherheitscheck konto schützen zwei-faktor 2fa passkey wiederherstellungscodes geteilt freigabelinks öffentlich zugriff entziehen anmeldungen fehlgeschlagen geräte tipps",
      en: "security check protect account two-factor 2fa passkey recovery codes shared share links public access remove sign-ins failed devices tips",
    },
    entries: [
      { title: { de: "Sicherheitscheck", en: "Security check" }, anchor: "checks" },
      { title: { de: "Was du geteilt hast", en: "What you shared" }, keywords: { de: "freigabelinks öffentliche seiten personen", en: "share links public pages people" }, anchor: "shared" },
      { title: { de: "HTML-Dateien mit Skripten", en: "HTML files with scripts" }, keywords: { de: "html skripte immer zulassen vorschau", en: "html scripts always allow preview" }, anchor: "html-scripts" },
      { title: { de: "Anmeldungen & Änderungen", en: "Sign-ins & changes" }, anchor: "activity" },
      { title: { de: "Tipps", en: "Tips" }, anchor: "tips" },
    ],
  },
  {
    id: "appearance",
    area: "settings",
    level: "beginner",
    group: "personal",
    icon: "Palette",
    title: { de: "Darstellung & Sprache", en: "Appearance & language" },
    description: { de: "Sprache, Hell oder Dunkel, Zeilennummern im Code, Tastenkürzel und die Einführung.", en: "Language, light or dark, line numbers in code, keyboard shortcuts and the introduction." },
    keywords: { de: "sprache deutsch englisch französisch design hell dunkel theme editor griffe blockgriffe code zeilennummern tastenkürzel shortcuts einführung tour", en: "language german english french theme light dark appearance editor handles block handles code line numbers keyboard shortcuts introduction tour" },
    entries: [
      { title: { de: "Sprache", en: "Language" }, anchor: "ui-language" },
      { title: { de: "Erscheinungsbild", en: "Appearance" }, keywords: { de: "hell dunkel", en: "light dark" }, anchor: "color-theme" },
      {
        title: { de: "Whiteboard-Fläche", en: "Whiteboard canvas" },
        keywords: { de: "whiteboard board fläche hintergrund dunkel hell dunkelmodus farbschema immer hell", en: "whiteboard board canvas background dark light dark mode colour scheme color always light" },
        anchor: "whiteboard-canvas",
        level: "normal",
      },
      {
        title: { de: "Animationen", en: "Animations" },
        keywords: { de: "bewegung animation reduziert aus übergänge einblenden barrierefreiheit", en: "motion animation reduced off transitions fade accessibility" },
        anchor: "motion",
        level: "normal",
      },
      {
        title: { de: "Beim Öffnen auf dem Handy", en: "When opening on a phone" },
        keywords: { de: "start startbildschirm startseite schnellerfassung erfassen handy telefon öffnen app", en: "start start screen home quick capture capture phone open app" },
        anchor: "start-screen",
        level: "normal",
      },
      { title: { de: "Darstellung des Arbeitsbereichs verwenden", en: "Use the workspace's appearance" }, keywords: { de: "akzentfarbe schrift standard", en: "accent font default" }, anchor: "workspace-look", level: "normal" },
      { title: { de: "Schriftart", en: "Font" }, keywords: { de: "schrift schriftart typografie lesbarkeit systemschrift serifen", en: "font typeface typography readability system font serif" }, anchor: "font", level: "normal" },
      {
        title: { de: "Symbole unten in der Seitenleiste", en: "Symbols at the bottom of the sidebar" },
        keywords: {
          de: "seitenleiste leiste symbole icons werkzeuge ausblenden einblenden vorlagen medien lernen tags graph papierkorb einstellungen tastenkürzel aufgeräumt",
          en: "sidebar toolbar symbols icons tools hide show templates media study tags graph trash settings keyboard shortcuts tidy",
        },
        anchor: "sidebar-tools",
      },
      {
        title: { de: "Funktionen", en: "Features" },
        keywords: {
          de: "funktionen module ausblenden einblenden aufgeräumt übersichtlich lernkarten whiteboards notizbücher journal dashboards workflows draw.io ki ansichten board kalender zeitleiste galerie diagramm formulare besprechungen",
          en: "features modules hide show clean tidy flashcards whiteboards notebooks journal dashboards workflows draw.io ai views board calendar timeline gallery chart forms meetings",
        },
        anchor: "modules",
        level: "normal",
      },
      {
        title: { de: "Seitensymbol", en: "Page icon" },
        keywords: { de: "symbol icon emoji titel neben über klein groß cover kopf", en: "icon emoji title next to inline above small large cover header" },
        anchor: "page-icon",
        level: "normal",
      },
      {
        title: { de: "Symbol bei externen Links", en: "Icon on external links" },
        keywords: { de: "link links pfeil extern web adresse url symbol icon", en: "link links arrow external web address url symbol icon" },
        anchor: "external-link-icon",
        level: "normal",
      },
      {
        title: { de: "Menü bei Textauswahl", en: "Menu on text selection" },
        keywords: { de: "textmenü markieren auswahl popup reaktionen formatieren handy tablet", en: "text menu select selection popup reactions formatting phone tablet" },
        anchor: "text-menu",
        level: "normal",
      },
      {
        title: { de: "Seiten in voller Breite anzeigen", en: "Show pages at full width" },
        keywords: { de: "volle breite breit seitenbreite layout einträge standard", en: "full width wide page width layout records default" },
        anchor: "full-width-pages",
        level: "normal",
      },
      {
        title: { de: "Textkommentare", en: "Text comments" },
        keywords: { de: "kommentare rand randspalte seitenrand neben dem text unter dem dokument textstelle karten", en: "comments margin side column next to the text below the document passage cards" },
        anchor: "comment-margin",
        level: "normal",
      },
      {
        title: { de: "Erledigte Aufgaben durchstreichen", en: "Strike through done tasks" },
        keywords: { de: "durchgestrichen durchstreichen erledigt aufgaben häkchen abgehakt blass checkliste", en: "strikethrough strike through done completed tasks tick checked faded checklist" },
        anchor: "strike-done-tasks",
        level: "normal",
      },
      {
        title: { de: "Formatierungsleiste", en: "Formatting toolbar" },
        keywords: { de: "symbolleiste toolbar leiste ausblenden fokusmodus formatieren", en: "toolbar bar hide focus mode formatting" },
        anchor: "formatting-toolbar",
        level: "normal",
      },
      {
        title: { de: "Formatierungsleiste anpassen", en: "Customize formatting toolbar" },
        keywords: { de: "symbolleiste toolbar leiste schaltflächen knöpfe reihenfolge sortieren gruppen trennlinie ausblenden anpassen blöcke tabelle code formel vorschau zurücksetzen", en: "toolbar bar buttons order reorder sort groups divider separator hide customise customize blocks table code formula preview reset" },
        anchor: "toolbar-layout",
        level: "expert",
      },
      {
        title: { de: "„>“ erzeugt", en: "“>” creates" },
        keywords: { de: "zitat aufklappbarer block toggle markdown kürzel tippen größer-zeichen", en: "quote blockquote toggle markdown shortcut typing greater-than" },
        anchor: "quote-shortcut",
        level: "expert",
      },
      {
        title: { de: "Wischen vom linken Rand", en: "Swipe from the left edge" },
        keywords: { de: "wischen rand geste zurück seitenleiste navigation iphone ipad android app", en: "swipe edge gesture back sidebar navigation iphone ipad android app" },
        anchor: "edge-swipe",
        level: "normal",
      },
      {
        title: { de: "Verwandte Seiten und Rückverweise anzeigen", en: "Show related pages and backlinks" },
        keywords: { de: "verlinkt von verknüpft erwähnungen backlinks", en: "linked from mentions backlinks related" },
        anchor: "discovery",
        level: "normal",
      },
      { title: { de: "Griffe immer anzeigen", en: "Always show block handles" }, keywords: { de: "blockgriff griff ziehen editor blöcke", en: "block handle drag editor blocks grip" }, anchor: "block-handles", level: "normal" },
      { title: { de: "Zeilennummern standardmäßig anzeigen", en: "Show line numbers by default" }, keywords: { de: "code codeblock editor", en: "code block editor" }, anchor: "line-numbers", level: "normal" },
      { title: { de: "draw.io-Design", en: "draw.io theme" }, keywords: { de: "drawio diagramm hell dunkel", en: "drawio diagram light dark" }, anchor: "drawio-theme", level: "normal" },
      { title: { de: "draw.io-Oberfläche", en: "draw.io interface" }, keywords: { de: "drawio diagramm kennedy minimal sketch skizze", en: "drawio diagram kennedy minimal sketch" }, anchor: "drawio-ui", level: "expert" },
      { title: { de: "Tastenkürzel", en: "Keyboard shortcuts" }, anchor: "keyboard-shortcuts", level: "normal" },
      { title: { de: "Einführung ansehen", en: "Show introduction" }, anchor: "introduction" },
      {
        title: { de: "Neuigkeiten nach Updates", en: "What’s new after updates" },
        keywords: { de: "neu update version änderungen versionshinweise breaking changes stumm aus", en: "new update version changes release notes changelog breaking changes mute off" },
        anchor: "update-notes",
        level: "normal",
      },
      { title: { de: "Was ist neu", en: "What’s new" }, keywords: { de: "neuigkeiten versionshinweise", en: "release notes changelog" }, anchor: "whats-new" },
    ],
  },
  {
    id: "notifications",
    area: "settings",
    level: "beginner",
    group: "personal",
    icon: "BellSimple",
    title: { de: "Benachrichtigungen", en: "Notifications" },
    description: { de: "Was dich im Posteingang, per Push, per E-Mail und in Chat-Apps erreicht.", en: "What reaches you in the inbox, as push, by e-mail and in chat apps." },
    keywords: {
      de: "posteingang push e-mail erwähnungen kommentare wöchentliche zusammenfassung digest chat-apps messenger telegram gotify ntfy matrix",
      en: "inbox push email mentions comments weekly digest chat apps messenger telegram gotify ntfy matrix",
    },
    entries: [
      { title: { de: "Benachrichtigungsarten", en: "Notification kinds" }, keywords: { de: "posteingang push e-mail erwähnungen kommentare", en: "inbox push email mentions comments" }, anchor: "kinds" },
      {
        title: { de: "Ton bei neuen Benachrichtigungen", en: "Sound for new notifications" },
        keywords: { de: "ton klang sound signalton geräusch hinweiston audio lautlos stumm sanft klar glocke anhören", en: "sound tone chime audio beep silent mute soft clear bell preview listen" },
        anchor: "notification-sound",
      },
      {
        title: { de: "Chat-Apps", en: "Chat apps" },
        keywords: { de: "messenger telegram gotify ntfy matrix bot testnachricht", en: "messenger telegram gotify ntfy matrix bot test message" },
        anchor: "messengers",
        level: "normal",
      },
      { title: { de: "Wöchentliche Zusammenfassung", en: "Weekly digest" }, anchor: "weekly-digest" },
      { title: { de: "Push-Benachrichtigungen", en: "Push notifications" }, keywords: { de: "desktop-app mitteilungen", en: "desktop app notifications" }, anchor: "push" },
      { title: { de: "Testbenachrichtigung", en: "Test notification" }, keywords: { de: "test push relay app gerät zustellung", en: "test push relay app device delivery" }, anchor: "push-test", level: "normal" },
    ],
  },
  {
    id: "ai",
    area: "settings",
    level: "normal",
    group: "personal",
    icon: "Sparkle",
    title: { de: "KI", en: "AI" },
    description: { de: "Deine KI-Funktionen, ein eigener Anbieter und worauf die KI zugreifen darf.", en: "Your AI features, an own provider and what the AI may access." },
    keywords: { de: "ki künstliche intelligenz anbieter ollama openai schlüssel zugriff", en: "ai artificial intelligence provider ollama openai key access" },
  },
  {
    id: "devices",
    area: "settings",
    level: "beginner",
    group: "personal",
    icon: "DeviceMobile",
    title: { de: "Offline & Geräte", en: "Offline & devices" },
    description: { de: "Inhalte auf diesem Gerät für die Nutzung ohne Verbindung.", en: "Content on this device for use without a connection." },
    keywords: { de: "offline synchronisierung gerät kopie cache", en: "offline sync device copy cache" },
    entries: [
      { title: { de: "Offline-Nutzung", en: "Offline use" }, anchor: "offline", level: "normal" },
      { title: { de: "Apps für iPhone, iPad, Android und Computer", en: "Apps for iPhone, iPad, Android and computers" }, keywords: { de: "app herunterladen app store apk android iphone ipad desktop", en: "app download app store apk android iphone ipad desktop" }, anchor: "apps" },
    ],
  },
  // ------------------------------------------------------------- connections
  {
    id: "api",
    area: "settings",
    level: "expert",
    group: "connections",
    icon: "PlugsConnected",
    title: { de: "API & KI-Assistenten", en: "API & AI assistants" },
    description: { de: "Persönliche API-Tokens und KI-Assistenten über MCP.", en: "Personal API tokens and AI assistants over MCP." },
    keywords: { de: "api token schlüssel mcp claude chatgpt cursor n8n home assistant browser-erweiterung", en: "api token key mcp claude chatgpt cursor n8n home assistant browser extension" },
    entries: [
      { title: { de: "Persönliche API-Tokens", en: "Personal API tokens" }, anchor: "tokens" },
      { title: { de: "KI-Assistenten (MCP)", en: "AI assistants (MCP)" }, anchor: "mcp" },
    ],
  },
  {
    id: "webhooks",
    area: "settings",
    level: "expert",
    group: "connections",
    icon: "WebhooksLogo",
    title: { de: "Webhooks", en: "Webhooks" },
    description: { de: "Ereignisse des Arbeitsbereichs an n8n, Slack, Matrix, Teams oder Discord.", en: "The workspace's events to n8n, Slack, Matrix, Teams or Discord." },
    keywords: { de: "webhook n8n home assistant slack matrix teams discord automationen ereignisse chat", en: "webhook n8n home assistant slack matrix teams discord automations events chat" },
    entries: [{ title: { de: "Webhook anlegen", en: "Create webhook" }, anchor: "new" }],
  },
  {
    id: "connections",
    area: "settings",
    level: "normal",
    group: "connections",
    icon: "CalendarBlank",
    title: { de: "Kalender & Issues", en: "Calendars & issues" },
    description: { de: "Google- und Microsoft-Kalender, Apple Kalender, Issues aus GitHub, GitLab und Forgejo/Gitea.", en: "Google and Microsoft calendars, Apple Calendar, GitHub, GitLab and Forgejo/Gitea issues." },
    keywords: { de: "kalender google outlook microsoft github gitlab forgejo gitea codeberg issues synchronisierung", en: "calendar google outlook microsoft github gitlab forgejo gitea codeberg issues sync" },
    entries: [
      { title: { de: "Kalender verbinden", en: "Connect calendar" }, anchor: "calendar" },
      { title: { de: "Kalender auf iPhone, iPad und Mac", en: "Calendars on iPhone, iPad and Mac" }, keywords: { de: "caldav apple kalender profil konfigurationsprofil mobileconfig", en: "caldav apple calendar profile configuration profile mobileconfig" }, anchor: "caldav-profile" },
      { title: { de: "GitHub, GitLab oder Forgejo verbinden", en: "Connect GitHub, GitLab or Forgejo" }, keywords: { de: "forgejo gitea codeberg", en: "forgejo gitea codeberg" }, anchor: "issues" },
    ],
  },
  {
    id: "clipper",
    area: "settings",
    level: "beginner",
    group: "connections",
    icon: "BookmarkSimple",
    title: { de: "Web-Clipper", en: "Web clipper" },
    description: { de: "Webseiten speichern, Lesezeichen importieren, Schnell erfassen.", en: "Save web pages, import bookmarks, quick capture." },
    keywords: { de: "clipper lesezeichen bookmarklet browser erweiterung erfassen", en: "clipper bookmarks bookmarklet browser extension capture" },
    entries: [
      { title: { de: "Erfassen", en: "Capture" }, keywords: { de: "schnell erfassen datenbank eingang", en: "quick capture database inbox" }, anchor: "capture" },
      { title: { de: "Browser-Lesezeichen importieren", en: "Import browser bookmarks" }, anchor: "bookmarks", level: "normal" },
    ],
  },
  // --------------------------------------------------------------- workspace
  {
    id: "workspace",
    area: "settings",
    level: "beginner",
    group: "workspace",
    icon: "SlidersHorizontal",
    title: { de: "Allgemein", en: "General" },
    description: { de: "Name und Symbol, Bibliothek, E-Mail-Eingang, Verlassen und Löschen.", en: "Name and icon, library, inbound e-mail, leaving and deleting." },
    keywords: {
      de: "arbeitsbereich name symbol icon emoji bild bibliothek handbuch e-mail-eingang webhook imap verlassen löschen gefahrenzone",
      en: "workspace name icon emoji image library handbook inbound email webhook imap leave delete danger zone",
    },
    entries: [
      { title: { de: "Name & Symbol des Arbeitsbereichs", en: "Workspace name & icon" }, anchor: "identity" },
      {
        title: { de: "Arbeitsbereich als Bibliothek", en: "Workspace as library" },
        keywords: {
          de: "bibliothek regale bücher handbuch wissensbasis wiki ausblenden seitenleiste meine aufgaben journal lernen graph",
          en: "library shelves books handbook knowledge base wiki hide sidebar my tasks journal study graph",
        },
        anchor: "library-mode",
      },
      { title: { de: "E-Mail-Eingang", en: "Inbound e-mail" }, keywords: { de: "weiterleiten mailgun postmark", en: "forward mailgun postmark" }, anchor: "inbound-mail", level: "expert" },
      { title: { de: "Arbeitsbereich verlassen", en: "Leave workspace" }, anchor: "danger" },
      { title: { de: "Arbeitsbereich löschen", en: "Delete workspace" }, anchor: "danger" },
    ],
  },
  {
    id: "look",
    area: "settings",
    level: "normal",
    group: "workspace",
    icon: "PaintBrush",
    title: { de: "Erscheinungsbild", en: "Appearance" },
    description: { de: "Akzentfarbe, Hintergrund und Schriften für alle im Arbeitsbereich.", en: "Accent colour, background and typefaces for everyone in the workspace." },
    keywords: {
      de: "erscheinungsbild design aussehen farbe akzentfarbe hintergrund schrift schriftart font eigene schrift hochladen branding corporate design",
      en: "appearance design look colour color accent background font typeface own font upload branding corporate design",
    },
    entries: [
      { title: { de: "Akzentfarbe", en: "Accent colour" }, keywords: { de: "farbe", en: "color" }, anchor: "look-colours" },
      { title: { de: "Schriften", en: "Typefaces" }, keywords: { de: "schriftart font", en: "font" }, anchor: "look-fonts" },
      { title: { de: "Eigene Schriften", en: "Own fonts" }, keywords: { de: "hochladen woff2 ttf otf", en: "upload woff2 ttf otf" }, anchor: "look-uploads" },
    ],
  },
  {
    id: "printpresets",
    area: "settings",
    level: "normal",
    group: "workspace",
    icon: "Printer",
    title: { de: "Druckvorlagen", en: "Print presets" },
    description: { de: "Einstellungen für Drucken und PDF, die alle im Arbeitsbereich wählen können.", en: "Print and PDF settings that everyone in the workspace can pick." },
    keywords: {
      de: "drucken pdf druckvorlage vorlage seitenzahlen titelbild tags eigenschaften inhaltsverzeichnis titelseite schrift links papier a4 letter",
      en: "print pdf print preset preset page numbers cover tags properties table of contents title page font links paper a4 letter",
    },
    entries: [{ title: { de: "Standardvorlage", en: "Default preset" }, anchor: "workspace-print-presets" }],
  },
  {
    id: "print",
    area: "settings",
    level: "normal",
    group: "personal",
    icon: "Printer",
    title: { de: "Drucken / PDF", en: "Print / PDF" },
    description: { de: "Deine Druckvorlagen: was beim Drucken und im PDF erscheint und wie es aussieht.", en: "Your print presets: what appears in print and PDF and how it looks." },
    keywords: {
      de: "drucken pdf druckvorlage vorlage seitenzahlen titelbild icon tags eigenschaften schrift links papier",
      en: "print pdf print preset preset page numbers cover icon tags properties font links paper",
    },
    entries: [{ title: { de: "Meine Druckvorlagen", en: "My print presets" }, anchor: "print-presets" }],
  },
  {
    id: "autolinks",
    area: "settings",
    level: "expert",
    group: "workspace",
    icon: "LinkSimple",
    title: { de: "Automatische Links", en: "Automatic links" },
    description: { de: "Muster wie ABC-123 beim Tippen und Einfügen zu Links machen.", en: "Turn patterns like ABC-123 into links while typing and pasting." },
    keywords: {
      de: "automatische links autolink verlinken regex regulärer ausdruck muster vorlage ticket jira github issue linkify",
      en: "automatic links autolink linkify regex regular expression pattern template ticket jira github issue",
    },
    entries: [
      { title: { de: "Regeln für automatische Links", en: "Automatic link rules" }, anchor: "link-rules" },
      { title: { de: "Regeln ausprobieren", en: "Try the rules" }, anchor: "link-rules-test" },
    ],
  },
  {
    id: "members",
    area: "settings",
    level: "beginner",
    group: "workspace",
    icon: "UsersThree",
    title: { de: "Mitglieder", en: "Members" },
    description: { de: "Wer zum Arbeitsbereich gehört, mit welcher Rolle, und wer eingeladen ist.", en: "Who belongs to the workspace, in which role, and who is invited." },
    keywords: { de: "mitglieder einladen einladung rolle gast eigentümer entfernen", en: "members invite invitation role guest owner remove" },
    entries: [
      { title: { de: "Mitglied einladen", en: "Invite member" }, anchor: "members" },
      { title: { de: "Ausstehende Einladungen", en: "Pending invitations" }, keywords: { de: "einladungslink", en: "invitation link" }, anchor: "invitations" },
    ],
  },
  {
    id: "groups",
    area: "settings",
    level: "normal",
    group: "workspace",
    icon: "ShieldCheck",
    title: { de: "Gruppen & Rechte", en: "Groups & permissions" },
    description: { de: "Gruppen bilden, SSO-Gruppen zuordnen und Zugriff auf Bereiche geben.", en: "Form groups, map SSO groups and give access to spaces." },
    keywords: { de: "gruppen rechte berechtigungen sso zugriff sichtbarkeit", en: "groups permissions sso access visibility" },
    entries: [
      { title: { de: "SSO-Gruppen zuordnen", en: "Map SSO groups" }, anchor: "sso", level: "expert" },
      { title: { de: "Zugriff auf Bereiche", en: "Access to spaces" }, keywords: { de: "privat sichtbarkeit", en: "private visibility" }, anchor: "access" },
    ],
  },
  {
    id: "spaces",
    area: "settings",
    level: "beginner",
    group: "workspace",
    icon: "FolderSimple",
    title: { de: "Bereiche", en: "Spaces" },
    description: { de: "Bereiche anlegen, umbenennen, freigeben und ihr Aussehen festlegen.", en: "Create, rename and share spaces and set their appearance." },
    keywords: { de: "bereiche teamspace privat freigeben farbe", en: "spaces teamspace private share colour" },
  },
  {
    id: "tags",
    area: "settings",
    level: "normal",
    group: "workspace",
    icon: "Tag",
    title: { de: "Tags & Eigenschaften", en: "Tags & properties" },
    description: { de: "Tags und Seiteneigenschaften des Arbeitsbereichs: umbenennen, einfärben, zusammenführen.", en: "The workspace's tags and page properties: rename, colour, merge." },
    keywords: { de: "tags schlagwörter etiketten eigenschaften felder metadaten farbe zusammenführen", en: "tags labels properties fields metadata colour merge" },
    entries: [
      { title: { de: "Tags", en: "Tags" }, anchor: "tags" },
      { title: { de: "Seiteneigenschaften", en: "Page properties" }, anchor: "properties" },
    ],
  },
  {
    id: "extensions",
    area: "settings",
    level: "expert",
    group: "workspace",
    icon: "PuzzlePiece",
    title: { de: "Block-Erweiterungen", en: "Block extensions" },
    description: { de: "Eigene Blocktypen von freigegebenen Webadressen.", en: "Own block types from allowed web addresses." },
    keywords: { de: "erweiterungen plugins blöcke", en: "extensions plugins blocks" },
  },
  {
    id: "data",
    area: "settings",
    level: "beginner",
    group: "workspace",
    icon: "Database",
    title: { de: "Import & Export", en: "Import & export" },
    description: { de: "Importieren, exportieren, Archive wiederherstellen und der Papierkorb.", en: "Import, export, restore archives and the trash." },
    keywords: { de: "export import zip json markdown pdf epub notion appflowy jira trello affine confluence evernote google docs goodnotes notizbuch obsidian backup sicherung wiederherstellen papierkorb aufbewahrung versionen", en: "export import zip json markdown pdf epub notion appflowy jira trello affine confluence evernote google docs goodnotes notebook obsidian backup restore trash retention versions" },
    entries: [
      { title: { de: "Aus Notion, AppFlowy, Confluence, Evernote oder Obsidian importieren", en: "Import from Notion, AppFlowy, Confluence, Evernote or Obsidian" }, keywords: { de: "google docs markdown zip", en: "google docs markdown zip" }, anchor: "import" },
      { title: { de: "Direkt aus Notion importieren (Integrations-Token)", en: "Import straight from Notion (integration token)" }, keywords: { de: "notion api token integration verbindung importbericht", en: "notion api token integration connection import report" }, anchor: "import-tools" },
      { title: { de: "Aus GoodNotes importieren", en: "Import from GoodNotes" }, keywords: { de: "pdf notizbuch handschrift ipad", en: "pdf notebook handwriting ipad" }, anchor: "import" },
      { title: { de: "Aus Jira oder Trello importieren", en: "Import from Jira or Trello" }, anchor: "import" },
      { title: { de: "Vorlage aus Datei importieren", en: "Import template from file" }, keywords: { de: "marketplace flowplan-template", en: "marketplace flowplan-template" }, anchor: "marketplace-file", level: "normal" },
      { title: { de: "Arbeitsbereich exportieren", en: "Export workspace" }, anchor: "export" },
      { title: { de: "Bereich als Markdown exportieren", en: "Export space as Markdown" }, keywords: { de: "pdf epub e-book", en: "pdf epub e-book" }, anchor: "export" },
      { title: { de: "Flowplan-Archiv wiederherstellen", en: "Restore a Flowplan archive" }, keywords: { de: "backup importieren sicherung", en: "import backup" }, anchor: "backups", level: "normal" },
      { title: { de: "Papierkorb & Aufbewahrung", en: "Trash & retention" }, anchor: "trash" },
    ],
  },
  {
    id: "meetings",
    area: "settings",
    level: "normal",
    group: "workspace",
    icon: "Microphone",
    title: { de: "Besprechungen", en: "Meetings" },
    description: { de: "Anweisungen für Zusammenfassungen, Aufbewahrung des Audios und Einwilligung.", en: "Instructions for summaries, keeping the audio and consent." },
    keywords: {
      de: "besprechung meeting protokoll aufnahme transkript zusammenfassung audio aufbewahren löschen einwilligung zustimmung dsgvo",
      en: "meeting minutes recording transcript summary audio retention delete consent gdpr",
    },
    entries: [
      { title: { de: "Einwilligung erforderlich", en: "Consent required" }, anchor: "consent" },
      { title: { de: "Audio aufbewahren", en: "Keep audio" }, anchor: "audio" },
    ],
  },
  {
    id: "time",
    area: "settings",
    level: "normal",
    group: "workspace",
    icon: "Timer",
    title: { de: "Zeiten", en: "Time" },
    description: { de: "Erfasste Zeiten aller Datenbanken auswerten, abrechnen und exportieren.", en: "Report, bill and export the time tracked in all databases." },
    keywords: { de: "zeiterfassung stunden abrechnung bericht", en: "time tracking hours billing report" },
  },
  // -------------------------------------------------------------------- help
  {
    id: "about",
    area: "settings",
    level: "beginner",
    group: "help",
    icon: "Info",
    title: { de: "Über Flowplan", en: "About Flowplan" },
    description: { de: "Version, Lizenz und Quellcode, Links zu Hilfe und Community.", en: "Version, licence and source code, links to help and community." },
    keywords: {
      de: "über info version build commit beta release lizenz agpl quellcode source github website dokumentation hilfe discord community fehler melden bug unterstützen sponsor spenden",
      en: "about info version build commit beta release licence license agpl source code github website documentation help discord community report bug support sponsor donate",
    },
    entries: [
      { title: { de: "Version", en: "Version" }, keywords: { de: "build commit beta release update", en: "build commit beta release update" }, anchor: "version" },
      { title: { de: "Lizenz & Quellcode", en: "Licence & source code" }, keywords: { de: "lizenz agpl quellcode source github", en: "licence license agpl source code github" }, anchor: "licence" },
      { title: { de: "Für Bug-Report kopieren", en: "Copy for bug report" }, keywords: { de: "bug report fehlerbericht installation details diagnose kopieren zwischenablage gerät browser", en: "bug report installation details diagnostics copy clipboard device browser" }, anchor: "bug-report" },
      { title: { de: "Fehler melden", en: "Report a bug" }, keywords: { de: "bug issue github", en: "bug issue github" }, anchor: "bug" },
      { title: { de: "Flowplan unterstützen", en: "Support Flowplan" }, keywords: { de: "unterstützen sponsor spenden github sponsors", en: "support sponsor donate github sponsors" }, anchor: "support" },
    ],
  },
  // ------------------------------------------------------------------ admin
  {
    id: "users",
    area: "admin",
    group: "people",
    icon: "Users",
    title: { de: "Benutzer", en: "Users" },
    description: { de: "Konten der Instanz: Status, Grenzen, Sitzungen, Sperren und Löschen.", en: "Accounts of the instance: state, limits, sessions, blocking and deleting." },
    keywords: { de: "benutzer konten personen sperren deaktivieren aktivieren inaktiv sitzungen admin grenzen speicher passwort zurücksetzen löschen", en: "users accounts people block disable enable inactive sessions admin limits storage reset password delete" },
    entries: [
      { title: { de: "Konto deaktivieren", en: "Disable account" }, keywords: { de: "sperren", en: "block lock" } },
      { title: { de: "Grenzen einer Person", en: "Limits of a person" }, keywords: { de: "speicher upload", en: "storage upload" } },
      { title: { de: "Link zum Zurücksetzen des Passworts", en: "Password reset link" } },
      { title: { de: "Konten zusammenführen", en: "Merge accounts" }, keywords: { de: "doppelt duplikat sso verbinden", en: "duplicate sso link merge" } },
      { title: { de: "Einstellungsstufe einer Person", en: "Settings level of a person" }, keywords: { de: "stufe einsteiger normal experte", en: "level beginner normal expert" } },
      { title: { de: "Unbestätigte Konten zur Löschung vormerken", en: "Mark unconfirmed accounts for deletion" }, keywords: { de: "e-mail unbestätigt spam löschen", en: "e-mail unconfirmed spam delete" } },
    ],
  },
  {
    id: "signin",
    area: "admin",
    group: "people",
    icon: "Key",
    title: { de: "Anmeldung & SSO", en: "Sign-in & SSO" },
    description: { de: "Registrierung, Zwei-Faktor-Pflicht, Sitzungsdauer, SSO mit Gruppen, SCIM und LDAP.", en: "Sign-up, required two-factor, session lifetime, SSO with groups, SCIM and LDAP." },
    keywords: { de: "registrierung anmeldung zwei-faktor 2fa sso oidc keycloak scim ldap verzeichnis gruppen zuordnen inaktive konten arbeitsbereiche anlegen", en: "sign-up registration sign-in two-factor 2fa sso oidc keycloak scim ldap directory groups mapping inactive accounts create workspaces" },
    entries: [
      { title: { de: "Registrierung mit E-Mail und Passwort", en: "Sign-up with email and password" }, anchor: "registration" },
      { title: { de: "Inaktive Konten sperren", en: "Block inactive accounts" }, anchor: "registration" },
      { title: { de: "Unbestätigte Konten automatisch vormerken", en: "Automatically mark unconfirmed accounts" }, keywords: { de: "e-mail unbestätigt spam löschen", en: "e-mail unconfirmed spam delete" }, anchor: "registration" },
      { title: { de: "Zwei-Faktor-Anmeldung verlangen", en: "Require two-factor sign-in" }, keywords: { de: "2fa", en: "2fa" }, anchor: "two-factor" },
      { title: { de: "Notfallzugriff erlauben", en: "Allow emergency access" }, keywords: { de: "vertrauensperson notfall", en: "trusted contact emergency" }, anchor: "emergency" },
      { title: { de: "Nachricht bei Inaktivität erlauben", en: "Allow inactivity messages" }, keywords: { de: "totmannschalter inaktivität", en: "dead man's switch inactivity" }, anchor: "deadman" },
      { title: { de: "Sitzungen", en: "Sessions" }, keywords: { de: "sitzungsdauer angemeldet bleiben abgemeldet timeout apps gerät merken", en: "session lifetime stay signed in signed out timeout apps remember device" }, anchor: "sessions" },
      { title: { de: "SSO-Gruppen zentral zuordnen", en: "Map SSO groups centrally" }, anchor: "sso-groups" },
      { title: { de: "SCIM-Token", en: "SCIM tokens" }, anchor: "scim" },
      { title: { de: "LDAP-Verzeichnis", en: "LDAP directory" }, anchor: "ldap" },
      { title: { de: "Kontakte aus LDAP", en: "Contacts from LDAP" }, keywords: { de: "kontakte adressbuch ou organisationseinheit", en: "contacts address book ou organizational unit" }, anchor: "ldap-contacts" },
    ],
  },
  {
    id: "workspaces",
    area: "admin",
    group: "people",
    icon: "Stack",
    title: { de: "Arbeitsbereiche", en: "Workspaces" },
    description: { de: "Alle Arbeitsbereiche mit Belegung und eigenem Speicherkontingent.", en: "All workspaces with usage and own storage quota." },
    keywords: { de: "arbeitsbereiche kontingent speicher belegung voll", en: "workspaces quota storage usage full" },
  },
  {
    id: "storage",
    area: "admin",
    group: "data",
    icon: "HardDrives",
    title: { de: "Speicher & Sicherung", en: "Storage & backup" },
    description: { de: "Belegung, S3, Litestream, geplante Sicherung und die Sicherung der gesamten Instanz.", en: "Usage, S3, Litestream, scheduled backup and the backup of the whole instance." },
    keywords: { de: "speicher s3 bucket litestream sicherung backup stündlich aufbewahren wiederherstellen restore herunterladen sftp", en: "storage s3 bucket litestream backup hourly keep restore download sftp" },
    entries: [
      { title: { de: "Geplante Sicherung", en: "Scheduled backup" }, keywords: { de: "täglich stündlich jetzt sichern", en: "daily hourly back up now" }, anchor: "backup" },
      { title: { de: "SFTP-Ziel", en: "SFTP target" }, keywords: { de: "sftp ssh server hostschlüssel nas smb nfs", en: "sftp ssh server host key nas smb nfs" }, anchor: "sftp-backup" },
      { title: { de: "Sicherung der gesamten Instanz", en: "Backup of the whole instance" }, anchor: "instance-backup" },
      { title: { de: "Aus Sicherung wiederherstellen", en: "Restore from backup" }, anchor: "restore" },
    ],
  },
  {
    id: "limits",
    area: "admin",
    group: "data",
    icon: "Gauge",
    title: { de: "Grenzen & Aufbewahrung", en: "Limits & retention" },
    description: { de: "Standard-Kontingente, größte Datei und wie lange Versionen bleiben.", en: "Default quotas, largest file and how long versions are kept." },
    keywords: { de: "grenzen kontingent speicher upload datei größe versionen aufbewahrung standard workflows gruppe", en: "limits quota storage upload file size versions retention default workflows group" },
    entries: [
      { title: { de: "Größte Datei beim Hochladen", en: "Largest upload" }, anchor: "storage-limits" },
      { title: { de: "Speicher je Arbeitsbereich", en: "Storage per workspace" }, anchor: "storage-limits" },
      { title: { de: "Link für mehr Speicher oder KI", en: "Link for more storage or AI" }, anchor: "storage-limits" },
      { title: { de: "Grenzen pro Gruppe", en: "Limits per group" }, keywords: { de: "gruppe scim ldap sso verzeichnis speicher arbeitsbereiche upload", en: "group scim ldap sso directory storage workspaces upload" }, anchor: "group-limits" },
      { title: { de: "Export / Import", en: "Export / import" }, keywords: { de: "tarife pläne datei json import export abrechnung ki kontingent modell", en: "plans file json import export billing ai quota model" }, anchor: "limits-file" },
      { title: { de: "Versionen aufbewahren", en: "Keep versions" }, anchor: "retention" },
      { title: { de: "Workflows", en: "Workflows" }, keywords: { de: "automation läufe ablauf grenzen warteschlange", en: "automation runs flow limits queue" }, anchor: "workflows" },
    ],
  },
  {
    id: "export",
    area: "admin",
    group: "data",
    icon: "FileArrowDown",
    title: { de: "Markdown- & Git-Export", en: "Markdown & Git export" },
    description: { de: "Eine lesbare Kopie gewählter Seiten außerhalb von Flowplan.", en: "A readable copy of chosen pages outside Flowplan." },
    keywords: { de: "markdown export git repository forgejo gitea github", en: "markdown export git repository forgejo gitea github" },
  },
  {
    id: "mail",
    area: "admin",
    group: "services",
    icon: "EnvelopeSimple",
    title: { de: "E-Mail", en: "E-mail" },
    description: { de: "Versand über SMTP, die Warteschlange und eine Test-E-Mail.", en: "Sending over SMTP, the queue and a test e-mail." },
    keywords: { de: "e-mail smtp versand test warteschlange", en: "email smtp sending test queue" },
    entries: [{ title: { de: "Test-E-Mail senden", en: "Send test email" }, anchor: "test" }],
  },
  {
    id: "push",
    area: "admin",
    group: "services",
    icon: "BellRinging",
    title: { de: "Push-Benachrichtigungen", en: "Push notifications" },
    description: { de: "Push-Relay für die Apps, Erreichbarkeit, Expo, Web Push und Zustellungen.", en: "Push relay for the apps, reachability, Expo, Web Push and deliveries." },
    keywords: {
      de: "push relay push-relay push.flowplan.org apps iphone android erreichbarkeit healthz well-known signaturschlüssel schlüssel wechseln rotieren expo web push vapid zustellung testbenachrichtigung",
      en: "push relay push.flowplan.org apps iphone android reachability healthz well-known signing key rotate expo web push vapid delivery test notification",
    },
    entries: [
      { title: { de: "Push-Relay", en: "Push relay" }, keywords: { de: "erreichbar app_url", en: "reachable app_url" }, anchor: "relay" },
      { title: { de: "Signaturschlüssel wechseln", en: "Rotate the signing key" }, keywords: { de: "rotieren", en: "rotation" }, anchor: "keys" },
      { title: { de: "Zustellungen der letzten 24 Stunden", en: "Deliveries of the last 24 hours" }, anchor: "deliveries" },
      { title: { de: "Expo und Web Push", en: "Expo and Web Push" }, keywords: { de: "vapid mobile_push", en: "vapid mobile_push" }, anchor: "channels" },
    ],
  },
  {
    id: "messengers",
    area: "admin",
    group: "services",
    icon: "ChatCircleDots",
    title: { de: "Chat-Apps", en: "Chat apps" },
    description: { de: "Telegram, Gotify, ntfy und Matrix für Benachrichtigungen: erlaubte Dienste, Server und der Telegram-Bot der Instanz.", en: "Telegram, Gotify, ntfy and Matrix for notifications: allowed services, servers and the instance's Telegram bot." },
    keywords: {
      de: "chat-apps messenger telegram bot gotify ntfy matrix benachrichtigungen server adressen erlauben sperren api relay",
      en: "chat apps messenger telegram bot gotify ntfy matrix notifications server addresses allow block api relay",
    },
    entries: [
      { title: { de: "Erlaubte Dienste", en: "Allowed services" }, anchor: "services" },
      { title: { de: "Telegram-Bot der Instanz", en: "Instance Telegram bot" }, keywords: { de: "bot token api-adresse", en: "bot token api address" }, anchor: "bot" },
      { title: { de: "Server-Adressen", en: "Server addresses" }, keywords: { de: "eigene server einschränken", en: "own servers restrict" }, anchor: "hosts" },
    ],
  },
  {
    id: "ai",
    area: "admin",
    group: "services",
    icon: "Sparkle",
    title: { de: "KI", en: "AI" },
    description: { de: "Anbieter, wer KI nutzen darf und welche Funktionen es gibt.", en: "Provider, who may use AI and which features exist." },
    keywords: { de: "ki anbieter ollama openai funktionen zugriff semantische suche", en: "ai provider ollama openai features access semantic search" },
    entries: [
      {
        title: { de: "Kontingente", en: "Quotas" },
        keywords: { de: "kontingent limit grenze tokens kosten zeitzone woche hinweis workflows", en: "quota limit tokens cost time zone week warning workflows" },
        anchor: "quotas",
      },
      {
        title: { de: "Grenzen je Instanz, Gruppe und Person", en: "Limits per instance, group and person" },
        keywords: { de: "kontingent standard gruppe rolle gäste administratoren ausgenommen ausnahme tag woche monat jahr", en: "quota default group role guests administrators exempt exception day week month year" },
        anchor: "quota-limits",
      },
      {
        title: { de: "KI-Nutzung je Person, Gruppe und Modell", en: "AI usage per person, group and model" },
        keywords: { de: "kontingent verbrauch übrig tokens kosten", en: "quota usage left tokens cost" },
        anchor: "quota-usage",
      },
    ],
  },
  {
    id: "extensions",
    area: "admin",
    group: "services",
    icon: "PuzzlePiece",
    title: { de: "Erweiterungen & Domains", en: "Extensions & domains" },
    description: { de: "Woher Block-Erweiterungen kommen dürfen, eigene Domains für Veröffentlichungen und der Marketplace.", en: "Where block extensions may come from, custom domains for publications and the marketplace." },
    keywords: { de: "erweiterungen plugins blöcke https domains eigene domain veröffentlichen dns marketplace vorlagen", en: "extensions plugins blocks https domains custom domain publish dns marketplace templates" },
    entries: [
      { title: { de: "Block-Erweiterungen von jeder HTTPS-Adresse", en: "Block extensions from any HTTPS address" }, anchor: "plugins" },
      { title: { de: "Eigene Domains für Veröffentlichungen", en: "Custom domains for publications" }, anchor: "domains" },
      { title: { de: "Marketplace", en: "Marketplace" }, keywords: { de: "vorlagen veröffentlichen teilen ausschalten", en: "templates publish share switch off" }, anchor: "marketplace" },
    ],
  },
  {
    id: "threats",
    area: "admin",
    group: "security",
    icon: "ShieldCheck",
    title: { de: "Angriffe & Vorfälle", en: "Threats & incidents" },
    description: { de: "Vorfälle, Anmeldeversuche, Sperren, Sitzungen und offene Zugänge – mit dem, was zu tun ist.", en: "Incidents, sign-in attempts, blocks, sessions and open ways in – with what to do." },
    keywords: {
      de: "sicherheit angriff vorfall brute force passwort raten credential stuffing sperren blockieren ip adresse netz sitzungen abmelden token freigabelinks öffentlich siem log otel opentelemetry prometheus fail2ban crowdsec erkennung",
      en: "security attack incident brute force password guessing credential stuffing block ip address network sessions sign out tokens share links public siem log otel opentelemetry prometheus fail2ban crowdsec detection",
    },
    entries: [
      { title: { de: "Vorfälle", en: "Incidents" }, anchor: "incidents" },
      { title: { de: "Adressen mit Fehlversuchen", en: "Addresses with failures" }, anchor: "addresses" },
      { title: { de: "Sicherheitsereignisse", en: "Security events" }, keywords: { de: "export csv json", en: "export csv json" }, anchor: "events" },
      { title: { de: "Angemeldete Personen", en: "Signed-in people" }, keywords: { de: "sitzungen beenden", en: "end sessions" }, anchor: "sessions" },
      { title: { de: "Offene Zugänge", en: "Open ways in" }, keywords: { de: "api-tokens freigabelinks öffentliche seiten", en: "api tokens share links public pages" }, anchor: "access" },
      { title: { de: "Sperren", en: "Blocks" }, keywords: { de: "ip netz sperren", en: "ip network block" }, anchor: "blocks" },
      { title: { de: "Erkennung & Anbindung", en: "Detection & connection" }, keywords: { de: "regeln opentelemetry prometheus log", en: "rules opentelemetry prometheus log" }, anchor: "setup" },
    ],
  },
  {
    id: "security",
    area: "admin",
    group: "security",
    icon: "LockKey",
    title: { de: "Verschlüsselung", en: "Encryption" },
    description: { de: "Schlüssel für Bucket, Sicherungen und Exporte.", en: "Key for the bucket, backups and exports." },
    keywords: { de: "verschlüsselung schlüssel encryption key", en: "encryption key" },
  },
  {
    id: "audit",
    area: "admin",
    group: "security",
    icon: "ListChecks",
    title: { de: "Aktivitätsprotokoll", en: "Activity log" },
    description: { de: "Die letzten Änderungen mit Person und betroffener Ressource.", en: "The latest changes with person and affected resource." },
    keywords: { de: "protokoll audit änderungen export csv json", en: "log audit changes export csv json" },
    entries: [{ title: { de: "Protokoll exportieren", en: "Export the log" }, anchor: "export" }],
  },
  {
    id: "monitoring",
    area: "admin",
    group: "operations",
    icon: "Pulse",
    title: { de: "Überwachung", en: "Monitoring" },
    description: { de: "Zustand, Nutzung und Ereignisse der Instanz – live.", en: "Health, usage and events of the instance – live." },
    keywords: {
      de: "betrieb metriken statistik dashboard live anfragen fehler 5xx antwortzeit latenz aktive personen anmeldungen warnungen alarm webhook hintergrunddienste worker zustellung warteschlangen ki tokens speicher datenträger",
      en: "operations metrics statistics dashboard live requests errors 5xx response time latency active people sign-ins alerts alarm webhook background workers delivery queues ai tokens storage disk",
    },
    entries: [
      { title: { de: "Zustand der Dienste", en: "Health of the services" }, anchor: "health" },
      { title: { de: "Anfragen & Fehler", en: "Requests & errors" }, anchor: "traffic" },
      { title: { de: "Fehler im Detail", en: "Errors in detail" }, keywords: { de: "fehler-id stack 500 ausnahme github issue melden signatur wöchentliche fehlerübersicht stummschalten", en: "error id request id stack 500 exception github issue report signature weekly error summary digest mute" }, anchor: "errors" },
      { title: { de: "Fehler bei Fremddiensten", en: "Errors from external services" }, keywords: { de: "502 503 504 ki-anbieter einbettung bildsuche kalender extern", en: "502 503 504 upstream ai provider embed image search calendar external" }, anchor: "upstream" },
      { title: { de: "Neustarts", en: "Restarts" }, keywords: { de: "absturz oom speicher neustart log protokoll", en: "crash oom memory restart log" }, anchor: "restarts" },
      { title: { de: "Aktive Personen", en: "Active people" }, anchor: "people" },
      { title: { de: "Anmeldungen", en: "Sign-ins" }, anchor: "signins" },
      { title: { de: "Abgewiesene Anfragen", en: "Refused requests" }, anchor: "refused" },
      { title: { de: "KI-Nutzung", en: "AI usage" }, keywords: { de: "tokens", en: "tokens" }, anchor: "ai" },
      { title: { de: "Warteschlangen", en: "Queues" }, anchor: "queues" },
      { title: { de: "Ereignisse", en: "Events" }, anchor: "events" },
      { title: { de: "Hintergrunddienste", en: "Background workers" }, anchor: "workers" },
      { title: { de: "Warnungen per Webhook", en: "Alerts by webhook" }, anchor: "alerts" },
      { title: { de: "Nutzungsstatistik erfassen", en: "Collect usage statistics" }, anchor: "metrics" },
    ],
  },
  {
    id: "maintenance",
    area: "admin",
    group: "operations",
    icon: "Megaphone",
    title: { de: "Wartung & Hinweise", en: "Maintenance & notices" },
    description: { de: "Ein Hinweis für alle, angekündigte Wartungen und Banner, die man einmal wegklickt.", en: "A notice for everyone, announced maintenance and banners people click away once." },
    keywords: { de: "wartung hinweis banner ankündigung ausfall update", en: "maintenance notice banner announcement downtime update" },
    entries: [
      { title: { de: "Hinweis für alle Personen", en: "Notice for everyone" }, anchor: "notice" },
      { title: { de: "Wartungshinweis", en: "Maintenance notice" }, anchor: "maintenance-window" },
      { title: { de: "Banner zum Wegklicken", en: "Banners to click away" }, keywords: { de: "werbung app discord community neuigkeit einmalig schließen", en: "promotion app discord community news once close" }, anchor: "banners" },
    ],
  },
  {
    id: "general",
    area: "admin",
    group: "operations",
    icon: "SlidersHorizontal",
    title: { de: "Name & Version", en: "Name & version" },
    description: { de: "Name, öffentliche Demo, Version und Aktualisierung der Instanz.", en: "Name, public demo, version and update of the instance." },
    keywords: { de: "instanz name demo version update aktualisieren commit bug-report diagnose admin-gruppe formatierungsleiste startinhalt onboarding", en: "instance name demo version update commit bug report diagnostics admin group formatting toolbar starter content onboarding" },
    entries: [
      { title: { de: "Name der Instanz", en: "Instance name" }, anchor: "instance" },
      { title: { de: "Öffentliche Demo", en: "Public demo" }, anchor: "instance" },
      {
        title: { de: "Neuigkeiten nach Updates für neue Konten", en: "What’s new after updates for new accounts" },
        keywords: { de: "versionshinweise neu update standard", en: "release notes new update default" },
        anchor: "version",
      },
      {
        title: { de: "Einstellungsstufe für neue Konten", en: "Settings level for new accounts" },
        keywords: { de: "stufe einsteiger normal experte standard einstellungen", en: "level beginner normal expert default settings" },
        anchor: "version",
      },
      {
        title: { de: "Standard-Formatierungsleiste", en: "Default formatting toolbar" },
        keywords: { de: "symbolleiste toolbar leiste schaltflächen reihenfolge gruppen trennlinie blöcke standard alle personen", en: "toolbar bar buttons order groups divider blocks default everyone" },
        anchor: "toolbar-layout-default",
      },
      {
        title: { de: "Startinhalt für neue Konten", en: "Starter content for new accounts" },
        keywords: { de: "onboarding vorlage startseiten willkommensseite neue konten bereich kopieren", en: "onboarding template starter pages welcome page new accounts space copy" },
        anchor: "starter",
      },
      {
        title: { de: "Funktionen dieser Instanz", en: "Features of this instance" },
        keywords: {
          de: "funktionen module ausschalten abschalten deaktivieren instanz server alle lernkarten whiteboards notizbücher journal dashboards workflows draw.io ki ansichten formulare besprechungen",
          en: "features modules switch off turn off disable instance server everyone flashcards whiteboards notebooks journal dashboards workflows draw.io ai views forms meetings",
        },
        anchor: "modules-off",
      },
      {
        title: { de: "Funktionen für neue Konten", en: "Features for new accounts" },
        keywords: { de: "funktionen module ausblenden standard neue konten alle konten zuweisen lernkarten whiteboards ki", en: "features modules hide default new accounts apply all accounts flashcards whiteboards ai" },
        anchor: "modules-default",
      },
      {
        title: { de: "Einstellungen exportieren / importieren", en: "Export / import settings" },
        keywords: {
          de: "einstellungen datei json export import sichern übertragen andere instanz versionskontrolle wiederherstellen ki grenzen konfiguration",
          en: "settings file json export import back up transfer move other instance version control restore ai limits configuration",
        },
        anchor: "settings-file",
      },
    ],
  },
];

// The tabs before the landing page, for old links (#settings/integrations).
export const LEGACY_SECTIONS: Record<SettingsArea, Record<string, string>> = {
  settings: {
    account: "account",
    workspace: "workspace",
    spaces: "spaces",
    members: "members",
    groups: "groups",
    data: "data",
    notifications: "notifications",
    ai: "ai",
    integrations: "api",
    time: "time",
  },
  admin: {
    users: "users",
    workspaces: "workspaces",
    operations: "monitoring",
    instance: "general",
    ai: "ai",
    audit: "audit",
  },
};

// Places that moved to another section ("<section>/<anchor>" → the new
// address), for links in old e-mails, bookmarks and other apps.
export const LEGACY_ANCHORS: Record<SettingsArea, Record<string, { section: string; anchor: string | null }>> = {
  settings: {
    // "Deine Grenzen" and "KI-Kontingent" before 0.11.3.
    "account/limits": { section: "usage", anchor: "storage" },
    "ai/quota": { section: "usage", anchor: "ai" },
  },
  admin: {},
};

export type SettingsRoute = { area: SettingsArea; section: string | null; anchor: string | null };

export const findSection = (area: SettingsArea, id: string | null | undefined) =>
  id ? SETTINGS_SECTIONS.find((s) => s.area === area && s.id === id) || null : null;

// One screen, one address space (#532): the personal settings at
// #settings/<section>[/<anchor>], the instance (area "admin", admins only)
// at #settings/instance/<section>[/<anchor>] – "instance" is no section id
// of the personal settings, so both stay unique. #settings/instance alone
// is the start page at its instance overview. The old addresses of the
// separate administration (#admin, #admin/<section>/…) still lead there:
// they come back as `redirected` (the screen replaces the address, no new
// history step). `tail` keeps what follows the anchor (an incident's own
// page, #settings/instance/threats/incident/<id>).
export const INSTANCE_SEGMENT = "instance";
export type ParsedSettingsHash = SettingsRoute & { redirected: boolean; tail?: string };
export function parseSettingsHash(hash: string): ParsedSettingsHash | null {
  const parts = hash.replace(/^#/, "").split("/");
  let area: SettingsArea;
  let rest: string[];
  let redirected = false;
  if (parts[0] === "settings" && parts[1] === INSTANCE_SEGMENT) {
    area = "admin";
    rest = parts.slice(2);
  } else if (parts[0] === "settings") {
    area = "settings";
    rest = parts.slice(1);
  } else if (parts[0] === "admin") {
    area = "admin";
    rest = parts.slice(1);
    redirected = true;
  } else return null;
  const raw = decodeURIComponent(rest[0] || "");
  const anchor = rest[1] ? decodeURIComponent(rest[1]) : null;
  const tail = rest.length > 2 ? rest.slice(2).join("/") : undefined;
  const route = (section: string | null, a: string | null, moved: boolean): ParsedSettingsHash => ({
    area,
    section,
    anchor: a,
    redirected: redirected || moved,
    ...(tail && section && a ? { tail } : {}),
  });
  if (!raw) return route(null, null, false);
  const moved = anchor ? LEGACY_ANCHORS[area][`${raw}/${anchor}`] : undefined;
  if (moved && findSection(area, moved.section)) return route(moved.section, moved.anchor, true);
  if (findSection(area, raw)) return route(raw, anchor, false);
  const legacy = LEGACY_SECTIONS[area][raw];
  if (legacy && findSection(area, legacy)) return route(legacy, anchor, true);
  return route(null, null, true);
}

// The address of a route; `tail` as parseSettingsHash returns it.
export function settingsHash(route: { area: SettingsArea; section?: string | null; anchor?: string | null; tail?: string }) {
  const base = route.area === "admin" ? `#settings/${INSTANCE_SEGMENT}` : "#settings";
  if (!route.section) return base;
  const anchor = route.anchor ? `/${encodeURIComponent(route.anchor)}${route.tail ? `/${route.tail}` : ""}` : "";
  return `${base}/${encodeURIComponent(route.section)}${anchor}`;
}

// The address an old or moved one stands for ("#admin/users" →
// "#settings/instance/users"), or null when it is current or no settings
// address at all.
export function redirectedSettingsHash(hash: string): string | null {
  const parsed = parseSettingsHash(hash);
  return parsed?.redirected ? settingsHash(parsed) : null;
}

// Matches a query against texts in every language at once: a French reader
// who types "password" finds the section too. All words must occur.
export function matchesQuery(haystack: string[], query: string) {
  const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const text = fold(haystack.join(" "));
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => text.includes(w));
}

// The search of the landing page: sections and their entries whose texts
// (in the reader's language via `pick`, and German and English) match –
// at every level (#294): `level` is the result's, for its mark when above
// the person's (personal settings only).
export type SettingsSearchResult<S extends SectionMeta = SectionMeta> = { section: S; entry?: SettingsEntry; anchor?: string; level?: SettingsLevel };
export function searchSettings<S extends SectionMeta>(sections: S[], query: string, pick: (text: Text) => string): SettingsSearchResult<S>[] {
  const out: SettingsSearchResult<S>[] = [];
  if (!query.trim()) return out;
  for (const s of sections) {
    const levelled = s.area === "settings";
    const own = [pick(s.title), s.title.de, s.title.en, pick(s.description), s.keywords.de, s.keywords.en, pick(s.keywords)];
    if (matchesQuery(own, query)) out.push({ section: s, level: levelled ? sectionMinLevel(s) : undefined });
    for (const e of s.entries || []) {
      const texts = [pick(e.title), e.title.de, e.title.en, ...(e.keywords ? [e.keywords.de, e.keywords.en, pick(e.keywords)] : [])];
      if (matchesQuery(texts, query)) out.push({ section: s, entry: e, anchor: e.anchor, level: levelled ? entryLevel(s, e) : undefined });
    }
  }
  return out;
}
