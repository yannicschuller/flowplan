// The meeting block (#199, "/meet") in the document schema – server and
// editor. Everything a person reads lives in the document, so versions,
// exports, archives, share links and copies carry it:
//
//   meeting (title, date, attendees, calendar event, instructions)
//     meetingSummary     the AI's notes: tasks, topics, open points (rich text)
//     meetingAgenda      the participants' own agenda and notes (rich text)
//     meetingTranscript  meetingSegment* – one passage each, with its time,
//                        speaker, track and recording session
//
// Citation chips (meetingCite, ①②…) in the summary point at a segment by
// its id. The recording, its processing and the kept audio are in the
// meetings table (lib/meetings.ts), keyed by the block's meetingId. The
// editor draws the block with components/meeting-block.tsx.
import { Node } from "@tiptap/core";
import { circled } from "./meeting-core";
import { formatTimestamp } from "./transcript";

const attr = (name: string, fallback = "") => ({
  default: fallback,
  parseHTML: (el: HTMLElement) => el.getAttribute(name) ?? fallback,
  renderHTML: () => ({}),
});
const num = (value: string | null) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const MEETING_ID = /^[0-9a-f-]{36}$/i;

export const Meeting = Node.create({
  name: "meeting",
  group: "block",
  content: "meetingSummary meetingAgenda meetingTranscript",
  defining: true,
  isolating: true,
  draggable: true,
  addAttributes() {
    return {
      meetingId: attr("data-meeting"),
      title: attr("data-meeting-title"),
      date: attr("data-meeting-date"),
      // JSON: [{ id?: user id, name }]
      attendees: attr("data-meeting-attendees", "[]"),
      // The calendar event it belongs to ("row:<id>@<date>" / "ics:<uid>@<date>").
      event: attr("data-meeting-event"),
      instructions: attr("data-meeting-instructions", "auto"),
      prompt: attr("data-meeting-prompt"),
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-meeting]",
      priority: 1000,
      contentElement: ".meeting-parts",
      getAttrs: (el) => (MEETING_ID.test((el as HTMLElement).getAttribute("data-meeting") || "") ? null : false),
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-meeting": node.attrs.meetingId,
      "data-meeting-title": node.attrs.title,
      "data-meeting-date": node.attrs.date,
      "data-meeting-attendees": node.attrs.attendees,
      "data-meeting-event": node.attrs.event,
      "data-meeting-instructions": node.attrs.instructions,
      "data-meeting-prompt": node.attrs.prompt,
      class: "meeting-block",
    },
    ["p", { class: "meeting-title" }, String(node.attrs.title || "")],
    ["div", { class: "meeting-parts" }, 0],
  ],
});

const part = (name: string, kind: string, content: string) =>
  Node.create({
    name,
    content,
    defining: true,
    isolating: true,
    parseHTML: () => [{ tag: `div[data-meeting-part="${kind}"]`, priority: 1000 }],
    renderHTML: () => ["div", { "data-meeting-part": kind, class: `meeting-part meeting-${kind}` }, 0],
  });
export const MeetingSummary = part("meetingSummary", "summary", "block+");
export const MeetingAgenda = part("meetingAgenda", "agenda", "block+");
export const MeetingTranscript = part("meetingTranscript", "transcript", "meetingSegment*");

export const MeetingSegmentNode = Node.create({
  name: "meetingSegment",
  content: "text*",
  marks: "",
  defining: true,
  addAttributes() {
    return {
      sid: attr("data-segment"),
      start: { default: 0, parseHTML: (el: HTMLElement) => num(el.getAttribute("data-start")), renderHTML: () => ({}) },
      end: { default: 0, parseHTML: (el: HTMLElement) => num(el.getAttribute("data-end")), renderHTML: () => ({}) },
      speaker: attr("data-speaker"),
      track: attr("data-track", "mixed"),
      session: { default: 1, parseHTML: (el: HTMLElement) => num(el.getAttribute("data-session")) || 1, renderHTML: () => ({}) },
    };
  },
  parseHTML: () => [{ tag: "p[data-segment]", priority: 1000 }],
  renderHTML: ({ node }) => [
    "p",
    {
      "data-segment": node.attrs.sid,
      "data-start": String(node.attrs.start),
      "data-end": String(node.attrs.end),
      "data-speaker": node.attrs.speaker,
      "data-track": node.attrs.track,
      "data-session": String(node.attrs.session),
      // Shown before the text (CSS), so exports read "03:21 · Ada".
      "data-label": `${formatTimestamp(Number(node.attrs.start) || 0)}${node.attrs.speaker ? ` · ${node.attrs.speaker}` : ""}`,
      class: "meeting-segment",
    },
    0,
  ],
});

export const MeetingCite = Node.create({
  name: "meetingCite",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      n: { default: 1, parseHTML: (el: HTMLElement) => num(el.getAttribute("data-n")) || 1, renderHTML: () => ({}) },
      sid: attr("data-meeting-cite"),
    };
  },
  parseHTML: () => [{ tag: "sup[data-meeting-cite]", priority: 1000 }],
  renderHTML: ({ node }) => ["sup", { "data-meeting-cite": node.attrs.sid, "data-n": String(node.attrs.n), class: "meeting-cite" }, circled(Number(node.attrs.n))],
});

export const meetingExtensions = [Meeting, MeetingSummary, MeetingAgenda, MeetingTranscript, MeetingSegmentNode, MeetingCite];

// The empty block as HTML (inserted by the API, the journal's meeting note).
export function meetingHtml(o: { meetingId: string; title: string; date?: string; attendees?: { id?: string; name: string }[]; event?: string; instructions?: string; prompt?: string }) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return (
    `<div data-meeting="${esc(o.meetingId)}" data-meeting-title="${esc(o.title)}" data-meeting-date="${esc(o.date || "")}" data-meeting-attendees="${esc(JSON.stringify(o.attendees || []))}"` +
    ` data-meeting-event="${esc(o.event || "")}" data-meeting-instructions="${esc(o.instructions || "auto")}" data-meeting-prompt="${esc(o.prompt || "")}" class="meeting-block">` +
    `<p class="meeting-title">${esc(o.title)}</p><div class="meeting-parts">` +
    `<div data-meeting-part="summary"><p></p></div><div data-meeting-part="agenda"><p></p></div><div data-meeting-part="transcript"></div></div></div>`
  );
}
