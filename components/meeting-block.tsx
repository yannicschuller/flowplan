"use client";
// The meeting block (#199, "/meet"): header (calendar event, title, date,
// attendees, full page, settings), recording (microphone and – in the
// desktop app – the call's sound), and the tabs Zusammenfassung · Agenda ·
// Transkript. Summary, agenda and transcript are document content
// (lib/meeting-schema.ts); this view only shows one of them at a time,
// links the citation chips ①② to their transcript passage (hover shows
// it, a click opens the transcript there and plays the kept audio) and
// talks to /api/meetings (lib/meetings.ts, lib/meeting-recorder.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import {
  ArrowClockwise,
  ArrowsIn,
  ArrowsOut,
  CalendarBlank,
  CaretDown,
  ChatCircleText,
  Gear,
  Microphone,
  Pause,
  Play,
  Plus,
  SpeakerHigh,
  Stop,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { serverMessage } from "@/lib/i18n-errors";
import { useEditorEditable } from "./editor-editable";
import { Meeting } from "@/lib/meeting-schema";
import { MEETING_PRESETS, MEETING_PRESET_LABELS, circled, type MeetingPreset, type MeetingTrack } from "@/lib/meeting-core";
import { MeetingRecorder, activeRecorder, getJson, postJson, systemAudioSupport, uploadMeetingFiles, type RecorderState } from "@/lib/meeting-recorder";
import { formatTimestamp } from "@/lib/transcript";
import { streamAiFrom } from "@/lib/ai/client";
import type { User } from "@/lib/types";

export type MeetingContext = {
  userId: string;
  pageId: string;
  rowId?: string;
  workspaceId: string;
  members: User[];
  editable: boolean;
  onError: (message: string) => void;
};
type Status = {
  status: string;
  error: string | null;
  durationMs: number;
  sessions: { n: number; state: string; byName: string }[];
  audio: { session: number; track: MeetingTrack; url: string }[];
  audioUntil: number | null;
  consentRequired: boolean;
  transcription: boolean;
};
type Settings = { consentRequired: boolean; consentText: string; defaultConsentText: string; transcription: boolean };
type Attendee = { id?: string; name: string };
type Tab = "summary" | "agenda" | "transcript";
type DayEvent = { title: string; start: string; timed: boolean; rowId?: string; pageId?: string; uid?: string; attendees?: { email: string; name: string }[] };

