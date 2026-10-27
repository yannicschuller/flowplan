// On-device AI in the browser (lib/ai/device.ts, lib/ai/device-prompts.ts):
// finding the apps' bridge, its availability, running prompts (streamed,
// guided, cancelled, busy), error codes, where an action runs and when the
// server takes over – never for end-to-end encrypted pages – and the
// prompts for the small model.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  aiRoute,
  checkDeviceAi,
  DEVICE_ERROR_TEXT,
  DEVICE_REASON_TEXT,
  DeviceAiError,
  deviceAiState,
  deviceBridge,
  deviceErrorCode,
  deviceErrorText,
  deviceReason,
  deviceSpeaks,
  deviceSummary,
  deviceSummaryFits,
  resetDeviceAi,
  runOnDevice,
  runRouted,
  subscribeDeviceAi,
  type DeviceAiBridge,
  type DeviceAiRequest,
  type DeviceAvailability,
} from "../lib/ai/device";
import { DEVICE_LIMITS, deviceSummaryMarkdown, deviceSummaryPrompt, deviceTokens, deviceWriteFits, deviceWritePrompt } from "../lib/ai/device-prompts";
import { parseSummary } from "../lib/ai/prompts";
import type { AiStatus } from "../lib/ai/features";

const t = (de: string, en: string) => `${de} | ${en}`;

type Call = { op: "generate" | "stream" | "cancel"; request?: DeviceAiRequest; id?: string };
// A bridge as the apps have it: answers decided by `answer`, calls recorded.
function fakeBridge(
  answer: (call: Call, onChunk?: (text: string) => void) => Promise<unknown> = async (call) => (call.request?.schema ? { json: { ok: true } } : { text: "Antwort" }),
  availability: unknown = { available: true, languages: ["de", "en", "fr"] },
) {
  const calls: Call[] = [];
  const bridge: DeviceAiBridge = {
    version: 1,
    availability: async () => availability as DeviceAvailability,
    generate: (request) => {
      const call: Call = { op: "generate", request };
      calls.push(call);
      return answer(call) as never;
    },
    stream: (request, onChunk) => {
      const call: Call = { op: "stream", request };
      calls.push(call);
      return answer(call, onChunk) as never;
    },
    cancel: (id) => void calls.push({ op: "cancel", id }),
  };
  return { bridge, calls };
}
const codeError = (code: string) => Object.assign(new Error(code), { code });

function status(patch: Partial<AiStatus> = {}): AiStatus {
  return {
    enabled: false,
    features: {
      write: { ok: false, reason: "off" },
      summarize: { ok: false, reason: "off" },
      ask: { ok: false, reason: "off" },
      database: { ok: false, reason: "off" },
      actions: { ok: false, reason: "off" },
      whiteboard: { ok: false, reason: "off" },
    },
    provider: null,
    userProviders: false,
    scope: "all",
    excludedPages: [],
    device: { mode: "prefer", features: { write: true, summarize: true }, excludedPages: [] },
    ...patch,
  };
}
const withServer = (patch: Partial<AiStatus> = {}) =>
  status({
    enabled: true,
    features: { write: { ok: true }, summarize: { ok: true }, ask: { ok: true }, database: { ok: true }, actions: { ok: true }, whiteboard: { ok: true } },
    provider: { kind: "ollama", model: "m", host: "ollama", source: "instance", local: true },
    ...patch,
  });
const available: DeviceAvailability = { available: true, languages: ["de", "en", "fr"] };

beforeEach(() => resetDeviceAi());

