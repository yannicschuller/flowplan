// On-device AI: Apple's language model through the native apps – the
// iPhone/iPad app's window.FlowplanApp.ai and the Mac app's
// window.FlowplanDesktop.ai, one contract for both (version 1):
//
//   availability() → { available, reason?, languages? }
//   generate({ id, instructions?, prompt, schema?, temperature?, maxTokens? }) → { text } | { json }
//   stream(request, onChunk(textSoFar)) → { text }
//   cancel(id)
//
// Errors reject with an Error whose `code` is unavailable, context-too-long,
// guardrail, cancelled, busy or error.
//
// Which actions may run there comes from the server (AiStatus.device: the
// administration's switch, the person's choice, the AI switches of the
// features, the pages closed to the AI); whether this device can is asked
// here. aiRoute decides per action: on the device, on the server, or not at
// all – in end-to-end encrypted spaces only on the device, so nothing is
// ever sent. Light actions only: the writing assistant and summaries of an
// open page or a voice note (lib/ai/device-prompts.ts); asking the
// workspace, AI in databases and AI actions stay on the server.
//
// Browser only, no server imports.
import { aiPageReadable, aiUsable } from "./client";
import { DEVICE_LIMITS, devicePartPrompt, deviceSummaryLanguage, deviceSummaryMarkdown, deviceSummaryPrompt, type DevicePrompt } from "./device-prompts";
import type { AiFeature, AiStatus } from "./features";
import { chunkText, type AiLocale } from "./prompts";

export type DeviceAiCode = "unavailable" | "context-too-long" | "guardrail" | "cancelled" | "busy" | "error";
export type DeviceUnavailableReason = "unsupported-os" | "device-not-eligible" | "apple-intelligence-off" | "model-not-ready" | "unsupported-language" | "error";
export type DeviceAvailability = { available: boolean; reason?: DeviceUnavailableReason; languages?: string[] };
export type DeviceAiRequest = { id: string; instructions?: string; prompt: string; schema?: object; temperature?: number; maxTokens?: number };
export type DeviceAiBridge = {
  version: 1;
  availability(): Promise<DeviceAvailability>;
  generate(request: DeviceAiRequest): Promise<{ text: string } | { json: unknown }>;
  stream(request: Omit<DeviceAiRequest, "schema">, onChunk: (textSoFar: string) => void): Promise<{ text: string }>;
  cancel(id: string): void;
};

export { DEVICE_AI_FEATURES } from "./features";
const CODES: DeviceAiCode[] = ["unavailable", "context-too-long", "guardrail", "cancelled", "busy", "error"];
const REASONS: DeviceUnavailableReason[] = ["unsupported-os", "device-not-eligible", "apple-intelligence-off", "model-not-ready", "unsupported-language", "error"];

// i18n-table: 1 – [German, English] pairs
export const DEVICE_ERROR_TEXT: Record<DeviceAiCode, readonly [string, string]> = {
  unavailable: ["Die KI auf diesem Gerät ist gerade nicht verfügbar.", "The on-device AI is not available right now."],
  "context-too-long": ["Der Text ist zu lang für die KI auf diesem Gerät. Bitte weniger Text auswählen.", "The text is too long for the on-device AI. Please select less text."],
  guardrail: ["Die KI auf diesem Gerät hat die Anfrage abgelehnt (Sicherheitsregeln von Apple).", "The on-device AI declined the request (Apple's safety rules)."],
  cancelled: ["Abgebrochen.", "Cancelled."],
  busy: ["Die KI auf diesem Gerät ist mit einer anderen Anfrage beschäftigt. Bitte gleich noch einmal versuchen.", "The on-device AI is busy with another request. Please try again in a moment."],
  error: ["Die KI auf diesem Gerät ist fehlgeschlagen.", "The on-device AI failed."],
};
// The availability line in the settings ("Apple Intelligence auf diesem
// Gerät: …").
// i18n-table: 1 – [German, English] pairs
export const DEVICE_REASON_TEXT: Record<DeviceUnavailableReason | "available" | "checking" | "no-app", readonly [string, string]> = {
  available: ["verfügbar", "available"],
  checking: ["wird geprüft …", "checking …"],
  "unsupported-os": ["nicht unterstützt – braucht iOS/iPadOS 26 oder macOS 26", "not supported – needs iOS/iPadOS 26 or macOS 26"],
  "device-not-eligible": ["nicht unterstützt – dieses Gerät hat kein Apple Intelligence", "not supported – this device has no Apple Intelligence"],
  "apple-intelligence-off": ["in den Einstellungen ausgeschaltet (Apple Intelligence & Siri)", "turned off in Settings (Apple Intelligence & Siri)"],
  "model-not-ready": ["wird noch geladen – bitte später erneut versuchen", "still downloading – please try again later"],
  "unsupported-language": ["spricht die Sprache der Oberfläche nicht", "does not speak the interface language"],
  error: ["nicht verfügbar", "not available"],
  "no-app": ["nur in den Flowplan-Apps auf iPhone, iPad und Mac", "only in the Flowplan apps on iPhone, iPad and Mac"],
};

