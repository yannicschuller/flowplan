"use client";
// "@" in the text of a note, text or shape (#567): the mention dialog of
// documents (components/mention-picker.tsx) opens, and the page, whiteboard,
// journal day, record or person picked goes into the text as a link,
// [Title](/#page=…) or [@Name](mention:…) (lib/whiteboard-links.ts). The
// board shows it as a link that opens the page (rich-text.tsx); the board's
// summary keeps it as a page link, so the page lists the board among its
// backlinks (lib/whiteboard.ts).
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { MentionPicker, linkJournalDay, type MentionChoice, type MentionMember, type MentionPage } from "../mention-picker";
import { atOpensMentionInText } from "@/lib/mention-trigger";
import { mentionMarkup } from "@/lib/whiteboard-richtext";
import type { Mention } from "@/lib/whiteboard-links";

// The elements whose text is rich text (lib/whiteboard-richtext.ts).
export const MENTION_TYPES = ["sticky", "text", "shape"];

export function useBoardMention({
  pageId,
  workspaceId,
  pages,
  members,
  container,
  write,
  onError,
}: {
  pageId: string;
  workspaceId?: string;
  pages: MentionPage[];
  members: MentionMember[];
  container: RefObject<HTMLElement | null>;
  // Stores the text of the element (the board's change()).
  write: (id: string, text: string) => void;
  onError: (message: string) => void;
}) {
  // Where the mention goes: the element and the selection the "@" replaces.
  const [at, setAt] = useState<{ id: string; start: number; end: number } | null>(null);
  const [query, setQuery] = useState("");
  // While the dialog is open the text field keeps its element in editing
  // (its blur does not end it); the caret comes back after the link.
  const open = useRef(false);
  const caret = useRef<number | null>(null);
  const lastKey = useRef("");
  const field = () => container.current?.querySelector<HTMLTextAreaElement>("textarea.wb-editor:not(.wb-cell-editor)") || null;

  const start = (id: string, from: number, to: number) => {
    open.current = true;
    caret.current = from;
    setQuery("");
    setAt({ id, start: from, end: to });
  };
  const close = () => {
    setAt(null);
    setQuery("");
  };
  // Puts text in place of the selection the "@" stood for.
  const insert = (text: string) => {
    const target = at;
    const el = field();
    if (!target || !el) return close();
    const value = el.value;
    const next = (value.slice(0, target.start) + text + value.slice(target.end)).slice(0, 10000);
    el.value = next;
    caret.current = Math.min(next.length, target.start + text.length);
    write(target.id, next);
    close();
  };
  const insertMention = (label: string, mention: Mention) => insert(`${mentionMarkup(label, mention)} `);
  const pick = async (choice: MentionChoice) => {
    if (choice.kind === "page") return insertMention(choice.title, { kind: "page", pageId: choice.page.id });
    if (choice.kind === "record")
      return insertMention(choice.title, { kind: "page", pageId: choice.record.id, rowId: choice.record.rowId });
    if (choice.kind === "person") return insertMention(`@${choice.member.name}`, { kind: "person", userId: choice.member.id });
    try {
      const day = await linkJournalDay(workspaceId || "", pageId, choice.date);
      insertMention(day.title, { kind: "page", pageId: day.dayId });
    } catch (e) {
      onError((e as Error).message);
      close();
    }
  };

  return {
    // Whether the text field keeps its element in editing on blur.
    holds: () => open.current,
    // "@" where a mention can start: the dialog instead of the character.
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>, id: string, type: string) {
      lastKey.current = e.key;
      if (e.key !== "@" || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing || !MENTION_TYPES.includes(type)) return false;
      const el = e.currentTarget;
      if (!atOpensMentionInText(el.value, el.selectionStart)) return false;
      e.preventDefault();
      start(id, el.selectionStart, el.selectionEnd);
      return true;
    },
    // Android's on-screen keyboards send "@" as text with the key
    // "Unidentified" (#207): the "@" just typed comes out again and the
    // dialog opens. True when the change was taken.
    onInput(el: HTMLTextAreaElement, id: string, type: string, data: string | null) {
      const key = lastKey.current;
      lastKey.current = "";
      if (data !== "@" || key === "@" || !MENTION_TYPES.includes(type)) return false;
      const end = el.selectionStart;
      if (el.value.slice(end - 1, end) !== "@" || !atOpensMentionInText(el.value, end - 1)) return false;
      el.value = el.value.slice(0, end - 1) + el.value.slice(end);
      el.setSelectionRange(end - 1, end - 1);
      start(id, end - 1, end - 1);
      return true;
    },
    picker: (
      <MentionPicker
        open={!!at}
        query={query}
        onQuery={setQuery}
        onPick={(choice) => void pick(choice)}
        // Left without a hit: the "@" and the search go into the text.
        onUnmatched={() => insert(`@${query}`)}
        onClose={close}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          open.current = false;
          const el = field();
          if (!el) return;
          el.focus({ preventScroll: true });
          const to = caret.current ?? el.value.length;
          el.setSelectionRange(to, to);
        }}
        pages={pages}
        members={members}
        workspaceId={workspaceId}
        excludePageId={pageId}
      />
    ),
  };
}
