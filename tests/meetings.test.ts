// Meeting notes (#199): citation numbers, echo removal, the summary as
// tasks, the recording → transcript → summary flow against a fake Whisper
// and a fake AI provider, retention, rights, API tokens and the MCP tool.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-meetings-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
delete process.env.WHISPER_DIARIZE;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { htmlState } = await import("../lib/document-server");
const { myTasks } = await import("../lib/doc-tasks");
const { handleMcpMessage, mcpToolNames } = await import("../lib/mcp");
const core = await import("../lib/meeting-core");
const meetings = await import("../lib/meetings");
const { meetingHtml } = await import("../lib/meeting-schema");
const { startOllamaMock } = await import("./helpers/ai-mock");
const { resolveAi } = await import("../lib/ai/resolve");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
async function tokenFor(user: Identity, scope: "read" | "write", ai = false) {
  const { token } = (await command(user, { action: "token.create", name: `T ${scope}${ai ? " ai" : ""}`, scope, ai })) as { token: string };
  return (await identityFromApiToken(`Bearer ${token}`))!;
}

const ada = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben"),
  vic = await person("Vic"),
  gus = await person("Gus");
const wid = await createWorkspace(ada.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;

// A page with an empty meeting block.
async function pageWithMeeting(title = "Weekly") {
  const pageId = await createPage(wid, space, ada.id, title);
  const meetingId = id();
  const html = meetingHtml({ meetingId, title, date: "2026-11-11", attendees: [{ id: ben.id, name: "Ben" }] });
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  return { pageId, meetingId };
}
const docHtml = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

// ---- Fake Whisper: the microphone hears Ada and the call (echo), the
// system sound the call only. ----
const whisperCalls: string[] = [];
const whisper = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("latin1");
    const name = /filename="([^"]+)"/.exec(body)?.[1] || "";
    whisperCalls.push(name);
    const others = name.includes("-others.");
    const segments = others
      ? [
          { start: 10, end: 16, text: "Ben, kannst du bis Freitag das Angebot an den Kunden schicken?" },
          { start: 40, end: 50, text: "Das Budget für das nächste Quartal bleibt gleich." },
        ]
      : name.includes("-mixed.")
        ? [{ start: 0, end: 20, text: "Kurze Notiz ohne viel Inhalt." }]
        : [
            { start: 2, end: 8, text: "Hallo zusammen, wir fangen mit dem Angebot an." },
            // The call through the loudspeakers, a little later and slightly different.
            { start: 10.4, end: 16.2, text: "Ben kannst du bis Freitag das Angebot an den Kunden schicken" },
            { start: 60, end: 70, text: "Ja, das mache ich bis Freitag." },
          ];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: segments.map((s) => s.text).join(" "), segments, duration: others ? 50 : 70 }));
  });
});
await new Promise<void>((done) => whisper.listen(0, "127.0.0.1", done));
process.env.WHISPER_URL = `http://127.0.0.1:${(whisper.address() as AddressInfo).port}`;

