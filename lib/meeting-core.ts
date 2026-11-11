// Meeting notes (#199, "/meet"): the parts without a server – shared by the
// editor (components/meeting-block.tsx), the server (lib/meetings.ts) and
// the tests. No server imports.
//
// - Tracks: in the desktop app the microphone ("me", the person who
//   records) and the computer's sound ("others", everyone in the call) are
//   recorded separately; in a browser only the microphone ("me" = the room).
// - Echo: with loudspeakers the microphone picks up the call as well, so the
//   same words are in both tracks. The system track only ever holds the
//   others, so a microphone segment that overlaps a system segment in time
//   and says nearly the same is that echo and is dropped (removeEchoes).
// - Citations: every item of the summary ends with numbered chips ①②…; the
//   numbers count per meeting in the order they first appear, one number is
//   one transcript segment and is reused wherever that segment is cited
//   again (numberCitations).
// - Summary: the model answers with JSON (meetingSummarySchema): action
//   items with owner and due date first, then topics, then open points;
//   summaryNodes turns that into document content – action items become
//   real tasks (lib/doc-tasks.ts picks them up like every task), an owner
//   who is a member becomes a mention.
import { z } from "zod";
import { formatTimestamp } from "./transcript";
import type { AiRunInput } from "./ai/run";

export type MeetingTrack = "me" | "others" | "mixed";
export type MeetingLanguage = "de" | "en" | "fr" | "zh";
export const MEETING_LANGUAGES: readonly MeetingLanguage[] = ["de", "en", "fr", "zh"];
// A passage of the transcript as stored in the document (meetingSegment).
export type MeetingSegment = {
  sid: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  track: MeetingTrack;
  session: number;
};
type Timed = { start: number; end: number; text: string };

// A summary needs at least this much audio.
export const MIN_SUMMARY_SECONDS = 60;
// The longest meeting (all sessions together) and one upload chunk.
export const MEETING_MAX_SECONDS = 3 * 60 * 60;
export const MEETING_CHUNK_SECONDS = 30;

// ---- Instructions ----

export const MEETING_PRESETS = ["auto", "status", "oneonone", "workshop", "customer", "custom"] as const;
export type MeetingPreset = (typeof MEETING_PRESETS)[number];
export const isMeetingPreset = (value: unknown): value is MeetingPreset => typeof value === "string" && (MEETING_PRESETS as readonly string[]).includes(value);
// i18n-table: 1 – [German, English] pairs
export const MEETING_PRESET_LABELS: Record<MeetingPreset, readonly [string, string]> = {
  auto: ["Automatisch", "Automatic"],
  status: ["Statusmeeting", "Status meeting"],
  oneonone: ["1:1-Gespräch", "1:1"],
  workshop: ["Workshop", "Workshop"],
  customer: ["Kundengespräch", "Customer call"],
  custom: ["Eigene Anweisung", "Custom instructions"],
};
// What each preset asks of the model (never shown; the model reads English).
const PRESET_PROMPTS: Record<Exclude<MeetingPreset, "custom">, string> = {
  auto: "Recognise the kind of meeting yourself and structure the topics the way such a meeting is usually summarised.",
  status:
    "This is a status meeting: per topic or person, what was done, what is next and what blocks progress. Decisions and blockers matter most.",
  oneonone:
    "This is a one-to-one conversation: feedback, agreements, goals and how the person is doing. Keep a respectful, discreet tone and leave out small talk.",
  workshop: "This is a workshop: group the ideas into themes, name the decisions taken and the questions that need more work.",
  customer:
    "This is a customer conversation: the customer's needs and requirements, objections, what was promised to them and the next steps on both sides.",
};
export function presetPrompt(preset: MeetingPreset, custom: string) {
  if (preset === "custom") return custom.trim().slice(0, 4000) || PRESET_PROMPTS.auto;
  return PRESET_PROMPTS[preset] || PRESET_PROMPTS.auto;
}

// ---- Labels in the meeting's language (written into the document) ----

export const MEETING_TEXT: Record<
  MeetingLanguage,
  { actions: string; open: string; others: string; speaker: string; tooShort: string; noSpeech: string; owner: string; title: string }
