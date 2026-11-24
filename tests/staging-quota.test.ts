// Per-person bounds of staged uploads (#493, #494, #495, lib/staging-quota.ts):
// notebook recordings, meeting pieces and transcription chunks take turns
// per person, at most three open uploads of a kind, the size of one upload,
// and everything a person has staged counts against their storage room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-staging-quota-"));
process.env.APP_URL = "https://flowplan.example.test";
// Never contacted: no live transcription, nothing finished.
process.env.WHISPER_URL = "http://127.0.0.1:9";
const { run, id, one } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { setUserLimits } = await import("../lib/user-limits");
const audio = await import("../lib/notebook-audio");
const meetings = await import("../lib/meetings");
const { storeTranscribeChunk } = await import("../lib/transcribe");
const { meetingHtml } = await import("../lib/meeting-schema");
const { htmlState } = await import("../lib/document-server");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("sq-owner");
const wid = await createWorkspace(owner.id, "Staging");
const space = (await bootstrap(owner, wid)).spaces[0].id;
async function editor(name: string, storageMb?: number) {
  const user = await account(name);
  await run("INSERT INTO members VALUES(?,?,?)", wid, user.id, "editor");
  if (storageMb) await setUserLimits(user.id, { storageMb });
  return user;
}
const notebook = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "NB", kind: "notebook" })) as { id: string }).id;
const plain = await createPage(wid, space, owner.id, "Diktat");

const el = (h: string, c: Buffer) => Buffer.concat([Buffer.from(h, "hex"), Buffer.from([0x80 | c.length]), c]);
function webm(pad: number) {
  const header = el("1a45dfa3", Buffer.concat([el("4282", Buffer.from("webm")), el("4287", Buffer.from([4]))]));
  return new Uint8Array(Buffer.concat([header, Buffer.from("18538067", "hex"), Buffer.from("01ffffffffffffff", "hex"), Buffer.alloc(pad, 7)]));
}
const dirBytes = (dir: string): number => {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(resolve(dir, e.name)) : statSync(resolve(dir, e.name)).size;
  } catch {}
  return n;
};
const status = (e: unknown) => (e as { status?: number })?.status;
const outcome = <T>(p: Promise<T>) => p.then(() => 200, (e) => status(e) ?? String(e));
const staged = async (userId: string) => Number((await one<{ n: number | null }>("SELECT SUM(bytes) n FROM staged_uploads WHERE user_id=?", userId))?.n || 0);

test("#493 notebook: parallel first chunks open at most three uploads; staged bytes count against the room", async () => {
  const racer = await editor("sq-nb-race");
  const chunk = webm(4 * 1024);
  const results = await Promise.all(Array.from({ length: 10 }, () => outcome(audio.storeRecordingChunk(racer, notebook, { recId: randomUUID(), offset: 0, type: "audio/webm" }, chunk))));
  assert.equal(results.filter((r) => r === 200).length, 3, JSON.stringify(results));
  assert.ok(results.every((r) => r === 200 || r === 429));

  // 1 MB storage: 700 KiB staged in one upload leaves no room for a second.
  const limited = await editor("sq-nb-room", 1);
  const big = webm(700 * 1024);
  const first = randomUUID();
  assert.equal(await outcome(audio.storeRecordingChunk(limited, notebook, { recId: first, offset: 0, type: "audio/webm" }, big)), 200);
  assert.equal(await outcome(audio.storeRecordingChunk(limited, notebook, { recId: randomUUID(), offset: 0, type: "audio/webm" }, big)), 413);
  assert.ok((await staged(limited.id)) <= 1024 * 1024);
  // Discarding frees the room again.
  await audio.discardRecordingUpload(limited, notebook, first);
  assert.equal(await staged(limited.id), 0);
  assert.equal(await outcome(audio.storeRecordingChunk(limited, notebook, { recId: randomUUID(), offset: 0, type: "audio/webm" }, big)), 200);
});

