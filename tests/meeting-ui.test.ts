// The meeting block's interface helpers (#229, #199 comment): pickers,
// the calm state after a recording, adapters to the processing side, and
// editing the transcript (lock, `edited`, find and replace, hidden lines).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

const ui = await import("../lib/meeting-ui");
const edit = await import("../lib/meeting-transcript-edit");
const { rewriteSchema } = await import("../lib/document-rewrite");
const { htmlJson } = await import("../lib/document-server");
const { meetingHtml } = await import("../lib/meeting-schema");

const MID = "0a1b2c3d-1111-4222-8333-444455556666";
function meetingState(segments: { sid: string; text: string; hallucination?: boolean; edited?: boolean }[]) {
  const html = meetingHtml({ meetingId: MID, title: "Wochentermin" }).replace(
    '<div data-meeting-part="transcript"></div>',
    `<div data-meeting-part="transcript">${segments
      .map(
        (s, i) =>
          `<p data-segment="${s.sid}" data-start="${i * 5}" data-end="${i * 5 + 4}" data-speaker="Ada" data-track="me" data-session="1"${s.hallucination ? ' data-hallucination="1"' : ""}${s.edited ? ' data-edited="1"' : ""}>${s.text}</p>`,
      )
      .join("")}</div>`,
  );
  const schema = rewriteSchema();
  const doc = schema.nodeFromJSON(htmlJson(`<p>Davor</p>${html}`));
  return EditorState.create({ schema, doc });
}
const meetingPos = (state: EditorState) => {
  let found = -1;
  state.doc.forEach((node, offset) => {
    if (node.type.name === "meeting") found = offset;
  });
  return found;
};
const segmentPos = (state: EditorState, sid: string) => {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "meetingSegment" && node.attrs.sid === sid) found = pos;
    return found < 0;
  });
  return found;
};

test("attendee picker: members by name or e-mail, word starts first, taken ones left out", () => {
  const members = [
    { id: "1", name: "Ada Lovelace", email: "ada@example.org" },
    { id: "2", name: "Grace Hopper", email: "grace@example.org" },
    { id: "3", name: "Linus Ådahl", email: "linus@example.org" },
    { id: "4", name: "Bob", email: "bob@navy.example" },
  ];
  assert.deepEqual(
    ui.matchMembers(members, "ada", []).map((m) => m.id),
    ["1", "3"],
  );
  assert.deepEqual(
    ui.matchMembers(members, "navy", []).map((m) => m.id),
    ["4"],
  );
  assert.deepEqual(
    ui.matchMembers(members, "", [{ id: "2" }]).map((m) => m.id),
    ["1", "4", "3"],
  );
  assert.equal(ui.guestName("  Gast   Grace ", members), "Gast Grace");
  assert.equal(ui.guestName("ada lovelace", members), "");
  assert.equal(ui.guestName("   ", members), "");
});

test("event picker: calendar appointments grouped by calendar and time, dated records apart", () => {
  const { calendars, others } = ui.groupEvents([
    { title: "Sync", start: "2026-11-12T08:23", timed: true, source: "Sync-Log", calendar: false },
    { title: "Kunde", start: "2026-11-12T14:30", timed: true, source: "Kalender", calendar: true },
    { title: "Weekly", start: "2026-11-12T09:00", timed: true, source: "Team", calendar: true },
    { title: "Urlaub", start: "2026-11-12", timed: false, source: "Team", calendar: true },
    // An older server without the flag: an appointment.
    { title: "Alt", start: "2026-11-12T10:00", timed: true, source: "Team" },
  ]);
  assert.deepEqual(
    calendars.map((g) => [g.source, g.events.map((e) => e.title)]),
    [
      ["Team", ["Urlaub", "Weekly", "Alt"]],
      ["Kalender", ["Kunde"]],
    ],
  );
  assert.deepEqual(
    others.map((e) => e.title),
    ["Sync"],
  );
});

