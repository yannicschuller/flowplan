// What an incident of a detection rule (lib/security-detect.ts) means, when
// it is harmless and what an administrator should do, step by step – shown
// on the incident's page in Administration → Angriffe & Vorfälle. Client-safe.
import type { SecurityRule } from "./security-kinds";

type Text = { de: string; en: string };
// A step can carry the action that does it right there, or a link to the
// place where it is done.
export type PlaybookAction = "block" | "sessions" | "disable" | "resolve";
export type PlaybookStep = Text & { action?: PlaybookAction; link?: { href: string } & Text };
export type Playbook = { meaning: Text; harmless: Text; steps: PlaybookStep[] };

const ACCOUNT_CHECK = { href: "#settings/security", de: "Sicherheitscheck", en: "Security check" };
const PEOPLE = { href: "#admin/users", de: "Personen", en: "People" };
const SIGN_IN = { href: "#admin/signin", de: "Anmeldung & SSO", en: "Sign-in & SSO" };
const AUDIT = { href: "#admin/audit", de: "Aktivitätsprotokoll", en: "Activity log" };
const SETUP = { href: "#admin/threats/setup", de: "Anbindung", en: "Setup" };
const RESOLVE: PlaybookStep = {
  de: "Wenn alles geklärt ist, den Vorfall als erledigt markieren. Kommt es wieder, öffnet die Regel einen neuen.",
  en: "Once everything is clear, mark the incident as resolved. If it happens again, the rule opens a new one.",
  action: "resolve",
};