async function meeting(i: number) {
  const pageId = await createPage(wid, space, owner.id, `Meeting ${i}`);
  const meetingId = id();
  const html = meetingHtml({ meetingId, title: `M${i}`, date: "2026-11-24", attendees: [] });
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  return { meetingId, pageId };
}

test("#494 meetings: pieces across meetings stay within the room and three open recordings", async () => {
  const limited = await editor("sq-meet-room", 1);
  const results: (number | string)[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await meeting(i);
    const s = await meetings.startMeetingSession(limited, { ...m, tracks: ["me"], mime: "audio/webm", consent: true });
    results.push(await outcome(meetings.storeMeetingChunk(limited, m.meetingId, { session: s.session, track: "me", index: 0 }, new Uint8Array(400 * 1024))));
  }
  // Two pieces fit into 1 MB; the third meeting has no room, the fourth none either.
  assert.deepEqual(results, [200, 200, 413, 413]);
  assert.ok(dirBytes(resolve(process.env.FLOWPLAN_DATA_DIR!, "tmp", "meetings")) <= 1024 * 1024);

  // Without a storage limit: at most three meetings recorded at once.
  const free = await editor("sq-meet-open");
  const open: (number | string)[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await meeting(10 + i);
    const s = await meetings.startMeetingSession(free, { ...m, tracks: ["me"], mime: "audio/webm", consent: true });
    open.push(await outcome(meetings.storeMeetingChunk(free, m.meetingId, { session: s.session, track: "me", index: 0 }, new Uint8Array(1024))));
  }
  assert.deepEqual(open, [200, 200, 200, 429]);
});

test("#494 meetings: parallel pieces of one meeting stay within its length", async () => {
  process.env.WHISPER_MAX_MB = "1";
  try {
    const user = await editor("sq-meet-len");
    const m = await meeting(20);
    const s = await meetings.startMeetingSession(user, { ...m, tracks: ["me"], mime: "audio/webm", consent: true });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => outcome(meetings.storeMeetingChunk(user, m.meetingId, { session: s.session, track: "me", index: i }, new Uint8Array(400 * 1024)))),
    );
    assert.equal(results.filter((r) => r === 200).length, 2, JSON.stringify(results));
    assert.ok((await staged(user.id)) <= 1024 * 1024);
  } finally {
    delete process.env.WHISPER_MAX_MB;
  }
});

test("#495 transcription: parallel first chunks open three uploads, parallel chunks of one stay within WHISPER_MAX_MB", async () => {
  const racer = await editor("sq-tr-race");
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => outcome(storeTranscribeChunk(racer, { uploadId: `tr-${i}-${randomUUID()}`, pageId: plain, index: 0 }, new Uint8Array(1024)))));
  assert.equal(results.filter((r) => r === 200).length, 3, JSON.stringify(results));
  assert.ok(results.every((r) => r === 200 || r === 429));

  process.env.WHISPER_MAX_MB = "1";
  try {
    const filler = await editor("sq-tr-size");
    const upload = randomUUID();
    const chunks = await Promise.all(Array.from({ length: 10 }, (_, i) => outcome(storeTranscribeChunk(filler, { uploadId: upload, pageId: plain, index: i }, new Uint8Array(400 * 1024)))));
    assert.equal(chunks.filter((r) => r === 200).length, 2, JSON.stringify(chunks));
    assert.ok(dirBytes(resolve(process.env.FLOWPLAN_DATA_DIR!, "tmp", "transcribe", upload)) <= 1024 * 1024 + 1024);
  } finally {
    delete process.env.WHISPER_MAX_MB;
  }
});

test("staged transcription chunks count against the room of a notebook recording", async () => {
  const limited = await editor("sq-mixed", 1);
  assert.equal(await outcome(storeTranscribeChunk(limited, { uploadId: randomUUID(), pageId: plain, index: 0 }, new Uint8Array(700 * 1024))), 200);
  assert.equal(await outcome(audio.storeRecordingChunk(limited, notebook, { recId: randomUUID(), offset: 0, type: "audio/webm" }, webm(700 * 1024))), 413);
});
