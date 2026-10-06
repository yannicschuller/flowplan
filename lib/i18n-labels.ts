// English for the German label tables in lib (filter operators, rollups,
// chart options, formats …). The tables stay German because server code and
// tests use them; the client translates them where they are shown.
import { currencies } from "./field-format";
import type { Locale } from "./i18n";

const labels: Record<string, string> = {
  // relative dates
  Heute: "Today",
  Gestern: "Yesterday",
  Morgen: "Tomorrow",
  "Diese Woche": "This week",
  "Letzte Woche": "Last week",
  "Nächste Woche": "Next week",
  "Dieser Monat": "This month",
  "Letzter Monat": "Last month",
  "Nächster Monat": "Next month",
  "Dieses Jahr": "This year",
  "Letztes Jahr": "Last year",
  "Nächstes Jahr": "Next year",
  "Letzte 7 Tage (inkl. heute)": "Last 7 days (incl. today)",
  "Letzte 30 Tage (inkl. heute)": "Last 30 days (incl. today)",
  "Nächste 7 Tage (inkl. heute)": "Next 7 days (incl. today)",
  "Nächste 30 Tage (inkl. heute)": "Next 30 days (incl. today)",
  "Letzte N Tage (inkl. heute)": "Last N days (incl. today)",
  "Nächste N Tage (inkl. heute)": "Next N days (incl. today)",
  // record layout and access
  Dialog: "Dialog",
  Seitenleiste: "Side panel",
  "Ganze Seite": "Full page",
  "Wie die Datenbank": "Same as the database",
  "Nur lesen (Ausnahmen unten)": "Read only (exceptions below)",
  "Privat (nur Freigegebene)": "Private (shared people only)",
  // rollups and calculations
  "Verknüpfte Einträge zählen": "Count linked records",
  "Originalwerte anzeigen": "Show original values",
  "Eindeutige Werte anzeigen": "Show unique values",
  "Werte zählen": "Count values",
  "Eindeutige Werte zählen": "Count unique values",
  "Leere Werte zählen": "Count empty values",
  "Gefüllte Werte zählen": "Count filled values",
  "Anteil leer": "Percent empty",
  "Anteil gefüllt": "Percent filled",
  Summe: "Sum",
  Durchschnitt: "Average",
  Median: "Median",
  Minimum: "Minimum",
  Maximum: "Maximum",
  Spannweite: "Range",
  "Abgehakte Werte zählen": "Count checked values",
  "Nicht abgehakte Werte zählen": "Count unchecked values",
  "Anteil abgehakt": "Percent checked",
  "Anteil nicht abgehakt": "Percent unchecked",
  "Frühestes Datum": "Earliest date",
  "Spätestes Datum": "Latest date",
  "Zeitraum in Tagen": "Range in days",
  Automatisch: "Automatic",
  "Keine Berechnung": "No calculation",
  "Einträge zählen": "Count records",
  "Zahlenbereich überschritten": "Number range exceeded",
  "Keine Werte": "No values",
  fehlerhaft: "with errors",
  // filter operators
  "liegt im relativen Zeitraum": "is within the relative period",
  "liegt außerhalb des relativen Zeitraums": "is outside the relative period",
  enthält: "contains",
  "enthält nicht": "does not contain",
  ist: "is",
  "ist nicht": "is not",
  "größer als": "greater than",
  "größer oder gleich": "greater than or equal",
  "kleiner als": "less than",
  "kleiner oder gleich": "less than or equal",
  "beginnt mit": "starts with",
  "endet mit": "ends with",
  vor: "before",
  nach: "after",
  "am oder vor": "on or before",
  "am oder nach": "on or after",
  "ist leer": "is empty",
  "ist nicht leer": "is not empty",
  "ist eines von": "is any of",
  "ist keines von": "is none of",
  "enthält alle": "contains all",
  "liegt zwischen": "is between",
  "ist abgehakt": "is checked",
  "ist nicht abgehakt": "is not checked",
  "ist vollständig": "is complete",
  "ist unvollständig": "is incomplete",
  // recurrence
  Täglich: "Daily",
  Wöchentlich: "Weekly",
  Monatlich: "Monthly",
  Jährlich: "Yearly",
  Tage: "days",
  Wochen: "weeks",
  Monate: "months",
  Jahre: "years",
  // notifications
  Erwähnungen: "Mentions",
  "Kommentare und Antworten": "Comments and replies",
  "Datums-Erinnerungen": "Date reminders",
  "Automationen in Datenbanken": "Database automations",
  "Gastkommentare und Gasteinträge": "Guest comments and guest records",
  "Änderungen an Seiten, denen du folgst": "Changes to pages you follow",
  // charts
  Standard: "Default",
  Warm: "Warm",
  Kühl: "Cool",
  Pastell: "Pastel",
  "Einfarbig (Blau)": "Single colour (blue)",
  Säulen: "Columns",
  Balken: "Bars",
  Linie: "Line",
  Donut: "Donut",
  "Anzahl Einträge": "Number of records",
  Mittelwert: "Mean",
  // template categories
  Projekte: "Projects",
  Meetings: "Meetings",
  "Wissen & Dokumentation": "Knowledge & documentation",
  "Planung & Ziele": "Planning & goals",
  Persönlich: "Personal",
  Sonstiges: "Other",
  // number, date and time formats
  Zahl: "Number",
  "Zahl ohne Tausendertrennzeichen": "Number without thousands separator",
  "Zahl mit 2 Nachkommastellen": "Number with 2 decimals",
  Prozent: "Percent",
  "Kurz (24. Sept. 2026)": "Short (24 Sept 2026)",
  "Lang (24. September 2026)": "Long (24 September 2026)",
  "Numerisch (24.09.2026)": "Numeric (24.09.2026)",
  "ISO (2026-09-24)": "ISO (2026-09-24)",
  "US (09/24/2026)": "US (09/24/2026)",
  "24 Stunden": "24 hours",
  "12 Stunden": "12 hours",
};

const currencyNames = new Map(
  Object.values(currencies).map(([name, code]) => [`${name} (${code})`, code]),
);
let displayNames: Intl.DisplayNames | undefined;

export function translateLabel(text: string, locale: Locale) {
  if (locale === "de") return text;
  if (labels[text]) return labels[text];
  const code = currencyNames.get(text);
  if (code) {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "currency" });
    return `${displayNames.of(code) || code} (${code})`;
  }
  return text;
}