const mock = await startOllamaMock();
after(async () => {
  await mock.close();
  whisper.close();
});
await command(ada, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
mock.answer = (request) =>
  request.system.includes("You write the notes of a meeting")
    ? JSON.stringify({
        actions: [{ text: "Angebot an den Kunden schicken", owner: "Ben", due: "2026-11-13", sources: [2, 3] }],
        topics: [{ title: "Budget", points: [{ text: "Das Budget bleibt im nächsten Quartal gleich.", sources: [4] }, { text: "Angebot hat Vorrang.", sources: [2] }] }],
        open: [{ text: "Wer bucht den Raum?", sources: [] }],
      })
    : "Ben schickt das Angebot [S2].";

async function record(user: Identity, pageId: string, meetingId: string, tracks: ("me" | "others" | "mixed")[], options: { consent?: boolean; durationMs?: number } = {}) {
  const started = await meetings.startMeetingSession(user, { meetingId, pageId, tracks, mime: "audio/webm", consent: options.consent });
  for (const track of tracks)
    for (let index = 0; index < 2; index++) await meetings.storeMeetingChunk(user, meetingId, { session: started.session, track, index }, new Uint8Array([1, 2, 3, index]));
  await meetings.finishMeetingSession(user, meetingId, { session: started.session, parts: Object.fromEntries(tracks.map((t) => [t, 2])), durationMs: options.durationMs ?? 70_000, language: "de" });
  await meetings.meetingJob(meetingId);
  return started;
}

// ---- Pure parts ----

test("citation numbers count in order of first appearance and are reused", () => {
  const { numbers, items } = core.numberCitations([["s3", "s1"], ["s1"], [], ["s7", "s3", "s3"]]);
  assert.deepEqual([...numbers], [
    ["s3", 1],
    ["s1", 2],
    ["s7", 3],
  ]);
  assert.deepEqual(items, [[1, 2], [2], [], [3, 1]]);
  assert.equal(core.circled(1), "①");
  assert.equal(core.circled(21), "㉑");
  assert.equal(core.circled(50), "㊿");
  assert.equal(core.circled(51), "(51)");
});

test("echoes of the call in the microphone are dropped, own speech stays", () => {
  const others = [{ start: 10, end: 16, text: "Kannst du bis Freitag das Angebot schicken?" }];
  const me = [
    { start: 10.6, end: 16.4, text: "kannst du bis freitag das angebot schicken" },
    { start: 11, end: 15, text: "Ich hole mir kurz einen Kaffee, bin gleich zurück." },
    { start: 40, end: 45, text: "Kannst du bis Freitag das Angebot schicken?" },
  ];
  const { kept, dropped } = core.removeEchoes(others, me);
  assert.equal(dropped, 1);
  // Different words at the same time stay; the same words much later too.
  assert.deepEqual(kept.map((s) => s.start), [11, 40]);
  assert.ok(core.textSimilarity("Das Angebot bis Freitag", "das angebot bis freitag!") > 0.99);
  assert.equal(core.textSimilarity("Ja", "Nein"), 0);
});

test("the summary becomes tasks with owner mention and due date, then topics and open points", () => {
  const summary = core.meetingSummarySchema.parse({
    actions: [
      { text: "Angebot schicken", owner: "ben", due: "2026-11-13", sources: [2, 1] },
      { text: "Raum buchen", owner: "Externe Person", due: "morgen", sources: [9] },
    ],
    topics: [{ title: "Budget", points: [{ text: "Bleibt gleich", sources: [1] }] }],
    open: [{ text: "Termin offen" }],
  });
  const segments = [{ sid: "1o0" }, { sid: "1m1" }];
  const { nodes, numbers } = core.summaryNodes(summary, segments, { language: "de", members: [{ id: "u-ben", name: "Ben Becker" }] });
  assert.equal(nodes[0].type, "heading");
  assert.equal(nodes[0].content![0].text, "Aufgaben");
  const tasks = nodes[1].content!;
  assert.equal(tasks[0].attrs!.due, "2026-11-13");
  const first = tasks[0].content![0].content!;
  assert.ok(first.some((n) => n.type === "mention" && n.attrs!.userId === "u-ben"));
  assert.deepEqual(first.filter((n) => n.type === "meetingCite").map((n) => n.attrs!.n), [1, 2]);
  // An invalid date is dropped, a non-member stays as text, an unknown segment is no chip.
  assert.equal(tasks[1].attrs!.due, undefined);
  assert.ok(tasks[1].content![0].content!.some((n) => n.text?.includes("Externe Person")));
  assert.ok(!tasks[1].content![0].content!.some((n) => n.type === "meetingCite"));
  assert.deepEqual(nodes.map((n) => n.type), ["heading", "taskList", "heading", "bulletList", "heading", "bulletList"]);
  // Segment S2 got ①, S1 ②: the order of first citation.
  assert.equal(numbers.get("1m1"), 1);
  assert.equal(numbers.get("1o0"), 2);
  assert.equal(nodes[4].content![0].text, "Offene Punkte");
});

test("speaker names come from the tracks", () => {
  const numbers = new Map([["A", 1], ["B", 2]]);
  assert.equal(core.speakerLabel("me", undefined, new Map(), { me: "Ada", language: "de", split: true }), "Ada");
  assert.equal(core.speakerLabel("others", undefined, new Map(), { me: "Ada", language: "en", split: true }), "Others");
  assert.equal(core.speakerLabel("others", "B", numbers, { me: "Ada", language: "de", split: true }), "Andere 2");
  assert.equal(core.speakerLabel("me", undefined, new Map(), { me: "Ada", language: "de", split: false }), "");
});

// ---- The whole flow ----

test("two tracks: transcript with Ada and Andere, echo removed, summary with tasks in My tasks", async () => {
  const { pageId, meetingId } = await pageWithMeeting();
  await record(ada, pageId, meetingId, ["me", "others"]);
  const status = await meetings.meetingDetails(ada, meetingId);
  assert.equal(status.status, "done", String(status.error));
  assert.ok(whisperCalls.some((n) => n.includes("-me.")) && whisperCalls.some((n) => n.includes("-others.")));
  const speakers = status.transcript.map((s) => `${s.speaker}@${s.start}`);
  assert.deepEqual(speakers, ["Ada@2", "Andere@10", "Andere@40", "Ada@60"]);
  const html = await docHtml(pageId);
  assert.match(html, /data-meeting-cite="[^"]+" data-n="1"/);
  assert.match(html, /data-type="taskItem"[^>]*data-due="2026-11-13"|data-due="2026-11-13"[^>]*data-type="taskItem"/);
  assert.match(status.summary, /Angebot an den Kunden schicken @Ben/);
  // The prompt saw numbered segments and the agenda section.
  const prompt = mock.chats.find((c) => c.system.includes("You write the notes"))!;
  assert.match(prompt.prompt, /S2 \[00:10\] Andere: Ben, kannst du/);
  // Ben's task appears in his "Meine Aufgaben", with a notification.
  const tasks = await myTasks(ben, wid);
  assert.ok(tasks.some((t) => t.pageId === pageId && t.text.startsWith("Angebot an den Kunden schicken") && t.due === "2026-11-13"));
  assert.ok(await one("SELECT 1 FROM notifications WHERE user_id=? AND page_id=?", ben.id, pageId));
  // Audio is deleted after the transcript by default.
  assert.equal(status.audio.length, 0);
  assert.equal(existsSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "tmp", "meetings", meetingId)), false);
});