export class DeviceAiError extends Error {
  constructor(
    public code: DeviceAiCode,
    message: string = code,
  ) {
    super(message);
    this.name = "DeviceAiError";
  }
}
export const deviceErrorCode = (error: unknown): DeviceAiCode => {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return CODES.includes(code as DeviceAiCode) ? (code as DeviceAiCode) : "error";
};
export const deviceErrorText = (error: unknown, t: (de: string, en: string) => string) => {
  const [de, en] = DEVICE_ERROR_TEXT[deviceErrorCode(error)];
  return t(de, en);
};
const isAbort = (error: unknown) => (error as Error | undefined)?.name === "AbortError";
const abortError = () => new DOMException("The operation was aborted.", "AbortError");

// ---- The bridge ----

type Host = { FlowplanApp?: { ai?: unknown } | null; FlowplanDesktop?: { ai?: unknown } | null };
const browserHost = (): Host | undefined => (typeof window === "undefined" ? undefined : (window as unknown as Host));

// The app's bridge, or null in a browser (or an app without it).
export function deviceBridge(host: Host | undefined = browserHost()): DeviceAiBridge | null {
  for (const candidate of [host?.FlowplanApp?.ai, host?.FlowplanDesktop?.ai]) {
    const bridge = candidate as Partial<DeviceAiBridge> | null | undefined;
    if (
      bridge &&
      bridge.version === 1 &&
      typeof bridge.availability === "function" &&
      typeof bridge.generate === "function" &&
      typeof bridge.stream === "function" &&
      typeof bridge.cancel === "function"
    )
      return bridge as DeviceAiBridge;
  }
  return null;
}

function normalize(raw: unknown): DeviceAvailability {
  if (!raw || typeof raw !== "object") return { available: false, reason: "error" };
  const r = raw as { available?: unknown; reason?: unknown; languages?: unknown };
  const languages = Array.isArray(r.languages) ? r.languages.filter((l): l is string => typeof l === "string").slice(0, 100) : undefined;
  if (r.available === true) return { available: true, ...(languages ? { languages } : {}) };
  return { available: false, reason: REASONS.includes(r.reason as DeviceUnavailableReason) ? (r.reason as DeviceUnavailableReason) : "error", ...(languages ? { languages } : {}) };
}

// Whether the model speaks the interface's language (without a list: yes).
export function deviceSpeaks(availability: DeviceAvailability | null | undefined, locale: AiLocale) {
  if (!availability?.languages?.length) return true;
  return availability.languages.some((l) => l.toLowerCase().split(/[-_]/)[0] === locale);
}
// Why the device cannot, for the settings line; null when it can.
export function deviceReason(state: DeviceAiState, locale: AiLocale): keyof typeof DEVICE_REASON_TEXT | null {
  if (!state.bridge) return "no-app";
  if (!state.checked) return "checking";
  if (!state.availability?.available) return state.availability?.reason || "error";
  return deviceSpeaks(state.availability, locale) ? null : "unsupported-language";
}

// ---- Whether the device can (asked once, again on request) ----

