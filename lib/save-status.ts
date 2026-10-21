// Saving states of documents, records and boards travel through the app as
// keys and are put into words only where they are shown, in the reader's
// language (components/i18n.tsx useStatusLabel).
export const SAVE_STATUSES = [
  "loading",
  "saved",
  "saving",
  "syncing",
  "unsaved",
  "saved-offline",
  "offline",
  "failed",
  "retrying",
  "reloading",
  "transcribing",
  "uploading",
  "importing",
  "changes-saved",
] as const;
export type SaveStatus = (typeof SAVE_STATUSES)[number];
export const isSaveStatus = (value: unknown): value is SaveStatus =>
  typeof value === "string" && (SAVE_STATUSES as readonly string[]).includes(value);

type T = (de: string, en: string) => string;
export function saveStatusLabel(status: SaveStatus, t: T): string {
  switch (status) {
    case "loading":
      return t("Laden …", "Loading …");
    case "saved":
      return t("Gespeichert", "Saved");
    case "saving":
      return t("Speichern …", "Saving …");
    case "syncing":
      return t("Synchronisieren …", "Syncing …");
    case "unsaved":
      return t("Ungespeicherte Änderungen", "Unsaved changes");
    case "saved-offline":
      return t("Offline gespeichert", "Saved offline");
    case "offline":
      return t("Offline", "Offline");
    case "failed":
      return t("Speichern fehlgeschlagen", "Saving failed");
    case "retrying":
      return t("Verbindung unterbrochen – wird wiederholt …", "Connection lost – retrying …");
    case "reloading":
      return t("Neue Dokumentversion wird geladen …", "Loading the new document version …");
    case "transcribing":
      return t("Sprachnotiz wird in Text umgewandelt …", "Turning the voice note into text …");
    case "uploading":
      return t("Bild wird hochgeladen …", "Uploading image …");
    case "importing":
      return t("Zeichnung wird importiert …", "Importing drawing …");
    case "changes-saved":
      return t("Änderungen gespeichert", "Changes saved");
  }
}

// Older callers still report the German words; they map to the keys so the
// label is translated all the same.
const legacyWords: Record<string, SaveStatus> = {
  "Laden …": "loading",
  Gespeichert: "saved",
  "Speichern …": "saving",
  "Synchronisieren …": "syncing",
  "Änderungen …": "unsaved",
  "Offline gespeichert": "saved-offline",
  Offline: "offline",
  "Speichern fehlgeschlagen": "failed",
  "Verbindung unterbrochen – wird wiederholt …": "retrying",
  "Neue Dokumentversion wird geladen …": "reloading",
  "Sprachnotiz wird in Text umgewandelt …": "transcribing",
  "Bild wird hochgeladen …": "uploading",
  "Zeichnung wird importiert …": "importing",
  "Änderungen gespeichert": "changes-saved",
};
export function saveStatusOf(value: string): SaveStatus | null {
  return isSaveStatus(value) ? value : legacyWords[value] || null;
}
