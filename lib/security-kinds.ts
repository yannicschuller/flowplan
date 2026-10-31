// Security events and detection rules (lib/security-events.ts,
// lib/security-detect.ts) with their default severity and their names –
// client-safe, for the administration's security section.
export type SecuritySeverity = "info" | "warn" | "critical";

type Kind = { severity: SecuritySeverity; de: string; en: string };
export const securityKinds = {
  "login.success": { severity: "info", de: "Anmeldung", en: "Sign-in" },
  "login.failure": { severity: "warn", de: "Fehlgeschlagene Anmeldung", en: "Failed sign-in" },
  "login.refused": { severity: "warn", de: "Anmeldung abgewiesen (Limit oder Sperre)", en: "Sign-in refused (limit or block)" },
  "login.new_device": { severity: "warn", de: "Anmeldung von neuem Gerät", en: "Sign-in from a new device" },
  "session.revoked": { severity: "warn", de: "Sitzungen beendet", en: "Sessions ended" },
  "account.password": { severity: "warn", de: "Passwort geändert", en: "Password changed" },
  "account.password_reset": { severity: "warn", de: "Passwort zurückgesetzt", en: "Password reset" },
  "account.passkey_added": { severity: "info", de: "Passkey hinzugefügt", en: "Passkey added" },
  "account.passkey_removed": { severity: "warn", de: "Passkey entfernt", en: "Passkey removed" },
  "account.2fa_on": { severity: "info", de: "Zwei-Faktor eingeschaltet", en: "Two-factor turned on" },
  "account.2fa_off": { severity: "warn", de: "Zwei-Faktor ausgeschaltet", en: "Two-factor turned off" },
  "account.token_created": { severity: "info", de: "API-Token erstellt", en: "API token created" },
  "account.token_revoked": { severity: "info", de: "API-Token widerrufen", en: "API token revoked" },
  "account.messenger_added": { severity: "info", de: "Chat-App verbunden", en: "Chat app connected" },
  "account.messenger_removed": { severity: "info", de: "Chat-App getrennt", en: "Chat app disconnected" },
  "account.deleted": { severity: "warn", de: "Konto gelöscht", en: "Account deleted" },
  "admin.granted": { severity: "critical", de: "Adminrechte vergeben", en: "Admin rights granted" },
  "admin.revoked": { severity: "warn", de: "Adminrechte entzogen", en: "Admin rights removed" },
  "admin.user": { severity: "warn", de: "Konto durch Admin geändert", en: "Account changed by an admin" },
  "admin.messenger_bot": { severity: "warn", de: "Telegram-Bot der Instanz geändert", en: "Instance Telegram bot changed" },
  "admin.settings": { severity: "warn", de: "Sicherheitsrelevante Einstellung geändert", en: "Security-relevant setting changed" },
  "role.changed": { severity: "info", de: "Rolle geändert", en: "Role changed" },
  "invite.created": { severity: "info", de: "Einladung verschickt", en: "Invitation sent" },
  "share.created": { severity: "info", de: "Freigabelink erstellt", en: "Share link created" },
  "share.public": { severity: "warn", de: "Seite öffentlich gemacht", en: "Page made public" },
  "data.export": { severity: "info", de: "Export", en: "Export" },
  "request.origin": { severity: "warn", de: "Anfrage von fremder Herkunft", en: "Request from a foreign origin" },
  "request.probing": { severity: "warn", de: "Viele abgewiesene Anfragen", en: "Many refused requests" },
  "blocked.ssrf": { severity: "warn", de: "Interne Adresse abgewiesen (SSRF)", en: "Internal address refused (SSRF)" },
  "blocked.content": { severity: "warn", de: "Gefährlicher Inhalt abgewiesen", en: "Dangerous content refused" },
  "security.block": { severity: "warn", de: "Adresse gesperrt", en: "Address blocked" },
  "security.unblock": { severity: "info", de: "Sperre aufgehoben", en: "Block lifted" },
  "security.blocked_request": { severity: "warn", de: "Anfrage einer gesperrten Adresse", en: "Request from a blocked address" },
} as const satisfies Record<string, Kind>;
export type SecurityKind = keyof typeof securityKinds;
export const isSecurityKind = (value: string): value is SecurityKind => value in securityKinds;

// The detection rules (lib/security-detect.ts): each opens an incident.
export const securityRules = {
  brute_force_account: { severity: "warn", de: "Passwort-Raten bei einem Konto", en: "Password guessing on an account" },
  brute_force_address: { severity: "warn", de: "Viele Fehlversuche von einer Adresse", en: "Many failures from one address" },
  credential_stuffing: { severity: "critical", de: "Viele Konten von einer Adresse probiert", en: "Many accounts tried from one address" },
  login_after_failures: { severity: "critical", de: "Anmeldung nach vielen Fehlversuchen", en: "Sign-in after many failures" },
  admin_new_device: { severity: "warn", de: "Admin meldet sich von neuem Gerät an", en: "Admin signs in from a new device" },
  impossible_travel: { severity: "critical", de: "Anmeldungen aus zwei Ländern kurz nacheinander", en: "Sign-ins from two countries in a short time" },
  privilege_change: { severity: "critical", de: "Rechte oder Anmeldung der Instanz geändert", en: "Rights or sign-in of the instance changed" },
  mass_export: { severity: "warn", de: "Ungewöhnlich viele Exporte", en: "Unusually many exports" },
  probing: { severity: "warn", de: "Abtasten von Adressen und IDs", en: "Probing of addresses and IDs" },
  injection_attempts: { severity: "warn", de: "Wiederholte Angriffsversuche über Inhalte", en: "Repeated attack attempts through content" },
} as const satisfies Record<string, Kind>;
export type SecurityRule = keyof typeof securityRules;