const parseAttendees = (raw: unknown): Attendee[] => {
  try {
    const list = JSON.parse(String(raw || "[]"));
    return Array.isArray(list) ? list.filter((a) => a && typeof a.name === "string") : [];
  } catch {
    return [];
  }
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const BUSY = new Set(["transcribing", "summarizing"]);

function MeetingView({ node, updateAttributes, editor, extension, getPos }: NodeViewProps) {
  const t = useT();
  const locale = useLocale();
  const context = (extension.options as { context: () => MeetingContext }).context();
  const hostEditable = useEditorEditable(editor);
  const canEdit = hostEditable && context.editable;
  const meetingId = String(node.attrs.meetingId || "");
  const attendees = parseAttendees(node.attrs.attendees);
  const [tab, setTab] = useState<Tab>("summary");
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [panel, setPanel] = useState<"" | "settings" | "attendees" | "events" | "consent" | "ask">("");
  const [consent, setConsent] = useState(false);
  const [recorder, setRecorder] = useState<MeetingRecorder | null>(null);
  const [recording, setRecording] = useState<RecorderState | null>(null);
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState<number | null>(null);
  const [events, setEvents] = useState<DayEvent[] | null>(null);
  const [hover, setHover] = useState<{ n: number; text: string; label: string; x: number; y: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; sids: string[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [guest, setGuest] = useState("");
  const [focus, setFocus] = useState("");
  const focusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const system = useMemo(() => systemAudioSupport(), []);

  // A block without id (old paste) or a copy of another block: its own id.
  const renew = useCallback(() => updateAttributes({ meetingId: crypto.randomUUID() }), [updateAttributes]);
  useEffect(() => {
    if (!/^[0-9a-f-]{36}$/i.test(meetingId) && canEdit) renew();
  }, [meetingId, canEdit, renew]);

  const load = useCallback(async () => {
    if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return;
    try {
      setStatus(await getJson<Status>(`/api/meetings/${meetingId}`));
    } catch (error) {
      // Not recorded yet: no row on the server.
      if ((error as { status?: number }).status !== 404) setStatus(null);
      else setStatus(null);
    }
  }, [meetingId]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void getJson<Settings>(`/api/meetings/settings?workspaceId=${context.workspaceId}`)
      .then(setSettings)
      .catch(() => {});
  }, [context.workspaceId]);
  // While the server works: ask again every few seconds.
  useEffect(() => {
    if (!status || !BUSY.has(status.status)) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [status, load]);
  // A recording that runs on while this view is drawn again.
  useEffect(() => {
    const running = recorder || activeRecorder(meetingId);
    if (!running) return;
    if (!recorder) setRecorder(running);
    return running.subscribe(setRecording);
  }, [recorder, meetingId]);

  // ---- Citation chips: hover and click (they are document content) ----
  const segmentElement = useCallback((sid: string) => root.current?.querySelector<HTMLElement>(`[data-meeting-part="transcript"] [data-segment="${CSS.escape(sid)}"]`) || null, []);
  const openSegment = useCallback(
    (sid: string) => {
      setTab("transcript");
      requestAnimationFrame(() => {
        const el = segmentElement(sid);
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        // Highlighted by a rule, not a class: the editor owns the passage's DOM.
        setFocus(sid);
        clearTimeout(focusTimer.current);
        focusTimer.current = setTimeout(() => setFocus(""), 2600);
        // Kept audio plays from there.
        const session = Number(el.getAttribute("data-session")) || 1;
        const track = (el.getAttribute("data-track") || "me") as MeetingTrack;
        const kept = status?.audio.find((a) => a.session === session && a.track === track) || status?.audio.find((a) => a.session === session);
        if (kept && audio.current) {
          // The file of a later session starts at that session's offset.
          const at = Math.max(0, Number(el.getAttribute("data-start")) - sessionOffset(session));
          if (!audio.current.src.endsWith(kept.url)) audio.current.src = kept.url;
          audio.current.currentTime = at;
          void audio.current.play().catch(() => {});
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, segmentElement],
  );
  const offsets = useRef(new Map<number, number>());
  const sessionOffset = (n: number) => offsets.current.get(n) || 0;
  useEffect(() => {
    void getJson<{ sessions: { n: number; offsetMs: number }[] }>(`/api/meetings/${meetingId}`)
      .then((s) => (offsets.current = new Map(s.sessions.map((x) => [x.n, x.offsetMs / 1000]))))
      .catch(() => {});
  }, [meetingId, status?.audio.length]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const chip = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>("sup[data-meeting-cite]") || null;
    const over = (event: MouseEvent) => {
      const c = chip(event.target);
      if (!c) return setHover(null);
      const segment = segmentElement(c.getAttribute("data-meeting-cite") || "");
      const box = c.getBoundingClientRect(),
        host = el.getBoundingClientRect();
      setHover({
        n: Number(c.getAttribute("data-n")) || 0,
        text: segment?.textContent || t("Diese Stelle ist nicht mehr im Transkript.", "This passage is no longer in the transcript."),
        label: segment?.getAttribute("data-label") || "",
        x: box.left - host.left + box.width / 2,
        y: box.bottom - host.top + 6,
      });
    };
    const click = (event: MouseEvent) => {
      const c = chip(event.target);
      if (!c) return;
      event.preventDefault();
      event.stopPropagation();
      setHover(null);
      openSegment(c.getAttribute("data-meeting-cite") || "");
    };
    el.addEventListener("mouseover", over);
    el.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("mouseover", over);
      el.removeEventListener("click", click, true);
    };
  }, [segmentElement, openSegment, t]);

  // ---- Recording ----
  const consentText = settings?.consentText?.trim() || settings?.defaultConsentText || "";
  const transcription = settings?.transcription ?? status?.transcription ?? true;
  const handle = (error: unknown) => {
    const e = error as Error & { code?: string };
    if (e.code === "copy") {
      renew();
      context.onError(t("Dieser Block war eine Kopie und hat eine eigene Aufnahme bekommen. Bitte erneut starten.", "This block was a copy and got a recording of its own. Please start again."));
      return;
    }
    context.onError(e.message);
  };
  const begin = async () => {
    if (settings?.consentRequired && !consent) return setPanel("consent");
    setPanel("");
    setNotice("");
    const next = new MeetingRecorder({
      meetingId,
      pageId: context.pageId,
      rowId: context.rowId,
      consent,
      system: system.supported,
      onError: context.onError,
    });
    try {
      await next.start();
      setRecorder(next);
      if (system.supported && next.tracks.length === 1) setNotice(systemNotice(next.systemReason));
      else if (!system.supported && system.reason !== "browser") setNotice(systemNotice(system.reason));
      await load();
    } catch (error) {
      setRecording(null);
      handle(error);
    }
  };
  const systemNotice = (reason?: string) =>
    reason === "permission"
      ? t(
          "Kein Zugriff auf den Systemton: Systemeinstellungen → Datenschutz & Sicherheit → Bildschirm- & Systemaudioaufnahme, Flowplan erlauben und neu starten. Es wird nur das Mikrofon aufgenommen.",
          "No access to the system sound: System Settings → Privacy & Security → Screen & System Audio Recording, allow Flowplan and restart it. Only the microphone is recorded.",
        )
      : reason === "update"
        ? t("Desktop-App aktualisieren, um Systemton aufzunehmen.", "Update the desktop app to record the system sound.")
        : t("Systemton ist auf diesem System nicht verfügbar – es wird nur das Mikrofon aufgenommen.", "System sound is not available on this system – only the microphone is recorded.");
  const stop = async () => {
    if (!recorder) return;
    try {
      await recorder.stop(locale);
    } catch (error) {
      handle(error);
    }
    setRecorder(null);
    setRecording(null);
    await load();
    setTab("transcript");
  };
  const uploadFiles = async (list: FileList | null) => {
    const picked = [...(list || [])].slice(0, 2);
    if (!picked.length) return;
    if (settings?.consentRequired && !consent) {
      setPanel("consent");
      return;
    }
    // Two files: the first is the microphone, the second the call.
    const chosen: Partial<Record<MeetingTrack, File>> = picked.length === 2 ? { me: picked[0], others: picked[1] } : { mixed: picked[0] };
    setUpload(0);
    try {
      await uploadMeetingFiles({ meetingId, pageId: context.pageId, rowId: context.rowId, consent, language: locale, files: chosen }, setUpload);
      await load();
    } catch (error) {
      handle(error);
    } finally {
      setUpload(null);
      if (files.current) files.current.value = "";
    }
  };
  const playConsent = () => {
    if (typeof speechSynthesis === "undefined") return;
    const utterance = new SpeechSynthesisUtterance(consentText);
    utterance.lang = locale === "de" ? "de-DE" : locale === "fr" ? "fr-FR" : locale === "zh" ? "zh-CN" : "en-US";
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  };
  const regenerate = async (instructions?: MeetingPreset) => {
    try {
      setStatus((s) => (s ? { ...s, status: "summarizing" } : s));
      await postJson(`/api/meetings/${meetingId}/summarize`, { instructions: instructions ?? node.attrs.instructions, prompt: node.attrs.prompt, language: locale });
      setTab("summary");
    } catch (error) {
      handle(error);
    }
    await load();
  };
  const retry = async () => {
    try {
      await postJson(`/api/meetings/${meetingId}/retry`, { language: locale });
    } catch (error) {
      handle(error);
    }
    await load();
  };
  const deleteAudio = async () => {
    try {
      await postJson(`/api/meetings/${meetingId}/audio/delete`, {});
    } catch (error) {
      handle(error);
    }
    await load();
  };

  // ---- "Frag diese Besprechung" ----
  const ask = async () => {
    if (!question.trim()) return;
    setAsking(true);
    let sids: string[] = [];
    try {
      const text = await streamAiFrom(
        `/api/meetings/${meetingId}/ask`,
        { question },
        {
          onResponse: (r) => {
            try {
              sids = JSON.parse(atob(r.headers.get("X-Flowplan-Segments") || "") || "[]");
            } catch {}
          },
          onText: (_piece, all) => setAnswer({ text: all, sids }),
        },
      );
      setAnswer({ text, sids });
    } catch (error) {
      handle(error);
    } finally {
      setAsking(false);
    }
  };
  const answerParts = (text: string, sids: string[]) =>
    text.split(/(\[S\d+\])/g).map((part, i) => {
      const m = /^\[S(\d+)\]$/.exec(part);
      const sid = m ? sids[Number(m[1]) - 1] : "";
      return sid ? (
        <button key={i} type="button" className="meeting-cite-button" onClick={() => openSegment(sid)} title={t("Im Transkript zeigen", "Show in transcript")}>
          {circled(Number(m![1]))}
        </button>
      ) : (
        <span key={i}>{part}</span>
      );
    });

  // ---- Calendar event ----
  const date = String(node.attrs.date || "");
  const loadEvents = async () => {
    setPanel(panel === "events" ? "" : "events");
    setEvents(null);
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setEvents((await getJson<{ events: DayEvent[] }>(`/api/meetings/events?workspaceId=${context.workspaceId}&date=${date || todayIso()}&zone=${encodeURIComponent(zone)}`)).events);
    } catch (error) {
      setEvents([]);
      handle(error);
    }
  };
  const chooseEvent = (event: DayEvent) => {
    const byMail = new Map(context.members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m]));
    const people: Attendee[] = [...attendees];
    for (const a of event.attendees || []) {
      const member = byMail.get(a.email.toLowerCase());
      const entry = member ? { id: member.id, name: member.name } : { name: a.name || a.email };
      if (!people.some((p) => (entry.id ? p.id === entry.id : p.name === entry.name))) people.push(entry);
    }
    updateAttributes({
      title: event.title || node.attrs.title,
      date: event.start.slice(0, 10) || date,
      attendees: JSON.stringify(people),
      event: event.rowId ? `row:${event.rowId}@${event.start.slice(0, 10)}` : `ics:${event.uid || event.title}@${event.start.slice(0, 10)}`,
    });
    setPanel("");
  };
  const addAttendee = (a: Attendee) => {
    if (attendees.some((p) => (a.id ? p.id === a.id : p.name === a.name))) return;
    updateAttributes({ attendees: JSON.stringify([...attendees, a]) });
  };
  const removeAttendee = (index: number) => updateAttributes({ attendees: JSON.stringify(attendees.filter((_, i) => i !== index)) });

  const busy = !!status && BUSY.has(status.status);
  const live = recording && recording.phase !== "done";
  const dateLabel = date
    ? new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))
    : t("Ohne Datum", "No date");
  const instructions = (MEETING_PRESETS as readonly string[]).includes(String(node.attrs.instructions)) ? (node.attrs.instructions as MeetingPreset) : "auto";
  const summaryEmpty = node.firstChild?.textContent.trim() === "";
  const transcriptEmpty = !node.child(2)?.childCount;
  const recorded = (status?.sessions.length || 0) > 0;
  void getPos;

  return (
    <NodeViewWrapper className={`meeting-block${expanded ? " meeting-expanded" : ""}`} data-tab={tab} ref={root} data-drag-handle="">
      <div className="meeting-head" contentEditable={false}>
        <div className="meeting-head-row">
          <button type="button" className="meeting-event" onClick={() => void loadEvents()} disabled={!canEdit} title={t("Termin aus dem Kalender wählen", "Choose an event from the calendar")}>
            <CalendarBlank size={16} />
            <CaretDown size={11} />
          </button>
          <input
            className="meeting-title-input"
            value={String(node.attrs.title || "")}
            placeholder={t("Neue Besprechung", "New meeting")}
            aria-label={t("Titel der Besprechung", "Meeting title")}
            readOnly={!canEdit}
            onChange={(e) => updateAttributes({ title: e.target.value.slice(0, 300) })}
          />
          <div className="meeting-head-actions">
            <button type="button" className="icon-button" onClick={() => setExpanded(!expanded)} aria-label={expanded ? t("Verkleinern", "Collapse") : t("Als ganze Seite", "Expand to full page")}>
              {expanded ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
            </button>
            {canEdit && (
              <button type="button" className="icon-button" onClick={() => setPanel(panel === "settings" ? "" : "settings")} aria-label={t("Einstellungen der Besprechung", "Meeting settings")}>
                <Gear size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="meeting-meta">
          <label className="meeting-date mention" title={t("Datum", "Date")}>
            @{dateLabel}
            {canEdit && <input type="date" value={date} onChange={(e) => updateAttributes({ date: e.target.value })} aria-label={t("Datum", "Date")} />}
          </label>
          {attendees.map((a, i) => (
            <span key={`${a.id || a.name}-${i}`} className={a.id ? "mention meeting-person" : "meeting-person meeting-guest"}>
              {a.id ? "@" : ""}
              {a.name}
              {canEdit && (
                <button type="button" aria-label={t(`${a.name} entfernen`, `Remove ${a.name}`)} onClick={() => removeAttendee(i)}>
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <button type="button" className="meeting-add-person" onClick={() => setPanel(panel === "attendees" ? "" : "attendees")} aria-label={t("Teilnehmende hinzufügen", "Add attendees")}>
              <Plus size={12} />
            </button>
          )}
        </div>
        {panel === "events" && (
          <div className="meeting-panel">
            {!events ? (
              <p className="muted">{t("Wird geladen …", "Loading …")}</p>
            ) : !events.length ? (
              <p className="muted">{t("An diesem Tag gibt es keine Termine.", "There are no events on this day.")}</p>
            ) : (
              events.map((e, i) => (
                <button key={i} type="button" className="meeting-choice" onClick={() => chooseEvent(e)}>
                  <strong>{e.title || t("Ohne Titel", "Untitled")}</strong>
                  {e.timed && <span className="muted"> · {new Date(e.start).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>}
                </button>
              ))
            )}
          </div>
        )}
        {panel === "attendees" && (
          <div className="meeting-panel">
            {context.members
              .filter((m) => !attendees.some((a) => a.id === m.id))
              .slice(0, 40)
              .map((m) => (
                <button key={m.id} type="button" className="meeting-choice" onClick={() => addAttendee({ id: m.id, name: m.name })}>
                  @{m.name}
                </button>
              ))}
            <form
              className="meeting-guest-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (guest.trim()) addAttendee({ name: guest.trim().slice(0, 200) });
                setGuest("");
              }}
            >
              <input value={guest} onChange={(e) => setGuest(e.target.value)} placeholder={t("Weitere Person (Name)", "Other person (name)")} aria-label={t("Weitere Person", "Other person")} />
            </form>
          </div>
        )}
        {panel === "settings" && (
          <div className="meeting-panel meeting-settings">
            <label>
              {t("Anweisungen", "Instructions")}
              <select value={instructions} onChange={(e) => updateAttributes({ instructions: e.target.value })}>
                {MEETING_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {t(MEETING_PRESET_LABELS[p][0], MEETING_PRESET_LABELS[p][1])}
                  </option>
                ))}
              </select>
            </label>
            {instructions === "custom" && (
              <textarea
                value={String(node.attrs.prompt || "")}
                maxLength={4000}
                rows={3}
                placeholder={t("z. B. „Fasse Entscheidungen und Risiken für das Projektteam zusammen.“", "e.g. “Summarise decisions and risks for the project team.”")}
                onChange={(e) => updateAttributes({ prompt: e.target.value })}
              />
            )}
            <div className="meeting-settings-buttons">
              {recorded && !transcriptEmpty && (
                <button type="button" className="button" onClick={() => void regenerate()} disabled={busy || !!live}>
                  <ArrowClockwise size={14} /> {t("Zusammenfassung neu erstellen", "Re-generate summary")}
                </button>
              )}
              {transcription && (
                <button type="button" className="button" onClick={() => files.current?.click()} disabled={busy || !!live || upload !== null}>
                  <UploadSimple size={14} /> {t("Aufnahme hochladen", "Upload recording")}
                </button>
              )}
              {!!status?.audio.length && (
                <button type="button" className="button" onClick={() => void deleteAudio()}>
                  <Trash size={14} /> {t("Audio jetzt löschen", "Delete audio now")}
                </button>
              )}
            </div>
            <p className="muted">
              {t(
                "Hochladen: M4A, MP3, WAV, AAC oder WebM – eine Datei mit allen, oder zwei Dateien (zuerst das Mikrofon, dann der Ton der Besprechung).",
                "Upload: M4A, MP3, WAV, AAC or WebM – one file with everyone, or two files (the microphone first, then the meeting's sound).",
              )}
            </p>
            <input ref={files} type="file" hidden multiple accept="audio/*,.m4a,.mp3,.wav,.aac,.webm,.ogg" onChange={(e) => void uploadFiles(e.target.files)} />
          </div>
        )}
        {panel === "consent" && (
          <div className="meeting-panel meeting-consent">
            <p>{consentText}</p>
            <label className="meeting-consent-check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              {t("Alle, die transkribiert werden, haben zugestimmt", "Everyone being transcribed has agreed")}
            </label>
            <div className="meeting-settings-buttons">
              <button type="button" className="button" onClick={playConsent}>
                <SpeakerHigh size={14} /> {t("Einwilligungshinweis abspielen", "Play consent notice")}
              </button>
              <button type="button" className="button primary" disabled={!consent} onClick={() => void begin()}>
                <Microphone size={14} /> {t("Aufnahme starten", "Start recording")}
              </button>
            </div>
          </div>
        )}
        <div className="meeting-record">
          {live ? (
            <>
              <span className={`meeting-dot${recording.phase === "recording" ? " on" : ""}`} aria-hidden />
              <span className="meeting-timer">{formatTimestamp(recording.elapsedMs / 1000)}</span>
              <span className="muted meeting-record-state">
                {recording.phase === "paused"
                  ? t("Pausiert", "Paused")
                  : recording.phase === "uploading" || recording.phase === "stopping"
                    ? t("Wird hochgeladen …", "Uploading …")
                    : recorder?.tracks.length === 2
                      ? t("Mikrofon und Systemton", "Microphone and system sound")
                      : t("Mikrofon", "Microphone")}
                {recording.offline ? ` · ${t("Keine Verbindung – Teile werden nachgereicht", "No connection – pieces will be sent later")}` : ""}
              </span>
              {recording.phase === "recording" && (
                <button type="button" className="button" onClick={() => recorder?.pause()}>
                  <Pause size={14} /> {t("Pause", "Pause")}
                </button>
              )}
              {recording.phase === "paused" && (
                <button type="button" className="button" onClick={() => recorder?.resume()}>
                  <Play size={14} /> {t("Fortsetzen", "Resume")}
                </button>
              )}
              {(recording.phase === "recording" || recording.phase === "paused") && (
                <button type="button" className="button danger" onClick={() => void stop()}>
                  <Stop size={14} /> {t("Beenden", "Stop")}
                </button>
              )}
            </>
          ) : busy ? (
            <span className="muted meeting-record-state">
              <span className="meeting-spinner" aria-hidden />
              {status!.status === "transcribing" ? t("Wird transkribiert …", "Transcribing …") : t("Zusammenfassung wird erstellt …", "Writing the summary …")}
            </span>
          ) : upload !== null ? (
            <span className="muted meeting-record-state">{t(`Wird hochgeladen … ${Math.round(upload * 100)} %`, `Uploading … ${Math.round(upload * 100)} %`)}</span>
          ) : panel === "consent" ? null : canEdit && transcription ? (
            <>
              <button type="button" className="button primary meeting-start" onClick={() => void begin()}>
                <Microphone size={14} /> {recorded ? t("Weiter aufnehmen", "Continue recording") : t("Aufnahme starten", "Start recording")}
              </button>
              {status?.status === "failed" && (
                <button type="button" className="button" onClick={() => void retry()}>
                  <ArrowClockwise size={14} /> {t("Erneut verarbeiten", "Process again")}
                </button>
              )}
              {status?.durationMs ? <span className="muted">{t(`Aufgenommen: ${formatTimestamp(status.durationMs / 1000)}`, `Recorded: ${formatTimestamp(status.durationMs / 1000)}`)}</span> : null}
            </>
          ) : canEdit ? (
            <span className="muted">{t("Transkription ist auf diesem Server nicht eingerichtet.", "Transcription is not set up on this server.")}</span>
          ) : null}
        </div>
        {(notice || status?.error) && !live && <p className="meeting-notice">{notice || serverMessage(status?.error || "")}</p>}
        {notice && live && <p className="meeting-notice">{notice}</p>}
        <div className="meeting-tabs" role="tablist">
          {(
            [
              ["summary", t("Zusammenfassung", "Summary")],
              ["agenda", t("Agenda", "Agenda")],
              ["transcript", t("Transkript", "Transcript")],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
          {!transcriptEmpty && (
            <button type="button" className={`meeting-ask-toggle${panel === "ask" ? " active" : ""}`} onClick={() => setPanel(panel === "ask" ? "" : "ask")}>
              <ChatCircleText size={14} /> {t("Frag diese Besprechung", "Ask this meeting")}
            </button>
          )}
        </div>
        {panel === "ask" && (
          <div className="meeting-panel meeting-ask">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("z. B. „Was wurde zum Budget entschieden?“", "e.g. “What was decided about the budget?”")} />
              <button className="button primary" disabled={asking || !question.trim()}>
                {t("Fragen", "Ask")}
              </button>
            </form>
            {answer && <p className="meeting-answer">{answerParts(answer.text, answer.sids)}</p>}
          </div>
        )}
        {tab === "summary" && summaryEmpty && (
          <p className="muted meeting-empty">
            {recorded ? t("Noch keine Zusammenfassung.", "No summary yet.") : t("Die Zusammenfassung erscheint nach der Aufnahme: zuerst die Aufgaben, dann die Themen und offenen Punkte.", "The summary appears after the recording: action items first, then topics and open points.")}
          </p>
        )}
        {tab === "transcript" && transcriptEmpty && <p className="muted meeting-empty">{t("Noch kein Transkript.", "No transcript yet.")}</p>}
        {tab === "agenda" && <p className="muted meeting-agenda-hint">{t("Eigene Notizen und Agenda – vor, während und nach der Besprechung; sie fließen in die Zusammenfassung ein.", "Your own notes and agenda – before, during and after the meeting; they go into the summary.")}</p>}
      </div>
      {focus && <style>{`.meeting-block [data-segment="${CSS.escape(focus)}"]{background:color-mix(in srgb,var(--blue) 14%,var(--bg))}`}</style>}
      <NodeViewContent className="meeting-content" />
      {hover && (
        <div className="meeting-cite-popover" contentEditable={false} style={{ left: hover.x, top: hover.y }} role="tooltip">
          <span className="meeting-cite-popover-head">
            {circled(hover.n)} {hover.label}
          </span>
          {hover.text}
        </div>
      )}
      <audio ref={audio} className="meeting-audio" controls hidden={!status?.audio.length} preload="none" />
    </NodeViewWrapper>
  );
}

export const meetingNode = (context: () => MeetingContext) =>
  Meeting.extend({
    addOptions() {
      return { context };
    },
    addNodeView() {
      return ReactNodeViewRenderer(MeetingView, {
        // The header's inputs and buttons handle their own events.
        stopEvent: ({ event }) => !!(event.target as HTMLElement)?.closest?.(".meeting-head, .meeting-cite-popover, .meeting-audio"),
      });
    },
  });