test("continue later appends to the same transcript after the earlier session", async () => {
  const { pageId, meetingId } = await pageWithMeeting("Fortsetzung");
  await record(ada, pageId, meetingId, ["mixed"], { durationMs: 20_000 });
  const second = await record(ada, pageId, meetingId, ["mixed"], { durationMs: 20_000 });
  assert.equal(second.session, 2);
  assert.equal(second.offsetMs, 20_000);
  const status = await meetings.meetingDetails(ada, meetingId);
  assert.deepEqual(status.transcript.map((s) => [s.session, s.start]), [
    [1, 0],
    [2, 20],
  ]);
  // 40 s in all: no summary, the block says why.
  assert.match(status.summary, /mindestens eine Minute/);
  assert.equal(status.durationMs, 40_000);
});

test("re-generating the summary uses other instructions without transcribing again", async () => {
  const { pageId, meetingId } = await pageWithMeeting("Neu");
  await record(ada, pageId, meetingId, ["me", "others"]);
  const before = whisperCalls.length;
  const chats = mock.chats.length;
  await meetings.regenerateSummary(ada, meetingId, { instructions: "customer" });
  assert.equal(whisperCalls.length, before);
  assert.match(mock.chats[chats].system, /customer conversation/);
});

test("kept audio is deleted after the workspace's number of days", async () => {
  await meetings.saveMeetingSettings(ada, wid, { retention: "days", retentionDays: 2 });
  const { pageId, meetingId } = await pageWithMeeting("Mit Audio");
  await record(ada, pageId, meetingId, ["me", "others"]);
  const kept = await meetings.meetingStatus(ada, meetingId);
  assert.equal(kept.audio.length, 2);
  assert.ok(kept.audioUntil! > Date.now() + 86_400_000);
  const fileIds = kept.audio.map((a) => a.url.split("/").pop()!);
  assert.equal(await meetings.sweepMeetingAudio(Date.now()), 0);
  assert.equal(await meetings.sweepMeetingAudio(Date.now() + 3 * 86_400_000), 1);
  assert.equal((await meetings.meetingStatus(ada, meetingId)).audio.length, 0);
  assert.equal((await all(`SELECT id FROM files WHERE id IN (?,?)`, ...fileIds)).length, 0);
  await meetings.saveMeetingSettings(ada, wid, { retention: "delete" });
});