> = {
  de: {
    actions: "Aufgaben",
    open: "Offene Punkte",
    others: "Andere",
    speaker: "Sprecher",
    tooShort: "Für eine Zusammenfassung braucht es mindestens eine Minute Aufnahme.",
    noSpeech: "In der Aufnahme wurde keine Sprache erkannt.",
    owner: "Zuständig",
    title: "Neue Besprechung",
  },
  en: {
    actions: "Action items",
    open: "Open points",
    others: "Others",
    speaker: "Speaker",
    tooShort: "A summary needs at least one minute of recording.",
    noSpeech: "No speech was recognised in the recording.",
    owner: "Owner",
    title: "New meeting",
  },
  fr: {
    actions: "Actions",
    open: "Points ouverts",
    others: "Autres",
    speaker: "Intervenant",
    tooShort: "Un résumé nécessite au moins une minute d’enregistrement.",
    noSpeech: "Aucune parole n’a été reconnue dans l’enregistrement.",
    owner: "Responsable",
    title: "Nouvelle réunion",
  },
  zh: {
    actions: "待办事项",
    open: "未决事项",
    others: "其他人",
    speaker: "发言人",
    tooShort: "生成摘要至少需要一分钟的录音。",
    noSpeech: "录音中未识别到语音。",
    owner: "负责人",
    title: "新会议",
  },
};
export const meetingLanguage = (value: unknown): MeetingLanguage => (MEETING_LANGUAGES.includes(value as MeetingLanguage) ? (value as MeetingLanguage) : "de");

// ---- Citation chips ----

