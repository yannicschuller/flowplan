// Obsidian's daily notes and templates (#668): the vault's settings in
// .obsidian/ say where they are. Daily notes (core plugin "Daily notes",
// .obsidian/daily-notes.json, or the Periodic Notes plugin) whose path
// matches the configured moment.js date format become days of the journal;
// the notes of the core Templates plugin's folder (.obsidian/templates.json)
// become saved page templates, their variables {{title}}, {{date}} and
// {{time}} Flowplan's placeholders (lib/page-placeholders.ts). Both are
// switched on in the import preview unless the person turns them off.
import { posix } from "node:path";
import { ct } from "../content-locale";
import type { ImportReport } from "./types";

export type DailyConfig = { folder: string; format: string };
export type VaultConfig = { daily: DailyConfig | null; templates: { folder: string } | null };

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

function json(entries: Map<string, Buffer>, path: string): Record<string, unknown> | null {
  const data = entries.get(path);
  if (!data || data.length > 1024 * 1024) return null;
  try {
    const value = JSON.parse(data.toString("utf8").replace(/^﻿/, ""));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
// "Journal/", "/Journal", "./Journal" → "Journal"; the vault's root → "".
const folderOf = (value: unknown) =>
  str(value)
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
    .normalize("NFC");

// The daily-notes and templates settings of the vault, when it has them.
export function vaultConfig(entries: Map<string, Buffer>): VaultConfig {
  let daily: DailyConfig | null = null;
  const core = json(entries, ".obsidian/daily-notes.json");
  const periodic = json(entries, ".obsidian/plugins/periodic-notes/data.json");
  const periodicDaily = periodic?.daily && typeof periodic.daily === "object" ? (periodic.daily as Record<string, unknown>) : null;
  const plugins = json(entries, ".obsidian/core-plugins.json");
  // Older vaults: a list of enabled plugins; newer ones: { name: enabled }.
  const coreOn = Array.isArray(plugins) ? plugins.includes("daily-notes") : plugins?.["daily-notes"] === true;
  if (core) daily = { folder: folderOf(core.folder), format: str(core.format) || DEFAULT_DAILY_FORMAT };
  else if (periodicDaily?.enabled === true) daily = { folder: folderOf(periodicDaily.folder), format: str(periodicDaily.format) || DEFAULT_DAILY_FORMAT };
  else if (coreOn) daily = { folder: "", format: DEFAULT_DAILY_FORMAT };
  const templatesJson = json(entries, ".obsidian/templates.json");
  const templatesFolder = folderOf(templatesJson?.folder);
  return { daily, templates: templatesFolder ? { folder: templatesFolder } : null };
}

// Month names as moment.js writes them in English and German (Obsidian
// follows the app's language).
const MONTHS: Record<string, number> = {};
[
  ["january", "jan", "januar", "jän", "jänner"],
  ["february", "feb", "februar"],
  ["march", "mar", "märz", "mär", "mrz"],
  ["april", "apr"],
  ["may", "mai"],
  ["june", "jun", "juni"],
  ["july", "jul", "juli"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct", "oktober", "okt"],
  ["november", "nov"],
  ["december", "dec", "dezember", "dez"],
].forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));

type Field = "year" | "year2" | "month" | "monthName" | "day";
// The moment.js tokens a daily note's name may use, longest first.
const TOKENS: [string, string, Field?][] = [
  ["YYYY", "(\\d{4})", "year"],
  ["YY", "(\\d{2})", "year2"],
  ["MMMM", "([\\p{L}]+\\.?)", "monthName"],
  ["MMM", "([\\p{L}]+\\.?)", "monthName"],
  ["MM", "(\\d{2})", "month"],
  ["M", "(\\d{1,2})", "month"],
  ["Do", "(\\d{1,2})(?:st|nd|rd|th|\\.|er|e)?", "day"],
  ["DD", "(\\d{2})", "day"],
  ["D", "(\\d{1,2})", "day"],
  // Weekdays: matched, not checked.
  ["dddd", "[\\p{L}]+\\.?"],
  ["ddd", "[\\p{L}]+\\.?"],
  ["dd", "[\\p{L}]+\\.?"],
  ["d", "[0-6]"],
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export type DateFormat = { match: (name: string) => string | null } | { unsupported: string };

// A moment.js format as a matcher of note paths (without ".md"): the date
// as YYYY-MM-DD, or null. Tokens beyond the supported ones (weeks, times,
// day of the year …) make the format unsupported.
export function compileDateFormat(format: string): DateFormat {
  let source = "";
  const fields: Field[] = [];
  for (let i = 0; i < format.length; ) {
    const ch = format[i];
    if (ch === "[") {
      const end = format.indexOf("]", i + 1);
      if (end < 0) return { unsupported: format.slice(i) };
      source += escapeRe(format.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const token = TOKENS.find(([t]) => format.startsWith(t, i));
      if (!token) return { unsupported: /^([A-Za-z])\1*/.exec(format.slice(i))![0] };
      source += token[1];
      if (token[2]) fields.push(token[2]);
      i += token[0].length;
      continue;
    }
    source += escapeRe(ch);
    i++;
  }
  const has = (...f: Field[]) => f.some((x) => fields.includes(x));
  if (!has("year", "year2") || !has("month", "monthName") || !has("day")) return { unsupported: format };
  const re = new RegExp(`^${source}$`, "iu");
  return {
    match(name) {
      const m = re.exec(name.normalize("NFC"));
      if (!m) return null;
      let year = 0,
        month = 0,
        day = 0;
      fields.forEach((field, i) => {
        const value = m[i + 1];
        if (field === "year") year = Number(value);
        else if (field === "year2") year = Number(value) + (Number(value) > 68 ? 1900 : 2000);
        else if (field === "month") month = Number(value);
        else if (field === "monthName") month = MONTHS[value.toLowerCase().replace(/\.$/, "")] || 0;
        else day = Number(value);
      });
      const date = new Date(Date.UTC(year, month - 1, day));
      if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    },
  };
}

const NOTE = /\.(md|markdown)$/i;
const inside = (path: string, folder: string) => !folder || path.startsWith(`${folder}/`);

export type SpecialNotes = {
  // Daily notes by path: their day.
  journal: Map<string, string>;
  // Notes of the templates folder.
  templates: Set<string>;
  // Counted whether or not they are switched on (for the preview).
  dailyNotes: number;
  templateNotes: number;
};

// Which notes are daily notes and which templates. `use`: what the
// preview switched on; the counts are there either way.
export function specialNotes(
  notes: string[],
  config: VaultConfig,
  use: { dailyNotes: boolean; templates: boolean },
  report: ImportReport,
  warn: (message: string) => void,
): SpecialNotes {
  const result: SpecialNotes = { journal: new Map(), templates: new Set(), dailyNotes: 0, templateNotes: 0 };
  const templateFolder = config.templates?.folder;
  if (templateFolder)
    for (const path of notes)
      if (inside(path.normalize("NFC"), templateFolder)) {
        result.templateNotes++;
        if (use.templates) result.templates.add(path);
      }
  const daily = config.daily;
  if (!daily) return result;
  const format = compileDateFormat(daily.format);
  if ("unsupported" in format) {
    warn("Das Datumsformat der Daily Notes wird nicht unterstützt; sie werden als Seiten übernommen.");
    report.add(
      "other",
      ct(
        `Datumsformat „${daily.format.slice(0, 100)}“ der Daily Notes wird nicht unterstützt (${format.unsupported.slice(0, 40)}) – als Seiten übernommen`,
        `Date format “${daily.format.slice(0, 100)}” of the daily notes is not supported (${format.unsupported.slice(0, 40)}) – imported as pages`,
      ),
    );
    return result;
  }
  const nested = !daily.format.includes("/") && !!daily.folder;
  for (const path of notes) {
    const name = path.normalize("NFC").replace(NOTE, "");
    if (templateFolder && inside(name, templateFolder)) continue;
    if (!inside(name, daily.folder)) continue;
    const relative = daily.folder ? name.slice(daily.folder.length + 1) : name;
    // A daily note moved into a subfolder (an archive by year) still counts
    // when its own name is the date.
    const date = format.match(relative) ?? (nested ? format.match(posix.basename(relative)) : null);
    if (date) {
      result.dailyNotes++;
      if (use.dailyNotes) result.journal.set(path, date);
    } else if (daily.folder && use.dailyNotes)
      report.add(
        "other",
        ct(
          `Notiz im Daily-Notes-Ordner passt nicht zum Datumsformat „${daily.format.slice(0, 100)}“ – als Seite übernommen`,
          `Note in the daily notes folder does not match the date format “${daily.format.slice(0, 100)}” – imported as a page`,
        ),
        path,
      );
  }
  return result;
}

// Obsidian's template variables as Flowplan's placeholders, filled when a
// page is created from the template: {{title}} → {{Title}}, {{date}} →
// {{Today}}, {{time}} → {{Now}}. A format (":YYYY-MM-DD") has no
// counterpart and is dropped; other variables and Templater commands stay
// as written. Each change and each kept variable is reported.
export function templateVariables(markdown: string, path: string, report: ImportReport) {
  const text = markdown.replace(/\{\{\s*(title|date|time)\s*(?::\s*([^{}\n]*?))?\s*\}\}/gi, (whole, name: string, format?: string) => {
    const kind = name.toLowerCase();
    const to = kind === "title" ? "{{Title}}" : kind === "date" ? "{{Today}}" : "{{Now}}";
    if (format || kind === "time")
      report.add(
        "other",
        kind === "time"
          ? ct(
              `Vorlagen-Variable ${whole.slice(0, 80)} als ${to} übernommen – mit Datum und Uhrzeit, im Format der Einstellungen`,
              `Template variable ${whole.slice(0, 80)} imported as ${to} – with date and time, in the format of the settings`,
            )
          : ct(
              `Vorlagen-Variable ${whole.slice(0, 80)} als ${to} übernommen – im Format der Einstellungen statt ${format!.slice(0, 40)}`,
              `Template variable ${whole.slice(0, 80)} imported as ${to} – in the format of the settings instead of ${format!.slice(0, 40)}`,
            ),
        path,
      );
    return to;
  });
  for (const match of text.matchAll(/\{\{\s*([^{}\n]{1,120}?)\s*\}\}/g))
    if (!/^(Title|Today|Now)$/.test(match[1]))
      report.add(
        "other",
        ct(`Vorlagen-Variable ${match[0].slice(0, 80)} ohne Entsprechung – bleibt wie geschrieben`, `Template variable ${match[0].slice(0, 80)} has no counterpart – kept as written`),
        path,
      );
  if (/<%[\s\S]*?%>/.test(text))
    report.add("other", ct("Templater-Befehle (<% … %>) bleiben wie geschrieben", "Templater commands (<% … %>) are kept as written"), path);
  return text;
}
