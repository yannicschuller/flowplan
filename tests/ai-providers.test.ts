import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-providers-"));
const { streamChat, complete, embed, listModels, testConnection, pullModel } = await import("../lib/ai/providers");
const { redactSecrets } = await import("../lib/ai/redact");
const { checkAiUrl } = await import("../lib/ai/transport");

const KEY = "sk-test-SUPERSECRET-0123456789";
type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let closedEarly = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function read(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
// Writes pieces with small pauses, split at awkward places, like a real stream.
async function trickle(res: ServerResponse, parts: string[]) {
  for (const part of parts) {
    res.write(part);
    await sleep(2);
  }
  res.end();
}
const server = createServer(async (req, res) => {
  const body = await read(req);
  const url = req.url || "";
  seen.push({ url, headers: req.headers, body });
  // Errors that echo the key (some providers do).
  if (url.includes("/echo-key/")) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `Invalid key ${req.headers["authorization"] || req.headers["x-api-key"]} for header Authorization: Bearer ${KEY}` } }));
  }
  if (url.includes("/bad-request/")) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `model foo not found; your key ${KEY} was used` } }));
  }
  if (url.includes("/redirect/")) {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
    return res.end();
  }
  if (url === "/api/chat" && JSON.parse(body).model === "slow") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.on("close", () => {
      if (!res.writableEnded) closedEarly++;
    });
    for (let i = 0; i < 200 && !res.destroyed; i++) {
      res.write(`{"message":{"content":"${i} "},"done":false}\n`);
      await sleep(10);
    }
    return res.end();
  }
  if (url === "/api/chat") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    return trickle(res, ['{"message":{"role":"assistant","content":"Hal"},"done":false}\n{"message":{"content":"lo "}', ',"done":false}\n', '{"message":{"content":"Welt"},"done":false}\n{"done":true}\n']);
  }
  if (url === "/api/embed") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ embeddings: JSON.parse(body).input.map((_: string, i: number) => [i, 0.5]) }));
  }
  if (url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "llama3.1:latest" }, { name: "nomic-embed-text:latest" }] }));
  }
  if (url === "/api/pull") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    return trickle(res, ['{"status":"pulling manifest"}\n', '{"status":"downloading","completed":50,"total":100}\n', '{"status":"success"}\n']);
  }
  if (url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return trickle(res, [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\ndata: {"choices":[{"de',
      'lta":{"content":" Welt"}}]}\n\n: keep-alive\n\n',
      "data: [DONE]\n\n",
    ]);
  }
  if (url === "/v1/embeddings") {
    res.writeHead(200, { "content-type": "application/json" });
    const input = JSON.parse(body).input as string[];
    return res.end(JSON.stringify({ data: input.map((_, i) => ({ index: input.length - 1 - i, embedding: [input.length - 1 - i] })).reverse() }));
  }
  if (url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "gpt-test" }, { id: "claude-sonnet-5-5" }] }));
  }
  if (url === "/v1/messages") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return trickle(res, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\nevent: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Welt"}}\r\n\r\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  }
  if (url.startsWith("/v1beta/models/gemini-test:streamGenerateContent")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return trickle(res, [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hal"}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"thinking","thought":true},{"text":"lo Welt"}]}}]}\r\n\r\n',
    ]);
  }
  if (url.startsWith("/v1beta/models/embed-test:batchEmbedContents")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ embeddings: JSON.parse(body).requests.map(() => ({ values: [1, 2, 3] })) }));
  }
  if (url.startsWith("/v1beta/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "models/gemini-test" }, { name: "models/embed-test" }] }));
  }
  if (url === "/mid-error/api/chat") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    return trickle(res, ['{"message":{"content":"a"},"done":false}\n', `{"error":"out of memory (key ${KEY})"}\n`]);
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;
const origin = `http://127.0.0.1:${port}`;
after(() => server.close());

const ask = { system: "Sei knapp.", messages: [{ role: "user" as const, content: "Sag hallo" }], maxTokens: 50 };
async function collect(iterable: AsyncIterable<string>) {
  const pieces: string[] = [];
  for await (const p of iterable) pieces.push(p);
  return pieces;
}

test("Ollama: streamed NDJSON, embeddings, models and pulling a model", async () => {
  const config = { kind: "ollama" as const, baseUrl: origin, model: "llama3.1", embeddingModel: "nomic-embed-text", trusted: true };
  assert.deepEqual(await collect(streamChat(config, ask)), ["Hal", "lo ", "Welt"]);
  const sent = JSON.parse(seen.at(-1)!.body);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.options.num_predict, 50);
  assert.deepEqual(await embed(config, ["a", "b"]), [[0, 0.5], [1, 0.5]]);
  assert.deepEqual(await listModels(config), ["llama3.1:latest", "nomic-embed-text:latest"]);
  const progress = [];
  for await (const step of pullModel(config, "llama3.1")) progress.push(step);
  assert.deepEqual(progress.map((p) => p.status), ["pulling manifest", "downloading", "success"]);
  assert.equal(progress[1].total, 100);
  assert.equal(await embed({ ...config, embeddingModel: "" }, ["a"]), null, "no embedding model, no embeddings");
});

