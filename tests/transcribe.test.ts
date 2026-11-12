import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { transcribe, transcriptionEnabled } = await import("../lib/transcribe");

test("voice notes go to the configured Whisper service", async () => {
  delete process.env.WHISPER_URL;
  assert.equal(transcriptionEnabled(), false);
  await assert.rejects(() => transcribe(new Blob(["x"], { type: "audio/webm" })), /nicht eingerichtet/);
  let received = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = `${req.url} ${body}`;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: "  Hallo aus der Sprachnotiz.  " }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  process.env.WHISPER_URL = `http://127.0.0.1:${port}/`;
  process.env.WHISPER_MODEL = "tiny";
  try {
    assert.equal(transcriptionEnabled(), true);
    const result = await transcribe(new Blob(["audio"], { type: "audio/webm" }), "notiz.webm");
    assert.equal(result.text, "Hallo aus der Sprachnotiz.");
    assert.match(received, /^\/v1\/audio\/transcriptions /);
    assert.match(received, /name="model"\r\n\r\ntiny/);
    assert.match(received, /name="language"\r\n\r\nde/);
    assert.match(received, /filename="notiz.webm"/);
  } finally {
    server.close();
    delete process.env.WHISPER_URL;
  }
});

// ---- #225: timeouts, error details, the vocabulary ----

const { transcribeTimeoutMs, whisperPrompt, TranscribeError, WHISPER_PROMPT_CHARS } = await import("../lib/transcribe");

test("the timeout is whole milliseconds, a minute per megabyte (3 min to 2 h), WHISPER_TIMEOUT_SECONDS overrides", () => {
  delete process.env.WHISPER_TIMEOUT_SECONDS;
  // 6.5 MB used to give a fraction, which AbortSignal.timeout() refused.
  for (const bytes of [6_543_210, 8_400_001, 1, 123_456_789, 999_999_999]) assert.ok(Number.isInteger(transcribeTimeoutMs(bytes)), String(bytes));
  assert.equal(transcribeTimeoutMs(1_000), 180_000);
  // whisper.cpp on an M2 needed 383 s for 8.4 MB.
  assert.ok(transcribeTimeoutMs(8_400_000) >= 383_000);
  assert.equal(transcribeTimeoutMs(10_000_000_000), 2 * 60 * 60_000);
  process.env.WHISPER_TIMEOUT_SECONDS = "900";
  assert.equal(transcribeTimeoutMs(1), 900_000);
  process.env.WHISPER_TIMEOUT_SECONDS = "1.7";
  assert.equal(transcribeTimeoutMs(1), 1_000);
  process.env.WHISPER_TIMEOUT_SECONDS = "nonsense";
  assert.equal(transcribeTimeoutMs(1), 180_000);
  delete process.env.WHISPER_TIMEOUT_SECONDS;
});

// A Whisper that answers – headers included – only after `delay` ms, as
// whisper.cpp does once it is done.
async function slowWhisper(
  delay: number,
  answer: (res: import("node:http").ServerResponse) => void = (res) => res.end(JSON.stringify({ text: "Spät, aber da." })),
) {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        answer(res);
      }, delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.WHISPER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    bodies,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

test("the configured limit governs the whole request, headers included, and a timeout says so", async () => {
  const slow = await slowWhisper(1500);
  try {
    // A tiny limit: ends the request although the server is still working.
    process.env.WHISPER_TIMEOUT_SECONDS = "1";
    const started = Date.now();
    await assert.rejects(
      () => transcribe(new Blob(["audio"], { type: "audio/webm" }), "lang.webm"),
      (e: unknown) => e instanceof TranscribeError && e.status === 504 && /nicht rechtzeitig/.test(e.message) && /TIMEOUT/.test(e.detail) && /limit 1 s/.test(e.detail),
    );
    assert.ok(Date.now() - started < 1400);
    // A larger one: headers after 1.5 s are fine – no other limit cuts in.
    process.env.WHISPER_TIMEOUT_SECONDS = "4";
    assert.equal((await transcribe(new Blob(["audio"], { type: "audio/webm" }), "lang.webm")).text, "Spät, aber da.");
  } finally {
    delete process.env.WHISPER_TIMEOUT_SECONDS;
    await slow.close();
    delete process.env.WHISPER_URL;
  }
});

test("errors keep their cause for administrators: refused connection, the service's answer", async () => {
  const closed = await slowWhisper(0);
  const url = process.env.WHISPER_URL!;
  await closed.close();
  process.env.WHISPER_URL = url;
  await assert.rejects(
    () => transcribe(new Blob(["audio"], { type: "audio/webm" })),
    (e: unknown) => e instanceof TranscribeError && e.status === 502 && /nicht erreichbar/.test(e.message) && /ECONNREFUSED/.test(e.detail),
  );
  const failing = await slowWhisper(0, (res) => {
    res.statusCode = 500;
    res.end("model not loaded");
  });
  try {
    await assert.rejects(
      () => transcribe(new Blob(["audio"], { type: "audio/webm" })),
      (e: unknown) => e instanceof TranscribeError && /\(500\)/.test(e.message) && e.detail === "HTTP 500: model not loaded",
    );
  } finally {
    await failing.close();
    delete process.env.WHISPER_URL;
  }
});

test("vocabulary: WHISPER_PROMPT and the glossary go along as prompt, without duplicates and cut after a whole term", async () => {
  process.env.WHISPER_PROMPT = "Flowplan, OKR";
  try {
    assert.equal(whisperPrompt("Ada Lovelace\nokr; Kubernetes,  Grace   Hopper"), "Flowplan, OKR, Ada Lovelace, Kubernetes, Grace Hopper");
    const long = whisperPrompt(Array.from({ length: 300 }, (_, i) => `Begriff${i}`).join("\n"));
    assert.ok(long.length <= WHISPER_PROMPT_CHARS, String(long.length));
    assert.match(long, /, Begriff\d+$/);
    assert.ok(whisperPrompt("x".repeat(2000)).length <= WHISPER_PROMPT_CHARS);
    const fake = await slowWhisper(0);
    try {
      await transcribe(new Blob(["audio"], { type: "audio/webm" }), "a.webm", { prompt: whisperPrompt("Ada Lovelace") });
      assert.match(fake.bodies[0], /name="prompt"\r\n\r\nFlowplan, OKR, Ada Lovelace\r\n/);
      // Without a glossary: the instance's own.
      await transcribe(new Blob(["audio"], { type: "audio/webm" }), "a.webm");
      assert.match(fake.bodies[1], /name="prompt"\r\n\r\nFlowplan, OKR\r\n/);
      assert.doesNotMatch(fake.bodies[1], /name="vad_filter"/);
      delete process.env.WHISPER_PROMPT;
      process.env.WHISPER_VAD = "on";
      await transcribe(new Blob(["audio"], { type: "audio/webm" }), "a.webm");
      assert.doesNotMatch(fake.bodies[2], /name="prompt"/);
      assert.match(fake.bodies[2], /name="vad_filter"\r\n\r\ntrue\r\n/);
      delete process.env.WHISPER_VAD;
    } finally {
      await fake.close();
      delete process.env.WHISPER_URL;
    }
  } finally {
    delete process.env.WHISPER_PROMPT;
  }
});
