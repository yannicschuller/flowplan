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
//   items ("owner: task", the owner only when one was named), decisions
//   with their reason, open questions with their context, then the summary
//   by topic; summaryNodes turns that into document content in this order –
//   action items become real tasks (lib/doc-tasks.ts picks them up like
//   every task), a named owner who is a member becomes a mention.
// - Not speech: silence phrases and loops Whisper makes up are marked
//   (markHallucinations), hidden and left out of the summary.
// - Live: windows transcribed while recording are merged without the
//   repeated overlap (mergeLiveWindow).
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
  // No speech (markHallucinations): hidden, not summarised.
  hallucination?: boolean;
  // Corrected by a person; `hash` is segmentHash of the transcribed text.
  edited?: boolean;
  hash?: string;
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
  {
    actions: string;
    decisions: string;
    questions: string;
    summary: string;
    open: string;
    others: string;
    speaker: string;
    tooShort: string;
    noSpeech: string;
    owner: string;
    ownerUnclear: string;
    title: string;
  }
> = {
  de: {
    actions: "Aufgaben",
    decisions: "Entscheidungen",
    questions: "Offene Fragen",
    summary: "Zusammenfassung",
    open: "Offene Punkte",
    others: "Andere",
    speaker: "Sprecher",
    tooShort: "Für eine Zusammenfassung braucht es mindestens eine Minute Aufnahme.",
    noSpeech: "In der Aufnahme wurde keine Sprache erkannt.",
    owner: "Zuständig",
    ownerUnclear: "unklar",
    title: "Neue Besprechung",
  },
  en: {
    actions: "Action items",
    decisions: "Decisions",
    questions: "Open questions",
    summary: "Summary",
    open: "Open points",
    others: "Others",
    speaker: "Speaker",
    tooShort: "A summary needs at least one minute of recording.",
    noSpeech: "No speech was recognised in the recording.",
    owner: "Owner",
    ownerUnclear: "unclear",
    title: "New meeting",
  },
  fr: {
    actions: "Actions",
    decisions: "Décisions",
    questions: "Questions ouvertes",
    summary: "Résumé",
    open: "Points ouverts",
    others: "Autres",
    speaker: "Intervenant",
    tooShort: "Un résumé nécessite au moins une minute d’enregistrement.",
    noSpeech: "Aucune parole n’a été reconnue dans l’enregistrement.",
    owner: "Responsable",
    ownerUnclear: "non précisé",
    title: "Nouvelle réunion",
  },
  zh: {
    actions: "待办事项",
    decisions: "决定",
    questions: "未决问题",
    summary: "摘要",
    open: "未决事项",
    others: "其他人",
    speaker: "发言人",
    tooShort: "生成摘要至少需要一分钟的录音。",
    noSpeech: "录音中未识别到语音。",
    owner: "负责人",
    ownerUnclear: "未明确",
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
// without duplicates, at most MAX_SOURCES each.
export function numberCitations(lists: string[][]): { numbers: Map<string, number>; items: number[][] } {
  const numbers = new Map<string, number>();
  const items = lists.map((list) => {
    const seen: number[] = [];
    for (const sid of list) {
      if (!sid) continue;
      if (seen.length >= MAX_SOURCES) break;
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

// ---- Not speech: what the recogniser makes up ----

// Whisper fills silence and noise with lines from its training material
// (subtitle credits, "Thanks for watching") and sometimes repeats a line
// over and over. Such segments are marked `hallucination`: the transcript
// hides them by default and the summary ignores them – nothing is deleted.
const normal = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
// Never said in a meeting.
const MADE_UP = [
  /untertitel(ung)? (im auftrag )?(des|der|vom) (zdf|ard|wdr|br|ndr|swr|hr|mdr|funk)/,
  /untertitel (der|von der|von) amara/,
  /\bamara org\b/,
  /^(copyright )?(wdr|zdf|swr|ard|ndr) 20\d\d/,
  /(vielen dank|danke) (fürs|für s|für das|für\'s) zu(schauen|sehen|hören)/,
  /^(thanks|thank you) (so much |very much )?for (watching|listening)/,
  /^(please )?(like (and|&) )?subscribe\b/,
  /^subtitles (by|made by|created by)/,
  /sous titres? (réalisés|réalisé|faits|fait|par)/,
  /^sous titrage\b/,
  /^merci d avoir regardé/,
  /^(请不吝)?点赞|订阅 转发|明镜与点点|字幕由/,
];
// Said in meetings too – made up only when nothing is said around it or
// the service doubts there is speech.
const SILENCE_PHRASE = /^(vielen dank|danke|danke schön|dankeschön|tschüss|bis zum nächsten mal|thank you|thanks|thank you very much|bye|merci|merci beaucoup|au revoir|谢谢|谢谢观看)$/;
type Heard = Timed & { noSpeechProb?: number; avgLogprob?: number; compressionRatio?: number; hallucination?: boolean };

export function hallucinationReason(segment: Heard, previous?: Timed, next?: Timed): "phrase" | "silence" | "repetition" | null {
  const text = normal(segment.text);
  if (!text) return "silence";
  if (MADE_UP.some((pattern) => pattern.test(text))) return "phrase";
  // Whisper's own thresholds: no speech with a low confidence, or text that
  // compresses too well (a loop).
  if ((segment.noSpeechProb ?? 0) >= 0.6 && (segment.avgLogprob ?? 0) <= -1) return "silence";
  if ((segment.compressionRatio ?? 0) > 2.4) return "repetition";
  const list = text.split(" ");
  if (list.length >= 8 && new Set(list).size <= 2) return "repetition";
  if (SILENCE_PHRASE.test(text)) {
    const alone = (!previous || segment.start - previous.end >= 3) && (!next || next.start - segment.end >= 3);
    if (alone || (segment.noSpeechProb ?? 0) >= 0.3) return "silence";
  }
  return null;
}

// Marks the made-up segments of one track (in time order): known phrases,
// silence, loops – and runs of three or more identical lines, of which the
// first stays.
export function markHallucinations<T extends Heard>(segments: T[]): (T & { hallucination?: boolean })[] {
  const out: (T & { hallucination?: boolean })[] = segments.map((s, i) => (hallucinationReason(s, segments[i - 1], segments[i + 1]) ? { ...s, hallucination: true } : s));
  for (let i = 0; i < out.length; ) {
    const text = normal(out[i].text);
    let j = i + 1;
    while (j < out.length && text && normal(out[j].text) === text) j++;
    if (j - i >= 3) for (let k = i + 1; k < j; k++) out[k] = { ...out[k], hallucination: true };
    i = j;
  }
  return out;
}

// ---- Corrections ----

// A short fingerprint of a segment's text (FNV-1a, 32 bit), the same in
// the browser and on the server: a segment whose text no longer matches
// the fingerprint it was transcribed with was corrected.
export function segmentHash(text: string) {
  let h = 0x811c9dc5;
  for (const char of text.replace(/\s+/g, " ").trim()) {
    h ^= char.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
export const isEdited = (segment: Pick<MeetingSegment, "text" | "edited" | "hash">) => !!segment.edited || (!!segment.hash && segment.hash !== segmentHash(segment.text));

// ---- Transcribing while recording ----

// The recording is transcribed in windows while it goes on (lib/meetings.ts):
// each window starts a little before the point up to which the transcript
// is final (`until`) and repeats what was heard there. Segments that start
// before `until` are dropped, as are those that say again what the last
// final ones said (removeEchoes); the window's last segment may be cut off
// by the window's end and stays open (`until` = its start) unless this is
// the last window.
export function mergeLiveWindow<T extends Timed>(committed: T[], until: number, window: T[], final: boolean): { committed: T[]; until: number } {
  const fresh = window.filter((s) => s.start >= until - 0.3).sort((a, b) => a.start - b.start);
  const { kept } = removeEchoes(committed.slice(-6), fresh, { slack: 1 });
  if (final) return { committed: [...committed, ...kept], until: Math.max(until, ...kept.map((s) => s.end)) };
  if (!kept.length) return { committed, until };
  const open = kept[kept.length - 1];
  return { committed: [...committed, ...kept.slice(0, -1)], until: Math.max(until, open.start) };
}

// ---- The summary the model returns ----

// The segments that best support an item (#199): at most three, the
// strongest first. A longer list is cut, not dropped.
export const MAX_SOURCES = 3;
const cites = z
  .array(z.number().int().min(1).max(100_000))
  .max(100)
  .catch([])
  .transform((numbers) => [...new Set(numbers)].slice(0, MAX_SOURCES));
const item = z.object({ text: z.string().trim().min(1).max(1000), sources: cites.optional().default([]) });
const aside = z.string().trim().max(1000).nullable().optional().catch(null);
export const meetingSummarySchema = z
  .object({
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
    decisions: z
      .array(item.extend({ reason: aside }))
      .max(50)
      .default([]),
    questions: z
      .array(item.extend({ context: aside }))
      .max(50)
      .default([]),
    topics: z
      .array(z.object({ title: z.string().trim().min(1).max(200), points: z.array(item).max(50).default([]) }))
      .max(30)
      .default([]),
    // Answers in the earlier shape: open points are open questions.
    open: z.array(item).max(50).default([]),
  })
  .transform(({ open, ...summary }) => ({ ...summary, questions: [...summary.questions, ...open.map((o) => ({ ...o, context: null }))] }));
export type MeetingSummary = z.infer<typeof meetingSummarySchema>;

// The transcript as the model reads it: numbered segments "S12 [03:21]
// Ada: …"; the answer cites them by number. Made-up segments are left out
// by the caller.
export function promptTranscript(segments: MeetingSegment[]) {
  return segments.map((s, i) => `S${i + 1} [${formatTimestamp(s.start)}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`).join("\n");
}

const LANGUAGE_NAMES: Record<MeetingLanguage, string> = { de: "German", en: "English", fr: "French", zh: "Chinese (simplified)" };
export function meetingPrompt(input: {
  segments: MeetingSegment[];
  // The participants' notes (the block's notes part), as they are now.
  agenda: string;
  title: string;
  date: string;
  attendees: string[];
  language: MeetingLanguage;
  instructions: string;
  today: string;
}): AiRunInput {
  const system = [
    "You write the notes of a meeting from its transcript and the notes the participants wrote.",
    `Write in ${LANGUAGE_NAMES[input.language]}.`,
    input.instructions,
    "Answer only with JSON, no other text, in this order:",
    '{"actions":[{"text":"…","owner":"name or null","due":"YYYY-MM-DD or null","sources":[3,7]}],"decisions":[{"text":"…","reason":"… or null","sources":[5]}],"questions":[{"text":"…","context":"… or null","sources":[12]}],"topics":[{"title":"…","points":[{"text":"…","sources":[1]}]}]}',
    "- actions: concrete action items agreed in the meeting. owner: only a person who was explicitly named as responsible (in the transcript or the notes), as named there; never guess an owner from who spoke or from context – null when nobody was named. due: only when a date or deadline was said (resolve relative dates like 'next Friday' from today's date), otherwise null.",
    "- decisions: what was decided; reason: why, in one short sentence, only when it was said (otherwise null).",
    "- questions: questions and points left open; context: what they relate to or what is needed to answer them (otherwise null).",
    "- topics: a summary by topic – the subjects discussed, each with a short title and 1–6 concise points (facts, results). Do not repeat the action items, decisions and questions there.",
    `- sources: the numbers of the 1–${MAX_SOURCES} transcript segments (S1, S2 …) that best support the item, as numbers, the strongest first – not every segment it touches. Every item cites at least one segment when the transcript supports it. Never invent segment numbers.`,
    "- Do not invent anything that was not said or written. The transcript comes from speech recognition: correct obvious recognition errors silently, and ignore lines that are not part of the conversation (subtitle credits, 'Thanks for watching', a phrase repeated over and over).",
    "- The notes are written by the participants and count as reliable context; points that are only in the notes belong in the result as well.",
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
  const notes = input.agenda.trim() ? `Notes:\n${input.agenda.trim()}\n\n` : "";
  return {
    system,
    messages: [{ role: "user", content: `${head}\n\n${notes}Transcript:\n${promptTranscript(input.segments)}` }],
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
const heading = (title: string, level = 3): JsonNode => ({ type: "heading", attrs: { level }, content: text(title) });
// A reason or context below its item.
const sub = (value: string | null | undefined): JsonNode[] =>
  value ? [{ type: "bulletList", content: [{ type: "listItem", content: [paragraph(text(value))] }] }] : [];

// The summary part's content, always in this order: action items, decisions,
// open questions, the summary by topic. `segments` are the transcript's
// segments in the order the prompt numbered them (S1 = segments[0]);
// `members` those who may become owners (people who can read the page).
// Only an owner the meeting named becomes a mention (and gets the task in
// My tasks); without one the item says "Zuständig: unklar".
export function summaryNodes(summary: MeetingSummary, segments: Pick<MeetingSegment, "sid">[], options: { language: MeetingLanguage; members: Person[] }) {
  const sidOfSource = (n: number) => segments[n - 1]?.sid || "";
  const lists: string[][] = [
    ...summary.actions.map((a) => a.sources.map(sidOfSource)),
    ...summary.decisions.map((d) => d.sources.map(sidOfSource)),
    ...summary.questions.map((q) => q.sources.map(sidOfSource)),
    ...summary.topics.flatMap((t) => t.points.map((p) => p.sources.map(sidOfSource))),
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
          : text(` (${labels.owner}: ${a.owner || labels.ownerUnclear})`);
        return { type: "taskItem", attrs: { checked: false, ...(a.due ? { due: a.due } : {}) }, content: [line(a.text, owner)] };
      }),
    });
  }
  if (summary.decisions.length) {
    nodes.push(heading(labels.decisions));
    nodes.push({ type: "bulletList", content: summary.decisions.map((d) => ({ type: "listItem", content: [line(d.text), ...sub(d.reason)] })) });
  }
  if (summary.questions.length) {
    nodes.push(heading(labels.questions));
    nodes.push({ type: "bulletList", content: summary.questions.map((q) => ({ type: "listItem", content: [line(q.text), ...sub(q.context)] })) });
  }
  const topics = summary.topics.filter((t) => t.points.length);
  if (topics.length) {
    nodes.push(heading(labels.summary));
    for (const topic of topics) {
      nodes.push(heading(topic.title, 4));
      nodes.push({ type: "bulletList", content: topic.points.map((p) => ({ type: "listItem", content: [line(p.text)] })) });
    }
  }
  return { nodes: nodes.length ? nodes : [paragraph([])], numbers };
}

// The transcript part's content.
export function segmentNodes(segments: MeetingSegment[]): JsonNode[] {
  return segments.map((s) => ({
    type: "meetingSegment",
    attrs: {
      sid: s.sid,
      start: Math.round(s.start * 10) / 10,
      end: Math.round(s.end * 10) / 10,
      speaker: s.speaker,
      track: s.track,
      session: s.session,
      hallucination: !!s.hallucination,
      edited: !!s.edited,
      hash: s.hash ?? "",
    },
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

// ---- Recording in the browser (lib/meeting-recorder.ts) ----

// Everyone in a call from a browser: Chrome and Edge share a tab's or the
// system's sound through getDisplayMedia (systemAudio: "include"); Firefox
// and Safari give no audio there, phones have no screen sharing.
export type BrowserCapture = { supported: boolean; reason?: "firefox" | "safari" | "mobile" | "unsupported" };
export function browserCaptureSupport(env: { userAgent: string; brands?: string[]; mobile?: boolean; getDisplayMedia: boolean }): BrowserCapture {
  const ua = env.userAgent || "";
  if (env.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return { supported: false, reason: "mobile" };
  if (/Firefox\/|FxiOS/i.test(ua)) return { supported: false, reason: "firefox" };
  const chromium = (env.brands || []).some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b)) || /\b(Chrome|Chromium|Edg)\/\d+/.test(ua);
  if (!chromium) return { supported: false, reason: /Safari\//.test(ua) ? "safari" : "unsupported" };
  if (!env.getDisplayMedia) return { supported: false, reason: "unsupported" };
  return { supported: true };
}
// i18n-table: 1 – [German, English] pairs
export const BROWSER_CAPTURE_HINT = [
  "Nutze Chrome oder Edge oder die Desktop-App, um alle Teilnehmenden aufzunehmen.",
  "Use Chrome or Edge or the desktop app to record all participants.",
] as const;

// Level meter: the loudness (RMS, 0–1) of a block of samples, measured
// every 100 ms per source.
export function rmsLevel(samples: ArrayLike<number>) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
// A source that has been silent for `afterMs` while another one had sound
// in that time (a muted microphone, a call without shared sound): reported
// once, again only after it had sound in between.
export const SILENT_LEVEL = 0.01;
export class SilenceWatch {
  private quietSince = new Map<string, number>();
  private loudAt = new Map<string, number>();
  private warned = new Set<string>();
  constructor(private options: { threshold?: number; afterMs?: number } = {}) {}
  update(levels: Record<string, number>, now: number): string[] {
    const threshold = this.options.threshold ?? SILENT_LEVEL,
      after = this.options.afterMs ?? 30_000;
    for (const [source, level] of Object.entries(levels)) {
      if (level >= threshold) {
        this.loudAt.set(source, now);
        this.quietSince.delete(source);
        this.warned.delete(source);
      } else if (!this.quietSince.has(source)) this.quietSince.set(source, now);
    }
    const silent: string[] = [];
    for (const [source, since] of this.quietSince) {
      if (this.warned.has(source) || now - since < after) continue;
      const others = Object.keys(levels).filter((s) => s !== source);
      if (others.some((s) => (this.loudAt.get(s) ?? -Infinity) >= since)) {
        this.warned.add(source);
        silent.push(source);
      }
    }
    return silent;
  }
}
