import type { CalloutType } from "./document-schema";

type T = (de: string, en: string) => string;
// Names of the five callout kinds (GitHub alerts), for menus and slash commands.
export const calloutLabels = (t: T): Record<CalloutType, string> => ({
  note: t("Hinweis", "Note"),
  tip: t("Tipp", "Tip"),
  important: t("Wichtig", "Important"),
  warning: t("Warnung", "Warning"),
  caution: t("Achtung", "Caution"),
});
export const calloutDescriptions = (t: T): Record<CalloutType, string> => ({
  note: t("Nützliche Information", "Useful information"),
  tip: t("Hilfreicher Rat", "Helpful advice"),
  important: t("Das Wichtigste auf einen Blick", "Key information"),
  warning: t("Braucht Aufmerksamkeit", "Needs attention"),
  caution: t("Risiko oder unerwünschte Folge", "Risk or negative outcome"),
});
