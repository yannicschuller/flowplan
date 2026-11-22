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
  // "Passkey hinzufügen" in the iPhone/iPad/Android app (lib/app-passkey.ts).
  "account.passkey_app_link": { severity: "info", de: "Passkey-Link für die App erstellt", en: "Passkey link for the app created" },
  "account.passkey_app_link_used": { severity: "info", de: "Passkey-Link der App benutzt", en: "Passkey link of the app used" },
  "account.2fa_on": { severity: "info", de: "Zwei-Faktor eingeschaltet", en: "Two-factor turned on" },
  "account.2fa_off": { severity: "warn", de: "Zwei-Faktor ausgeschaltet", en: "Two-factor turned off" },
  "account.token_created": { severity: "info", de: "API-Token erstellt", en: "API token created" },
  "account.token_revoked": { severity: "info", de: "API-Token widerrufen", en: "API token revoked" },
  "account.messenger_added": { severity: "info", de: "Chat-App verbunden", en: "Chat app connected" },
  "account.messenger_removed": { severity: "info", de: "Chat-App getrennt", en: "Chat app disconnected" },
  "account.deleted": { severity: "warn", de: "Konto gelöscht", en: "Account deleted" },
  // Sign-in identities (lib/identities.ts, #101).
  "account.sso_linked": { severity: "warn", de: "SSO-Konto verbunden", en: "SSO identity connected" },
  "account.sso_unlinked": { severity: "warn", de: "SSO-Konto getrennt", en: "SSO identity disconnected" },
  "account.sso_link_refused": { severity: "warn", de: "SSO-Verbindung abgelehnt", en: "SSO connection refused" },
  "account.password_removed": { severity: "warn", de: "Passwort entfernt (nur SSO)", en: "Password removed (SSO only)" },
  // Changing the e-mail address (#405, lib/email-change.ts).
  "account.email_change_requested": { severity: "info", de: "Änderung der E-Mail-Adresse angefordert", en: "E-mail address change requested" },
  "account.email_change_cancelled": { severity: "info", de: "Änderung der E-Mail-Adresse abgebrochen", en: "E-mail address change cancelled" },
  "account.email_changed": { severity: "warn", de: "E-Mail-Adresse geändert", en: "E-mail address changed" },
  "admin.merge": { severity: "critical", de: "Konten zusammengeführt", en: "Accounts merged" },
  "admin.granted": { severity: "critical", de: "Adminrechte vergeben", en: "Admin rights granted" },
  "admin.revoked": { severity: "warn", de: "Adminrechte entzogen", en: "Admin rights removed" },
  "admin.user": { severity: "warn", de: "Konto durch Admin geändert", en: "Account changed by an admin" },
  // Administration → Benutzer → "Konto anlegen" (#433, lib/account-create.ts).
  "admin.account_created": { severity: "warn", de: "Konto durch Admin angelegt", en: "Account created by an admin" },
  // Accounts with an unconfirmed address marked for deletion (#436, lib/unconfirmed-deletion.ts).
  "admin.deletion_marked": { severity: "warn", de: "Unbestätigte Konten zur Löschung vorgemerkt", en: "Unconfirmed accounts marked for deletion" },
  "admin.deletion_cancelled": { severity: "info", de: "Vorgemerkte Löschung abgebrochen", en: "Pending deletion cancelled" },
  "account.deletion_averted": { severity: "info", de: "Löschung durch Bestätigen der Adresse abgewendet", en: "Deletion averted by confirming the address" },
  "admin.messenger_bot": { severity: "warn", de: "Telegram-Bot der Instanz geändert", en: "Instance Telegram bot changed" },
  "admin.settings": { severity: "warn", de: "Sicherheitsrelevante Einstellung geändert", en: "Security-relevant setting changed" },
  // SSO groups → workspace roles and groups (lib/sso-mappings.ts, #321).
  "admin.sso_mapping_changed": { severity: "warn", de: "SSO-Gruppenzuordnung geändert", en: "SSO group mapping changed" },
  "role.changed": { severity: "info", de: "Rolle geändert", en: "Role changed" },
  "invite.created": { severity: "info", de: "Einladung verschickt", en: "Invitation sent" },
  // Invitation links for several people (#320, lib/invite-links.ts).
  "invite_link.created": { severity: "info", de: "Einladungslink erstellt", en: "Invite link created" },
  "invite_link.revoked": { severity: "info", de: "Einladungslink zurückgezogen", en: "Invite link revoked" },
  "invite_link.used": { severity: "info", de: "Über Einladungslink beigetreten", en: "Joined through an invite link" },
  "invite_link.refused": { severity: "warn", de: "Einladungslink abgewiesen", en: "Invite link refused" },
  "share.created": { severity: "info", de: "Freigabelink erstellt", en: "Share link created" },
  "share.public": { severity: "warn", de: "Seite öffentlich gemacht", en: "Page made public" },
  "share.revoked": { severity: "info", de: "Freigaben widerrufen", en: "Shares revoked" },
  "data.export": { severity: "info", de: "Export", en: "Export" },
  "request.origin": { severity: "warn", de: "Anfrage von fremder Herkunft", en: "Request from a foreign origin" },
  "request.probing": { severity: "warn", de: "Viele abgewiesene Anfragen", en: "Many refused requests" },
  "blocked.ssrf": { severity: "warn", de: "Interne Adresse abgewiesen (SSRF)", en: "Internal address refused (SSRF)" },
  "blocked.content": { severity: "warn", de: "Gefährlicher Inhalt abgewiesen", en: "Dangerous content refused" },
  "security.block": { severity: "warn", de: "Adresse gesperrt", en: "Address blocked" },
  "security.unblock": { severity: "info", de: "Sperre aufgehoben", en: "Block lifted" },
  "instance.move": { severity: "critical", de: "Instanzumzug", en: "Instance move" },
  "instance.move_refused": { severity: "warn", de: "Umzugstoken abgewiesen", en: "Move token refused" },
  "security.blocked_request": { severity: "warn", de: "Anfrage einer gesperrten Adresse", en: "Request from a blocked address" },
  // Workflows (#168, docs/specs/workflows.md §9.9).
  "workflow.hook.refused": { severity: "warn", de: "Workflow-Webhook abgewiesen (Signatur oder Token)", en: "Workflow webhook refused (signature or token)" },
  "workflow.auto_paused": { severity: "info", de: "Workflow automatisch pausiert", en: "Workflow paused automatically" },
  "workflow.approval.refused": { severity: "warn", de: "Freigabe aus der App abgewiesen (Bestätigung oder Gerät)", en: "Approval from the app refused (confirmation or device)" },
  "workflow.limit": { severity: "warn", de: "Workflow am Limit (Kaskade oder Rate)", en: "Workflow at its limit (cascade or rate)" },
  // Emergency access for trusted contacts (#281, lib/emergency-access.ts).
  "emergency.designated": { severity: "info", de: "Vertrauensperson eingetragen", en: "Trusted contact added" },
  "emergency.accepted": { severity: "info", de: "Rolle als Vertrauensperson angenommen", en: "Trusted contact role accepted" },
  "emergency.removed": { severity: "info", de: "Vertrauensperson entfernt", en: "Trusted contact removed" },
  "emergency.requested": { severity: "warn", de: "Notfallzugriff angefragt", en: "Emergency access requested" },
  "emergency.reminder": { severity: "info", de: "Erinnerung an angefragten Notfallzugriff", en: "Reminder of requested emergency access" },
  "emergency.cancelled": { severity: "info", de: "Anfrage auf Notfallzugriff zurückgezogen", en: "Emergency access request withdrawn" },
  "emergency.denied": { severity: "info", de: "Notfallzugriff abgelehnt", en: "Emergency access denied" },
  "emergency.granted": { severity: "warn", de: "Notfallzugriff freigegeben", en: "Emergency access granted" },
  "emergency.revoked": { severity: "info", de: "Notfallzugriff beendet", en: "Emergency access ended" },
  "emergency.expired": { severity: "info", de: "Notfallzugriff abgelaufen", en: "Emergency access expired" },
  "emergency.viewed": { severity: "info", de: "Inhalte über Notfallzugriff gelesen", en: "Content read through emergency access" },
  "emergency.exported": { severity: "warn", de: "Export über Notfallzugriff", en: "Export through emergency access" },
  // Inactivity message per workspace (#282, lib/dead-man-switch.ts).
  "deadman.armed": { severity: "info", de: "Nachricht bei Inaktivität eingeschaltet", en: "Inactivity message switched on" },
  "deadman.disarmed": { severity: "info", de: "Nachricht bei Inaktivität ausgeschaltet", en: "Inactivity message switched off" },
  "deadman.changed": { severity: "info", de: "Nachricht bei Inaktivität geändert", en: "Inactivity message changed" },
  "deadman.recipients": { severity: "warn", de: "Empfänger der Nachricht bei Inaktivität geändert", en: "Recipients of the inactivity message changed" },
  "deadman.warning": { severity: "info", de: "Erinnerung vor der Nachricht bei Inaktivität", en: "Reminder before the inactivity message" },
  "deadman.fired": { severity: "warn", de: "Nachricht bei Inaktivität verschickt", en: "Inactivity message sent" },
  "deadman.checkin": { severity: "info", de: "Lebenszeichen zur Nachricht bei Inaktivität", en: "Check-in for the inactivity message" },
  "deadman.rearmed": { severity: "info", de: "Nachricht bei Inaktivität wieder eingeschaltet", en: "Inactivity message switched on again" },
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
  // Instance-wide alerts (#321).
  admin_2fa_off: { severity: "critical", de: "Zwei-Faktor eines Admins ausgeschaltet", en: "Two-factor of an admin turned off" },
  instance_policy_change: { severity: "warn", de: "Zugang zur Instanz geöffnet oder SSO-Zuordnung geändert", en: "Access to the instance opened or SSO mapping changed" },
  emergency_access: { severity: "warn", de: "Notfallzugriff freigegeben oder für einen Export genutzt", en: "Emergency access granted or used for an export" },
  e2ee_reset: { severity: "warn", de: "Verschlüsselungsschlüssel zurückgesetzt", en: "Encryption key reset" },
  e2ee_mass_reset: { severity: "critical", de: "Mehrere Verschlüsselungsschlüssel zurückgesetzt", en: "Several encryption keys reset" },
  mass_export: { severity: "warn", de: "Ungewöhnlich viele Exporte", en: "Unusually many exports" },
  probing: { severity: "warn", de: "Abtasten von Adressen und IDs", en: "Probing of addresses and IDs" },
  injection_attempts: { severity: "warn", de: "Wiederholte Angriffsversuche über Inhalte", en: "Repeated attack attempts through content" },
  emergency_requests: { severity: "warn", de: "Mehrere Anfragen auf Notfallzugriff in kurzer Zeit", en: "Several emergency access requests in a short time" },
} as const satisfies Record<string, Kind>;
export type SecurityRule = keyof typeof securityRules;
