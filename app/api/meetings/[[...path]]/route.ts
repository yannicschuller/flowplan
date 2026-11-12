// Meeting notes (#199, lib/meetings.ts):
//
//   POST /api/meetings                       multipart: audio (one file with
//        everyone) or me + others (separate tracks), title, pageId or
//        databaseId, attendees, instructions, prompt, date, consent – creates
//        the block (or a record with it) and processes it in the background
//   GET  /api/meetings/{id}[?content=1]      status (with summary and transcript)
//   POST /api/meetings/{id}/start            a recording session of a block
//   POST /api/meetings/{id}/chunk?session=&track=&index=   a piece (raw bytes)
//   GET  /api/meetings/{id}/chunks?session=  the pieces that arrived
//   POST /api/meetings/{id}/finish           transcribe and summarise
//   POST /api/meetings/{id}/retry            again after an error
//   POST /api/meetings/{id}/summarize        the summary again (other instructions)
//   POST /api/meetings/{id}/retranscribe     transcribe the kept audio again
//        { force?, dryRun?, language? } – corrected passages stay unless force
//   POST /api/meetings/{id}/ask              "Frag diese Besprechung" (text stream)
//   POST /api/meetings/{id}/audio/delete     remove the kept audio now
//   POST /api/meetings/{id}/event            the block's calendar event (its reminder)
//   GET/POST /api/meetings/settings?workspaceId=   the workspace's defaults
//   GET  /api/meetings/events?workspaceId=&date=&zone=   appointments of a day
//
// Browser sessions and API tokens; tokens need "KI und Transkription" for
// everything that records, transcribes or asks the AI.
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requireMember } from "@/lib/permissions";
import { databaseEvents } from "@/lib/journal-extras";
import { transcribeMaxBytes } from "@/lib/transcribe";
import {
  askMeeting,
  audioMime,
  createMeetingFromUpload,
  deleteMeetingAudio,
  finishMeetingSession,
  meetingChunks,
  meetingStatus,
  meetingStatusOrNew,
  MEETING_CHUNK_BYTES,
  MEETING_COPY,
  readMeetingSettings,
  regenerateSummary,
  retranscribeMeeting,
  retryMeeting,
  saveMeetingSettings,
  startMeetingSession,
  storeMeetingChunk,
  type MeetingUpload,
} from "@/lib/meetings";
import type { MeetingTrack } from "@/lib/meeting-core";
import { linkMeetingEvent } from "@/lib/meeting-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };
function error(e: unknown) {
  if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error("Besprechung:", e);
  const status = e instanceof HttpError ? e.status : 500;
  return NextResponse.json(
    {
      error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden.",
      // A copied block: the editor gives it its own id and tries again.
      ...(e instanceof HttpError && e.message === MEETING_COPY ? { code: "copy" } : {}),
    },
    { status },
  );
}
const uuid = z.uuid();
async function json(req: Request, limit = 100_000) {
  if (Number(req.headers.get("content-length") || 0) > limit) throw new HttpError(413, "Anfrage zu groß.");
  return await req.json().catch(() => ({}));
}

export const GET = withRequestLocale(async (req: Request, { params }: { params: Promise<{ path?: string[] }> }) => {
  try {
    const path = (await params).path || [];
    const user = await requireUser();
    const url = new URL(req.url);
    if (path.length === 1 && path[0] === "settings")
      return NextResponse.json(await readMeetingSettings(user, uuid.parse(url.searchParams.get("workspaceId"))), noStore);
    if (path.length === 1 && path[0] === "events") {
      const workspaceId = uuid.parse(url.searchParams.get("workspaceId"));
      await requireMember(user, workspaceId);
      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(url.searchParams.get("date"));
      const zone = z.string().max(100).catch("UTC").parse(url.searchParams.get("zone") || "UTC");
      return NextResponse.json({ events: await databaseEvents(user, workspaceId, date, zone) }, noStore);
    }
    if (path.length === 1)
      return NextResponse.json(
        url.searchParams.get("content") === "1" ? await meetingStatus(user, path[0], { content: true }) : await meetingStatusOrNew(user, path[0]),
        noStore,
      );
    if (path.length === 2 && path[1] === "chunks")
      return NextResponse.json(await meetingChunks(user, path[0], Number(url.searchParams.get("session"))), noStore);
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return error(e);
  }
});