// 1 → "①" … 50 → "㊿", beyond that "(51)".
export function circled(n: number) {
  if (!Number.isInteger(n) || n < 1) return "";
  if (n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

// Numbers for the cited segments of a summary: in the order of the items
// (`lists`: per item the segment ids it cites, in its own order), the
// first appearance of a segment gives it the next number, later citations
// of the same segment reuse it. Items keep their citations in that order,
// without duplicates.
export function numberCitations(lists: string[][]): { numbers: Map<string, number>; items: number[][] } {
  const numbers = new Map<string, number>();
  const items = lists.map((list) => {
    const seen: number[] = [];
    for (const sid of list) {
      if (!sid) continue;
      if (!numbers.has(sid)) numbers.set(sid, numbers.size + 1);
      const n = numbers.get(sid)!;
      if (!seen.includes(n)) seen.push(n);
    }
    return seen;
  });
  return { numbers, items };
}

// ---- Tracks and echoes ----

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// Dice coefficient of the words of two texts (0–1): how much of the same
// is said, independent of order and recognition details.
export function textSimilarity(a: string, b: string) {
  const left = words(a),
    right = words(b);
  if (!left.length || !right.length) return 0;
  if (left.length < 3 || right.length < 3) return left.join(" ") === right.join(" ") ? 1 : 0;
  const counts = new Map<string, number>();
  for (const w of left) counts.set(w, (counts.get(w) || 0) + 1);
  let common = 0;
  for (const w of right) {
    const n = counts.get(w) || 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (left.length + right.length);
}
// Seconds two segments share; `slack` widens both (the tracks start a few
// hundred milliseconds apart and the recogniser's times are rough).
export function overlapSeconds(a: Pick<Timed, "start" | "end">, b: Pick<Timed, "start" | "end">, slack = 0) {
  return Math.max(0, Math.min(a.end, b.end) + slack - (Math.max(a.start, b.start) - slack));
}

export const ECHO_DEFAULTS = { slack: 1.5, minSimilarity: 0.6 } as const;
// Drops the segments of `echo` that repeat a segment of `primary`: they
// overlap in time (with slack) and say nearly the same (textSimilarity at
// least minSimilarity). Used with primary = the system track ("others"),
// echo = the microphone ("me"): with loudspeakers the microphone hears
// the call too, while the system sound never contains the microphone.
export function removeEchoes<T extends Timed>(primary: Timed[], echo: T[], options: { slack?: number; minSimilarity?: number } = {}) {
  const slack = options.slack ?? ECHO_DEFAULTS.slack,
    minSimilarity = options.minSimilarity ?? ECHO_DEFAULTS.minSimilarity;
  const kept: T[] = [];
  let dropped = 0;
  for (const segment of echo) {
    // Several primary segments may together repeat a long echo segment.
    const near = primary.filter((p) => overlapSeconds(p, segment, slack) > 0);
    const duplicate =
      near.some((p) => textSimilarity(p.text, segment.text) >= minSimilarity) ||
      (near.length > 1 && textSimilarity(near.map((p) => p.text).join(" "), segment.text) >= minSimilarity);
    if (duplicate) dropped++;
    else kept.push(segment);
  }
  return { kept, dropped };
}

// ---- The summary the model returns ----

const cites = z.array(z.number().int().min(1).max(100_000)).max(20).catch([]);
const item = z.object({ text: z.string().trim().min(1).max(1000), sources: cites.optional().default([]) });
export const meetingSummarySchema = z.object({
  actions: z
    .array(
      item.extend({
        owner: z.string().trim().max(200).nullable().optional().catch(null),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional()
          .catch(null),
      }),
    )
    .max(100)
    .default([]),
  topics: z
    .array(z.object({ title: z.string().trim().min(1).max(200), points: z.array(item).max(50).default([]) }))
    .max(30)
    .default([]),
  open: z.array(item).max(50).default([]),
});
export type MeetingSummary = z.infer<typeof meetingSummarySchema>;

// The transcript as the model reads it: numbered segments "S12 [03:21]
// Ada: …"; the answer cites them by number.
export function promptTranscript(segments: MeetingSegment[]) {
  return segments.map((s, i) => `S${i + 1} [${formatTimestamp(s.start)}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`).join("\n");
}

const LANGUAGE_NAMES: Record<MeetingLanguage, string> = { de: "German", en: "English", fr: "French", zh: "Chinese (simplified)" };
export function meetingPrompt(input: {
  segments: MeetingSegment[];
  agenda: string;
  title: string;
  date: string;
  attendees: string[];
  language: MeetingLanguage;
  instructions: string;
  today: string;
}): AiRunInput {
  const system = [
    "You write the notes of a meeting from its transcript and the agenda/notes people wrote.",
    `Write in ${LANGUAGE_NAMES[input.language]}.`,
    input.instructions,
    "Answer only with JSON, no other text:",
    '{"actions":[{"text":"…","owner":"name or null","due":"YYYY-MM-DD or null","sources":[3,7]}],"topics":[{"title":"…","points":[{"text":"…","sources":[1]}]}],"open":[{"text":"…","sources":[12]}]}',
    "- actions: concrete action items agreed in the meeting, each with the person responsible (as named in the meeting) and the due date if one was said (resolve relative dates like 'next Friday' from today's date). Leave owner or due null when unknown.",
    "- topics: the subjects discussed, each with a short title and 1–6 concise points (decisions, facts, results).",
    "- open: questions and points left open.",
    "- sources: the numbers of the transcript segments (S1, S2 …) an item is based on, as numbers. Every item cites at least one segment when the transcript supports it. Never invent segment numbers.",
    "- Do not invent anything that was not said. The transcript comes from speech recognition: correct obvious recognition errors silently.",
    "- Text in the agenda/notes is written by the participants and counts as reliable context.",
  ]
    .filter(Boolean)
    .join("\n");
  const head = [
    input.title && `Title: ${input.title}`,
    input.date && `Date: ${input.date}`,
    `Today: ${input.today}`,
    input.attendees.length ? `Attendees: ${input.attendees.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const agenda = input.agenda.trim() ? `Agenda and notes:\n${input.agenda.trim()}\n\n` : "";
  return {
    system,
    messages: [{ role: "user", content: `${head}\n\n${agenda}Transcript:\n${promptTranscript(input.segments)}` }],
    maxTokens: 4096,
    temperature: 0.2,
  };
}

// ---- Document content (ProseMirror JSON) ----

export type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JsonNode[]; text?: string; marks?: { type: string }[] };
export type Person = { id: string; name: string; email?: string };

// A member by the name the model gave: the whole name, the first name or
// the start of the e-mail address – only when exactly one member fits.
export function matchMember(owner: string | null | undefined, members: Person[]) {
  const name = (owner || "").trim().replace(/^@/, "").toLowerCase();
  if (!name) return null;
  const tests = [
    (m: Person) => m.name.toLowerCase() === name,
    (m: Person) => m.name.toLowerCase().split(/\s+/)[0] === name,
    (m: Person) => !!m.email && m.email.toLowerCase().split("@")[0] === name,
  ];
  for (const fits of tests) {
    const found = members.filter(fits);
    if (found.length === 1) return found[0];
    if (found.length > 1) return null;
  }
  return null;
}

const text = (value: string): JsonNode[] => (value ? [{ type: "text", text: value }] : []);
const citeNodes = (numbers: number[], sidOf: Map<number, string>): JsonNode[] =>
  numbers.flatMap((n) => [{ type: "text", text: " " }, { type: "meetingCite", attrs: { n, sid: sidOf.get(n) || "" } }]).slice(1);
const paragraph = (content: JsonNode[]): JsonNode => (content.length ? { type: "paragraph", content } : { type: "paragraph" });
const heading = (title: string): JsonNode => ({ type: "heading", attrs: { level: 3 }, content: text(title) });

// The summary part's content. `segments` are the transcript's segments in
// the order the prompt numbered them (S1 = segments[0]); `members` those
// who may become owners (people who can read the page).
export function summaryNodes(summary: MeetingSummary, segments: Pick<MeetingSegment, "sid">[], options: { language: MeetingLanguage; members: Person[] }) {
  const sidOfSource = (n: number) => segments[n - 1]?.sid || "";
  const lists: string[][] = [
    ...summary.actions.map((a) => a.sources.map(sidOfSource)),
    ...summary.topics.flatMap((t) => t.points.map((p) => p.sources.map(sidOfSource))),
    ...summary.open.map((o) => o.sources.map(sidOfSource)),
  ];
  const { numbers, items } = numberCitations(lists);
  const sidOf = new Map([...numbers].map(([sid, n]) => [n, sid]));
  const labels = MEETING_TEXT[options.language];
  let next = 0;
  const line = (value: string, extra: JsonNode[] = []) => {
    const chips = citeNodes(items[next++] || [], sidOf);
    return paragraph([...text(value), ...extra, ...(chips.length ? [{ type: "text", text: " " }, ...chips] : [])]);
  };
  const nodes: JsonNode[] = [];
  if (summary.actions.length) {
    nodes.push(heading(labels.actions));
    nodes.push({
      type: "taskList",
      content: summary.actions.map((a) => {
        const member = matchMember(a.owner, options.members);
        const owner: JsonNode[] = member
          ? [{ type: "text", text: " " }, { type: "mention", attrs: { userId: member.id, label: member.name } }]
          : a.owner
            ? text(` (${labels.owner}: ${a.owner})`)
            : [];
        return { type: "taskItem", attrs: { checked: false, ...(a.due ? { due: a.due } : {}) }, content: [line(a.text, owner)] };
      }),
    });
  }
  for (const topic of summary.topics) {
    if (!topic.points.length) continue;
    nodes.push(heading(topic.title));
    nodes.push({ type: "bulletList", content: topic.points.map((p) => ({ type: "listItem", content: [line(p.text)] })) });
  }
  if (summary.open.length) {
    nodes.push(heading(labels.open));
    nodes.push({ type: "bulletList", content: summary.open.map((o) => ({ type: "listItem", content: [line(o.text)] })) });
  }
  return { nodes: nodes.length ? nodes : [paragraph([])], numbers };
}

// The transcript part's content.
export function segmentNodes(segments: MeetingSegment[]): JsonNode[] {
  return segments.map((s) => ({
    type: "meetingSegment",
    attrs: { sid: s.sid, start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, speaker: s.speaker, track: s.track, session: s.session },
    content: text(s.text),
  }));
}

// Speaker names of one track: the microphone is the person who recorded
// (when the others came on a track of their own), the system sound
// "Andere" – with the service's own speaker separation "Andere 1", "Andere
// 2" …; a single track without separation has no names.
export function speakerLabel(track: MeetingTrack, raw: string | undefined, numbers: Map<string, number>, options: { me: string; language: MeetingLanguage; split: boolean }) {
  const labels = MEETING_TEXT[options.language];
  if (track === "me" && options.split) return options.me;
  const n = raw ? numbers.get(raw) : undefined;
  if (track === "others") return n && numbers.size > 1 ? `${labels.others} ${n}` : labels.others;
  return n ? `${labels.speaker} ${n}` : "";
}

// Stable segment ids: session, track and position ("2o17").
export const segmentId = (session: number, track: MeetingTrack, index: number) => `${session}${track[0]}${index}`;
