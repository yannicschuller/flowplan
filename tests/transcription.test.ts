import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-transcription-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { transcribe, parseTranscription, storeTranscribeChunk, finishTranscribeUpload, TRANSCRIBE_CHUNK_BYTES } = await import("../lib/transcribe");
const { transcriptHtml, transcriptText, transcriptPassages, formatTimestamp } = await import("../lib/transcript");
const { proposeActions, runActions } = await import("../lib/ai/actions");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const meeting = createPage(wid, space, admin.id, "Teamsitzung");

// A Whisper service: verbose_json with segments (and speakers when asked
// for diarization), or – in "old" mode – a server that only knows json.
const whisper = { mode: "verbose" as "verbose" | "old", bodies: [] as string[] };
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("latin1");
    whisper.bodies.push(body);
    const format = body.match(/name="response_format"\r\n\r\n([^\r]+)/)?.[1];
    res.setHeader("Content-Type", "application/json");
    if (whisper.mode === "old" && format !== "json") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "unknown response_format" }));
    }
    if (format === "json") return res.end(JSON.stringify({ text: "Nur Text." }));
    const diarize = /name="diarize"\r\n\r\ntrue/.test(body);
    res.end(
      JSON.stringify({
        text: "Hallo zusammen. Ich übernehme das Angebot. Gut.",
        duration: 3725.4,
        segments: [
          { start: 0, end: 2.5, text: " Hallo zusammen.", ...(diarize ? { speaker: "SPEAKER_00" } : {}) },
          { start: 2.6, end: 5, text: "Ich übernehme das Angebot.", ...(diarize ? { speaker: "SPEAKER_01" } : {}) },
          { start: 3700, end: 3725, text: "Gut.", ...(diarize ? { speaker: "SPEAKER_00" } : {}) },
        ],
      }),
    );
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
process.env.WHISPER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  server.close();
  delete process.env.WHISPER_URL;
});

test("segments with timestamps; speakers only when the service separates them", async () => {
  const plain = await transcribe(new Blob(["audio"], { type: "audio/webm" }), "notiz.webm");
  assert.match(whisper.bodies.at(-1)!, /name="response_format"\r\n\r\nverbose_json/);
  assert.match(whisper.bodies.at(-1)!, /name="timestamp_granularities\[\]"\r\n\r\nsegment/);
  assert.ok(!/name="diarize"/.test(whisper.bodies.at(-1)!));
  assert.equal(plain.segments.length, 3);
  assert.equal(plain.segments[0].text, "Hallo zusammen.");
  assert.equal(plain.speakers, false, "no guessed speakers");
  assert.equal(plain.duration, 3725.4);
  process.env.WHISPER_DIARIZE = "on";
  try {
    const diarized = await transcribe(new Blob(["audio"], { type: "audio/webm" }));
    assert.equal(diarized.speakers, true);
    assert.deepEqual(diarized.segments.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]);
  } finally {
    delete process.env.WHISPER_DIARIZE;
  }
  // A server that only knows plain JSON: a second request without segments.
  whisper.mode = "old";
  const old = await transcribe(new Blob(["audio"], { type: "audio/webm" }));
  assert.deepEqual(old, { text: "Nur Text.", segments: [], speakers: false });
  whisper.mode = "verbose";
});

test("answers are parsed defensively; more than two hours are cut", () => {
  const parsed = parseTranscription({ segments: [{ start: "x", text: "a" }, { start: 1, text: "  " }, { start: 2, end: 3, text: "ok", speaker: 1 }, { start: 8000, text: "zu spät" }] });
  assert.deepEqual(parsed.segments, [{ start: 2, end: 3, text: "ok", speaker: "1" }]);
  assert.equal(parsed.text, "ok");
  assert.deepEqual(parseTranscription(null), { text: "", segments: [], speakers: false });
});

test("the transcript block: timestamps, passages, speakers numbered, escaped", () => {
  assert.equal(formatTimestamp(75), "01:15");
  assert.equal(formatTimestamp(3725.9), "1:02:05");
  const segments = [
    { start: 0, end: 2, text: "Hallo <b>alle</b>.", speaker: "S0" },
    { start: 2.1, end: 4, text: "Weiter.", speaker: "S0" },
    { start: 4.2, end: 6, text: "Ja.", speaker: "S1" },
    { start: 60, end: 61, text: "Nach der Pause.", speaker: "S1" },
  ];
  assert.deepEqual(
    transcriptPassages(segments).map((p) => p.start),
    [0, 4.2, 60],
  );
  const html = transcriptHtml({ segments, duration: 61 }, { title: "Transkript", speaker: (n) => `Sprecher ${n}` })!;
  assert.equal(
    html,
    "<details><summary>Transkript · 01:01</summary><div><p><code>00:00</code> <strong>Sprecher 1:</strong> Hallo &lt;b&gt;alle&lt;/b&gt;. Weiter.</p><p><code>00:04</code> <strong>Sprecher 2:</strong> Ja.</p><p><code>01:00</code> <strong>Sprecher 2:</strong> Nach der Pause.</p></div></details>",
  );
  assert.equal(transcriptHtml({ segments: [] }, { title: "T", speaker: String }), null);
  const withoutSpeakers = transcriptHtml({ segments: [{ start: 5, end: 6, text: "Text." }] }, { title: "T", speaker: String })!;
  assert.ok(!withoutSpeakers.includes("<strong>"));
  assert.equal(transcriptText({ segments, text: "" }, (n) => `S${n}`).split("\n")[0], "[00:00] S1: Hallo <b>alle</b>. Weiter.");
});