test("consent: required by the workspace, refused without it", async () => {
  await meetings.saveMeetingSettings(ada, wid, { consentRequired: true, consentText: "Alle sind einverstanden." });
  const { pageId, meetingId } = await pageWithMeeting("Einwilligung");
  await assert.rejects(() => meetings.startMeetingSession(ada, { meetingId, pageId, tracks: ["me"] }), (e: { status: number }) => e.status === 428);
  const started = await meetings.startMeetingSession(ada, { meetingId, pageId, tracks: ["me"], consent: true });
  assert.equal(started.session, 1);
  const row = (await one<{ consent_by: string }>("SELECT consent_by FROM meetings WHERE id=?", meetingId))!;
  assert.equal(row.consent_by, ada.id);
  await assert.rejects(() => meetings.saveMeetingSettings(ben, wid, { consentRequired: false }), /Berechtigung/);
  await meetings.saveMeetingSettings(ada, wid, { consentRequired: false });
});

test("rights: viewers read but do not record, outsiders see nothing, a copied block gets its own meeting", async () => {
  const { pageId, meetingId } = await pageWithMeeting("Rechte");
  await assert.rejects(() => meetings.startMeetingSession(vic, { meetingId, pageId, tracks: ["me"] }), /Berechtigung/);
  await meetings.startMeetingSession(ben, { meetingId, pageId, tracks: ["me"] });
  assert.equal((await meetings.meetingStatus(vic, meetingId)).status, "recording");
  await assert.rejects(() => meetings.meetingStatus(gus, meetingId), /Seite nicht gefunden|Berechtigung/);
  // Only the person who records sends its pieces.
  await assert.rejects(() => meetings.storeMeetingChunk(ada, meetingId, { session: 1, track: "me", index: 0 }, new Uint8Array([1])), /Berechtigung/);
  // The same block id on another page.
  const other = await createPage(wid, space, ada.id, "Kopie");
  const html = meetingHtml({ meetingId, title: "Kopie" });
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), other);
  await assert.rejects(() => meetings.startMeetingSession(ada, { meetingId, pageId: other, tracks: ["me"] }), (e: Error) => e.message === meetings.MEETING_COPY);
  // A meeting id that is not in the document.
  await assert.rejects(() => meetings.startMeetingSession(ada, { meetingId: id(), pageId, tracks: ["me"] }), /nicht gefunden/);
});