test("the bridge is the iOS app's or the Mac app's, version 1 with all four functions", () => {
  const { bridge } = fakeBridge();
  assert.equal(deviceBridge({}), null);
  assert.equal(deviceBridge(undefined), null);
  assert.equal(deviceBridge({ FlowplanApp: { ai: bridge } }), bridge);
  assert.equal(deviceBridge({ FlowplanDesktop: { ai: bridge } }), bridge);
  assert.equal(deviceBridge({ FlowplanApp: {}, FlowplanDesktop: { ai: bridge } }), bridge);
  assert.equal(deviceBridge({ FlowplanApp: { ai: { ...bridge, version: 2 } } }), null);
  assert.equal(deviceBridge({ FlowplanApp: { ai: { ...bridge, stream: undefined } } }), null);
  assert.equal(deviceBridge({ FlowplanApp: null }), null);
  // Outside the apps (and in Node) there is none.
  assert.equal(deviceBridge(), null);
});

test("availability is asked once, kept, asked again on request, and checked", async () => {
  let asked = 0;
  const answers: unknown[] = [{ available: false, reason: "apple-intelligence-off" }, { available: true, languages: ["de", 5, "en"] }, null];
  const bridge = { ...fakeBridge().bridge, availability: async () => (asked++, answers.shift()) as DeviceAvailability };
  const host = { FlowplanApp: { ai: bridge } };
  let changes = 0;
  const stop = subscribeDeviceAi(() => changes++);
  assert.deepEqual(deviceAiState(), { bridge: false, checked: false, availability: null });
  const first = checkDeviceAi(false, host);
  assert.equal(checkDeviceAi(false, host), first, "one question at a time");
  assert.deepEqual(await first, { available: false, reason: "apple-intelligence-off" });
  assert.deepEqual(await checkDeviceAi(false, host), { available: false, reason: "apple-intelligence-off" });
  assert.equal(asked, 1);
  assert.equal(deviceReason(deviceAiState(), "de"), "apple-intelligence-off");
  assert.deepEqual(await checkDeviceAi(true, host), { available: true, languages: ["de", "en"] });
  assert.equal(deviceReason(deviceAiState(), "de"), null);
  assert.equal(deviceReason(deviceAiState(), "fr"), "unsupported-language");
  // A broken answer counts as an error.
  assert.deepEqual(await checkDeviceAi(true, host), { available: false, reason: "error" });
  assert.ok(changes >= 3);
  stop();
  // Without the bridge: "only in the apps".
  resetDeviceAi();
  assert.equal(await checkDeviceAi(false, {}), null);
  assert.equal(deviceReason(deviceAiState(), "de"), "no-app");
  // A rejecting availability is an error too.
  resetDeviceAi();
  assert.deepEqual(await checkDeviceAi(false, { FlowplanApp: { ai: { ...bridge, availability: () => Promise.reject(new Error("x")) } } }), { available: false, reason: "error" });
  // Every state has a line for the settings.
  for (const reason of ["unsupported-os", "device-not-eligible", "apple-intelligence-off", "model-not-ready", "unsupported-language", "error", "available", "checking", "no-app"] as const)
    assert.equal(DEVICE_REASON_TEXT[reason].length, 2);
  assert.ok(deviceSpeaks({ available: true }, "fr"));
  assert.ok(deviceSpeaks({ available: true, languages: ["en-US", "de_DE"] }, "de"));
  assert.ok(!deviceSpeaks({ available: true, languages: ["en"] }, "de"));
});