test("long recordings: chunks put together on the server, owner and size checked", async () => {
  const upload = randomUUID();
  const part = (n: number) => new Uint8Array(1000).fill(n);
  await storeTranscribeChunk(ben, { uploadId: upload, pageId: meeting, index: 1 }, part(2));
  await storeTranscribeChunk(ben, { uploadId: upload, pageId: meeting, index: 0 }, part(1));
  await assert.rejects(storeTranscribeChunk(admin, { uploadId: upload, pageId: meeting, index: 2 }, part(3)), /Keine Berechtigung/);
  await assert.rejects(storeTranscribeChunk(ben, { uploadId: upload, pageId: meeting, index: 2 }, new Uint8Array(TRANSCRIBE_CHUNK_BYTES + 1)), /zu groß/);
  await assert.rejects(finishTranscribeUpload(ben, { uploadId: upload, pageId: meeting, parts: 3, name: "a.webm", type: "audio/webm" }), /unvollständig/);
  // A failed finish removes the upload.
  assert.equal(existsSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "tmp", "transcribe", upload)), false);

  const second = randomUUID();
  await storeTranscribeChunk(ben, { uploadId: second, pageId: meeting, index: 0 }, part(1));
  await storeTranscribeChunk(ben, { uploadId: second, pageId: meeting, index: 1 }, part(2));
  const before = whisper.bodies.length;
  const result = await finishTranscribeUpload(ben, { uploadId: second, pageId: meeting, parts: 2, name: "sitzung.webm", type: "audio/webm" });
  assert.equal(result.segments.length, 3);
  const body = whisper.bodies[before];
  // The file arrives in order: 1000 × 0x01, then 1000 × 0x02.
  assert.ok(body.includes("\u0001".repeat(1000) + "\u0002".repeat(1000)));
  assert.match(body, /filename="sitzung.webm"/);
  process.env.WHISPER_MAX_MB = "1";
  try {
    await assert.rejects(storeTranscribeChunk(ben, { uploadId: randomUUID(), pageId: meeting, index: 0 }, new Uint8Array(1024 * 1024 + 1)), /zu lang/);
  } finally {
    delete process.env.WHISPER_MAX_MB;
  }
});

test("tasks and summary from a transcript go through the AI actions preview", async () => {
  const mock = await startOllamaMock();
  after(() => mock.close());
  const transcript = transcriptText(await transcribe(new Blob(["audio"], { type: "audio/webm" })), (n) => `Sprecher ${n}`);
  // AI off: no proposal.
  await assert.rejects(proposeActions(ben, { workspaceId: wid, instruction: "x", context: transcript, pageId: meeting, mode: "transcript" }), /ausgeschaltet/);
  command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
  mock.answer = () =>
    JSON.stringify({
      actions: [
        { tool: "append_text", pageId: meeting, markdown: "## Zusammenfassung\n\n- Das Angebot geht raus." },
        { tool: "create_tasks", pageId: meeting, tasks: [{ text: "Angebot übernehmen", assignee: "Ben", due: null }] },
      ],
    });
  const { actions } = await proposeActions(ben, { workspaceId: wid, instruction: "Aufgaben und Zusammenfassung erzeugen", context: transcript, pageId: meeting, mode: "transcript" });
  const prompt = mock.chats.at(-1)!.prompt;
  assert.match(prompt, /\[00:00\] Hallo zusammen\. Ich übernehme das Angebot\.\n\[1:01:40\] Gut\./);
  assert.match(prompt, /Zusammenfassung/);
  assert.deepEqual(
    actions.map((a) => [a.tool, a.ok]),
    [
      ["append_text", true],
      ["create_tasks", true],
    ],
  );
  assert.ok(!one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", meeting)!.html.includes("Angebot"), "nothing before confirming");
  runActions(ben, { workspaceId: wid, actions: actions.map((a) => a.action) });
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", meeting)!.html;
  assert.match(html, /Das Angebot geht raus/);
  assert.match(html, /Angebot übernehmen/);
});