test("calm state: one quiet line after processing, the error with its action, an interrupted session", () => {
  const base = { error: null, durationMs: 2481000, audio: [], sessions: [{ n: 1, state: "done", by: "u1", byName: "Ada" }] };
  const o = { userId: "u1", transcript: true, summary: true, recordingHere: false };
  assert.deepEqual(ui.calmState(null, o), { kind: "new" });
  assert.deepEqual(ui.calmState({ ...base, status: "new", sessions: [] }, o), { kind: "new" });
  assert.deepEqual(ui.calmState({ ...base, status: "done" }, o), { kind: "done", durationMs: 2481000, transcribed: true, summarized: true, note: "" });
  assert.deepEqual(ui.calmState({ ...base, status: "done", error: "Zu kurz." }, o), { kind: "done", durationMs: 2481000, transcribed: true, summarized: true, note: "Zu kurz." });
  assert.deepEqual(ui.calmState({ ...base, status: "failed", error: "Kaputt." }, o), { kind: "failed", error: "Kaputt." });
  assert.deepEqual(ui.calmState({ ...base, status: "summarizing" }, o), { kind: "busy" });
  const open = { ...base, status: "recording", sessions: [...base.sessions, { n: 2, state: "recording", by: "u1", byName: "Ada" }] };
  assert.deepEqual(ui.calmState(open, o), { kind: "interrupted" });
  assert.deepEqual(ui.calmState(open, { ...o, userId: "u2" }), { kind: "elsewhere", name: "Ada" });
  // Recording here: the live controls show instead.
  assert.equal(ui.calmState(open, { ...o, recordingHere: true }).kind, "done");
});

test("adapters: error detail, re-transcription, glossary, levels and the silent source", () => {
  assert.equal(ui.errorDetail({ errorDetail: " RangeError: x " }), "RangeError: x");
  assert.equal(ui.errorDetail({ error_detail: "ECONNREFUSED" }), "ECONNREFUSED");
  assert.equal(ui.errorDetail({}), "");
  assert.equal(ui.canRetranscribe({ status: "done", audio: [{}] }), true);
  assert.equal(ui.canRetranscribe({ status: "transcribing", audio: [{}] }), false);
  assert.equal(ui.canRetranscribe({ status: "done", audio: [] }), false);
  assert.equal(ui.errorDetail({ errorDetail: null }), "");
  assert.equal(ui.glossaryOf({}), null);
  assert.deepEqual(ui.glossaryOf({ glossary: "BANF, Ariba\nVIM" }), ["BANF", "Ariba", "VIM"]);
  assert.deepEqual(ui.withGlossaryEntry({ glossary: ["Maier"] }, "maier"), ["Maier"]);
  assert.deepEqual(ui.withGlossaryEntry({ glossary: ["BANF"] }, " Maier "), ["BANF", "Maier"]);
  assert.equal(ui.withGlossaryEntry({ glossary: "BANF" }, "Maier"), "BANF\nMaier");
  assert.equal(ui.transcriptEditableByDefault({ transcriptEditable: true }), true);
  assert.equal(ui.transcriptEditableByDefault({}), false);
  assert.deepEqual(ui.normalizeLevels({ me: 0.5, others: 3 }), { me: 0.5, others: 1 });
  assert.deepEqual(ui.normalizeLevels({ levels: { mixed: -1 } }), { mixed: 0 });
  assert.deepEqual(ui.normalizeLevels("others", 0.25), { others: 0.25 });
  assert.equal(ui.silentSourceOf({ silentSource: "others" }), "others");
  assert.equal(ui.silentSourceOf(null, { silent: "me" }), "me");
  assert.equal(ui.silentSourceOf({ silentSource: "x" }), null);
});

test("the segment flags and the meeting's language survive HTML", () => {
  const state = meetingState([
    { sid: "s1", text: "Hallo", edited: true },
    { sid: "s2", text: "Untertitel im Auftrag des ZDF", hallucination: true },
  ]);
  const meeting = state.doc.nodeAt(meetingPos(state))!;
  assert.deepEqual(edit.segmentCounts(meeting), { edited: 1, hidden: 1, total: 2 });
  const schema = rewriteSchema();
  const withLanguage = schema.nodeFromJSON(htmlJson(meetingHtml({ meetingId: MID, title: "x" }).replace("<div data-meeting=", '<div data-meeting-language="fr" data-meeting=')));
  assert.equal(withLanguage.firstChild!.attrs.language, "fr");
});

