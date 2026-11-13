"use client";
// The meeting block (#199, "/meet"): header (calendar event, title, date,
// attendees, full page, settings), recording (microphone and – in the
// desktop app – the call's sound), and the tabs Zusammenfassung · Notizen ·
// Transkript. Summary, notes and transcript are document content
// (lib/meeting-schema.ts); this view only shows one of them at a time,
// links the citation chips ("08:17", the time of their passage) to their
// transcript passage (hover shows it, a click opens the transcript there
// and plays the kept audio) and
// talks to /api/meetings (lib/meetings.ts, lib/meeting-recorder.ts).
//
// #229: settings, attendees and the calendar event open anchored menus
// that float above the content (components/block-menu.tsx,
// components/meeting-popover.tsx) – nothing pushes the block down. One
// prominent action per state: before = start, during = stop, after = none
// (a failure: process again); "continue recording" lives in the menu.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import {
  ArrowClockwise,
  ArrowsClockwise,
  ArrowsIn,
  ArrowsOut,
  CalendarBlank,
  CaretDown,
  CaretRight,
  ChatCircleText,
  Eye,
  EyeSlash,
  Gear,
  Globe,
  Link as LinkIcon,
  LockSimple,
  LockSimpleOpen,
  MagnifyingGlass,
  Microphone,
  NotePencil,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  SpeakerHigh,
  Stop,
  Trash,
  UploadSimple,
  UserPlus,
  UsersThree,
  Warning,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { serverMessage } from "@/lib/i18n-errors";
import { useEditorEditable } from "./editor-editable";
import { Meeting, MeetingCite, MeetingTranscript } from "@/lib/meeting-schema";
import { BROWSER_CAPTURE_HINT, MEETING_LANGUAGES, MEETING_PRESETS, MEETING_PRESET_LABELS, citeAria, citeLabel, meetingSegmentIndex, type CitedSegment, type MeetingLanguage, type MeetingPreset, type MeetingTrack } from "@/lib/meeting-core";
import { MeetingRecorder, activeRecorder, getJson, postJson, systemAudioSupport, uploadMeetingFiles, type RecorderState } from "@/lib/meeting-recorder";
import {
  calmState,
  canRetranscribe,
  errorDetail,
  glossaryOf,
  groupEvents,
  guestName,
  matchMembers,
  normalizeLevels,
  silentSourceOf,
  transcriptEditableByDefault,
  withGlossaryEntry,
  type Levels,
} from "@/lib/meeting-ui";
import {
  clearTranscript,
  onTranscriptLocks,
  replaceInTranscript,
  segmentCounts,
  setTranscriptUnlocked,
  transcriptEditPlugin,
  transcriptMatches,
  transcriptUnlocked,
} from "@/lib/meeting-transcript-edit";
import { formatTimestamp } from "@/lib/transcript";
import { tr } from "@/lib/locale-tag";
import type { Node as PMNode } from "@tiptap/pm/model";
import { streamAiFrom } from "@/lib/ai/client";
import { BlockMenu, type BlockMenuClose, type BlockMenuItem, type BlockMenuView } from "./block-menu";
import { AnchoredPopover } from "./meeting-popover";
import { layerHost } from "./layer-host";
import { Avatar, Modal } from "./ui";
import type { User } from "@/lib/types";

export type MeetingContext = {
  userId: string;
  pageId: string;
  rowId?: string;
  workspaceId: string;
  members: User[];
  editable: boolean;
  onError: (message: string) => void;
  // "Link zur Besprechung kopieren": the block's link (components/editor.tsx).
  copyLink?: (pos: number) => void;
};
type Status = {
  status: string;
  error: string | null;
  durationMs: number;
  sessions: { n: number; offsetMs: number; state: string; by?: string; byName: string }[];
  audio: { session: number; track: MeetingTrack; url: string }[];
  audioUntil: number | null;
  summarizedAt?: number | null;
  consentRequired: boolean;
  transcription: boolean;
  [key: string]: unknown;
};
type Settings = { consentRequired: boolean; consentText: string; defaultConsentText: string; transcription: boolean; [key: string]: unknown };
type Attendee = { id?: string; name: string };
type Tab = "summary" | "agenda" | "transcript";
type DayEvent = {
  title: string;
  start: string;
  end?: string;
  timed: boolean;
  source?: string;
  calendar?: boolean;
  rowId?: string;
  pageId?: string;
  uid?: string;
  attendees?: { email: string; name: string }[];
};

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
// The languages by their own names (the same in every interface language).
const LANGUAGE_NAMES: Record<MeetingLanguage, string> = { de: "Deutsch", en: "English", fr: "Français", zh: "中文" };
// The separators of a menu level without empty groups.
const tidy = (items: (BlockMenuItem | false | null | undefined)[]): BlockMenuItem[] => {
  const out: BlockMenuItem[] = [];
  for (const item of items) {
    if (!item) continue;
    if (item === "separator" && (!out.length || out[out.length - 1] === "separator")) continue;
    out.push(item);
  }
  while (out[out.length - 1] === "separator") out.pop();
  return out;
};

