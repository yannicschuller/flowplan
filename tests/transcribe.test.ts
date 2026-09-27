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