test("storage quota: pieces beyond the workspace quota are refused", async () => {
  const { pageId, meetingId } = await pageWithMeeting("Quota");
  const started = await meetings.startMeetingSession(ada, { meetingId, pageId, tracks: ["me"] });
  await run("UPDATE workspaces SET quota_mb=? WHERE id=?", 1, wid);
  try {
    await assert.rejects(
      () => meetings.storeMeetingChunk(ada, meetingId, { session: started.session, track: "me", index: 0 }, new Uint8Array(1024 * 1024 + 10)),
      (e: { status: number }) => e.status === 413,
    );
  } finally {
    await run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  }
});

test("API tokens: only with the AI and transcription permission, and only while the administration allows it", async () => {
  const plain = await tokenFor(ada, "write");
  const withAi = await tokenFor(ada, "write", true);
  const readAi = await tokenFor(ada, "read", true);
  assert.equal(plain.apiAi, undefined);
  assert.equal(withAi.apiAi, true);
  const { pageId, meetingId } = await pageWithMeeting("Token");
  await assert.rejects(() => meetings.startMeetingSession(plain, { meetingId, pageId, tracks: ["me"] }), /KI und Transkription/);
  await assert.rejects(() => meetings.startMeetingSession(readAi, { meetingId, pageId, tracks: ["me"] }), /nur lesen/);
  assert.equal((await meetings.startMeetingSession(withAi, { meetingId, pageId, tracks: ["me"] })).session, 1);
  // The AI gate: tokens without the permission stay "api-token".
  assert.equal(((await resolveAi(plain, "summarize", { workspaceId: wid })) as { reason?: string }).reason, "api-token");
  assert.equal((await resolveAi(withAi, "summarize", { workspaceId: wid })).ok, true);
  await command(ada, { action: "admin.ai", settings: { tokens: false } });
  try {
    assert.equal(((await resolveAi(withAi, "summarize", { workspaceId: wid })) as { reason?: string }).reason, "api-token");
    await assert.rejects(() => meetings.createMeetingFromUpload(withAi, { pageId, transcript: "Ada: Hallo" }), /ausgeschaltet/);
  } finally {
    await command(ada, { action: "admin.ai", settings: { tokens: true } });
  }
  // Browser sessions are not affected.
  assert.equal((await resolveAi(ada, "summarize", { workspaceId: wid })).ok, true);
});

test("POST /api/meetings: a record in a meetings database with date, attendees, duration and status", async () => {
  const db = await createPage(wid, space, ada.id, "Besprechungen", "database");
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db))!.fields);
  // The default "Status" (Nicht begonnen, In Arbeit, Erledigt) stays.
  const statusField = fields.find((f: { name: string }) => f.name === "Status");
  fields.push({ id: "when", name: "Datum", type: "date" }, { id: "who", name: "Teilnehmende", type: "person" }, { id: "len", name: "Dauer (Minuten)", type: "number" });
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), db);
  const token = await tokenFor(ada, "write", true);
  const created = await meetings.createMeetingFromUpload(token, {
    databaseId: db,
    title: "Kundentermin",
    date: "2026-11-10",
    attendees: ["Ben", "extern@example.org"],
    instructions: "customer",
    audio: { me: { data: new Uint8Array([1, 2]), mime: "audio/webm", name: "me.webm" }, others: { data: new Uint8Array([3, 4]), mime: "audio/webm", name: "others.webm" } },
  });
  assert.ok(created.rowId);
  assert.equal(created.statusUrl, `/api/meetings/${created.id}`);
  await meetings.meetingJob(created.id);
  const status = await meetings.meetingDetails(token, created.id);
  assert.equal(status.status, "done", String(status.error));
  assert.equal(status.title, "Kundentermin");
  const row = (await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", created.rowId))!;
  const cells = JSON.parse(row.cells);
  assert.equal(String(cells.when).slice(0, 10), "2026-11-10");
  assert.equal(cells.who, ben.id);
  assert.equal(cells.len, 1);
  assert.equal(cells[statusField.id], "Erledigt");
  assert.ok(Object.values(cells).includes("Kundentermin"));
  // Without a target or with both: refused.
  await assert.rejects(() => meetings.createMeetingFromUpload(token, { transcript: "x" }), /genau eine/);
});

