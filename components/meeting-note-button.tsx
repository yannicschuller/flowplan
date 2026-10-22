"use client";
// Next to an appointment of a journal day: "Besprechungsnotiz anlegen"
// creates a meeting note (lib/meeting-notes.ts) and opens it; once there is
// one, "Notiz öffnen".
import { useState } from "react";
import { NotePencil } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";

export type NoteEvent = {
  title: string;
  start: string;
  end: string;
  timed: boolean;
  pageId?: string;
  rowId?: string;
  uid?: string;
  attendees?: { email: string; name: string }[];
  noteId?: string;
};

export function MeetingNoteButton({ dayId, event, editable, onError }: { dayId: string; event: NoteEvent; editable: boolean; onError: (message: string) => void }) {
  const t = useT();
  const [noteId, setNoteId] = useState(event.noteId || "");
  const [busy, setBusy] = useState(false);
  if (noteId)
    return (
      <a className="text-button meeting-note-link" href={`/#page=${noteId}`}>
        <NotePencil size={14} aria-hidden="true" /> {t("Notiz öffnen", "Open note")}
      </a>
    );
  if (!editable) return null;
  const create = async () => {
    setBusy(true);
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const { noteId: _ignored, ...data } = event;
      void _ignored;
      const created = await api<{ id: string }>("/api/command", { action: "meeting.note", pageId: dayId, zone, event: data });
      setNoteId(created.id);
      location.hash = `page=${created.id}`;
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="text-button meeting-note-link" disabled={busy} onClick={() => void create()}>
      <NotePencil size={14} aria-hidden="true" /> {t("Besprechungsnotiz anlegen", "Create meeting note")}
    </button>
  );
}