export type DeviceAiState = { bridge: boolean; checked: boolean; availability: DeviceAvailability | null };
let state: DeviceAiState = { bridge: false, checked: false, availability: null };
let pending: Promise<DeviceAvailability | null> | null = null;
const listeners = new Set<() => void>();
const set = (next: DeviceAiState) => {
  state = next;
  for (const listener of listeners) listener();
};
export const deviceAiState = () => state;
export function subscribeDeviceAi(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// Asks the bridge (the answer is kept; `again` asks anew, e.g. after the
// app was in the background – Apple Intelligence may have been turned on).
export function checkDeviceAi(again = false, host: Host | undefined = browserHost()): Promise<DeviceAvailability | null> {
  const bridge = deviceBridge(host);
  if (!bridge) {
    if (state.bridge || !state.checked) set({ bridge: false, checked: true, availability: null });
    return Promise.resolve(null);
  }
  if (pending) return pending;
  if (state.checked && state.bridge && !again) return Promise.resolve(state.availability);
  if (!state.bridge) set({ bridge: true, checked: false, availability: null });
  pending = Promise.resolve()
    .then(() => bridge.availability())
    .then(normalize, () => normalize(null))
    .then((availability) => {
      pending = null;
      set({ bridge: true, checked: true, availability });
      return availability;
    });
  return pending;
}
// For the tests.
export function resetDeviceAi() {
  pending = null;
  state = { bridge: false, checked: false, availability: null };
}

// ---- Where an action runs ----

export type AiRoute = {
  // "hidden": no entry point; "blocked": shown, disabled (the AI may not
  // read this page); "ok": usable.
  availability: "hidden" | "blocked" | "ok";
  primary: "device" | "server" | null;
  // Where it goes when the device cannot (too long, unavailable).
  fallback: "server" | null;
};
export type AiRouteInput = {
  status: AiStatus | null | undefined;
  feature: AiFeature;
  pageId?: string | null;
  // A page of an end-to-end encrypted space: never the server.
  encrypted?: boolean;
  // The device's availability (null: no bridge or not asked yet).
  device: DeviceAvailability | null | undefined;
  locale: AiLocale;
};
export function aiRoute({ status, feature, pageId, encrypted, device, locale }: AiRouteInput): AiRoute {
  const serverFeature = !encrypted && aiUsable(status, feature);
  const serverPage = serverFeature && (!pageId || aiPageReadable(status, pageId));
  const allowed = status?.device;
  const deviceFeature = !!allowed?.features[feature] && !!device?.available && deviceSpeaks(device, locale);
  const devicePage = deviceFeature && (!pageId || !allowed!.excludedPages.includes(pageId));
  if (!serverFeature && !deviceFeature) return { availability: "hidden", primary: null, fallback: null };
  if (!serverPage && !devicePage) return { availability: "blocked", primary: null, fallback: null };
  const primary = devicePage && (allowed!.mode === "prefer" || !serverPage) ? "device" : "server";
  return { availability: "ok", primary, fallback: primary === "device" && serverPage ? "server" : null };
}

// Codes after which the server may take over (when the route allows it).
const FALLBACK: DeviceAiCode[] = ["unavailable", "context-too-long", "busy", "error"];

// Runs on the route's primary place; when the device fails with one of the
// codes above and the route allows the server, there. Says where it ran.
export async function runRouted<T>(
  route: AiRoute,
  run: { device: () => Promise<T>; server: () => Promise<T> },
): Promise<{ result: T; ranOn: "device" | "server"; deviceError?: DeviceAiCode }> {
  if (route.primary === "server") return { result: await run.server(), ranOn: "server" };
  if (route.primary !== "device") throw new DeviceAiError("unavailable");
  try {
    return { result: await run.device(), ranOn: "device" };
  } catch (error) {
    if (isAbort(error)) throw error;
    const code = deviceErrorCode(error);
    if (route.fallback !== "server" || !FALLBACK.includes(code)) throw error instanceof DeviceAiError ? error : new DeviceAiError(code, (error as Error)?.message);
    return { result: await run.server(), ranOn: "server", deviceError: code };
  }
}

// ---- Running a prompt ----

let sequence = 0;
const newId = () => `fp-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(abortError())), { once: true });
  });

export type DeviceRunOptions = {
  bridge?: DeviceAiBridge | null;
  signal?: AbortSignal;
  // Streams the text so far (not with a schema).
  onText?: (text: string) => void;
  // Attempts while the model is busy (a cancelled request still ending).
  retries?: number;
};

// One prompt on the device: the text (streamed when onText is given), or
// with a schema the generated JSON. Aborting cancels it on the device and
// rejects with an AbortError, like fetch.
export async function runOnDevice(prompt: DevicePrompt, options: DeviceRunOptions = {}): Promise<unknown> {
  const bridge = options.bridge === undefined ? deviceBridge() : options.bridge;
  if (!bridge) throw new DeviceAiError("unavailable");
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await once(bridge, prompt, options);
    } catch (error) {
      if (isAbort(error) || deviceErrorCode(error) !== "busy" || attempt >= retries) throw error;
      await wait(300 * (attempt + 1), options.signal);
    }
  }
}

function once(bridge: DeviceAiBridge, prompt: DevicePrompt, { signal, onText }: DeviceRunOptions) {
  return new Promise<unknown>((resolve, reject) => {
    const id = newId();
    const request: DeviceAiRequest = { id, prompt: prompt.prompt, temperature: prompt.temperature, maxTokens: prompt.maxTokens };
    if (prompt.instructions) request.instructions = prompt.instructions;
    let done = false;
    const abort = () => {
      if (done) return;
      done = true;
      try {
        bridge.cancel(id);
      } catch {}
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    let call: Promise<unknown>;
    try {
      call = prompt.schema
        ? bridge.generate({ ...request, schema: prompt.schema })
        : onText
          ? bridge.stream(request, (text) => {
              if (!done && typeof text === "string") onText(text);
            })
          : bridge.generate(request);
    } catch (error) {
      call = Promise.reject(error);
    }
    call.then(
      (result) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        const r = (result || {}) as { text?: unknown; json?: unknown };
        if (prompt.schema) return "json" in r ? resolve(r.json) : reject(new DeviceAiError("error", "no json"));
        resolve(typeof r.text === "string" ? r.text : "");
      },
      (error) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        reject(new DeviceAiError(deviceErrorCode(error), (error as Error)?.message || String(error)));
      },
    );
  });
}

// ---- Summaries on the device ----

// Whether the content can be summarised here: up to maxParts parts.
export const deviceSummaryFits = (content: string) => chunkText(content, DEVICE_LIMITS.partChars).length <= DEVICE_LIMITS.maxParts;

// The summary of an open page, a record's document or a transcript:
// short content in one step (guided generation), long content first
// condensed part by part (one request after the other), then summarised.
// More than maxParts parts: only the beginning (truncated).
export async function deviceSummary(
  content: string,
  { title, locale, ...options }: DeviceRunOptions & { title?: string; locale: AiLocale; onPart?: (part: number, parts: number) => void },
): Promise<{ markdown: string; parts: number; truncated: boolean }> {
  const all = chunkText(content, DEVICE_LIMITS.partChars);
  if (!all.length) throw new DeviceAiError("error", "empty");
  const parts = all.slice(0, DEVICE_LIMITS.maxParts);
  let truncated = all.length > parts.length;
  let text = parts[0];
  if (parts.length > 1) {
    const condensed: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      options.onPart?.(i + 1, parts.length);
      condensed.push(String(await runOnDevice(devicePartPrompt(parts[i], i + 1, parts.length, locale), { ...options, onText: undefined })).trim());
    }
    text = condensed.join("\n\n");
    if (text.length > DEVICE_LIMITS.partChars) {
      text = text.slice(0, DEVICE_LIMITS.partChars);
      truncated = true;
    }
  }
  const json = await runOnDevice(deviceSummaryPrompt(text, locale, title), { ...options, onText: undefined });
  return { markdown: deviceSummaryMarkdown(json, deviceSummaryLanguage(content, locale)), parts: parts.length, truncated };
}