test("MCP: create_meeting_note only for tokens with the AI permission", async () => {
  const plain = await tokenFor(ada, "write");
  const withAi = await tokenFor(ada, "write", true);
  assert.equal(mcpToolNames(plain).includes("create_meeting_note"), false);
  assert.ok(mcpToolNames(withAi).includes("create_meeting_note"));
  const { pageId } = await pageWithMeeting("MCP");
  const call = async (user: Identity, args: Record<string, unknown>) =>
    (await handleMcpMessage(user, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_meeting_note", arguments: args } })) as unknown as {
      result: { content: { text: string }[]; isError?: boolean };
    };
  const refused = await call(plain, { pageId, transcript: "Ada: Hallo" });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /AI and transcription/);
  const ok = await call(withAi, {
    pageId,
    title: "Aus dem Assistenten",
    transcript: "Ada: Ben, kannst du bis Freitag das Angebot an den Kunden schicken?\nBen: Ja, mache ich.",
  });
  assert.equal(ok.result.isError, undefined, ok.result.content[0].text);
  const created = JSON.parse(ok.result.content[0].text) as { id: string };
  await meetings.meetingJob(created.id);
  const status = await meetings.meetingDetails(withAi, created.id);
  assert.equal(status.status, "done", String(status.error));
  assert.deepEqual(status.transcript.map((s) => s.speaker), ["Ada", "Ben"]);
  assert.match(status.summary, /Angebot/);
});

test("Markdown export carries the meeting with chips and transcript", async () => {
  const { pageId } = await pageWithMeeting("Export");
  const { htmlToMarkdown } = await import("../lib/markdown");
  const html = (await docHtml(pageId)).replace(
    '<div data-meeting-part="transcript"></div>',
    '<div data-meeting-part="transcript"><p data-segment="1m0" data-start="65" data-speaker="Ada">Hallo</p></div>',
  ).replace('<div data-meeting-part="summary"><p></p></div>', '<div data-meeting-part="summary"><p>Punkt <sup data-meeting-cite="1m0" data-n="1">①</sup></p></div>');
  const markdown = htmlToMarkdown(html, { url: () => null, linked: () => null });
  assert.match(markdown, /### Export/);
  assert.match(markdown, /Punkt ①/);
  assert.match(markdown, /`01:05` \*\*Ada:\*\* Hallo/);
});

test("guests read a meeting only on a page shared with them; private spaces stay private", async () => {
  const guest = await person("Gina");
  await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
  await run("INSERT INTO workspace_guests VALUES(?,?)", wid, guest.id);
  const { pageId, meetingId } = await pageWithMeeting("Geteilt");
  await meetings.startMeetingSession(ada, { meetingId, pageId, tracks: ["me"] });
  await assert.rejects(() => meetings.meetingStatus(guest, meetingId), /Berechtigung|nicht gefunden/);
  await run("INSERT INTO grants(resource_id,user_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?)", pageId, guest.id, "viewer", "page", wid);
  assert.equal((await meetings.meetingStatus(guest, meetingId)).status, "recording");
  await assert.rejects(() => meetings.startMeetingSession(guest, { meetingId, pageId, tracks: ["me"] }), /Berechtigung/);
  // A meeting in Ada's private space: Ben, a member, sees nothing.
  const privateSpace = id();
  await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", ada.id);
  const secret = await createPage(wid, privateSpace, ada.id, "Personalgespräch");
  const secretMeeting = id();
  const html = meetingHtml({ meetingId: secretMeeting, title: "1:1" });
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), secret);
  await meetings.startMeetingSession(ada, { meetingId: secretMeeting, pageId: secret, tracks: ["me"] });
  await assert.rejects(() => meetings.meetingStatus(ben, secretMeeting), /Berechtigung|nicht gefunden/);
});
