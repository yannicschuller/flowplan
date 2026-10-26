// Inline shorthand of quick capture: "Angebot schreiben morgen 15 Uhr
// #kunde @anna !hoch" – a due date (with time), tags, a person and a
// priority, in German, English and French. The desktop app's capture window
// shows them as chips under the text (POST /api/capture/preview) and the
// same parse runs again when the capture is saved (lib/desktop-capture.ts),
// so there is one parser for every client.
//
// Two steps, both plain functions without database access:
//   1. tokens(text, context)  – what the text says (a date, #tags, @names,
//      !priority) with its place in the text;
//   2. mapTokens(…)           – onto the properties the target database
//      actually has (the first date property, a multi-select with that tag
//      as an option, a person property, a select with priority options).
// What the target cannot take stays in the text. A chip the person removed
// (its id in `literal`) stays in the text as typed.

export type CaptureTokenKind = "date" | "tag" | "person" | "priority";
export type CaptureToken = {
  // Stable while the text around it changes: kind and the words as typed.
  id: string;
  kind: CaptureTokenKind;
  raw: string;
  start: number;
  end: number;
  // date: { date: YYYY-MM-DD, time?: HH:MM }; tag/person: the word without
  // # or @; priority: 1 (urgent) … 4 (low).
  value: { date: string; time?: string } | string | number;
};
export type ParseContext = {
  today: string;
  // "de" | "en" | "fr": decides 12/24 (December 24 in English, 12 December otherwise).
  locale?: string;
  // Chip ids the person removed: kept as text.
  literal?: readonly string[];
};

export const MAX_PARSE_TEXT = 20_000;
export const MAX_LITERAL = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---- Dates ----

const pad = (n: number) => String(n).padStart(2, "0");
function addDays(day: string, n: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
function validDay(y: number, m: number, d: number) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000 && y <= 9999)) return null;
  const value = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
}
// A day without a year: this year, or next year once it has passed.
function upcoming(today: string, m: number, d: number) {
  const year = Number(today.slice(0, 4));
  const value = validDay(year, m, d);
  if (value && value >= today) return value;
  return validDay(year + 1, m, d);
}

// Sunday = 0, as getUTCDay.
const WEEKDAYS: Record<string, number> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
// Abbreviations only with a dot or as the whole English short form.
const SHORT_WEEKDAYS = new Set(["so", "mo", "di", "mi", "do", "fr", "sa"]);
const MONTHS: Record<string, number> = {
  januar: 1, jänner: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12,
  janvier: 1, février: 2, mars: 3, avril: 4, juin: 6, juillet: 7, août: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12,
  jan: 1, feb: 2, fév: 2, mär: 3, mar: 3, apr: 4, avr: 4, jun: 6, jul: 7, juil: 7, aug: 8, sep: 9, sept: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12, déc: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const NUMBER_WORDS: Record<string, number> = {
  ein: 1, eine: 1, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
};
const COUNT = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
const count = (value: string) => (/^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value.toLowerCase()] || 0);

// Words in front of a date that belong to it ("bis morgen", "due friday",
// "pour demain") and go with it out of the title.
const LEAD = "(?:(?:bis\\s+(?:zum\\s+|zur\\s+)?|am\\s+|ab\\s+|fällig\\s+(?:am\\s+)?|on\\s+|by\\s+|due\\s+(?:on\\s+|by\\s+)?|until\\s+|le\\s+|pour\\s+(?:le\\s+)?|d'ici\\s+(?:le\\s+)?|avant\\s+(?:le\\s+)?)\\s*)?";
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