// A level above this counts as sound again (RMS, 0–1).
const SOUND = 0.02;
// Per person and device: record everyone through the browser (Chrome/Edge),
// and microphone and call as one track.
const PREF_BROWSER = "flowplan-meeting-capture-all";
const PREF_MIX = "flowplan-meeting-mix";
const readPref = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const writePref = (key: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {}
};
const useTranscriptUnlocked = (meetingId: string) =>
  useSyncExternalStore(
    onTranscriptLocks,
    () => transcriptUnlocked(meetingId),
    () => false,
  );

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
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [picker, setPicker] = useState<"" | "attendees" | "events">("");
  const [consentOpen, setConsentOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [recorder, setRecorder] = useState<MeetingRecorder | null>(null);
  const [recording, setRecording] = useState<RecorderState | null>(null);
  const [levels, setLevels] = useState<Levels>({});
  const [silent, setSilent] = useState<MeetingTrack | null>(null);
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState<number | null>(null);
  const [events, setEvents] = useState<DayEvent[] | null>(null);
  const [hover, setHover] = useState<{ text: string; label: string; x: number; y: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; sids: string[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [toGlossary, setToGlossary] = useState(false);
  const [focus, setFocus] = useState("");
  const focusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const calendar = useRef<HTMLButtonElement>(null);
  const system = useMemo(() => systemAudioSupport(), []);
  const unlocked = useTranscriptUnlocked(meetingId);
  const language = (MEETING_LANGUAGES as readonly string[]).includes(String(node.attrs.language)) ? (node.attrs.language as MeetingLanguage) : null;
  const spoken = language || locale;
  const position = () => (typeof getPos === "function" ? getPos() : undefined);

  // A block without id (old paste) or a copy of another block: its own id.
  const renew = useCallback(() => updateAttributes({ meetingId: crypto.randomUUID() }), [updateAttributes]);
  useEffect(() => {
    if (!/^[0-9a-f-]{36}$/i.test(meetingId) && canEdit) renew();
  }, [meetingId, canEdit, renew]);

  const load = useCallback(async () => {
    if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return;
    try {
      // A block nobody recorded with yet answers an empty status ("new").
      setStatus(await getJson<Status>(`/api/meetings/${meetingId}`));
    } catch {
      setStatus(null);
    }
  }, [meetingId]);
  useEffect(() => void load(), [load]);
  const loadSettings = useCallback(
    () =>
      void getJson<Settings>(`/api/meetings/settings?workspaceId=${context.workspaceId}`)
        .then(setSettings)
        .catch(() => {}),
    [context.workspaceId],
  );
  useEffect(loadSettings, [loadSettings]);
  // The workspace may open transcripts for editing by default.
  const defaulted = useRef(false);
  useEffect(() => {
    if (!settings || defaulted.current) return;
    defaulted.current = true;
    if (transcriptEditableByDefault(settings)) setTranscriptUnlocked(meetingId, true);
  }, [settings, meetingId]);
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
  // Its levels per source, and a source that stays silent (the warning
  // goes once that source has sound again).
  useEffect(() => {
    if (!recorder) return;
    return recorder.subscribeLevels(
      (next) => {
        const read = normalizeLevels(next);
        setLevels((current) => ({ ...current, ...read }));
        setSilent((quiet) => (quiet && (read[quiet] || 0) > SOUND ? null : quiet));
      },
      (source) => setSilent(source),
    );
  }, [recorder]);

  // ---- Citation chips: hover and click (they are document content) ----
  const segmentElement = useCallback((sid: string) => root.current?.querySelector<HTMLElement>(`[data-meeting-part="transcript"] [data-segment="${CSS.escape(sid)}"]`) || null, []);
  const openSegment = useCallback(
    (sid: string) => {
      setTab("transcript");
      requestAnimationFrame(() => {
        const el = segmentElement(sid);
        if (!el) return;
        // A hidden line (invented in silence) is shown when it is cited.
        if (el.hasAttribute("data-hallucination")) setShowHidden(true);
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
  // Where each session's audio starts in the transcript's time.
  const sessionOffset = (n: number) => (status?.sessions.find((s) => s.n === n)?.offsetMs || 0) / 1000;
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
        text: segment?.textContent || t("Diese Stelle ist nicht mehr im Transkript.", "This passage is no longer in the transcript."),
        // "08:17 · Ada"; the chip's own text when the passage is gone.
        label: segment?.getAttribute("data-label") || c.textContent || "",
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
  const owner = (context.members.find((m) => m.id === context.userId) as (User & { role?: string }) | undefined)?.role;
  const mayChangeWorkspace = owner === undefined || owner === "owner";
  const handle = (error: unknown) => {
    const e = error as Error & { code?: string };
    if (e.code === "copy") {
      renew();
      context.onError(t("Dieser Block war eine Kopie und hat eine eigene Aufnahme bekommen. Bitte erneut starten.", "This block was a copy and got a recording of its own. Please start again."));
      return;
    }
    context.onError(e.message);
  };
  // In Chrome/Edge everyone can be recorded through the screen sharing's
  // sound; elsewhere in a browser only the microphone.
  const browserAll = !system.supported && !!system.browser?.supported;
  const [captureAll, setCaptureAll] = useState(false);
  const [mix, setMix] = useState(false);
  useEffect(() => {
    setCaptureAll(readPref(PREF_BROWSER));
    setMix(readPref(PREF_MIX));
  }, []);
  const begin = async (everyone = browserAll && captureAll) => {
    if (settings?.consentRequired && !consent) return setConsentOpen(true);
    setConsentOpen(false);
    setNotice("");
    if (browserAll) {
      setCaptureAll(everyone);
      writePref(PREF_BROWSER, everyone);
    }
    const next = new MeetingRecorder({
      meetingId,
      pageId: context.pageId,
      rowId: context.rowId,
      consent,
      system: system.supported,
      capture: browserAll && everyone ? "browser" : "desktop",
      mix,
      onError: context.onError,
    });
    try {
      setLevels({});
      setSilent(null);
      await next.start();
      setRecorder(next);
      // The call's sound was wanted but is not there: why.
      if ((system.supported || (browserAll && everyone)) && next.systemReason) setNotice(systemNotice(next.systemReason));
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
        : reason === "cancelled"
          ? t("Keine Freigabe gewählt – es wird nur das Mikrofon aufgenommen.", "No sharing chosen – only the microphone is recorded.")
          : reason === "no-audio"
            ? t(
                "Die Freigabe hat keinen Ton – beim nächsten Mal „Tab-Audio teilen“ bzw. „Systemaudio teilen“ ankreuzen. Es wird nur das Mikrofon aufgenommen.",
                "The sharing has no sound – next time tick “Share tab audio” or “Share system audio”. Only the microphone is recorded.",
              )
            : t("Systemton ist auf diesem System nicht verfügbar – es wird nur das Mikrofon aufgenommen.", "System sound is not available on this system – only the microphone is recorded.");
  const stop = async () => {
    if (!recorder) return;
    // Ending means: transcribe, summarise, done – asked once.
    if (!window.confirm(t("Besprechung beenden? Danach wird transkribiert und zusammengefasst.", "End the meeting? It is then transcribed and summarised."))) return;
    try {
      await recorder.stop(spoken);
    } catch (error) {
      handle(error);
    }
    setRecorder(null);
    setRecording(null);
    setLevels({});
    setSilent(null);
    await load();
    setTab("transcript");
  };
  const uploadFiles = async (list: FileList | null) => {
    const picked = [...(list || [])].slice(0, 2);
    if (!picked.length) return;
    if (settings?.consentRequired && !consent) {
      setConsentOpen(true);
      if (files.current) files.current.value = "";
      return;
    }
    // Two files: the first is the microphone, the second the call.
    const chosen: Partial<Record<MeetingTrack, File>> = picked.length === 2 ? { me: picked[0], others: picked[1] } : { mixed: picked[0] };
    setUpload(0);
    try {
      await uploadMeetingFiles({ meetingId, pageId: context.pageId, rowId: context.rowId, consent, language: spoken, files: chosen }, setUpload);
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
  const saveSettings = async (patch: Record<string, unknown>) => {
    try {
      setSettings(await postJson<Settings>("/api/meetings/settings", { workspaceId: context.workspaceId, settings: patch }));
    } catch (error) {
      handle(error);
    }
  };
  const regenerate = async (instructions?: MeetingPreset) => {
    try {
      setStatus((s) => (s ? { ...s, status: "summarizing" } : s));
      await postJson(`/api/meetings/${meetingId}/summarize`, { instructions: instructions ?? node.attrs.instructions, prompt: node.attrs.prompt, language: spoken });
      setTab("summary");
    } catch (error) {
      handle(error);
    }
    await load();
  };
  const retry = async () => {
    try {
      await postJson(`/api/meetings/${meetingId}/retry`, { language: spoken });
    } catch (error) {
      handle(error);
    }
    await load();
  };
  // Transcribing the kept audio again: the server first says how many
  // passages people corrected; those stay unless they are to be replaced.
  const [corrected, setCorrected] = useState(0);
  const retranscribe = async (force?: boolean) => {
    if (force === undefined) {
      try {
        const { edited } = await postJson<{ edited?: number }>(`/api/meetings/${meetingId}/retranscribe`, { language: spoken, dryRun: true });
        if (edited) return setCorrected(edited);
      } catch (error) {
        return handle(error);
      }
      if (!window.confirm(t("Erneut transkribieren? Transkript und Zusammenfassung werden neu erstellt.", "Transcribe again? The transcript and the summary are created anew."))) return;
    }
    setCorrected(0);
    try {
      setStatus((s) => (s ? { ...s, status: "transcribing" } : s));
      await postJson(`/api/meetings/${meetingId}/retranscribe`, { language: spoken, ...(force ? { force: true } : {}) });
    } catch (error) {
      handle(error);
    }
    await load();
  };
  const deleteAudio = async () => {
    if (!window.confirm(t("Audio jetzt löschen? Transkript und Zusammenfassung bleiben erhalten.", "Delete the audio now? The transcript and the summary are kept."))) return;
    try {
      await postJson(`/api/meetings/${meetingId}/audio/delete`, {});
    } catch (error) {
      handle(error);
    }
    await load();
  };
  const deleteTranscript = () => {
    if (!window.confirm(t("Transkript löschen? Die Zusammenfassung bleibt; ihre Quellenverweise zeigen dann ins Leere. Rückgängig machen geht mit ⌘Z / Strg+Z.", "Delete the transcript? The summary stays; its source references then point nowhere. Undo with ⌘Z / Ctrl+Z.")))
      return;
    const pos = position();
    if (pos === undefined) return;
    const change = clearTranscript(editor.state, pos);
    if (change) editor.view.dispatch(change);
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
      if (!sid) return <span key={i}>{part}</span>;
      // The passage's time, as the summary's chips show it.
      const segment = segmentElement(sid);
      const label = citeLabel({ n: m![1] }, segment ? { start: Number(segment.getAttribute("data-start")) || 0 } : null);
      return (
        <button
          key={i}
          type="button"
          className="meeting-cite-button"
          onClick={() => openSegment(sid)}
          title={t("Im Transkript zeigen", "Show in transcript")}
          aria-label={citeAria(label, segment?.textContent, t("Quelle", "Source"))}
        >
          {label}
        </button>
      );
    });

  // ---- Calendar event ----
  const date = String(node.attrs.date || "");
  const openEvents = async () => {
    if (picker === "events") return setPicker("");
    setPicker("events");
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
    const key = event.rowId ? `row:${event.rowId}@${event.start.slice(0, 10)}` : `ics:${event.uid || event.title}@${event.start.slice(0, 10)}`;
    updateAttributes({
      title: event.title || node.attrs.title,
      date: event.start.slice(0, 10) || date,
      attendees: JSON.stringify(people),
      event: key,
      eventStart: event.start,
    });
    setPicker("");
    calendar.current?.focus({ preventScroll: true });
    // The reminder when the event starts goes to whoever linked it.
    void postJson(`/api/meetings/${meetingId}/event`, {
      pageId: context.pageId,
      rowId: context.rowId || null,
      event: key,
      title: event.title || String(node.attrs.title || ""),
      start: event.start,
      timed: event.timed,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).catch(handle);
  };
  const addAttendee = (a: Attendee) => {
    if (attendees.some((p) => (a.id ? p.id === a.id : p.name === a.name))) return;
    updateAttributes({ attendees: JSON.stringify([...attendees, a]) });
  };
  const removeAttendee = (index: number) => updateAttributes({ attendees: JSON.stringify(attendees.filter((_, i) => i !== index)) });

  const live = !!recording && recording.phase !== "done";
  const busy = !!status && BUSY.has(status.status);
  const dateLabel = date
    ? new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))
    : t("Ohne Datum", "No date");
  const instructions = (MEETING_PRESETS as readonly string[]).includes(String(node.attrs.instructions)) ? (node.attrs.instructions as MeetingPreset) : "auto";
  const summaryEmpty = node.firstChild?.textContent.trim() === "";
  const transcriptEmpty = !node.child(2)?.childCount;
  const notesEmpty = node.child(1)?.textContent.trim() === "" && (node.child(1)?.childCount || 0) <= 1;
  const recorded = (status?.sessions.length || 0) > 0;
  const counts = segmentCounts(node);
  const calm = calmState(status, { userId: context.userId, transcript: !transcriptEmpty, summary: !summaryEmpty, recordingHere: live });
  const detail = errorDetail(status);

  // ---- The settings menu (#229 A) ----
  const closeMenu = (reason?: BlockMenuClose) => {
    setMenu(null);
    if (reason !== "away") gear.current?.focus({ preventScroll: true });
  };
  const presetLabel = (p: MeetingPreset) => t(MEETING_PRESET_LABELS[p][0], MEETING_PRESET_LABELS[p][1]);
  const views: Record<string, BlockMenuView> = {
    main: {
      title: t("Besprechung", "Meeting"),
      items: tidy([
        canEdit && transcription && recorded && !live && !busy && { icon: <span className="meeting-menu-dot" aria-hidden />, label: t("Weiter aufnehmen", "Continue recording"), run: () => void begin() },
        canEdit && recorded && !transcriptEmpty && { icon: <ArrowClockwise />, label: t("Zusammenfassung neu erstellen", "Re-generate summary"), run: () => void regenerate(), disabled: busy || live },
        canEdit && transcription && canRetranscribe(status) && { icon: <ArrowsClockwise />, label: t("Erneut transkribieren", "Transcribe again"), run: () => void retranscribe(), disabled: busy || live },
        "separator",
        canEdit && { icon: <Globe />, label: t("Sprache", "Language"), value: language ? LANGUAGE_NAMES[language] : t("Automatisch", "Automatic"), view: "language" },
        canEdit && { icon: <NotePencil />, label: t("Anweisungen", "Instructions"), value: presetLabel(instructions), view: "instructions" },
        canEdit && { icon: <ShieldCheck />, label: t("Einwilligung", "Consent"), value: settings?.consentRequired ? t("Erforderlich", "Required||consent") : t("Optional", "Optional||consent"), view: "consent" },
        canEdit && transcription && { icon: <UploadSimple />, label: t("Aufnahme hochladen …", "Upload recording …"), view: "upload", disabled: busy || live || upload !== null },
        // Microphone and call as one track (per person and device).
        canEdit &&
          transcription &&
          (system.supported || browserAll) && {
            icon: <Waveform />,
            label: t("Eine gemeinsame Tonspur", "One combined track"),
            checked: mix,
            stay: true,
            disabled: live,
            run: () => {
              writePref(PREF_MIX, !mix);
              setMix(!mix);
            },
          },
        "separator",
        !!context.copyLink && {
          icon: <LinkIcon />,
          label: t("Link zur Besprechung kopieren", "Copy link to meeting"),
          run: () => {
            const pos = position();
            if (pos !== undefined) context.copyLink?.(pos);
          },
        },
        "separator",
        canEdit && !!status?.audio.length && { icon: <Trash />, label: t("Audio jetzt löschen …", "Delete audio now …"), danger: true, run: () => void deleteAudio() },
        canEdit && !transcriptEmpty && { icon: <Trash />, label: t("Transkript löschen …", "Delete transcript …"), danger: true, run: deleteTranscript, disabled: busy || live },
      ]),
    },
    language: {
      title: t("Sprache", "Language"),
      items: [
        { icon: <Globe />, label: t("Automatisch (Sprache der Oberfläche)", "Automatic (interface language)"), checked: !language, run: () => updateAttributes({ language: "" }) },
        ...MEETING_LANGUAGES.map((l) => ({ icon: <span className="meeting-menu-code">{l.toUpperCase()}</span>, label: LANGUAGE_NAMES[l], checked: language === l, run: () => updateAttributes({ language: l }) })),
      ],
      note: t("Für Transkription und Zusammenfassung.", "For the transcription and the summary."),
    },
    instructions: {
      title: t("Anweisungen", "Instructions"),
      items: [
        ...MEETING_PRESETS.filter((p) => p !== "custom").map((p) => ({ icon: <NotePencil />, label: presetLabel(p), checked: instructions === p, run: () => updateAttributes({ instructions: p }) })),
        "separator" as const,
        { icon: <NotePencil />, label: t("Eigene Anweisung …", "Custom …"), checked: instructions === "custom", view: "custom" },
      ],
      note: recorded ? t("Gilt für die nächste Zusammenfassung – „Zusammenfassung neu erstellen“ wendet sie an.", "Applies to the next summary – “Re-generate summary” uses it.") : undefined,
    },
    custom: {
      title: t("Eigene Anweisung", "Custom instructions"),
      items: tidy([canEdit && recorded && !transcriptEmpty && { icon: <ArrowClockwise />, label: t("Zusammenfassung damit neu erstellen", "Re-generate the summary with it"), run: () => void regenerate("custom"), disabled: busy || live }]),
      content: (
        <textarea
          className="meeting-menu-field"
          autoFocus
          value={String(node.attrs.prompt || "")}
          maxLength={4000}
          rows={4}
          aria-label={t("Eigene Anweisung", "Custom instructions")}
          placeholder={t("z. B. „Fasse Entscheidungen und Risiken für das Projektteam zusammen.“", "e.g. “Summarise decisions and risks for the project team.”")}
          onChange={(e) => updateAttributes({ instructions: "custom", prompt: e.target.value })}
        />
      ),
    },
    consent: {
      title: t("Einwilligung", "Consent"),
      items: [
        {
          icon: <ShieldCheck />,
          label: t("Vor der Aufnahme bestätigen", "Confirm before recording"),
          checked: !!settings?.consentRequired,
          stay: true,
          disabled: !mayChangeWorkspace || !settings,
          run: () => void saveSettings({ consentRequired: !settings?.consentRequired }),
        },
        { icon: <SpeakerHigh />, label: t("Einwilligungshinweis abspielen", "Play consent notice"), stay: true, run: playConsent },
      ],
      content: mayChangeWorkspace ? (
        <ConsentText
          value={settings?.consentText || ""}
          placeholder={settings?.defaultConsentText || ""}
          label={t("Hinweistext", "Notice text")}
          onSave={(text) => void saveSettings({ consentText: text })}
        />
      ) : (
        <p className="meeting-menu-text">{consentText}</p>
      ),
      note: t("Gilt für alle Besprechungen dieses Arbeitsbereichs.", "Applies to every meeting in this workspace."),
    },
    upload: {
      title: t("Aufnahme hochladen", "Upload recording"),
      items: [{ icon: <UploadSimple />, label: t("Dateien auswählen …", "Choose files …"), run: () => files.current?.click() }],
      note: t(
        "M4A, MP3, WAV, AAC oder WebM – eine Datei mit allen, oder zwei Dateien (zuerst das Mikrofon, dann der Ton der Besprechung).",
        "M4A, MP3, WAV, AAC or WebM – one file with everyone, or two files (the microphone first, then the meeting's sound).",
      ),
    },
  };

  // ---- Transcript: find and replace ----
  const glossary = glossaryOf(settings);
  const matchCount = useMemo(() => (findOpen && find.trim() ? transcriptMatches(node, 0, find).length : 0), [findOpen, find, node]);
  const replaceAll = async () => {
    const pos = position();
    if (pos === undefined || !find.trim()) return;
    const result = replaceInTranscript(editor.state, pos, find, replace);
    if (!result) return;
    editor.view.dispatch(result.tr);
    if (toGlossary && replace.trim() && settings) await saveSettings({ glossary: withGlossaryEntry(settings, replace) });
  };

  const trackLabel = (track: MeetingTrack) => (track === "others" ? t("Systemton", "System sound") : track === "mixed" ? t("Alle", "Everyone") : t("Mikrofon", "Microphone"));
  const levelTracks = (Object.keys(levels) as MeetingTrack[]).filter((k) => recorder?.tracks.includes(k) ?? true);
  const quiet = silent || silentSourceOf(recording);

  return (
    <NodeViewWrapper
      className={`meeting-block${expanded ? " meeting-expanded" : ""}${showHidden ? " meeting-show-hidden" : ""}${unlocked ? " meeting-transcript-open" : ""}`}
      data-tab={tab}
      ref={root}
      data-drag-handle=""
    >
      <div className="meeting-head" contentEditable={false}>
        <div className="meeting-head-row">
          <button
            ref={calendar}
            type="button"
            className="meeting-event"
            onClick={() => void openEvents()}
            disabled={!canEdit}
            title={t("Termin aus dem Kalender wählen", "Choose an event from the calendar")}
            aria-label={t("Termin aus dem Kalender wählen", "Choose an event from the calendar")}
            aria-haspopup="dialog"
            aria-expanded={picker === "events"}
          >
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
            {(canEdit || context.copyLink) && (
              <button
                ref={gear}
                type="button"
                className={`icon-button${menu ? " active" : ""}`}
                onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
                aria-label={t("Einstellungen der Besprechung", "Meeting settings")}
                aria-haspopup="menu"
                aria-expanded={!!menu}
              >
                <Gear size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="meeting-meta">
          <label className="meeting-chip meeting-date mention" title={t("Datum", "Date")}>
            @{dateLabel}
            {canEdit && <input type="date" value={date} onChange={(e) => updateAttributes({ date: e.target.value })} aria-label={t("Datum", "Date")} />}
          </label>
          {attendees.map((a, i) => (
            <span key={`${a.id || a.name}-${i}`} className={a.id ? "meeting-chip mention meeting-person" : "meeting-chip meeting-person meeting-guest"}>
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
            <button
              ref={plus}
              type="button"
              className="meeting-chip meeting-add-person"
              onClick={() => setPicker(picker === "attendees" ? "" : "attendees")}
              aria-label={t("Teilnehmende hinzufügen", "Add attendees")}
              aria-haspopup="dialog"
              aria-expanded={picker === "attendees"}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        <div className="meeting-record" aria-live="polite">
          {live && recording ? (
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
              {levelTracks.length > 0 && recording.phase === "recording" && (
                <span className="meeting-levels">
                  {levelTracks.map((track) => (
                    <span key={track} className={`meeting-level${quiet === track ? " silent" : ""}`}>
                      <span className="meeting-level-label">{trackLabel(track)}</span>
                      <span
                        className="meeting-level-bar"
                        role="meter"
                        aria-label={t(`Pegel ${trackLabel(track)}`, `Level ${trackLabel(track)}`)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round((levels[track] || 0) * 100)}
                      >
                        <span style={{ transform: `scaleX(${Math.max(0.02, levels[track] || 0)})` }} />
                      </span>
                    </span>
                  ))}
                </span>
              )}
              <span className="meeting-record-actions">
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
                  <button type="button" className="button danger meeting-stop" onClick={() => void stop()}>
                    <Stop size={14} /> {t("Beenden", "Stop")}
                  </button>
                )}
              </span>
            </>
          ) : upload !== null ? (
            <span className="muted meeting-record-state">{t(`Wird hochgeladen … ${Math.round(upload * 100)} %`, `Uploading … ${Math.round(upload * 100)} %`)}</span>
          ) : calm.kind === "busy" ? (
            <span className="muted meeting-record-state">
              <span className="meeting-spinner" aria-hidden />
              {status!.status === "transcribing" ? t("Wird transkribiert …", "Transcribing …") : t("Zusammenfassung wird erstellt …", "Writing the summary …")}
            </span>
          ) : calm.kind === "failed" ? (
            <span className="meeting-status meeting-status-failed" role="alert">
              <Warning size={15} aria-hidden />
              <span>{serverMessage(calm.error) || t("Die Verarbeitung ist fehlgeschlagen.", "Processing failed.")}</span>
              {canEdit && (
                <button type="button" className="button primary" onClick={() => void retry()}>
                  <ArrowClockwise size={14} /> {t("Erneut verarbeiten", "Process again")}
                </button>
              )}
            </span>
          ) : calm.kind === "elsewhere" ? (
            <span className="muted meeting-record-state">
              <span className="meeting-dot on" aria-hidden />
              {calm.name ? t(`${calm.name} nimmt gerade auf …`, `${calm.name} is recording …`) : t("Wird gerade aufgenommen …", "Recording …")}
            </span>
          ) : calm.kind === "interrupted" ? (
            <span className="meeting-status">
              <span className="muted">{t("Aufnahme vorzeitig beendet – fortsetzen?", "Recording stopped early – continue?")}</span>
              {canEdit && transcription && (
                <button type="button" className="button" onClick={() => void begin()}>
                  <Microphone size={14} /> {t("Fortsetzen", "Continue")}
                </button>
              )}
            </span>
          ) : calm.kind === "done" ? (
            <span className="muted meeting-status meeting-status-done">
              {[
                calm.durationMs ? t(`${formatTimestamp(calm.durationMs / 1000)} aufgenommen`, `${formatTimestamp(calm.durationMs / 1000)} recorded`) : "",
                calm.transcribed ? t("transkribiert", "transcribed") : "",
                calm.summarized && !calm.note ? t("zusammengefasst", "summarised") : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : canEdit && transcription ? (
            <>
              <button type="button" className="button primary meeting-start" onClick={() => void begin(false)}>
                <Microphone size={14} /> {t("Aufnahme starten", "Start recording")}
              </button>
              {browserAll ? (
                <>
                  <button type="button" className="button meeting-start-all" onClick={() => void begin(true)} title={t("Chrome oder Edge fragen nach einem Tab oder dem Bildschirm – dort „Tab-Audio teilen“ ankreuzen.", "Chrome or Edge ask for a tab or the screen – tick “Share tab audio” there.")}>
                    <UsersThree size={14} /> {t("Alle Teilnehmenden aufnehmen", "Record all participants")}
                  </button>
                  {/* "Start recording" hears only this microphone: the others
                      in the call are missing unless the tab's sound is shared (#199). */}
                  <span className="muted meeting-capture-hint meeting-mic-only-hint">
                    {t("Nur dein Mikrofon – wähle „Alle Teilnehmenden aufnehmen“, um die anderen mit aufzunehmen.", "Only your microphone – choose “Record all participants” to include the others.")}
                  </span>
                </>
              ) : system.reason === "browser" ? (
                <span className="muted meeting-capture-hint">{t(BROWSER_CAPTURE_HINT[0], BROWSER_CAPTURE_HINT[1])}</span>
              ) : null}
            </>
          ) : canEdit ? (
            <span className="muted">{t("Transkription ist auf diesem Server nicht eingerichtet.", "Transcription is not set up on this server.")}</span>
          ) : null}
        </div>
        {detail && calm.kind === "failed" && <p className="meeting-error-detail">{t(`Details für Admins: ${detail}`, `Details for admins: ${detail}`)}</p>}
        {calm.kind === "done" && calm.note && !live && <p className="meeting-notice">{serverMessage(calm.note)}</p>}
        {quiet && live && (
          <p className="meeting-notice meeting-warning" role="alert">
            <Warning size={15} aria-hidden />
            {quiet === "others"
              ? t("Vom Systemton kommt seit über 30 Sekunden nichts an – Freigabe des Tons oder die Lautsprecher prüfen.", "No system sound for more than 30 seconds – check the sound sharing or the speakers.")
              : t("Das Mikrofon ist seit über 30 Sekunden still – ist es stummgeschaltet oder ein anderes gewählt?", "The microphone has been silent for more than 30 seconds – is it muted or is another one selected?")}
          </p>
        )}
        {notice && <p className="meeting-notice">{notice}</p>}
        <div className="meeting-tabs" role="tablist">
          {(
            [
              ["summary", t("Zusammenfassung", "Summary")],
              ["agenda", t("Notizen", "Notes")],
              ["transcript", t("Transkript", "Transcript")],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
          {!transcriptEmpty && (
            <button type="button" className={`meeting-ask-toggle${askOpen ? " active" : ""}`} aria-expanded={askOpen} onClick={() => setAskOpen(!askOpen)}>
              <ChatCircleText size={14} /> {t("Frag diese Besprechung", "Ask this meeting")}
            </button>
          )}
        </div>
        {askOpen && (
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
        {tab === "transcript" && !transcriptEmpty && (canEdit || counts.hidden > 0) && (
          <div className="meeting-transcript-bar">
            {canEdit && (
              <button type="button" className={`meeting-bar-button${unlocked ? " active" : ""}`} aria-pressed={unlocked} onClick={() => setTranscriptUnlocked(meetingId, !unlocked)}>
                {unlocked ? <LockSimpleOpen size={14} aria-hidden /> : <LockSimple size={14} aria-hidden />}
                {t("Transkript bearbeiten", "Edit transcript")}
              </button>
            )}
            {canEdit && unlocked && (
              <button type="button" className={`meeting-bar-button${findOpen ? " active" : ""}`} aria-expanded={findOpen} onClick={() => setFindOpen(!findOpen)}>
                <MagnifyingGlass size={14} aria-hidden />
                {t("Suchen und ersetzen", "Find and replace")}
              </button>
            )}
            {counts.hidden > 0 && (
              <button type="button" className="meeting-bar-button meeting-hidden-toggle" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}>
                {showHidden ? <EyeSlash size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                {showHidden
                  ? t("Ausgeblendete Zeilen verbergen", "Hide hidden lines")
                  : counts.hidden === 1
                    ? t("1 ausgeblendete Zeile anzeigen", "Show 1 hidden line")
                    : t(`${counts.hidden} ausgeblendete Zeilen anzeigen`, `Show ${counts.hidden} hidden lines`)}
              </button>
            )}
          </div>
        )}
        {tab === "transcript" && canEdit && unlocked && findOpen && (
          <form
            className="meeting-find"
            onSubmit={(e) => {
              e.preventDefault();
              void replaceAll();
            }}
          >
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("Suchen", "Find")} aria-label={t("Suchen", "Find")} autoFocus />
            <input value={replace} onChange={(e) => setReplace(e.target.value)} placeholder={t("Ersetzen durch", "Replace with")} aria-label={t("Ersetzen durch", "Replace with")} />
            <span className="muted meeting-find-count">{find.trim() ? (matchCount === 1 ? t("1 Treffer", "1 match") : t(`${matchCount} Treffer`, `${matchCount} matches`)) : ""}</span>
            {glossary && mayChangeWorkspace && (
              <label className="meeting-find-glossary">
                <input type="checkbox" checked={toGlossary} onChange={(e) => setToGlossary(e.target.checked)} />
                {t("Ins Glossar aufnehmen", "Add to the glossary")}
              </label>
            )}
            <button className="button" disabled={!matchCount}>
              {t("Alle ersetzen", "Replace all")}
            </button>
          </form>
        )}
        {tab === "agenda" && (
          <p className="muted meeting-agenda-hint">
            {notesEmpty
              ? t("Eigene Notizen – vor, während und nach der Besprechung. Die Zusammenfassung bezieht sie ein.", "Your own notes – before, during and after the meeting. The summary takes them into account.")
              : t("Die Zusammenfassung bezieht diese Notizen ein.", "The summary takes these notes into account.")}
          </p>
        )}
      </div>
      {focus && <style>{`.meeting-block [data-segment="${CSS.escape(focus)}"]{background:color-mix(in srgb,var(--blue) 14%,var(--bg))}`}</style>}
      <NodeViewContent className="meeting-content" />
      {hover && (
        <div className="meeting-cite-popover" contentEditable={false} style={{ left: hover.x, top: hover.y }} role="tooltip">
          <span className="meeting-cite-popover-head">
            {hover.label}
          </span>
          {hover.text}
        </div>
      )}
      <audio ref={audio} className="meeting-audio" controls hidden={!status?.audio.length} preload="none" />
      <input ref={files} type="file" hidden multiple accept="audio/*,.m4a,.mp3,.wav,.aac,.webm,.ogg" onChange={(e) => void uploadFiles(e.target.files)} />
      {menu &&
        createPortal(
          <BlockMenu anchor={menu} owner={gear.current} placement="below" views={views} label={t("Einstellungen der Besprechung", "Meeting settings")} className="meeting-menu" onClose={closeMenu} />,
          // In a record's dialog the menu stays in the dialog (#232).
          layerHost(gear.current),
        )}
      {picker === "attendees" && (
        <AnchoredPopover anchor={plus.current} label={t("Teilnehmende hinzufügen", "Add attendees")} className="meeting-picker" onClose={() => setPicker("")}>
          <AttendeePicker members={context.members} taken={attendees} onPick={addAttendee} />
        </AnchoredPopover>
      )}
      {picker === "events" && (
        <AnchoredPopover anchor={calendar.current} label={t("Termin wählen", "Choose an event")} className="meeting-picker meeting-event-picker" onClose={() => setPicker("")}>
          <EventPicker events={events} dateLabel={dateLabel} onPick={chooseEvent} />
        </AnchoredPopover>
      )}
      <Modal
        open={corrected > 0}
        onClose={() => setCorrected(0)}
        title={t("Erneut transkribieren", "Transcribe again")}
        className="meeting-retranscribe"
        actions={
          <>
            <button type="button" className="button danger" onClick={() => void retranscribe(true)}>
              {t("Ersetzen", "Replace")}
            </button>
            <button type="button" className="button primary" onClick={() => void retranscribe(false)} autoFocus>
              {corrected === 1 ? t("Korrigierte Stelle behalten", "Keep the corrected passage") : t(`${corrected} korrigierte Stellen behalten`, `Keep ${corrected} corrected passages`)}
            </button>
          </>
        }
      >
        <p>
          {corrected === 1
            ? t(
                "1 Stelle im Transkript wurde von Hand korrigiert. Sie bleibt beim neuen Transkribieren erhalten – oder wird durch die neue Erkennung ersetzt.",
                "1 passage of the transcript was corrected by hand. It is kept when transcribing again – or replaced by the new recognition.",
              )
            : t(
                `${corrected} Stellen im Transkript wurden von Hand korrigiert. Sie bleiben beim neuen Transkribieren erhalten – oder werden durch die neue Erkennung ersetzt.`,
                `${corrected} passages of the transcript were corrected by hand. They are kept when transcribing again – or replaced by the new recognition.`,
              )}
        </p>
      </Modal>
      <Modal
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        title={t("Einwilligung", "Consent")}
        className="meeting-consent"
        actions={
          <>
            <button type="button" className="button" onClick={playConsent}>
              <SpeakerHigh size={14} /> {t("Einwilligungshinweis abspielen", "Play consent notice")}
            </button>
            <button type="button" className="button primary" disabled={!consent} onClick={() => void begin()}>
              <Microphone size={14} /> {t("Aufnahme starten", "Start recording")}
            </button>
          </>
        }
      >
        <p>{consentText}</p>
        <label className="meeting-consent-check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          {t("Alle, die transkribiert werden, haben zugestimmt", "Everyone being transcribed has agreed")}
        </label>
      </Modal>
    </NodeViewWrapper>
  );
}

// The workspace's consent notice, saved when the field is left.
function ConsentText({ value, placeholder, label, onSave }: { value: string; placeholder: string; label: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <textarea
      className="meeting-menu-field"
      value={text}
      rows={4}
      maxLength={2000}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
    />
  );
}

// #229 C: a combobox – search on top, members with their picture, the
// typed text as a guest in the last row. Arrow keys move, Enter adds; the
// picker stays open for the next person.
function AttendeePicker({ members, taken, onPick }: { members: User[]; taken: Attendee[]; onPick: (a: Attendee) => void }) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const found = matchMembers(members, query, taken);
  const guest = guestName(query, members);
  const options: { key: string; attendee: Attendee; label: ReactNode }[] = [
    ...found.map((m) => ({
      key: m.id,
      attendee: { id: m.id, name: m.name },
      label: (
        <>
          <Avatar name={m.name} userId={m.id} small />
          <span className="meeting-option-text">
            <span>{m.name}</span>
            {m.email && <span className="muted meeting-option-sub">{m.email}</span>}
          </span>
        </>
      ),
    })),
    ...(guest
      ? [
          {
            key: "guest",
            attendee: { name: guest },
            label: (
              <>
                <span className="meeting-option-icon" aria-hidden>
                  <UserPlus size={15} />
                </span>
                <span className="meeting-option-text">{t(`Gast „${guest}“ hinzufügen`, `Add guest “${guest}”`)}</span>
              </>
            ),
          },
        ]
      : []),
  ];
  const current = Math.min(active, options.length - 1);
  const pick = (index: number) => {
    const option = options[index];
    if (!option) return;
    onPick(option.attendee);
    setQuery("");
    setActive(0);
  };
  return (
    <div className="meeting-combobox">
      <input
        className="meeting-picker-search"
        role="combobox"
        aria-expanded
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={current >= 0 ? `${id}-${current}` : undefined}
        aria-label={t("Person suchen oder Gast eingeben", "Search for a person or type a guest")}
        placeholder={t("Person suchen oder Gast eingeben …", "Search for a person or type a guest …")}
        value={query}
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((current + 1) % Math.max(1, options.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((current - 1 + options.length) % Math.max(1, options.length));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(current);
          }
        }}
      />
      <div className="meeting-options" role="listbox" id={`${id}-list`} aria-label={t("Personen", "People")}>
        {options.map((option, index) => (
          <div
            key={option.key}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === current}
            className={`meeting-option${index === current ? " active" : ""}${option.key === "guest" ? " meeting-option-guest" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => index !== current && setActive(index)}
            onClick={() => pick(index)}
          >
            {option.label}
          </div>
        ))}
        {!options.length && <p className="muted meeting-picker-empty">{t("Alle Mitglieder sind schon dabei – tippe einen Namen für einen Gast.", "Every member is already in – type a name for a guest.")}</p>}
      </div>
    </div>
  );
}

// #229 C: the day's appointments – of calendars only, grouped by calendar,
// the time on the left; dated records of other databases under a closed
// "Weitere Einträge dieses Tages".
function EventPicker({ events, dateLabel, onPick }: { events: DayEvent[] | null; dateLabel: string; onPick: (event: DayEvent) => void }) {
  const t = useT();
  const locale = useLocale();
  const [others, setOthers] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (events) list.current?.querySelector<HTMLElement>("[role=option], .meeting-more")?.focus({ preventScroll: true });
  }, [events]);
  if (!events) return <p className="muted meeting-picker-empty">{t("Wird geladen …", "Loading …")}</p>;
  const { calendars, others: rest } = groupEvents(events);
  const time = (e: DayEvent) => (e.timed ? new Date(e.start).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : t("Ganztägig", "All day"));
  const row = (e: DayEvent, i: number) => (
    <button key={`${e.start}-${e.title}-${i}`} type="button" role="option" aria-selected={false} className="meeting-option meeting-event-option" onClick={() => onPick(e)}>
      <span className="meeting-event-time">{time(e)}</span>
      <strong className="meeting-option-text">{e.title || t("Ohne Titel", "Untitled")}</strong>
    </button>
  );
  return (
    <div
      ref={list}
      className="meeting-events"
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const all = [...(list.current?.querySelectorAll<HTMLElement>("[role=option], .meeting-more") || [])];
        const i = all.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
      }}
    >
      <p className="meeting-picker-head">{t(`Termine am ${dateLabel}`, `Events on ${dateLabel}`)}</p>
      {!calendars.length && <p className="muted meeting-picker-empty">{t("An diesem Tag gibt es keine Termine.", "There are no events on this day.")}</p>}
      {calendars.map((group) => (
        <div key={group.source} role="listbox" aria-label={group.source || t("Kalender", "Calendar")} className="meeting-event-group">
          {calendars.length > 1 || group.source ? <p className="meeting-group-label">{group.source || t("Kalender", "Calendar")}</p> : null}
          {group.events.map(row)}
        </div>
      ))}
      {rest.length > 0 && (
        <>
          <button type="button" className="meeting-more" aria-expanded={others} onClick={() => setOthers(!others)}>
            {others ? <CaretDown size={12} aria-hidden /> : <CaretRight size={12} aria-hidden />}
            {t(`Weitere Einträge dieses Tages (${rest.length})`, `Other entries of this day (${rest.length})`)}
          </button>
          {others && (
            <div role="listbox" aria-label={t("Weitere Einträge dieses Tages", "Other entries of this day")} className="meeting-event-group meeting-event-others">
              {rest.map((e, i) => (
                <button key={`${e.start}-${e.title}-${i}`} type="button" role="option" aria-selected={false} className="meeting-option meeting-event-option" onClick={() => onPick(e)}>
                  <span className="meeting-event-time">{time(e)}</span>
                  <span className="meeting-option-text">
                    <strong>{e.title || t("Ohne Titel", "Untitled")}</strong>
                    {e.source && <span className="muted meeting-option-sub">{e.source}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
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
    addProseMirrorPlugins() {
      return [transcriptEditPlugin()];
    },
  });

// The transcript part in the editor: not editable while locked (#199
// comment point 2) – reading, selecting and copying change nothing.
export const MeetingTranscriptView = MeetingTranscript.extend({
  addNodeView() {
    return ({ getPos, editor }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-meeting-part", "transcript");
      dom.className = "meeting-part meeting-transcript";
      const meetingId = () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined || pos > editor.state.doc.content.size) return "";
        return String(editor.state.doc.resolve(pos).parent.attrs.meetingId || "");
      };
      const sync = () => {
        const open = transcriptUnlocked(meetingId());
        if (open) dom.removeAttribute("contenteditable");
        else dom.setAttribute("contenteditable", "false");
        dom.toggleAttribute("data-locked", !open);
      };
      sync();
      const off = onTranscriptLocks(sync);
      return {
        dom,
        contentDOM: dom,
        update: (next) => {
          if (next.type.name !== "meetingTranscript") return false;
          sync();
          return true;
        },
        ignoreMutation: (mutation) => mutation.type === "attributes" && mutation.target === dom,
        destroy: off,
      };
    };
  },
});

// A citation chip in the editor: the time of the passage it cites, read
// from the meeting's transcript (so chips stored with a number ①② show it
// too), named for screen readers ("Quelle 08:17: …"). Drawn again when the
// document changes; the transcript's index is shared by all chips of a
// meeting while the transcript stays the same.
const citedSegments = new WeakMap<PMNode, Map<string, CitedSegment>>();
export const MeetingCiteView = MeetingCite.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("sup");
      dom.className = "meeting-cite";
      let current = node;
      const segment = () => {
        try {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (pos === undefined || pos > editor.state.doc.content.size) return null;
          const $pos = editor.state.doc.resolve(pos);
          for (let depth = $pos.depth; depth >= 0; depth--) {
            const meeting = $pos.node(depth);
            if (meeting.type.name !== "meeting") continue;
            const transcript = meeting.lastChild;
            if (!transcript || transcript.type.name !== "meetingTranscript") return null;
            let index = citedSegments.get(transcript);
            if (!index) citedSegments.set(transcript, (index = meetingSegmentIndex(transcript)));
            return index.get(String(current.attrs.sid || "")) || null;
          }
        } catch {}
        return null;
      };
      const draw = () => {
        const found = segment();
        const label = citeLabel(current.attrs, found);
        dom.setAttribute("data-meeting-cite", String(current.attrs.sid || ""));
        dom.setAttribute("data-n", String(current.attrs.n));
        if (current.attrs.start !== null && current.attrs.start !== undefined) dom.setAttribute("data-cite-start", String(current.attrs.start));
        else dom.removeAttribute("data-cite-start");
        if (dom.textContent !== label) dom.textContent = label;
        const aria = citeAria(label, found?.text, tr("Quelle", "Source"));
        if (dom.getAttribute("aria-label") !== aria) dom.setAttribute("aria-label", aria);
      };
      draw();
      editor.on("update", draw);
      return {
        dom,
        update: (next) => {
          if (next.type !== current.type) return false;
          current = next;
          draw();
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => {
          editor.off("update", draw);
        },
      };
    };
  },
});