test("OpenAI-compatible: SSE deltas, key only as a bearer header, embeddings in order", async () => {
  const config = { kind: "openai" as const, baseUrl: `${origin}/v1`, model: "gpt-test", embeddingModel: "emb", apiKey: KEY, trusted: true };
  assert.equal(await complete(config, ask), "Hallo Welt");
  const request = seen.at(-1)!;
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!request.url.includes(KEY));
  assert.equal(JSON.parse(request.body).max_tokens, 50);
  assert.deepEqual(await embed(config, ["x", "y", "z"]), [[0], [1], [2]]);
  const result = await testConnection(config);
  assert.equal(result.reply, "Hallo Welt");
  assert.ok(result.models.includes("gpt-test"));
});

test("Anthropic: message events, x-api-key and version header, no embeddings", async () => {
  const config = { kind: "anthropic" as const, baseUrl: origin, model: "claude-sonnet-5-5", apiKey: KEY, trusted: true };
  assert.deepEqual(await collect(streamChat(config, ask)), ["Hallo", " Welt"]);
  const request = seen.at(-1)!;
  assert.equal(request.headers["x-api-key"], KEY);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers.authorization, undefined);
  const sent = JSON.parse(request.body);
  assert.equal(sent.system, "Sei knapp.");
  assert.equal(sent.max_tokens, 50);
  assert.equal(await embed({ ...config, embeddingModel: "x" }, ["a"]), null);
  assert.deepEqual(await listModels(config), ["claude-sonnet-5-5", "gpt-test"]);
});

test("Gemini: alt=sse stream, key in x-goog-api-key and never in the URL, thoughts skipped", async () => {
  const config = { kind: "gemini" as const, baseUrl: origin, model: "gemini-test", embeddingModel: "embed-test", apiKey: KEY, trusted: true };
  assert.equal(await complete(config, ask), "Hallo Welt");
  const request = seen.at(-1)!;
  assert.match(request.url, /:streamGenerateContent\?alt=sse$/);
  assert.ok(!request.url.includes(KEY) && !/key=/.test(request.url));
  assert.equal(request.headers["x-goog-api-key"], KEY);
  const sent = JSON.parse(request.body);
  assert.equal(sent.systemInstruction.parts[0].text, "Sei knapp.");
  assert.equal(sent.generationConfig.maxOutputTokens, 50);
  assert.deepEqual(await embed(config, ["a", "b"]), [[1, 2, 3], [1, 2, 3]]);
  assert.deepEqual(await listModels(config), ["embed-test", "gemini-test"]);
});