test("generate and stream: the text, streamed chunks, guided JSON", async () => {
  const { bridge, calls } = fakeBridge(async (call, onChunk) => {
    if (call.request?.schema) return { json: { tasks: ["a"] } };
    if (call.op === "stream") {
      onChunk?.("Hal");
      onChunk?.("Hallo");
      return { text: "Hallo" };
    }
    return { text: "einmal" };
  });
  const chunks: string[] = [];
  assert.equal(await runOnDevice({ instructions: "Kurz.", prompt: "Text", temperature: 0.2, maxTokens: 100 }, { bridge, onText: (text) => chunks.push(text) }), "Hallo");
  assert.deepEqual(chunks, ["Hal", "Hallo"]);
  assert.equal(await runOnDevice({ instructions: "", prompt: "Text", temperature: 0.5, maxTokens: 50 }, { bridge }), "einmal");
  const schema = { type: "object", properties: { tasks: { type: "array", items: { type: "string" } } } };
  assert.deepEqual(await runOnDevice({ instructions: "x", prompt: "y", temperature: 0, maxTokens: 10, schema }, { bridge, onText: () => assert.fail("no stream with a schema") }), { tasks: ["a"] });
  assert.equal(calls[0].op, "stream");
  assert.deepEqual({ ...calls[0].request, id: "" }, { id: "", instructions: "Kurz.", prompt: "Text", temperature: 0.2, maxTokens: 100 });
  // No empty instructions; the schema goes along with generate only.
  assert.ok(!("instructions" in calls[1].request!));
  assert.equal(calls[2].op, "generate");
  assert.deepEqual(calls[2].request!.schema, schema);
  // Every call has its own id.
  assert.equal(new Set(calls.map((c) => c.request!.id)).size, 3);
  // Without a bridge: unavailable.
  await assert.rejects(runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge: null }), (e: DeviceAiError) => e.code === "unavailable");
  // A guided answer without JSON is an error.
  const { bridge: broken } = fakeBridge(async () => ({ text: "kein JSON" }));
  await assert.rejects(runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1, schema }, { bridge: broken }), (e: DeviceAiError) => e.code === "error");
});

test("aborting cancels on the device and rejects like fetch; busy is retried", async () => {
  let release: (value: unknown) => void = () => {};
  const { bridge, calls } = fakeBridge((call) => (call.op === "stream" ? new Promise((resolve) => (release = resolve)) : Promise.resolve({ text: "x" })));
  const abort = new AbortController();
  const chunks: string[] = [];
  const running = runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge, signal: abort.signal, onText: (text) => chunks.push(text) });
  abort.abort();
  await assert.rejects(running, (e: Error) => e.name === "AbortError");
  const id = calls[0].request!.id;
  assert.deepEqual(calls[1], { op: "cancel", id });
  // The late answer of the cancelled call changes nothing.
  release({ text: "spät" });
  assert.deepEqual(chunks, []);
  // Already aborted: nothing is sent.
  await assert.rejects(runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge, signal: abort.signal }), (e: Error) => e.name === "AbortError");
  assert.equal(calls.length, 2);

  // Busy (a cancelled request still ending): tried again, then given up.
  let busy = 2;
  const retried = fakeBridge(async () => (busy-- > 0 ? Promise.reject(codeError("busy")) : { text: "endlich" }));
  assert.equal(await runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge: retried.bridge, retries: 3 }), "endlich");
  assert.equal(retried.calls.length, 3);
  const always = fakeBridge(async () => Promise.reject(codeError("busy")));
  await assert.rejects(runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge: always.bridge, retries: 1 }), (e: DeviceAiError) => e.code === "busy");
  assert.equal(always.calls.length, 2);
});

test("error codes from the bridge, with a text for each", async () => {
  for (const code of ["unavailable", "context-too-long", "guardrail", "cancelled", "busy", "error"] as const) {
    const { bridge } = fakeBridge(async () => Promise.reject(codeError(code)));
    await assert.rejects(runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge, retries: 0 }), (e: DeviceAiError) => e instanceof DeviceAiError && e.code === code);
    assert.equal(deviceErrorText(new DeviceAiError(code), t), `${DEVICE_ERROR_TEXT[code][0]} | ${DEVICE_ERROR_TEXT[code][1]}`);
  }
  assert.equal(deviceErrorCode(codeError("whatever")), "error");
  assert.equal(deviceErrorCode(new Error("x")), "error");
  assert.equal(deviceErrorCode(null), "error");
  // A bridge that throws synchronously.
  const thrower = { ...fakeBridge().bridge, stream: () => { throw codeError("guardrail"); } };
  await assert.rejects(runOnDevice({ instructions: "", prompt: "x", temperature: 0, maxTokens: 1 }, { bridge: thrower, onText: () => {} }), (e: DeviceAiError) => e.code === "guardrail");
});