type DateRule = { re: RegExp; day: (m: RegExpExecArray, today: string, locale: string) => string | null };
const rule = (source: string, day: DateRule["day"]): DateRule => ({ re: new RegExp(`${B}${LEAD}${source}${E}`, "giu"), day });
const nextWeekday = (today: string, wanted: number, skipToday = true) => {
  const delta = (wanted - weekday(today) + 7) % 7;
  return addDays(today, delta === 0 && skipToday ? 7 : delta);
};
const DATE_RULES: DateRule[] = [
  rule("(?:day\\s+after\\s+tomorrow|übermorgen|après-demain|apres-demain)", (_m, t) => addDays(t, 2)),
  rule("(?:heute|today|aujourd'hui|aujourd’hui|tonight|heute\\s+abend|ce\\s+soir)", (_m, t) => t),
  rule("(?:morgen|tomorrow|demain)", (_m, t) => addDays(t, 1)),
  // Next week: its Monday.
  rule("(?:nächste\\s+woche|kommende\\s+woche|next\\s+week|(?:la\\s+)?semaine\\s+prochaine)", (_m, t) => nextWeekday(t, 1)),
  rule("(?:nächsten\\s+monat|next\\s+month|(?:le\\s+)?mois\\s+prochain)", (_m, t) => {
    const [y, m] = [Number(t.slice(0, 4)), Number(t.slice(5, 7))];
    return validDay(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
  }),
  rule(`(?:in|dans)\\s+${COUNT}\\s+(tagen|tag|days?|jours?|wochen|woche|weeks?|semaines?)`, (m, t) => {
    const n = count(m[1]);
    if (!n || n > 400) return null;
    return addDays(t, /^(w|s)/i.test(m[2]) ? n * 7 : n);
  }),
  // "nächsten Montag", "next friday", "vendredi prochain", "am Montag", "Mo."
  rule(`(?:(?:nächsten|nächster|kommenden|diesen|next|this|ce)\\s+)?(${WEEKDAY_NAMES})(\\.)?(?:\\s+prochain)?`, (m, t) => {
    const name = m[1].toLowerCase();
    if (SHORT_WEEKDAYS.has(name) && !m[2]) return null;
    return nextWeekday(t, WEEKDAYS[name]);
  }),
  // ISO: 2026-12-24
  rule("(\\d{4})-(\\d{2})-(\\d{2})", (m) => validDay(Number(m[1]), Number(m[2]), Number(m[3]))),
  // 24.12. / 24.12.2026 / 24.12.26
  rule("(\\d{1,2})\\.(\\d{1,2})\\.(?:(\\d{4}|\\d{2})(?![.\\d]))?", (m, t) => {
    if (!m[3]) return upcoming(t, Number(m[2]), Number(m[1]));
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validDay(year, Number(m[2]), Number(m[1]));
  }),
  // 24/12, 12/24 (English), with a year
  rule("(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?", (m, t, locale) => {
    let [a, b] = [Number(m[1]), Number(m[2])];
    // English: month first, unless the first number cannot be a month.
    const monthFirst = locale === "en" ? a <= 12 : b > 12;
    const [month, day] = monthFirst ? [a, b] : [b, a];
    [a, b] = [month, day];
    if (!m[3]) return upcoming(t, a, b);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validDay(year, a, b);
  }),
  // 24. Dezember, 24 décembre, 24 Dec 2026
  rule(`(\\d{1,2})\\.?\\s+(${MONTH_NAMES})\\.?(?:\\s+(\\d{4}))?`, (m, t) => {
    const month = MONTHS[m[2].toLowerCase()];
    return m[3] ? validDay(Number(m[3]), month, Number(m[1])) : upcoming(t, month, Number(m[1]));
  }),
  // December 24, Dec 24th, 2026
  rule(`(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, (m, t) => {
    const month = MONTHS[m[1].toLowerCase()];
    return m[3] ? validDay(Number(m[3]), month, Number(m[2])) : upcoming(t, month, Number(m[2]));
  }),
];

// Times: "15 Uhr", "um 15:30", "15.30 Uhr", "3pm", "at 3:30 pm", "15h", "à 15h30", "15:30".
const TIME_RULES: { re: RegExp; time: (m: RegExpExecArray) => string | null }[] = [
  {
    re: new RegExp(`${B}(?:(?:um|gegen|at|à|a|vers)\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*uhr${E}`, "giu"),
    time: (m) => hm(Number(m[1]), Number(m[2] || 0)),
  },
  {
    re: new RegExp(`${B}(?:(?:at|um|by)\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?(?![\\p{L}\\p{N}_])`, "giu"),
    time: (m) => {
      const h = Number(m[1]);
      if (h < 1 || h > 12) return null;
      return hm((h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0), Number(m[2] || 0));
    },
  },
  {
    re: new RegExp(`${B}(?:(?:à|a|vers)\\s+)?(\\d{1,2})h(\\d{2})?${E}`, "giu"),
    time: (m) => hm(Number(m[1]), Number(m[2] || 0)),
  },
  {
    re: new RegExp(`${B}(?:(?:um|at|à|a|gegen|vers)\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)${E}`, "giu"),
    time: (m) => hm(Number(m[1]), Number(m[2])),
  },
];
function hm(h: number, m: number) {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;
}

type Span = { start: number; end: number; raw: string };
function firstMatch<T>(text: string, rules: { re: RegExp }[], read: (index: number, m: RegExpExecArray) => T | null, taken: Span[]) {
  let best: (Span & { value: T }) | null = null;
  rules.forEach((r, index) => {
    r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      const start = m.index,
        end = m.index + m[0].length;
      if (!m[0].trim() || taken.some((s) => start < s.end && end > s.start)) continue;
      const value = read(index, m);
      if (value === null) continue;
      // The earliest in the text; at the same place the longest.
      if (!best || start < best.start || (start === best.start && end > best.end)) best = { start, end, raw: m[0], value };
      break;
    }
  });
  return best as (Span & { value: T }) | null;
}

// ---- Tokens ----

const TAG = /(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const PERSON = /(^|[\s(,;])@([\p{L}\p{N}_][\p{L}\p{N}_.\-]*)/gu;
const PRIORITY_WORDS: Record<string, number> = {
  dringend: 1, urgent: 1, urgente: 1, kritisch: 1, critical: 1, critique: 1, asap: 1,
  hoch: 2, high: 2, haute: 2, haut: 2, wichtig: 2, important: 2, élevée: 2, elevee: 2,
  mittel: 3, medium: 3, moyenne: 3, moyen: 3, normal: 3, normale: 3,
  niedrig: 4, low: 4, basse: 4, bas: 4, faible: 4, gering: 4,
  "1": 1, "2": 2, "3": 3, "4": 4, p1: 1, p2: 2, p3: 3, p4: 4,
};
const PRIORITY = /(^|[\s(,;])(!{2,3}|!(\p{L}+|\d|p\d))(?=$|[\s.,;:)!?])/giu;

const tokenId = (kind: CaptureTokenKind, raw: string) => `${kind}:${raw.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;

// Everything the text says, in the order it says it. One date (the first;
// a time next to it belongs to it), every tag and person, one priority.
export function tokens(raw: string, context: ParseContext): CaptureToken[] {
  const text = String(raw).slice(0, MAX_PARSE_TEXT);
  if (!DAY.test(context.today)) return [];
  const locale = (context.locale || "de").slice(0, 2).toLowerCase();
  const found: CaptureToken[] = [];
  const taken: Span[] = [];
  const push = (kind: CaptureTokenKind, span: Span, value: CaptureToken["value"]) => {
    found.push({ id: tokenId(kind, span.raw), kind, raw: span.raw.trim(), start: span.start + (span.raw.length - span.raw.trimStart().length), end: span.end - (span.raw.length - span.raw.trimEnd().length), value });
    taken.push(span);
  };
  // Tags, people and the priority first: "#2026-12-24" is a tag, not a date.
  for (const m of text.matchAll(TAG)) {
    const start = m.index! + m[1].length;
    const word = m[2].replace(/[-/]+$/, "");
    if (/^\d+$/.test(word)) continue; // "#27" is an issue number
    push("tag", { start, end: start + 1 + word.length, raw: `#${word}` }, word);
  }
  for (const m of text.matchAll(PERSON)) {
    const start = m.index! + m[1].length;
    const word = m[2].replace(/[.\-]+$/, "");
    push("person", { start, end: start + 1 + word.length, raw: `@${word}` }, word);
  }
  for (const m of text.matchAll(PRIORITY)) {
    const start = m.index! + m[1].length;
    const word = m[2];
    const level = word === "!!!" ? 1 : word === "!!" ? 2 : PRIORITY_WORDS[word.slice(1).toLowerCase()];
    if (!level) continue;
    if (found.some((t) => t.kind === "priority")) break;
    push("priority", { start, end: start + word.length, raw: word }, level);
  }
  const date = firstMatch(text, DATE_RULES, (index, m) => DATE_RULES[index].day(m, context.today, locale), taken);
  const time = firstMatch(text, TIME_RULES, (index, m) => TIME_RULES[index].time(m), date ? [...taken, date] : taken);
  if (date || time) {
    // A time right next to the date belongs to it ("morgen 15 Uhr", "15 Uhr morgen").
    const near = (a: Span, b: Span) => /^[\s,]*(?:um|at|à)?[\s,]*$/i.test(text.slice(Math.min(a.end, b.end), Math.max(a.start, b.start)));
    if (date && time && near(date, time)) {
      const start = Math.min(date.start, time.start),
        end = Math.max(date.end, time.end);
      push("date", { start, end, raw: text.slice(start, end) }, { date: date.value, time: time.value });
    } else if (date) push("date", date, { date: date.value });
    else if (time) push("date", time!, { date: context.today, time: time!.value });
  }
  return found.sort((a, b) => a.start - b.start);
}

// ---- Onto the target's properties ----

export type CaptureProperty = { id: string; name: string; type: string; options?: string[] };
export type CaptureMember = { id: string; name: string; email: string };
export type CaptureChip = CaptureToken & {
  // The property it fills; null when the target has none for it (the text
  // stays as typed then, and the chip says so).
  field: { id: string; name: string } | null;
  // What is written: an option, a person's id, a date (YYYY-MM-DD or with time).
  cell: unknown;
  // What the chip shows (the option, the person's name).
  label: string;
};

const norm = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const PRIORITY_LEVELS: Record<number, string[]> = {
  1: ["dringend", "urgent", "urgente", "kritisch", "critical", "critique", "sehr hoch", "very high", "tres haute", "tres eleve", "tres elevee", "hochste", "highest", "p1"],
  2: ["hoch", "high", "haute", "haut", "elevee", "eleve", "wichtig", "important", "p2"],
  3: ["mittel", "medium", "moyenne", "moyen", "normal", "normale", "p3"],
  4: ["niedrig", "low", "basse", "bas", "faible", "gering", "lowest", "p4"],
};
const priorityWords = new Set(Object.values(PRIORITY_LEVELS).flat());
// The option of a select property for a level, when it has one.
function priorityOption(options: string[] = [], level: number) {
  return options.find((o) => PRIORITY_LEVELS[level].includes(norm(o)));
}
function isPriorityField(f: CaptureProperty) {
  return f.type === "select" && (/prio/i.test(f.name) || (f.options || []).filter((o) => priorityWords.has(norm(o))).length >= 2);
}
// The due date: a property named so, otherwise the first date property.
function dueProperty(properties: CaptureProperty[]) {
  const dates = properties.filter((f) => f.type === "date");
  return dates.find((f) => /fällig|faellig|due|deadline|frist|échéance|echeance|termin|date limite/i.test(f.name)) || dates[0];
}
function personProperty(properties: CaptureProperty[]) {
  const people = properties.filter((f) => f.type === "person");
  return people.find((f) => /zuständig|zustaendig|verantwortlich|assignee|assigned|owner|responsable|assigné|assigne/i.test(f.name)) || people[0];
}
// A tag: the multi-select (then select) property with that option, the one
// named like tags first.
function tagProperty(properties: CaptureProperty[], word: string) {
  const wanted = norm(word);
  const candidates = properties
    .filter((f) => (f.type === "multiselect" || f.type === "select") && !isPriorityField(f))
    .sort((a, b) => Number(b.type === "multiselect") - Number(a.type === "multiselect") || Number(/tag|schlagw|étiquette|etiquette|label|kategorie|category|catégorie/i.test(b.name)) - Number(/tag|schlagw|étiquette|etiquette|label|kategorie|category|catégorie/i.test(a.name)));
  for (const f of candidates) {
    const option = (f.options || []).find((o) => norm(o) === wanted || norm(o).replace(/ /g, "") === wanted.replace(/ /g, ""));
    if (option) return { field: f, option };
  }
  return null;
}
// A person by @name: first name, full name without spaces, e-mail name; only
// when exactly one member fits.
export function findMember(members: CaptureMember[], word: string) {
  const wanted = norm(word).replace(/ /g, "");
  if (!wanted) return null;
  const exact = members.filter((m) => {
    const name = norm(m.name);
    return name.replace(/ /g, "") === wanted || name.split(" ")[0] === wanted || norm(m.email.split("@")[0]).replace(/ /g, "") === wanted;
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const prefix = members.filter((m) => norm(m.name).replace(/ /g, "").startsWith(wanted) || norm(m.email).startsWith(wanted));
  return prefix.length === 1 ? prefix[0] : null;
}

// The tokens as chips for a target: `properties` of its database (empty for
// a page or the journal, where only the date of a task counts).
export function mapTokens(list: CaptureToken[], properties: CaptureProperty[], members: CaptureMember[], options: { task?: boolean } = {}): CaptureChip[] {
  const chips: CaptureChip[] = [];
  const used = new Set<string>();
  for (const token of list) {
    let chip: CaptureChip = { ...token, field: null, cell: null, label: token.raw };
    if (token.kind === "date") {
      const value = token.value as { date: string; time?: string };
      const cell = value.time ? `${value.date}T${value.time}` : value.date;
      const f = dueProperty(properties);
      if (f && !used.has(f.id)) chip = { ...chip, field: { id: f.id, name: f.name }, cell };
      // A page or the journal: the due date of the task.
      else if (!properties.length && options.task) chip = { ...chip, field: { id: "task", name: "" }, cell: value.date };
      chip.label = cell;
    } else if (token.kind === "tag") {
      const found = tagProperty(properties, token.value as string);
      if (found) chip = { ...chip, field: { id: found.field.id, name: found.field.name }, cell: found.option, label: found.option };
    } else if (token.kind === "person") {
      const member = findMember(members, token.value as string);
      const f = personProperty(properties);
      if (member) chip.label = member.name || member.email;
      if (member && f && !used.has(f.id)) chip = { ...chip, field: { id: f.id, name: f.name }, cell: member.id };
      else if (member && !properties.length && options.task) chip = { ...chip, field: { id: "task", name: "" }, cell: member.id };
    } else if (token.kind === "priority") {
      const f = properties.find(isPriorityField);
      const option = f && priorityOption(f.options, token.value as number);
      if (f && option && !used.has(f.id)) chip = { ...chip, field: { id: f.id, name: f.name }, cell: option, label: option };
    }
    // Single-value properties take the first; tags of one multi-select gather.
    if (chip.field && token.kind !== "tag") used.add(chip.field.id);
    chips.push(chip);
  }
  return chips;
}

// The cells for the record: dates, people and priority as one value, tags
// of a multi-select as a list (a select takes the first).
export function cellsOf(chips: CaptureChip[], properties: CaptureProperty[]) {
  const cells: Record<string, unknown> = {};
  for (const chip of chips) {
    if (!chip.field || chip.field.id === "task") continue;
    const f = properties.find((p) => p.id === chip.field!.id);
    if (!f) continue;
    if (f.type === "multiselect") cells[f.id] = [...new Set([...((cells[f.id] as string[]) || []), chip.cell as string])];
    else if (!(f.id in cells)) cells[f.id] = chip.cell;
  }
  return cells;
}

// The text without what went into properties: spaces closed up, empty lines kept.
export function stripChips(text: string, chips: Pick<CaptureChip, "start" | "end" | "field">[]) {
  let out = text;
  for (const chip of [...chips].filter((c) => c.field).sort((a, b) => b.start - a.start)) out = out.slice(0, chip.start) + out.slice(chip.end);
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])(?=\s|$)/g, "$1").replace(/^[ \t,;]+|[ \t,;]+$/g, ""))
    .join("\n")
    .trim();
}

// The whole parse for a target: chips (without the removed ones), cells,
// and title and text without the applied shorthand.
export function parseCapture(
  text: string,
  context: ParseContext & { properties?: CaptureProperty[]; members?: CaptureMember[]; task?: boolean },
) {
  const literal = new Set((context.literal || []).slice(0, MAX_LITERAL));
  const list = tokens(text, context).filter((t) => !literal.has(t.id));
  const chips = mapTokens(list, context.properties || [], context.members || [], { task: context.task });
  const cleaned = stripChips(String(text).slice(0, MAX_PARSE_TEXT), chips);
  const [first, ...rest] = cleaned.split("\n");
  const taskChip = chips.find((c) => c.field?.id === "task" && c.kind === "date");
  const assignee = chips.find((c) => c.field?.id === "task" && c.kind === "person");
  return {
    chips,
    cells: cellsOf(chips, context.properties || []),
    title: first.trim().slice(0, 300),
    text: rest.join("\n").trim(),
    due: (taskChip?.cell as string | undefined) || undefined,
    assignee: (assignee?.cell as string | undefined) || undefined,
  };
}