test("provider errors never contain the key", async () => {
  for (const kind of ["openai", "anthropic", "gemini"] as const) {
    const config = { kind, baseUrl: `${origin}/echo-key`, model: "m", apiKey: KEY, trusted: true };
    await assert.rejects(complete(config, ask), (error: Error) => {
      assert.ok(!error.message.includes(KEY), error.message);
      assert.match(error.message, /Zugang ab/);
      return true;
    });
  }
  const config = { kind: "openai" as const, baseUrl: `${origin}/bad-request`, model: "m", apiKey: KEY, trusted: true };
  await assert.rejects(complete(config, ask), (error: Error) => {
    assert.ok(!error.message.includes(KEY), error.message);
    assert.match(error.message, /^Der KI-Anbieter meldet: model foo not found/);
    return true;
  });
  await assert.rejects(complete({ kind: "ollama", baseUrl: `${origin}/mid-error`, model: "m", apiKey: KEY, trusted: true }, ask), (error: Error) => {
    assert.ok(!error.message.includes(KEY), error.message);
    assert.match(error.message, /out of memory/);
    return true;
  });
});

test("redirects are not followed, not even for the administration's provider", async () => {
  await assert.rejects(complete({ kind: "openai", baseUrl: `${origin}/redirect`, model: "m", trusted: true }, ask), /Weiterleitungen sind nicht erlaubt/);
});

test("own providers: only public https, never internal or metadata addresses", async () => {
  for (const url of ["http://127.0.0.1:11434", "https://127.0.0.1/v1", "https://10.1.2.3/v1", "https://169.254.169.254/latest", "https://[::1]/v1", "https://[::ffff:10.0.0.1]/v1", "https://192.168.1.5", "https://user:pw@api.example.com", "ftp://example.com"])
    assert.throws(() => checkAiUrl(url, false), /https|Interne/, url);
  assert.doesNotThrow(() => checkAiUrl("https://api.openai.com/v1", false));
  // The administration may use the local network.
  assert.doesNotThrow(() => checkAiUrl("http://ollama:11434", true));
  // A request from a person's own config to a local address is refused before connecting.
  const before = seen.length;
  await assert.rejects(complete({ kind: "openai", baseUrl: `${origin}/v1`, model: "gpt-test", apiKey: KEY, trusted: false }, ask), /https|Interne/);
  // A name that resolves to an internal address is refused by the pinned lookup.
  await assert.rejects(complete({ kind: "openai", baseUrl: `https://localhost:${port}/v1`, model: "gpt-test", apiKey: KEY, trusted: false }, ask), /Interne|nicht erreichbar/);
  assert.equal(seen.length, before, "nothing reached the server");
});

test("aborting stops the provider request and closes the connection", async () => {
  const controller = new AbortController();
  const pieces: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const piece of streamChat({ kind: "ollama", baseUrl: origin, model: "slow", trusted: true }, { ...ask, signal: controller.signal })) {
        pieces.push(piece);
        if (pieces.length === 3) controller.abort();
      }
    })(),
    /abgebrochen/,
  );
  await sleep(100);
  assert.equal(pieces.length, 3);
  assert.ok(closedEarly >= 1, "the provider saw the request end early");
});

test("redactSecrets removes keys, bearer tokens and key parameters", () => {
  const text = `Authorization: Bearer ${KEY}; x-api-key: sk-ant-api03-abcdefghijklmnop; https://x.test/v1?key=AIzaSyA-very-secret-google-key-123 and x-goog-api-key="AIzaSyB0123456789abcdefghij" plus ${encodeURIComponent("my key/with+chars")}`;
  const out = redactSecrets(text, [KEY, "my key/with+chars"]);
  for (const secret of [KEY, "sk-ant-api03-abcdefghijklmnop", "AIzaSyA-very-secret-google-key-123", "AIzaSyB0123456789abcdefghij", "my%20key"])
    assert.ok(!out.includes(secret), `${secret} in ${out}`);
  assert.match(out, /Authorization: \[…\]/);
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
  assert.ok(!redactSecrets(`token ${Buffer.from(KEY).toString("base64")}`, [KEY]).includes(Buffer.from(KEY).toString("base64").slice(0, 20)));
});