export const securityPlaybooks: Record<SecurityRule, Playbook> = {
  brute_force_account: {
    meaning: {
      de: "Jemand versucht, das Passwort eines Kontos zu erraten. Solange danach keine erfolgreiche Anmeldung folgt, ist das Konto nicht übernommen – das Anmelde-Limit bremst die Versuche.",
      en: "Someone is trying to guess the password of an account. As long as no successful sign-in follows, the account is not taken over – the sign-in limit slows the attempts down.",
    },
    harmless: {
      de: "Die Person hat ihr Passwort vergessen, oder eine alte App bzw. Synchronisation probiert es mit einem alten Passwort immer wieder.",
      en: "The person forgot their password, or an old app or sync keeps trying with an old password.",
    },
    steps: [
      {
        de: "Unter „Erfolgreich angemeldet“ nachsehen, ob nach den Fehlversuchen eine Anmeldung kam. Wenn ja und die Person war es nicht: Sitzungen beenden und das Passwort zurücksetzen lassen.",
        en: "Check “Signed in successfully” for a sign-in after the failures. If there is one and it was not the person: end the sessions and have the password reset.",
        action: "sessions",
      },
      {
        de: "Kommen die Versuche aus einem fremden Netz, die Adresse sperren – bei wechselnden Adressen aus demselben Netz das Netz.",
        en: "If the attempts come from a foreign network, block the address – the network if the addresses change within it.",
        action: "block",
      },
      {
        de: "Die Person bitten, ein langes, einmaliges Passwort und Zwei-Faktor oder einen Passkey einzurichten.",
        en: "Ask the person to set a long, unique password and two-factor or a passkey.",
        link: ACCOUNT_CHECK,
      },
      RESOLVE,
    ],
  },
  brute_force_address: {
    meaning: {
      de: "Von einer Adresse schlagen sehr viele Anmeldungen fehl – meist ein Skript, das Passwörter durchprobiert.",
      en: "Very many sign-ins fail from one address – usually a script trying passwords.",
    },
    harmless: {
      de: "Viele Menschen teilen sich einen Ausgang ins Internet (Firma, Hochschule, VPN) und vertippen sich zufällig gleichzeitig.",
      en: "Many people share one way out to the internet (company, university, VPN) and happen to mistype at the same time.",
    },
    steps: [
      { de: "Netz und Länder ansehen: Kennst du das Netz (Büro, VPN)? Dann nur beobachten.", en: "Look at the network and countries: do you know the network (office, VPN)? Then just watch it." },
      { de: "Sonst die Adresse 24 Stunden sperren; kommt es wieder, das Netz.", en: "Otherwise block the address for 24 hours; if it comes back, the network.", action: "block" },
      { de: "Bei dauerhaftem Beschuss fail2ban oder CrowdSec vor den Reverse Proxy setzen – die Anleitung steht unter Anbindung.", en: "Under constant attack, put fail2ban or CrowdSec in front of the reverse proxy – see Setup.", link: SETUP },
      RESOLVE,
    ],
  },
  credential_stuffing: {
    meaning: {
      de: "Von einer Adresse wurden viele verschiedene Konten probiert – typisch für Listen mit Zugangsdaten, die bei anderen Diensten geleakt sind. Gefährdet ist jede Person, die ihr Passwort auch woanders benutzt.",
      en: "Many different accounts were tried from one address – typical of lists of credentials leaked from other services. Everyone who uses their password elsewhere too is at risk.",
    },
    harmless: { de: "Selten – etwa ein Lasttest mit vielen Testkonten.", en: "Rarely – for example a load test with many test accounts." },
    steps: [
      { de: "Die Adresse sofort sperren; kommen die Versuche aus mehreren Adressen eines Netzes, das Netz.", en: "Block the address right away; if the attempts come from several addresses of one network, the network.", action: "block" },
      {
        de: "„Erfolgreich angemeldet“ prüfen: Jede erfolgreiche Anmeldung im Zeitraum kann ein übernommenes Konto sein – Sitzungen beenden und das Passwort zurücksetzen lassen.",
        en: "Check “Signed in successfully”: every successful sign-in in the window may be a taken account – end its sessions and have the password reset.",
        action: "sessions",
      },
      {
        de: "Die Personen unter „Probierte Konten“ informieren: Wer das Passwort auch woanders nutzt, ändert es überall.",
        en: "Tell the people under “Accounts tried”: whoever uses the password elsewhere too changes it everywhere.",
        link: PEOPLE,
      },
      { de: "Zwei-Faktor für alle empfehlen oder unter Anmeldung & SSO verlangen.", en: "Recommend two-factor for everyone or require it under Sign-in & SSO.", link: SIGN_IN },
      RESOLVE,
    ],
  },
  login_after_failures: {
    meaning: {
      de: "Nach vielen Fehlversuchen kam eine erfolgreiche Anmeldung – das Passwort könnte erraten worden sein. Das ist der deutlichste Hinweis auf ein übernommenes Konto.",
      en: "A successful sign-in came after many failures – the password may have been guessed. This is the clearest sign of a taken account.",
    },
    harmless: { de: "Die Person hat es selbst nach ein paar Versuchen geschafft – vom gewohnten Gerät und Netz.", en: "The person made it themselves after a few tries – from their usual device and network." },
    steps: [
      { de: "Die Person fragen, ob sie das war; Gerät und Netz im Verlauf mit ihren üblichen vergleichen.", en: "Ask the person whether it was them; compare device and network in the timeline with their usual ones." },
      {
        de: "Wenn nicht oder unklar: alle Sitzungen beenden, das Konto vorübergehend sperren und das Passwort zurücksetzen.",
        en: "If not or unclear: end all sessions, disable the account for now and reset the password.",
        action: "disable",
      },
      { de: "Im Aktivitätsprotokoll prüfen, was das Konto seitdem getan hat (Exporte, Freigaben, neue Tokens).", en: "Check in the activity log what the account has done since (exports, shares, new tokens).", link: AUDIT },
      { de: "Die Adresse der Anmeldung sperren.", en: "Block the address of the sign-in.", action: "block" },
      { de: "Zwei-Faktor oder einen Passkey einrichten lassen, bevor das Konto wieder freigegeben wird.", en: "Have two-factor or a passkey set up before the account is enabled again.", link: ACCOUNT_CHECK },
      RESOLVE,
    ],
  },
  admin_new_device: {
    meaning: {
      de: "Ein Admin hat sich von einem Gerät angemeldet, das in den letzten 90 Tagen nicht benutzt wurde. Admin-Konten sind das wertvollste Ziel – deshalb fällt das auf.",
      en: "An admin signed in from a device not used in the last 90 days. Admin accounts are the most valuable target – so this stands out.",
    },
    harmless: { de: "Neuer Laptop, neuer Browser, ein privates Fenster oder gelöschte Browserdaten.", en: "A new laptop, a new browser, a private window or cleared browser data." },
    steps: [
      { de: "Den Admin fragen, ob das Gerät neu ist.", en: "Ask the admin whether the device is new." },
      { de: "Wenn nicht: alle Sitzungen beenden und Passwort bzw. Passkey erneuern lassen.", en: "If not: end all sessions and have the password or passkey renewed.", action: "sessions" },
      { de: "Unter Personen prüfen, wer Adminrechte hat, und im Aktivitätsprotokoll, was seit der Anmeldung geändert wurde.", en: "Check under People who has admin rights, and in the activity log what changed since the sign-in.", link: AUDIT },
      RESOLVE,
    ],
  },
  impossible_travel: {
    meaning: {
      de: "Dasselbe Konto hat sich kurz nacheinander aus zwei Ländern angemeldet – so schnell reist niemand. Oft steckt ein gestohlenes Passwort oder eine kopierte Sitzung dahinter.",
      en: "The same account signed in from two countries in a short time – nobody travels that fast. Often a stolen password or a copied session is behind it.",
    },
    harmless: { de: "Ein VPN, Roaming im Mobilfunk oder ein Firmen-Proxy in einem anderen Land.", en: "A VPN, mobile roaming or a company proxy in another country." },
    steps: [
      { de: "Die Person fragen, ob sie ein VPN oder einen Proxy benutzt.", en: "Ask the person whether they use a VPN or a proxy." },
      { de: "Wenn nicht: alle Sitzungen beenden, das Passwort ändern und Zwei-Faktor einrichten lassen.", en: "If not: end all sessions, change the password and set up two-factor.", action: "sessions" },
      { de: "Die unbekannte Herkunft sperren.", en: "Block the unknown origin.", action: "block" },
      { de: "Im Aktivitätsprotokoll prüfen, was von dort aus getan wurde.", en: "Check in the activity log what was done from there.", link: AUDIT },
      RESOLVE,
    ],
  },
  privilege_change: {
    meaning: {
      de: "Jemand hat Adminrechte vergeben oder geändert, wer sich anmelden darf (Verzeichnis, Provisionierung, Wiederherstellung, Erweiterungen, Domains). So verschaffen sich Angreifer dauerhaften Zugang.",
      en: "Someone granted admin rights or changed who may sign in (directory, provisioning, restore, extensions, domains). This is how attackers get lasting access.",
    },
    harmless: { de: "Eine geplante Änderung durch einen Admin – dann reicht es, sie zu bestätigen.", en: "A planned change by an admin – then it is enough to confirm it." },
    steps: [
      { de: "Im Verlauf nachsehen, wer was geändert hat, und mit der Person klären, ob es geplant war.", en: "See in the timeline who changed what, and check with the person whether it was planned." },
      { de: "War es nicht geplant: die Änderung rückgängig machen (Personen bzw. Anmeldung & SSO).", en: "If it was not planned: undo the change (People or Sign-in & SSO).", link: PEOPLE },
      { de: "Das Konto, das die Änderung gemacht hat, sperren – damit enden auch seine Sitzungen und Tokens.", en: "Disable the account that made the change – its sessions and tokens end with it.", action: "disable" },
      { de: "Alle Admins durchgehen und deren Passwörter, Passkeys und API-Tokens erneuern lassen.", en: "Go through all admins and have their passwords, passkeys and API tokens renewed.", link: PEOPLE },
      RESOLVE,
    ],
  },
  mass_export: {
    meaning: {
      de: "Ein Konto hat in kurzer Zeit ungewöhnlich viel exportiert – ein Hinweis auf möglichen Datenabfluss, etwa mit einem gestohlenen Konto oder Token.",
      en: "An account exported unusually much in a short time – a sign of possible data leaving, for example with a stolen account or token.",
    },
    harmless: { de: "Ein Umzug, eine Sicherung oder eine Migration, die die Person selbst angestoßen hat.", en: "A move, a backup or a migration the person started themselves." },
    steps: [
      { de: "Die Person fragen, wofür sie exportiert hat.", en: "Ask the person what they exported for." },
      { de: "Wenn sie es nicht war: Konto sperren – Sitzungen und API-Tokens enden damit.", en: "If it was not them: disable the account – sessions and API tokens end with it.", action: "disable" },
      { de: "Im Aktivitätsprotokoll nachsehen, was exportiert wurde.", en: "See in the activity log what was exported.", link: AUDIT },
      {
        de: "Waren personenbezogene Daten dabei, prüfen, ob eine Meldung an die Aufsichtsbehörde nötig ist (DSGVO Art. 33: innerhalb von 72 Stunden).",
        en: "If personal data was included, check whether the supervisory authority must be notified (GDPR Art. 33: within 72 hours).",
      },
      RESOLVE,
    ],
  },
  probing: {
    meaning: {
      de: "Eine Adresse fragt viele API-Pfade ab, die es nicht gibt oder die sie nicht darf – jemand sucht nach Lücken, gültigen IDs oder offenen Zugängen (Scanner, Bots). Solange nur 401, 403 und 404 zurückkommen, hat er nichts gefunden.",
      en: "An address asks for many API paths that do not exist or that it may not use – someone is looking for gaps, valid IDs or open ways in (scanners, bots). As long as only 401, 403 and 404 come back, it found nothing.",
    },
    harmless: {
      de: "Eine eigene Integration oder App mit abgelaufenem Token, oder ein Monitoring mit falscher Adresse.",
      en: "An own integration or app with an expired token, or monitoring with a wrong address.",
    },
    steps: [
      {
        de: "Die abgefragten Pfade ansehen: Gezielt auf Flowplan (z. B. /api/admin, /api/pages/:id) ist ernster als ein breiter Scan (wp-login, .env).",
        en: "Look at the requested paths: aimed at Flowplan (e.g. /api/admin, /api/pages/:id) is more serious than a broad scan (wp-login, .env).",
      },
      { de: "Ist es eine eigene Integration (401 mit Token)? Dann dort Token oder Adresse korrigieren.", en: "Is it an own integration (401 with a token)? Then fix the token or address there." },
      { de: "Sonst die Adresse sperren; bei Scannern aus Rechenzentren auch das Netz.", en: "Otherwise block the address; for scanners from data centres the network too.", action: "block" },
      { de: "Dauerhaft hilft CrowdSec oder fail2ban vor dem Reverse Proxy – die Anleitung steht unter Anbindung.", en: "For good, CrowdSec or fail2ban in front of the reverse proxy helps – see Setup.", link: SETUP },
      RESOLVE,
    ],
  },
  injection_attempts: {
    meaning: {
      de: "Mehrmals wurden Inhalte abgewiesen, die interne Adressen (SSRF) oder gefährliches Markup enthielten – jemand testet, ob sich Flowplan für Angriffe missbrauchen lässt. Abgewiesen heißt: Es hat nicht funktioniert.",
      en: "Content with internal addresses (SSRF) or dangerous markup was refused several times – someone is testing whether Flowplan can be misused for attacks. Refused means: it did not work.",
    },
    harmless: {
      de: "Inhalte aus anderen Werkzeugen mit Skripten eingefügt, oder Links auf Dienste im eigenen Netz.",
      en: "Content with scripts pasted from other tools, or links to services in the own network.",
    },
    steps: [
      { de: "Im Verlauf nachsehen, welches Konto es war und was eingefügt wurde.", en: "See in the timeline which account it was and what was inserted." },
      { de: "Ist das Konto fremd oder übernommen: Konto sperren.", en: "If the account is foreign or taken over: disable it.", action: "disable" },
      { de: "Kam es über einen Freigabelink: den Link unter Offene Zugänge widerrufen.", en: "If it came through a share link: revoke it under Open ways in.", link: { href: "#admin/threats/access", de: "Offene Zugänge", en: "Open ways in" } },
      { de: "Die Adresse sperren.", en: "Block the address.", action: "block" },
      RESOLVE,
    ],
  },
};