test("where an action runs: device first, server as fallback, the person's mode", () => {
  const route = (s: AiStatus, extra: { pageId?: string; encrypted?: boolean; device?: DeviceAvailability | null; feature?: "write" | "summarize" | "ask" } = {}) =>
    aiRoute({ status: s, feature: extra.feature || "write", pageId: extra.pageId ?? "p1", encrypted: extra.encrypted, device: extra.device === undefined ? available : extra.device, locale: "de" });
  // No provider on the instance: the device alone.
  assert.deepEqual(route(status()), { availability: "ok", primary: "device", fallback: null });
  // The device cannot (or is not asked yet): hidden, as before.
  assert.deepEqual(route(status(), { device: null }), { availability: "hidden", primary: null, fallback: null });
  assert.deepEqual(route(status(), { device: { available: false, reason: "apple-intelligence-off" } }), { availability: "hidden", primary: null, fallback: null });
  assert.deepEqual(route(status(), { device: { available: true, languages: ["en"] } }), { availability: "hidden", primary: null, fallback: null });
  // AI off for the person or the administration (device: null) – hidden, the device is never used.
  assert.deepEqual(route(status({ device: null })), { availability: "hidden", primary: null, fallback: null });
  assert.deepEqual(route(status({ device: { mode: "prefer", features: { write: false, summarize: true }, excludedPages: [] } })), { availability: "hidden", primary: null, fallback: null });
  // Heavy features never run on the device.
  assert.deepEqual(route(status(), { feature: "ask" }), { availability: "hidden", primary: null, fallback: null });
  // With a server: the device first, the server when the device cannot.
  assert.deepEqual(route(withServer()), { availability: "ok", primary: "device", fallback: "server" });
  assert.deepEqual(route(withServer(), { device: null }), { availability: "ok", primary: "server", fallback: null });
  // "Only without AI on the server".
  const fallback = { mode: "fallback" as const, features: { write: true, summarize: true }, excludedPages: [] };
  assert.deepEqual(route(withServer({ device: fallback })), { availability: "ok", primary: "server", fallback: null });
  assert.deepEqual(route(status({ device: fallback })), { availability: "ok", primary: "device", fallback: null });
  // A page closed to the AI is closed to the device too.
  assert.deepEqual(route(status({ device: { mode: "prefer", features: { write: true }, excludedPages: ["p1"] } })), { availability: "blocked", primary: null, fallback: null });
  assert.deepEqual(route(withServer({ excludedPages: ["p1"], device: { mode: "prefer", features: { write: true }, excludedPages: ["p1"] } })), { availability: "blocked", primary: null, fallback: null });
  // Encrypted: the server is out (its excludedPages has the page), the device may.
  const e2ee = withServer({ excludedPages: ["p1"] });
  assert.deepEqual(route(e2ee, { encrypted: true }), { availability: "ok", primary: "device", fallback: null });
  assert.deepEqual(route(withServer(), { encrypted: true }), { availability: "ok", primary: "device", fallback: null }, "encrypted: never the server, even if it would read");
  assert.deepEqual(route(withServer(), { encrypted: true, device: null }), { availability: "hidden", primary: null, fallback: null });
});