test("a locked transcript refuses local changes; unlocked, changed passages get `edited`", () => {
  let state = meetingState([
    { sid: "s1", text: "Herr Mayr kommt" },
    { sid: "s2", text: "Danke" },
  ]);
  const inside = segmentPos(state, "s1") + 3;
  const typing = state.tr.insertText("x", inside);
  assert.equal(edit.touchesLockedTranscript(typing, () => true), true);
  assert.equal(edit.touchesLockedTranscript(typing, () => false), false);
  // The sync (other people, the server) always passes.
  assert.equal(edit.touchesLockedTranscript(state.tr.insertText("x", inside).setMeta(ySyncPluginKey, { isChangeOrigin: true }), () => true), false);
  // Outside the transcript: the notes and the text around stay editable.
  assert.equal(edit.touchesLockedTranscript(state.tr.insertText("x", 2), () => true), false);
  // Removing the whole block is no change inside it.
  const pos = meetingPos(state);
  assert.equal(edit.touchesLockedTranscript(state.tr.delete(pos, pos + state.doc.nodeAt(pos)!.nodeSize), () => true), false);
  // The plugin's filter.
  const plugin = edit.transcriptEditPlugin(() => true);
  state = EditorState.create({ doc: state.doc, plugins: [plugin] });
  assert.equal(state.applyTransaction(state.tr.insertText("x", inside)).state.doc.eq(state.doc), true);

  // Unlocked: the typed-in passage is marked, the other one is not.
  state = meetingState([
    { sid: "s1", text: "Herr Mayr kommt" },
    { sid: "s2", text: "Danke" },
  ]);
  const typed = state.apply(state.tr.insertText("x", segmentPos(state, "s1") + 3));
  const mark = edit.editedSegmentsTransaction(typed, [{ from: segmentPos(typed, "s1") + 3, to: segmentPos(typed, "s1") + 4 }])!;
  const marked = typed.apply(mark);
  assert.equal(marked.doc.nodeAt(segmentPos(marked, "s1"))!.attrs.edited, true);
  assert.equal(marked.doc.nodeAt(segmentPos(marked, "s2"))!.attrs.edited, false);
  // A whole new transcript (pasted, inserted) is no correction.
  const whole = meetingPos(state);
  assert.equal(edit.editedSegmentsTransaction(state, [{ from: whole, to: whole + state.doc.nodeAt(whole)!.nodeSize }]), null);
});

test("find and replace across one transcript, marking the passages; clearing the transcript", () => {
  const state = meetingState([
    { sid: "s1", text: "Herr Mayr kommt" },
    { sid: "s2", text: "mayr sagt ja" },
    { sid: "s3", text: "Danke" },
  ]);
  const pos = meetingPos(state);
  assert.equal(edit.transcriptMatches(state.doc.nodeAt(pos)!, pos, "MAYR").length, 2);
  const result = edit.replaceInTranscript(state, pos, "Mayr", "Maier", { markEdited: true })!;
  assert.equal(result.count, 2);
  const next = state.apply(result.tr);
  const texts: string[] = [];
  const flags: boolean[] = [];
  next.doc.descendants((node) => {
    if (node.type.name === "meetingSegment") {
      texts.push(node.textContent);
      flags.push(node.attrs.edited);
    }
  });
  assert.deepEqual(texts, ["Herr Maier kommt", "Maier sagt ja", "Danke"]);
  assert.deepEqual(flags, [true, true, false]);
  assert.equal(edit.replaceInTranscript(state, pos, "Nobody", "x"), null);
  // Lock state per meeting, with listeners.
  let calls = 0;
  const off = edit.onTranscriptLocks(() => calls++);
  edit.setTranscriptUnlocked(MID, true);
  assert.equal(edit.transcriptUnlocked(MID), true);
  edit.setTranscriptUnlocked(MID, true);
  edit.setTranscriptUnlocked(MID, false);
  off();
  assert.equal(calls, 2);
  // Delete transcript: empty, the rest of the block stays; passes a lock.
  const cleared = state.apply(edit.clearTranscript(state, pos)!);
  const meeting = cleared.doc.nodeAt(pos)!;
  assert.equal(meeting.child(2).childCount, 0);
  assert.equal(meeting.childCount, 3);
  assert.equal(edit.touchesLockedTranscript(edit.clearTranscript(state, pos)!, () => true), false);
});

test("the meeting's language survives the server's cleaning, only as one of its languages", async () => {
  const { cleanHtml, htmlJson } = await import("../lib/document-server");
  const withLanguage = (value: string) => meetingHtml({ meetingId: MID, title: "Weekly" }).replace("<div data-meeting=", `<div data-meeting-language="${value}" data-meeting=`);
  const kept = cleanHtml(withLanguage("fr"));
  assert.match(kept, /data-meeting-language="fr"/);
  assert.equal((htmlJson(kept) as { content: { attrs: { language: string } }[] }).content[0].attrs.language, "fr");
  // Other values are emptied (the reader's language, as without one).
  for (const value of ["xx", "EN", "de-DE", "<b>", ""]) {
    const cleaned = cleanHtml(withLanguage(value));
    assert.doesNotMatch(cleaned, /data-meeting-language="[^"]/);
    assert.ok(!(htmlJson(cleaned) as { content: { attrs: { language: string } }[] }).content[0].attrs.language);
  }
});
