// The meeting pipeline's pure parts (#199, #225): what Whisper makes up,
// corrections, live windows merged without the repeated overlap, windows of
// a real WebM/Opus recording from Chromium's MediaRecorder, and the
// browser's capture options, level meter and silence warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const core = await import("../lib/meeting-core");
const { webmClusters, webmHeader, webmWindow } = await import("../lib/webm");

const seg = (start: number, end: number, text: string, extra: Record<string, unknown> = {}) => ({ start, end, text, ...extra });

test("made-up lines: subtitle credits, silence phrases alone, loops and repeated lines are marked, speech stays", () => {
  const marked = core.markHallucinations([
    seg(0, 4, "Wir besprechen heute das Budget."),
    seg(4, 6, "Vielen Dank."),
    seg(30, 33, "Untertitel im Auftrag des ZDF, 2021"),
    seg(40, 42, "Untertitelung des ZDF für funk, 2017"),
    seg(50, 52, "Thanks for watching!"),
    seg(60, 62, "Sous-titres réalisés par la communauté d’Amara.org"),
    seg(70, 72, "Untertitel der Amara.org-Community"),
    seg(90, 92, "Vielen Dank."),
    seg(120, 125, "Ja, ja, ja, ja, ja, ja, ja, ja, ja"),
    seg(130, 131, "Okay."),
    seg(131, 132, "Okay."),
    seg(132, 133, "Okay."),
    seg(133, 134, "Okay."),
    seg(140, 142, "Das klingt gut.", { noSpeechProb: 0.9, avgLogprob: -1.4 }),
    seg(150, 152, "Ein ganz normaler Satz.", { compressionRatio: 2.9 }),
    seg(160, 165, "Danke, dann machen wir das so."),
  ]);
  const flags = marked.map((s) => !!s.hallucination);
  assert.deepEqual(flags, [
    false,
    // "Vielen Dank." right after speech is speech.
    false,
    true,
    true,
    true,
    true,
    true,
    // Alone in the silence: made up.
    true,
    true,
    // A run of identical lines: the first stays.
    false,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  assert.equal(core.hallucinationReason(seg(0, 1, "Merci."), undefined, undefined), "silence");
  assert.equal(core.hallucinationReason(seg(0, 1, "Merci."), undefined, seg(1.5, 3, "On commence.")), null);
  assert.equal(core.hallucinationReason(seg(0, 1, "Merci.", { noSpeechProb: 0.5 }), undefined, seg(1.5, 3, "On commence.")), "silence");
});

test("corrections: the fingerprint of the transcribed text shows an edited segment", () => {
  const hash = core.segmentHash("Ja, das mache ich bis Freitag.");
  assert.equal(core.segmentHash("Ja,  das mache ich bis Freitag. "), hash);
  assert.equal(core.isEdited({ text: "Ja, das mache ich bis Freitag.", hash }), false);
  assert.equal(core.isEdited({ text: "Ja, das mache ich bis Donnerstag.", hash }), true);
  assert.equal(core.isEdited({ text: "Alt", hash: "" }), false);
  assert.equal(core.isEdited({ text: "Alt", edited: true }), true);
});

test("live windows: the overlap is not repeated, the cut-off last segment waits for the next window", () => {
  // Window 1 (0–31 s): the last segment is cut by the window's end.
  let state = core.mergeLiveWindow([], 0, [seg(1, 5, "Hallo zusammen"), seg(10, 20, "Wir fangen mit dem Angebot an"), seg(28, 31, "Das Budget")], false);
  assert.deepEqual(state.committed.map((s) => s.text), ["Hallo zusammen", "Wir fangen mit dem Angebot an"]);
  assert.equal(state.until, 28);
  // Window 2 starts earlier (context) and hears the overlap again, slightly
  // differently, then the whole sentence.
  state = core.mergeLiveWindow(
    state.committed,
    state.until,
    [seg(10.3, 20.2, "wir fangen mit dem Angebot an"), seg(28.1, 34, "Das Budget für das nächste Quartal bleibt gleich"), seg(40, 45, "Ben schickt"), seg(58, 61, "Bis")],
    false,
  );
  assert.deepEqual(state.committed.map((s) => s.text), ["Hallo zusammen", "Wir fangen mit dem Angebot an", "Das Budget für das nächste Quartal bleibt gleich", "Ben schickt"]);
  assert.equal(state.until, 58);
  // The last window takes everything, a repeat of a final segment excepted.
  state = core.mergeLiveWindow(state.committed, state.until, [seg(40.2, 45, "Ben schickt"), seg(58, 62, "Bis Freitag dann")], true);
  assert.deepEqual(state.committed.map((s) => s.text).slice(-2), ["Ben schickt", "Bis Freitag dann"]);
  assert.equal(state.until, 62);
});

const fixture = (i: number) => new Uint8Array(readFileSync(new URL(`./fixtures/mediarecorder/chunk${i}`, import.meta.url)));

test("WebM windows from Chromium's MediaRecorder pieces: header of the first piece, then from a cluster on", () => {
  // Five 1-second pieces of `new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" }).start(1000)`.
  const pieces = [0, 1, 2, 3, 4].map(fixture);
  const head = webmHeader(pieces[0])!;
  assert.ok(head);
  assert.equal(head.tick, 0.001);
  assert.equal(head.clusters[0].offset, head.header.length);
  assert.equal(head.clusters[0].time, 0);
  // Later pieces start in the middle of a cluster and hold the next one.
  assert.equal(webmHeader(pieces[2]), null);
  const later = webmClusters(pieces[2]);
  assert.equal(later.length, 1);
  assert.ok(later[0].offset > 0);
  assert.ok(Math.abs(later[0].time - 2034) < 50, String(later[0].time));
  // Not a WebM at all.
  assert.equal(webmHeader(new Uint8Array([1, 2, 3, 4])), null);
  const window = webmWindow(head.header, pieces.slice(2), later[0].offset, false);
  assert.equal(window.size, head.header.length + pieces[2].length - later[0].offset + pieces[3].length + pieces[4].length);
  // From the start: the first piece as it is.
  assert.equal(webmWindow(head.header, pieces, head.header.length, true).size, pieces.reduce((n, p) => n + p.length, 0));
});

test("WebM windows decode (ffmpeg, when installed): a window from piece 2 is about 2.5 s of audio", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const pieces = [0, 1, 2, 3, 4].map(fixture);
  const head = webmHeader(pieces[0])!;
  const cluster = webmClusters(pieces[2])[0];
  const dir = mkdtempSync(join(tmpdir(), "flowplan-webm-"));
  try {
    const file = join(dir, "window.webm");
    writeFileSync(file, new Uint8Array(await webmWindow(head.header, pieces.slice(2), cluster.offset, false).arrayBuffer()));
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { maxBuffer: 10_000_000 });
    assert.equal(decoded.status, 0, String(decoded.stderr));
    const seconds = decoded.stdout.length / 2 / 16000;
    assert.ok(seconds > 2.2 && seconds < 2.8, String(seconds));
    // Piece 2 alone (no header) does not decode.
    writeFileSync(file, pieces[2]);
    assert.notEqual(spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recording everyone from a browser: Chrome and Edge yes, Firefox, Safari and phones no", () => {
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const edge = `${chrome} Edg/131.0.0.0`;
  const firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  const android = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(core.browserCaptureSupport({ userAgent: chrome, getDisplayMedia: true }), { supported: true });
  assert.deepEqual(core.browserCaptureSupport({ userAgent: edge, getDisplayMedia: true }), { supported: true });
  assert.deepEqual(core.browserCaptureSupport({ userAgent: "x", brands: ["Microsoft Edge"], getDisplayMedia: true }), { supported: true });
  assert.equal(core.browserCaptureSupport({ userAgent: chrome, getDisplayMedia: false }).reason, "unsupported");
  assert.equal(core.browserCaptureSupport({ userAgent: firefox, getDisplayMedia: true }).reason, "firefox");
  assert.equal(core.browserCaptureSupport({ userAgent: safari, getDisplayMedia: true }).reason, "safari");
  assert.equal(core.browserCaptureSupport({ userAgent: android, getDisplayMedia: true }).reason, "mobile");
  assert.equal(core.browserCaptureSupport({ userAgent: chrome, mobile: true, getDisplayMedia: true }).reason, "mobile");
});

test("level meter and silent source: reported once after 30 s of silence while the other source has sound", () => {
  assert.equal(core.rmsLevel([]), 0);
  assert.ok(Math.abs(core.rmsLevel([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9);
  const watch = new core.SilenceWatch();
  const reported: string[] = [];
  for (let t = 0; t <= 40_000; t += 100) reported.push(...watch.update({ me: 0.2, others: 0 }, t));
  assert.deepEqual(reported, ["others"]);
  // Back with sound, silent again: reported again.
  watch.update({ me: 0.2, others: 0.3 }, 40_100);
  const again: string[] = [];
  for (let t = 40_200; t <= 75_000; t += 100) again.push(...watch.update({ me: 0.2, others: 0.001 }, t));
  assert.deepEqual(again, ["others"]);
  // Both silent (a pause in the meeting): nothing to report.
  const pause = new core.SilenceWatch();
  const quiet: string[] = [];
  for (let t = 0; t <= 60_000; t += 100) quiet.push(...pause.update({ me: 0, others: 0 }, t));
  assert.deepEqual(quiet, []);
});
