// The settings and the administration as one list of areas, groups and
// sections (docs/settings-architecture.md). This file is plain data – no
// React – so routing, tests and the search can use it; the components that
// render a section are attached in components/settings/registry.tsx.
//
// Every section has a stable id: it is the address of the section
// (#settings/<id>, #admin/<id>) and must not change once released. Texts are
// { de, en } pairs (French and further languages come from locales/ via
// `npm run i18n`).

export type SettingsArea = "settings" | "admin";
export type Text = { de: string; en: string };

// A single setting inside a section, for the search ("Passkeys" finds
// Konto & Sicherheit). `anchor` is the id of an element in the section the
// result scrolls to (#settings/account/passkeys); without it the section
// opens at the top.
export type SettingsEntry = { title: Text; keywords?: Text; anchor?: string };

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
};

export type GroupMeta = { id: string; area: SettingsArea; title: Text };

// The groups in the order of the landing page. The workspace group shows the
// workspace's name ("Arbeitsbereich „Team“"): its title has {name}.
export const SETTINGS_GROUPS: GroupMeta[] = [
  { id: "personal", area: "settings", title: { de: "Persönlich", en: "Personal" } },
  { id: "connections", area: "settings", title: { de: "Verbindungen", en: "Connections" } },
  { id: "workspace", area: "settings", title: { de: "Arbeitsbereich", en: "Workspace" } },
  { id: "people", area: "admin", title: { de: "Personen", en: "People" } },
  { id: "data", area: "admin", title: { de: "Daten", en: "Data" } },
  { id: "services", area: "admin", title: { de: "Dienste", en: "Services" } },
  { id: "security", area: "admin", title: { de: "Sicherheit", en: "Security" } },
  { id: "operations", area: "admin", title: { de: "Betrieb", en: "Operations" } },
];