test("runRouted: the server takes over only where the route allows and only for some errors", async () => {
  const ok = { availability: "ok" as const };
  let server = 0;
  const toServer = async () => (server++, "vom Server");
  const failing = (code: string) => async () => Promise.reject(new DeviceAiError(code as never));
  assert.deepEqual(await runRouted({ ...ok, primary: "device", fallback: "server" }, { device: async () => "vom Gerät", server: toServer }), { result: "vom Gerät", ranOn: "device" });
  for (const code of ["unavailable", "context-too-long", "busy", "error"]) {
    const result = await runRouted({ ...ok, primary: "device", fallback: "server" }, { device: failing(code), server: toServer });
    assert.deepEqual(result, { result: "vom Server", ranOn: "server", deviceError: code });
  }
  assert.equal(server, 4);
  // Refused by the guardrails or cancelled: not sent to the server instead.
  for (const code of ["guardrail", "cancelled"])
    await assert.rejects(runRouted({ ...ok, primary: "device", fallback: "server" }, { device: failing(code), server: toServer }), (e: DeviceAiError) => e.code === code);
  const abort = async () => Promise.reject(new DOMException("x", "AbortError"));
  await assert.rejects(runRouted({ ...ok, primary: "device", fallback: "server" }, { device: abort, server: toServer }), (e: Error) => e.name === "AbortError");
  // No fallback (encrypted, or no server AI): the device's error stands.
  await assert.rejects(runRouted({ ...ok, primary: "device", fallback: null }, { device: failing("context-too-long"), server: toServer }), (e: DeviceAiError) => e.code === "context-too-long");
  assert.equal(server, 4, "the server was never asked");
  assert.deepEqual(await runRouted({ ...ok, primary: "server", fallback: null }, { device: () => assert.fail("not the device"), server: toServer }), { result: "vom Server", ranOn: "server" });
  await assert.rejects(runRouted({ availability: "hidden", primary: null, fallback: null }, { device: toServer, server: toServer }), (e: DeviceAiError) => e.code === "unavailable");
});

