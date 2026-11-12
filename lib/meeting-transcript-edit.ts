// Editing the transcript of a meeting block (#199 comment point 2):
// - locked by default: changes of this person inside a locked transcript
//   are refused (other people's and the server's changes arrive through
//   the Yjs sync and always pass);
// - a passage this person changes gets `edited`, so transcribing again
//   can warn before it replaces corrections – in a transaction of its own
//   right after the change, like the block ids (lib/block-ids-plugin.ts);
// - find and replace across one transcript.
// Which meetings are unlocked is the view's state (components/
// meeting-block.tsx), not the document's: it is kept here per meeting id.
import { getChangedRanges } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

export const transcriptEditKey = new PluginKey("meetingTranscriptEdit");

// ---- Locks (per meeting, in this window) ----

const unlocked = new Set<string>();
const listeners = new Set<() => void>();
export const transcriptUnlocked = (meetingId: string) => unlocked.has(meetingId);
export function setTranscriptUnlocked(meetingId: string, open: boolean) {
  if (open === unlocked.has(meetingId)) return;
  if (open) unlocked.add(meetingId);
  else unlocked.delete(meetingId);
  for (const listener of listeners) listener();
}
export function onTranscriptLocks(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// The meeting whose transcript holds `pos` (in `doc`), if any.
function transcriptMeetingAt(doc: PMNode, pos: number): string | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--)
    if ($pos.node(d).type.name === "meetingTranscript") return String($pos.node(d - 1).attrs.meetingId || "");
  return null;
}

// Whether a transaction of this person changes a locked transcript.
export function touchesLockedTranscript(tr: Transaction, locked: (meetingId: string) => boolean): boolean {
  if (!tr.docChanged || tr.getMeta(ySyncPluginKey) || tr.getMeta(transcriptEditKey)) return false;
  return tr.steps.some((step, i) => {
    const doc = tr.docs[i];
    const hit = (pos: number) => {
      const meeting = transcriptMeetingAt(doc, pos);
      return meeting !== null && locked(meeting);
    };
    // Attribute and node-mark steps change no range: their position counts.
    const at = (step as unknown as { pos?: number }).pos;
    if (typeof at === "number" && hit(at + 1)) return true;
    let blocked = false;
    step.getMap().forEach((from, to) => {
      if (hit(from) || hit(to)) blocked = true;
    });
    return blocked;
  });
}

type Range = { from: number; to: number };
// `edited` for the passages changed within `ranges` – not for passages that
// came whole (a pasted or inserted block, a new transcript).
export function editedSegmentsTransaction(state: EditorState, ranges: Range[]): Transaction | null {
  if (!ranges.length) return null;
  const marks: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "meetingSegment") return !node.isTextblock;
    const end = pos + node.nodeSize;
    const touched = ranges.some((r) => r.from <= end - 1 && r.to >= pos + 1 && !(r.from <= pos && r.to >= end));
    if (touched && !node.attrs.edited) marks.push(pos);
    return false;
  });
  if (!marks.length) return null;
  const tr = state.tr;
  for (const pos of marks) tr.setNodeAttribute(pos, "edited", true);
  return tr.setMeta(transcriptEditKey, true).setMeta("addToHistory", false);
}

export function transcriptEditPlugin(locked: (meetingId: string) => boolean = (id) => !transcriptUnlocked(id)) {
  let ranges: Range[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Plugin({
    key: transcriptEditKey,
    filterTransaction: (tr) => !touchesLockedTranscript(tr, locked),
    appendTransaction(transactions) {
      for (const t of transactions) {
        if (!t.docChanged) continue;
        ranges = ranges.map((r) => ({ from: t.mapping.map(r.from, -1), to: t.mapping.map(r.to, 1) }));
        if (t.getMeta(transcriptEditKey) || t.getMeta(ySyncPluginKey)) continue;
        ranges.push(...getChangedRanges(t).map((r) => r.newRange));
      }
      return null;
    },
    view: () => ({
      update(view) {
        if (!ranges.length || timer) return;
        const run = () => {
          timer = null;
          if (view.isDestroyed) return;
          if (view.composing) {
            timer = setTimeout(run, 200);
            return;
          }
          const change = editedSegmentsTransaction(view.state, ranges);
          ranges = [];
          if (change) view.dispatch(change);
        };
        timer = setTimeout(run, 0);
      },
      destroy() {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    }),
  });
}

// ---- Find and replace ----

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matcher = (find: string) => new RegExp(escape(find.trim()), "giu");

// The places of `find` (case-insensitive) in a meeting's transcript.
export function transcriptMatches(meeting: PMNode, meetingPos: number, find: string): Range[] {
  if (!find.trim()) return [];
  const found: Range[] = [];
  meeting.descendants((node, pos) => {
    if (node.type.name === "meetingSummary" || node.type.name === "meetingAgenda") return false;
    if (!node.isText) return true;
    const re = matcher(find);
    for (let m = re.exec(node.text || ""); m; m = re.exec(node.text || "")) {
      const from = meetingPos + 1 + pos + m.index;
      found.push({ from, to: from + m[0].length });
    }
    return false;
  });
  return found;
}
// Replaces every place; null when there is none. The passages count as
// edited (the plugin marks them; `markEdited` does it at once without it).
export function replaceInTranscript(state: EditorState, meetingPos: number, find: string, replace: string, o: { markEdited?: boolean } = {}) {
  const meeting = state.doc.nodeAt(meetingPos);
  if (!meeting || meeting.type.name !== "meeting") return null;
  const found = transcriptMatches(meeting, meetingPos, find);
  if (!found.length) return null;
  const tr = state.tr;
  for (const r of [...found].reverse()) {
    if (replace) tr.insertText(replace, r.from, r.to);
    else tr.delete(r.from, r.to);
  }
  if (o.markEdited) {
    const marked = editedSegmentsTransaction(state.apply(tr), found.map((r) => ({ from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) })));
    if (marked) for (const step of marked.steps) tr.step(step);
  }
  return { tr, count: found.length };
}

// ---- Counts for the view ----

export function segmentCounts(meeting: PMNode) {
  let edited = 0,
    hidden = 0,
    total = 0;
  meeting.descendants((node) => {
    if (node.type.name === "meetingSummary" || node.type.name === "meetingAgenda") return false;
    if (node.type.name !== "meetingSegment") return true;
    total++;
    if (node.attrs.edited) edited++;
    if (node.attrs.hallucination) hidden++;
    return false;
  });
  return { edited, hidden, total };
}
// Removes all passages of the transcript (an ordinary, undoable change).
export function clearTranscript(state: EditorState, meetingPos: number): Transaction | null {
  const meeting = state.doc.nodeAt(meetingPos);
  if (!meeting || meeting.type.name !== "meeting") return null;
  let start = meetingPos + 1;
  for (let i = 0; i < meeting.childCount; i++) {
    const part = meeting.child(i);
    if (part.type.name === "meetingTranscript") {
      if (!part.childCount) return null;
      return state.tr.delete(start + 1, start + part.nodeSize - 1).setMeta(transcriptEditKey, true);
    }
    start += part.nodeSize;
  }
  return null;
}