export const SETTINGS_SECTIONS: SectionMeta[] = [
  // ---------------------------------------------------------------- personal
  {
    id: "account",
    area: "settings",
    group: "personal",
    icon: "UserCircle",
    title: { de: "Konto & Sicherheit", en: "Account & security" },
    description: { de: "Profil, Anmeldung, angemeldete Geräte, Verschlüsselung und deine Grenzen.", en: "Profile, sign-in, signed-in devices, encryption and your limits." },
    keywords: { de: "profil name anzeigename passwort passkey zwei-faktor 2fa authenticator sitzungen geräte abmelden verschlüsselung e2ee grenzen speicher konto löschen", en: "profile name display name password passkey two-factor 2fa authenticator sessions devices sign out encryption e2ee limits storage delete account" },
    entries: [
      { title: { de: "Anzeigename", en: "Display name" }, keywords: { de: "profil name", en: "profile name" }, anchor: "profile" },
      { title: { de: "Passwort ändern", en: "Change password" }, anchor: "password" },
      { title: { de: "Passkeys", en: "Passkeys" }, anchor: "passkeys" },
      { title: { de: "Zwei-Faktor-Anmeldung", en: "Two-factor sign-in" }, keywords: { de: "2fa authenticator code wiederherstellungscodes", en: "2fa authenticator code recovery codes" }, anchor: "two-factor" },
      { title: { de: "Angemeldete Geräte", en: "Signed-in devices" }, keywords: { de: "sitzungen abmelden", en: "sessions sign out" }, anchor: "sessions" },
      { title: { de: "Ende-zu-Ende-Verschlüsselung", en: "End-to-end encryption" }, keywords: { de: "e2ee schlüssel passphrase wiederherstellungsschlüssel", en: "e2ee key passphrase recovery key" }, anchor: "encryption" },
      { title: { de: "Deine Grenzen", en: "Your limits" }, keywords: { de: "speicher kontingent", en: "storage quota" }, anchor: "limits" },
      { title: { de: "Konto löschen", en: "Delete account" }, anchor: "delete-account" },
    ],
  },
  {
    id: "appearance",
    area: "settings",
    group: "personal",
    icon: "Palette",
    title: { de: "Darstellung & Sprache", en: "Appearance & language" },
    description: { de: "Sprache, Hell oder Dunkel, Tastenkürzel und die Einführung.", en: "Language, light or dark, keyboard shortcuts and the introduction." },
    keywords: { de: "sprache deutsch englisch französisch design hell dunkel theme tastenkürzel shortcuts einführung tour", en: "language german english french theme light dark appearance keyboard shortcuts introduction tour" },
    entries: [
      { title: { de: "Sprache", en: "Language" } },
      { title: { de: "Erscheinungsbild", en: "Appearance" }, keywords: { de: "hell dunkel", en: "light dark" } },
      { title: { de: "Tastenkürzel", en: "Keyboard shortcuts" } },
      { title: { de: "Einführung ansehen", en: "Show introduction" } },
    ],
  },
  {
    id: "notifications",
    area: "settings",
    group: "personal",
    icon: "BellSimple",
    title: { de: "Benachrichtigungen", en: "Notifications" },
    description: { de: "Was dich im Posteingang, per Push und per E-Mail erreicht.", en: "What reaches you in the inbox, as push and by e-mail." },
    keywords: { de: "posteingang push e-mail erwähnungen kommentare wöchentliche zusammenfassung digest", en: "inbox push email mentions comments weekly digest" },
    entries: [
      { title: { de: "Benachrichtigungsarten", en: "Notification kinds" }, keywords: { de: "posteingang push e-mail erwähnungen kommentare", en: "inbox push email mentions comments" }, anchor: "kinds" },
      { title: { de: "Wöchentliche Zusammenfassung", en: "Weekly digest" }, anchor: "weekly-digest" },
      { title: { de: "Push-Benachrichtigungen", en: "Push notifications" }, keywords: { de: "desktop-app mitteilungen", en: "desktop app notifications" }, anchor: "push" },
    ],
  },
  {
    id: "ai",
    area: "settings",
    group: "personal",
    icon: "Sparkle",
    title: { de: "KI", en: "AI" },
    description: { de: "Deine KI-Funktionen, ein eigener Anbieter und worauf die KI zugreifen darf.", en: "Your AI features, an own provider and what the AI may access." },
    keywords: { de: "ki künstliche intelligenz anbieter ollama openai schlüssel zugriff", en: "ai artificial intelligence provider ollama openai key access" },
  },
  {
    id: "devices",
    area: "settings",
    group: "personal",
    icon: "DeviceMobile",
    title: { de: "Offline & Geräte", en: "Offline & devices" },
    description: { de: "Inhalte auf diesem Gerät für die Nutzung ohne Verbindung.", en: "Content on this device for use without a connection." },
    keywords: { de: "offline synchronisierung gerät kopie cache", en: "offline sync device copy cache" },
    entries: [{ title: { de: "Offline-Nutzung", en: "Offline use" }, anchor: "offline" }],
  },
  // ------------------------------------------------------------- connections
  {
    id: "api",
    area: "settings",
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
    group: "connections",
    icon: "CalendarBlank",
    title: { de: "Kalender & Issues", en: "Calendars & issues" },
    description: { de: "Google- und Microsoft-Kalender, GitHub- und GitLab-Issues.", en: "Google and Microsoft calendars, GitHub and GitLab issues." },
    keywords: { de: "kalender google outlook microsoft github gitlab issues synchronisierung", en: "calendar google outlook microsoft github gitlab issues sync" },
    entries: [
      { title: { de: "Kalender verbinden", en: "Connect calendar" }, anchor: "calendar" },
      { title: { de: "GitHub oder GitLab verbinden", en: "Connect GitHub or GitLab" }, anchor: "issues" },
    ],
  },
  {
    id: "clipper",
    area: "settings",
    group: "connections",
    icon: "BookmarkSimple",
    title: { de: "Web-Clipper", en: "Web clipper" },
    description: { de: "Webseiten speichern, Lesezeichen importieren, Schnell erfassen.", en: "Save web pages, import bookmarks, quick capture." },
    keywords: { de: "clipper lesezeichen bookmarklet browser erweiterung erfassen", en: "clipper bookmarks bookmarklet browser extension capture" },
    entries: [
      { title: { de: "Erfassen", en: "Capture" }, keywords: { de: "schnell erfassen datenbank eingang", en: "quick capture database inbox" }, anchor: "capture" },
      { title: { de: "Browser-Lesezeichen importieren", en: "Import browser bookmarks" }, anchor: "bookmarks" },
    ],
  },
  // --------------------------------------------------------------- workspace
  {
    id: "workspace",
    area: "settings",
    group: "workspace",
    icon: "SlidersHorizontal",
    title: { de: "Allgemein", en: "General" },
    description: { de: "Name und Symbol, E-Mail-Eingang, Verlassen und Löschen.", en: "Name and icon, inbound e-mail, leaving and deleting." },
    keywords: { de: "arbeitsbereich name symbol icon emoji bild e-mail-eingang webhook imap verlassen löschen gefahrenzone", en: "workspace name icon emoji image inbound email webhook imap leave delete danger zone" },
    entries: [
      { title: { de: "Name & Symbol des Arbeitsbereichs", en: "Workspace name & icon" }, anchor: "identity" },
      { title: { de: "E-Mail-Eingang", en: "Inbound e-mail" }, keywords: { de: "weiterleiten mailgun postmark", en: "forward mailgun postmark" }, anchor: "inbound-mail" },
      { title: { de: "Arbeitsbereich verlassen", en: "Leave workspace" }, anchor: "danger" },
      { title: { de: "Arbeitsbereich löschen", en: "Delete workspace" }, anchor: "danger" },
    ],
  },
  {
    id: "members",
    area: "settings",
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
    group: "workspace",
    icon: "ShieldCheck",
    title: { de: "Gruppen & Rechte", en: "Groups & permissions" },
    description: { de: "Gruppen bilden, SSO-Gruppen zuordnen und Zugriff auf Bereiche geben.", en: "Form groups, map SSO groups and give access to spaces." },
    keywords: { de: "gruppen rechte berechtigungen sso zugriff sichtbarkeit", en: "groups permissions sso access visibility" },
    entries: [
      { title: { de: "SSO-Gruppen zuordnen", en: "Map SSO groups" }, anchor: "sso" },
      { title: { de: "Zugriff auf Bereiche", en: "Access to spaces" }, keywords: { de: "privat sichtbarkeit", en: "private visibility" }, anchor: "access" },
    ],
  },
  {
    id: "spaces",
    area: "settings",
    group: "workspace",
    icon: "FolderSimple",
    title: { de: "Bereiche", en: "Spaces" },
    description: { de: "Bereiche anlegen, umbenennen, freigeben und ihr Aussehen festlegen.", en: "Create, rename and share spaces and set their appearance." },
    keywords: { de: "bereiche teamspace privat freigeben farbe", en: "spaces teamspace private share colour" },
  },
  {
    id: "extensions",
    area: "settings",
    group: "workspace",
    icon: "PuzzlePiece",
    title: { de: "Block-Erweiterungen", en: "Block extensions" },
    description: { de: "Eigene Blocktypen von freigegebenen Webadressen.", en: "Own block types from allowed web addresses." },
    keywords: { de: "erweiterungen plugins blöcke", en: "extensions plugins blocks" },
  },
  {
    id: "data",
    area: "settings",
    group: "workspace",
    icon: "Database",
    title: { de: "Import & Export", en: "Import & export" },
    description: { de: "Importieren, exportieren, Archive wiederherstellen und der Papierkorb.", en: "Import, export, restore archives and the trash." },
    keywords: { de: "export import zip json markdown pdf epub notion appflowy jira trello confluence evernote google docs obsidian backup sicherung wiederherstellen papierkorb aufbewahrung versionen", en: "export import zip json markdown pdf epub notion appflowy jira trello confluence evernote google docs obsidian backup restore trash retention versions" },
    entries: [
      { title: { de: "Aus Notion, AppFlowy, Confluence, Evernote oder Obsidian importieren", en: "Import from Notion, AppFlowy, Confluence, Evernote or Obsidian" }, keywords: { de: "google docs markdown zip", en: "google docs markdown zip" }, anchor: "import" },
      { title: { de: "Aus Jira oder Trello importieren", en: "Import from Jira or Trello" }, anchor: "import" },
      { title: { de: "Arbeitsbereich exportieren", en: "Export workspace" }, anchor: "export" },
      { title: { de: "Bereich als Markdown exportieren", en: "Export space as Markdown" }, keywords: { de: "pdf epub e-book", en: "pdf epub e-book" }, anchor: "export" },
      { title: { de: "Flowplan-Archiv wiederherstellen", en: "Restore a Flowplan archive" }, keywords: { de: "backup importieren sicherung", en: "import backup" }, anchor: "backups" },
      { title: { de: "Papierkorb & Aufbewahrung", en: "Trash & retention" }, anchor: "trash" },
    ],
  },
  {
    id: "time",
    area: "settings",
    group: "workspace",
    icon: "Timer",
    title: { de: "Zeiten", en: "Time" },
    description: { de: "Erfasste Zeiten aller Datenbanken auswerten, abrechnen und exportieren.", en: "Report, bill and export the time tracked in all databases." },
    keywords: { de: "zeiterfassung stunden abrechnung bericht", en: "time tracking hours billing report" },
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
    ],
  },
  {
    id: "signin",
    area: "admin",
    group: "people",
    icon: "Key",
    title: { de: "Anmeldung & SSO", en: "Sign-in & SSO" },
    description: { de: "Registrierung, Zwei-Faktor-Pflicht, SSO mit Gruppen, SCIM und LDAP.", en: "Sign-up, required two-factor, SSO with groups, SCIM and LDAP." },
    keywords: { de: "registrierung anmeldung zwei-faktor 2fa sso oidc keycloak scim ldap verzeichnis gruppen zuordnen inaktive konten arbeitsbereiche anlegen", en: "sign-up registration sign-in two-factor 2fa sso oidc keycloak scim ldap directory groups mapping inactive accounts create workspaces" },
    entries: [
      { title: { de: "Registrierung mit E-Mail und Passwort", en: "Sign-up with email and password" }, anchor: "registration" },
      { title: { de: "Inaktive Konten sperren", en: "Block inactive accounts" }, anchor: "registration" },
      { title: { de: "Zwei-Faktor-Anmeldung verlangen", en: "Require two-factor sign-in" }, keywords: { de: "2fa", en: "2fa" }, anchor: "two-factor" },
      { title: { de: "SSO-Gruppen zentral zuordnen", en: "Map SSO groups centrally" }, anchor: "sso" },
      { title: { de: "SCIM-Token", en: "SCIM tokens" }, anchor: "scim" },
      { title: { de: "LDAP-Verzeichnis", en: "LDAP directory" }, anchor: "ldap" },
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
    keywords: { de: "speicher s3 bucket litestream sicherung backup stündlich aufbewahren wiederherstellen restore herunterladen", en: "storage s3 bucket litestream backup hourly keep restore download" },
    entries: [
      { title: { de: "Geplante Sicherung", en: "Scheduled backup" }, keywords: { de: "täglich stündlich jetzt sichern", en: "daily hourly back up now" }, anchor: "backup" },
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
    keywords: { de: "grenzen kontingent speicher upload datei größe versionen aufbewahrung standard", en: "limits quota storage upload file size versions retention default" },
    entries: [
      { title: { de: "Größte Datei beim Hochladen", en: "Largest upload" }, anchor: "storage-limits" },
      { title: { de: "Speicher je Arbeitsbereich", en: "Storage per workspace" }, anchor: "storage-limits" },
      { title: { de: "Versionen aufbewahren", en: "Keep versions" }, anchor: "retention" },
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
    id: "ai",
    area: "admin",
    group: "services",
    icon: "Sparkle",
    title: { de: "KI", en: "AI" },
    description: { de: "Anbieter, wer KI nutzen darf und welche Funktionen es gibt.", en: "Provider, who may use AI and which features exist." },
    keywords: { de: "ki anbieter ollama openai funktionen zugriff semantische suche", en: "ai provider ollama openai features access semantic search" },
  },
  {
    id: "extensions",
    area: "admin",
    group: "services",
    icon: "PuzzlePiece",
    title: { de: "Erweiterungen & Domains", en: "Extensions & domains" },
    description: { de: "Woher Block-Erweiterungen kommen dürfen und eigene Domains für Veröffentlichungen.", en: "Where block extensions may come from and custom domains for publications." },
    keywords: { de: "erweiterungen plugins blöcke https domains eigene domain veröffentlichen dns", en: "extensions plugins blocks https domains custom domain publish dns" },
    entries: [
      { title: { de: "Block-Erweiterungen von jeder HTTPS-Adresse", en: "Block extensions from any HTTPS address" }, anchor: "plugins" },
      { title: { de: "Eigene Domains für Veröffentlichungen", en: "Custom domains for publications" }, anchor: "domains" },
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
    description: { de: "Metriken, abgewiesene Anfragen, Hintergrunddienste, Zustellung, Warnungen und Wartungshinweis.", en: "Metrics, refused requests, background workers, delivery, alerts and maintenance notice." },
    keywords: { de: "betrieb metriken warnungen alarm webhook wartung hintergrunddienste worker zustellung", en: "operations metrics alerts alarm webhook maintenance background workers delivery" },
  },
  {
    id: "maintenance",
    area: "admin",
    group: "operations",
    icon: "Megaphone",
    title: { de: "Wartung & Hinweise", en: "Maintenance & notices" },
    description: { de: "Ein Hinweis für alle und angekündigte Wartungen als Banner.", en: "A notice for everyone and announced maintenance as a banner." },
    keywords: { de: "wartung hinweis banner ankündigung ausfall update", en: "maintenance notice banner announcement downtime update" },
    entries: [
      { title: { de: "Hinweis für alle Personen", en: "Notice for everyone" }, anchor: "notice" },
      { title: { de: "Wartungshinweis", en: "Maintenance notice" }, anchor: "maintenance-window" },
    ],
  },
  {
    id: "general",
    area: "admin",
    group: "operations",
    icon: "SlidersHorizontal",
    title: { de: "Instanz", en: "Instance" },
    description: { de: "Name, öffentliche Demo, Version und Aktualisierung der Instanz.", en: "Name, public demo, version and update of the instance." },
    keywords: { de: "instanz name demo version update aktualisieren commit admin-gruppe", en: "instance name demo version update commit admin group" },
    entries: [
      { title: { de: "Name der Instanz", en: "Instance name" }, anchor: "instance" },
      { title: { de: "Öffentliche Demo", en: "Public demo" }, anchor: "instance" },
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

export type SettingsRoute = { area: SettingsArea; section: string | null; anchor: string | null };

export const sectionsOf = (area: SettingsArea) => SETTINGS_SECTIONS.filter((s) => s.area === area);
export const findSection = (area: SettingsArea, id: string | null | undefined) =>
  id ? SETTINGS_SECTIONS.find((s) => s.area === area && s.id === id) || null : null;

// "#settings", "#admin/users", "#settings/account/passkeys" → the route;
// anything else → null. Unknown sections fall back to the landing page, old
// tab ids to their new section.
export function parseSettingsHash(hash: string): (SettingsRoute & { redirected: boolean }) | null {
  const parts = hash.replace(/^#/, "").split("/");
  const area = parts[0];
  if (area !== "settings" && area !== "admin") return null;
  const raw = decodeURIComponent(parts[1] || "");
  const anchor = parts[2] ? decodeURIComponent(parts[2]) : null;
  if (!raw) return { area, section: null, anchor: null, redirected: false };
  if (findSection(area, raw)) return { area, section: raw, anchor, redirected: false };
  const legacy = LEGACY_SECTIONS[area][raw];
  if (legacy && findSection(area, legacy)) return { area, section: legacy, anchor, redirected: true };
  return { area, section: null, anchor: null, redirected: true };
}

export function settingsHash(route: { area: SettingsArea; section?: string | null; anchor?: string | null }) {
  return `#${route.area}${route.section ? `/${encodeURIComponent(route.section)}` : ""}${route.section && route.anchor ? `/${encodeURIComponent(route.anchor)}` : ""}`;
}

// Matches a query against texts in every language at once: a French reader
// who types "password" finds the section too. All words must occur.
export function matchesQuery(haystack: string[], query: string) {
  const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const text = fold(haystack.join(" "));
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => text.includes(w));
}