test("an encrypted page never reaches the server: whatever the device does", async () => {
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => (fetched++, new Response("nein"))) as typeof fetch;
  try {
    for (const code of ["unavailable", "context-too-long", "busy", "error", "guardrail"]) {
      const route = aiRoute({ status: withServer(), feature: "summarize", pageId: "p1", encrypted: true, device: available, locale: "de" });
      const { bridge } = fakeBridge(async () => Promise.reject(codeError(code)));
      await assert.rejects(
        runRouted(route, {
          device: () => deviceSummary("Geheimer Text. ".repeat(20), { bridge, locale: "de", retries: 0 }),
          server: async () => ({ markdown: await (await fetch("/api/ai/summarize")).text(), parts: 1, truncated: false }),
        }),
      );
    }
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("summaries on the device: one guided step, long text in parts, the rest cut", async () => {
  const prompts: DeviceAiRequest[] = [];
  const { bridge } = fakeBridge(async (call) => {
    prompts.push(call.request!);
    if (call.request?.schema) return { json: { summary: "Kurz gesagt.", points: ["Eins", "Zwei"], tasks: [{ task: "Bericht schreiben", who: "Ben", due: "Freitag" }, "Anrufen", { task: "" }] } };
    return { text: `- Teil ${prompts.length}` };
  });
  const short = await deviceSummary("Das ist der Text der Seite und wir planen die Woche.", { bridge, locale: "de", title: "Woche" });
  assert.equal(short.parts, 1);
  assert.equal(short.truncated, false);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].schema);
  assert.match(prompts[0].prompt, /^Titel: Woche/);
  assert.deepEqual(parseSummary(short.markdown), { summary: "Kurz gesagt.", points: ["Eins", "Zwei"], tasks: ["Bericht schreiben (Ben, Freitag)", "Anrufen"] });
  assert.match(short.markdown, /^## Zusammenfassung/);

  prompts.length = 0;
  const paragraph = "Wir haben heute über das Projekt gesprochen und die nächsten Schritte geplant. ".repeat(40);
  const long = Array.from({ length: 3 }, () => paragraph).join("\n\n");
  const parts: number[] = [];
  const result = await deviceSummary(long, { bridge, locale: "en", onPart: (part) => parts.push(part) });
  assert.equal(result.parts, 3);
  assert.deepEqual(parts, [1, 2, 3]);
  assert.equal(prompts.length, 4);
  assert.ok(prompts.slice(0, 3).every((p) => !p.schema && p.maxTokens === 400));
  assert.match(prompts[3].prompt, /- Teil 1\n\n- Teil 2\n\n- Teil 3/);
  // German content: German headings, whatever the interface.
  assert.match(result.markdown, /^## Zusammenfassung/);

  const huge = Array.from({ length: DEVICE_LIMITS.maxParts + 3 }, () => paragraph).join("\n\n");
  assert.equal(deviceSummaryFits(long), true);
  assert.equal(deviceSummaryFits(huge), false);
  prompts.length = 0;
  const cut = await deviceSummary(huge, { bridge, locale: "de" });
  assert.equal(cut.parts, DEVICE_LIMITS.maxParts);
  assert.equal(cut.truncated, true);
  await assert.rejects(deviceSummary("   ", { bridge, locale: "de" }), (e: DeviceAiError) => e.code === "error");
});

test("prompts for the small model: short, in the interface's language, within the context", () => {
  const de = deviceWritePrompt({ action: "improve", text: "Das ist ein Text mit Fehlern und er ist nicht gut.", locale: "de" });
  assert.match(de.instructions, /^Du bist der Schreibassistent von Flowplan\. Korrigiere/);
  assert.match(de.instructions, /Antworte auf Deutsch\.$/);
  assert.match(de.prompt, /^Text:\nDas ist ein Text/);
  assert.equal(de.temperature, 0.1);
  const en = deviceWritePrompt({ action: "translate", text: "Das ist der Plan für die Woche und wir sind bereit.", locale: "en" });
  assert.match(en.instructions, /Translate the text into English/);
  assert.match(en.instructions, /Write in English\.$/);
  const fr = deviceWritePrompt({ action: "translate", text: "This is the plan for the week and we are ready.", language: "fr", locale: "fr" });
  assert.match(fr.instructions, /Traduis le texte en français/);
  const tone = deviceWritePrompt({ action: "tone", tone: "casual", text: "Sehr geehrte Damen und Herren, wir bitten um Antwort.", locale: "de" });
  assert.match(tone.instructions, /lockeren Ton/);
  const custom = deviceWritePrompt({ action: "custom", instruction: "Mach drei Punkte daraus", text: "a b c", locale: "de" });
  assert.match(custom.prompt, /^Auftrag:\nMach drei Punkte daraus\n\nText:\na b c$/);
  const prompt = deviceWritePrompt({ action: "prompt", instruction: "Write an introduction about the project", page: { title: "", markdown: "# Projekt" }, locale: "de" });
  assert.match(prompt.prompt, /^Auftrag:\nWrite an introduction about the project\n\nDie aktuelle Seite als Kontext:\n# Projekt$/);
  assert.doesNotMatch(prompt.prompt, /Text:/);
  for (const action of ["improve", "rephrase", "shorten", "expand", "simplify", "list", "table"] as const) {
    const p = deviceWritePrompt({ action, text: "x".repeat(DEVICE_LIMITS.writeChars), locale: "de" });
    assert.ok(deviceTokens(p.instructions + p.prompt) + p.maxTokens <= DEVICE_LIMITS.contextTokens, action);
    assert.ok(p.instructions.length < 600, action);
  }
  assert.equal(deviceWriteFits({ action: "improve", text: "x".repeat(DEVICE_LIMITS.writeChars), locale: "de" }), true);
  assert.equal(deviceWriteFits({ action: "improve", text: "x".repeat(DEVICE_LIMITS.writeChars + 1), locale: "de" }), false);
  const summary = deviceSummaryPrompt("x".repeat(DEVICE_LIMITS.partChars), "de");
  assert.ok(deviceTokens(summary.instructions + summary.prompt) + summary.maxTokens <= DEVICE_LIMITS.contextTokens);
  assert.deepEqual(Object.keys((summary.schema as { properties: object }).properties), ["summary", "points", "tasks"]);
  // Nothing found: "Keine", as the server's summaries.
  assert.deepEqual(parseSummary(deviceSummaryMarkdown({ summary: "S" }, "en")), { summary: "S", points: [], tasks: [] });
  assert.match(deviceSummaryMarkdown(null, "fr"), /## Résumé[\s\S]*## Tâches ouvertes\n- Aucune$/);
});