const formText = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};
async function uploadInput(req: Request): Promise<MeetingUpload> {
  const max = transcribeMaxBytes() * 2 + 2 * 1024 * 1024;
  if (Number(req.headers.get("content-length") || 0) > max) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "Ungültige Eingabe.");
  });
  const audio: MeetingUpload["audio"] = {};
  for (const [field, track] of [
    ["audio", "mixed"],
    ["me", "me"],
    ["others", "others"],
  ] as [string, MeetingTrack][]) {
    const file = form.get(field);
    if (!(file instanceof Blob)) continue;
    const name = file instanceof File ? file.name : `${field}.webm`;
    const mime = audioMime(file.type || "", name);
    if (!mime) throw new HttpError(415, "Dieses Audioformat wird nicht unterstützt.");
    audio[track] = { data: new Uint8Array(await file.arrayBuffer()), mime, name, durationMs: Number(formText(form, `${field}DurationMs`)) || undefined };
  }
  const rawAttendees = formText(form, "attendees") || "";
  let attendees: string[] = [];
  try {
    const parsed = JSON.parse(rawAttendees);
    if (Array.isArray(parsed)) attendees = parsed.map((a) => String(a));
  } catch {
    attendees = rawAttendees.split(",");
  }
  return {
    title: formText(form, "title"),
    pageId: formText(form, "pageId") || undefined,
    databaseId: formText(form, "databaseId") || undefined,
    attendees,
    instructions: formText(form, "instructions"),
    prompt: formText(form, "prompt"),
    date: formText(form, "date"),
    consent: /^(1|true|yes|on)$/i.test(formText(form, "consent") || ""),
    language: formText(form, "language"),
    audio,
    transcript: formText(form, "transcript"),
  };
}

export const POST = withRequestLocale(async (req: Request, { params }: { params: Promise<{ path?: string[] }> }) => {
  try {
    await checkOrigin(req);
    const path = (await params).path || [];
    const user = await requireUser();
    if (!path.length) return NextResponse.json(await createMeetingFromUpload(user, await uploadInput(req)), { status: 202, ...noStore });
    if (path.length === 1 && path[0] === "settings") {
      const b = await json(req);
      return NextResponse.json(await saveMeetingSettings(user, uuid.parse(b.workspaceId), b.settings), noStore);
    }
    const [meetingId, action, sub] = path;
    uuid.parse(meetingId);
    if (path.length === 2 && action === "start") return NextResponse.json(await startMeetingSession(user, { ...(await json(req)), meetingId }), noStore);
    if (path.length === 2 && action === "chunk") {
      const url = new URL(req.url);
      if (Number(req.headers.get("content-length") || 0) > MEETING_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
      const bytes = new Uint8Array(await req.arrayBuffer());
      return NextResponse.json(
        await storeMeetingChunk(
          user,
          meetingId,
          { session: Number(url.searchParams.get("session")), track: String(url.searchParams.get("track")), index: Number(url.searchParams.get("index")) },
          bytes,
        ),
        noStore,
      );
    }
    if (path.length === 2 && action === "finish") return NextResponse.json(await finishMeetingSession(user, meetingId, await json(req)), noStore);
    if (path.length === 2 && action === "retry") return NextResponse.json(await retryMeeting(user, meetingId, (await json(req)).language), noStore);
    if (path.length === 2 && action === "retranscribe") return NextResponse.json(await retranscribeMeeting(user, meetingId, await json(req)), noStore);
    if (path.length === 2 && action === "summarize") return NextResponse.json(await regenerateSummary(user, meetingId, await json(req)), noStore);
    if (path.length === 2 && action === "ask") return await askMeeting(user, meetingId, await json(req, 200_000), req.signal);
    // The block's calendar event: its reminder (lib/meeting-reminders.ts).
    if (path.length === 2 && action === "event") return NextResponse.json(await linkMeetingEvent(user, meetingId, await json(req)), noStore);
    if (path.length === 3 && action === "audio" && sub === "delete") return NextResponse.json(await deleteMeetingAudio(user, meetingId), noStore);
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return error(e);
  }
});
