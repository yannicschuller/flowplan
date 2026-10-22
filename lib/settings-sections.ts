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
    description: { de: "Profil, Passwort, zweiter Faktor, Passkeys, Geräte und deine Grenzen.", en: "Profile, password, second factor, passkeys, devices and your limits." },
    keywords: { de: "profil name passwort passkey zwei-faktor 2fa authenticator sitzungen geräte abmelden verschlüsselung e2ee grenzen speicher konto löschen", en: "profile name password passkey two-factor 2fa authenticator sessions devices sign out encryption e2ee limits storage delete account" },
    entries: [
      { title: { de: "Passwort ändern", en: "Change password" } },
      { title: { de: "Passkeys", en: "Passkeys" } },
      { title: { de: "Zwei-Faktor-Anmeldung", en: "Two-factor sign-in" }, keywords: { de: "2fa authenticator code", en: "2fa authenticator code" } },
      { title: { de: "Angemeldete Geräte", en: "Signed-in devices" }, keywords: { de: "sitzungen abmelden", en: "sessions sign out" } },
      { title: { de: "Ende-zu-Ende-Verschlüsselung", en: "End-to-end encryption" }, keywords: { de: "e2ee schlüssel passphrase", en: "e2ee key passphrase" } },
      { title: { de: "Konto löschen", en: "Delete account" } },
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
      { title: { de: "Wöchentliche Zusammenfassung", en: "Weekly digest" } },
      { title: { de: "Push-Benachrichtigungen", en: "Push notifications" } },
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
  },
  // ------------------------------------------------------------- connections
  {
    id: "api",
    area: "settings",
    group: "connections",
    icon: "PlugsConnected",
    title: { de: "API & Webhooks", en: "API & webhooks" },
    description: { de: "Persönliche API-Tokens, KI-Assistenten (MCP) und Webhooks des Arbeitsbereichs.", en: "Personal API tokens, AI assistants (MCP) and the workspace's webhooks." },
    keywords: { de: "api token schlüssel mcp claude chatgpt webhook n8n home assistant automationen", en: "api token key mcp claude chatgpt webhook n8n home assistant automations" },
    entries: [
      { title: { de: "Persönliche API-Tokens", en: "Personal API tokens" } },
      { title: { de: "KI-Assistenten (MCP)", en: "AI assistants (MCP)" } },
      { title: { de: "Webhooks", en: "Webhooks" } },
    ],
  },
  {
    id: "connections",
    area: "settings",
    group: "connections",
    icon: "CalendarBlank",
    title: { de: "Kalender & Issues", en: "Calendars & issues" },
    description: { de: "Google- und Microsoft-Kalender, GitHub- und GitLab-Issues.", en: "Google and Microsoft calendars, GitHub and GitLab issues." },
    keywords: { de: "kalender google outlook microsoft github gitlab issues synchronisierung", en: "calendar google outlook microsoft github gitlab issues sync" },
  },
  {
    id: "clipper",
    area: "settings",
    group: "connections",
    icon: "BookmarkSimple",
    title: { de: "Web-Clipper", en: "Web clipper" },
    description: { de: "Webseiten speichern, Lesezeichen importieren, Schnell erfassen.", en: "Save web pages, import bookmarks, quick capture." },
    keywords: { de: "clipper lesezeichen bookmarklet browser erweiterung erfassen", en: "clipper bookmarks bookmarklet browser extension capture" },
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
    description: { de: "Konten der Instanz: Grenzen, Sitzungen, Sperren und Löschen.", en: "Accounts of the instance: limits, sessions, blocking and deleting." },
    keywords: { de: "benutzer konten sperren deaktivieren sitzungen admin grenzen registrierung", en: "users accounts block disable sessions admin limits sign-up" },
  },
  {
    id: "signin",
    area: "admin",
    group: "people",
    icon: "Key",
    title: { de: "Anmeldung & SSO", en: "Sign-in & SSO" },
    description: { de: "SSO-Gruppen, Benutzerverwaltung über SCIM und LDAP.", en: "SSO groups, user provisioning over SCIM and LDAP." },
    keywords: { de: "sso oidc keycloak scim ldap verzeichnis gruppen zuordnen", en: "sso oidc keycloak scim ldap directory groups mapping" },
  },
  {
    id: "workspaces",
    area: "admin",
    group: "people",
    icon: "Stack",
    title: { de: "Arbeitsbereiche", en: "Workspaces" },
    description: { de: "Alle Arbeitsbereiche mit Belegung und Speicherkontingent.", en: "All workspaces with usage and storage quota." },
    keywords: { de: "arbeitsbereiche kontingent speicher belegung", en: "workspaces quota storage usage" },
  },
  {
    id: "storage",
    area: "admin",
    group: "data",
    icon: "HardDrives",
    title: { de: "Speicher & Sicherung", en: "Storage & backup" },
    description: { de: "Belegung, S3, geplante Sicherung und die Sicherung der gesamten Instanz.", en: "Usage, S3, scheduled backup and the backup of the whole instance." },
    keywords: { de: "speicher s3 bucket litestream sicherung backup wiederherstellen restore", en: "storage s3 bucket litestream backup restore" },
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
    description: { de: "Versand über SMTP und eine Test-E-Mail.", en: "Sending over SMTP and a test e-mail." },
    keywords: { de: "e-mail smtp versand test", en: "email smtp sending test" },
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
    id: "general",
    area: "admin",
    group: "operations",
    icon: "SlidersHorizontal",
    title: { de: "Instanz", en: "Instance" },
    description: { de: "Name, Hinweis, Zugang, Grenzen, Versionen und Version der Instanz.", en: "Name, notice, access, limits, versions and version of the instance." },
    keywords: { de: "instanz name hinweis banner registrierung zwei-faktor demo domains kontingent upload versionen aufbewahrung sicherung version update", en: "instance name notice banner sign-up two-factor demo domains quota upload versions retention backup version update" },
    entries: [
      { title: { de: "Name der Instanz", en: "Instance name" } },
      { title: { de: "Hinweis für alle Personen", en: "Notice for everyone" } },
      { title: { de: "Registrierung mit E-Mail und Passwort", en: "Sign-up with email and password" } },
      { title: { de: "Zwei-Faktor-Anmeldung verlangen", en: "Require two-factor sign-in" } },
      { title: { de: "Größte Datei beim Hochladen", en: "Largest upload" } },
      { title: { de: "Versionen aufbewahren", en: "Keep versions" } },
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
