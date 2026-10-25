// Idempotency keys (lib/idempotency.ts on the server): every state-changing
// request may carry `Idempotency-Key: <key>`. The key stands for one logical
// action – a click, a queued offline change, a widget tap – and is sent again
// unchanged when that action is retried, so the server applies it once and
// answers retries with the stored answer. Shared by the browser, the
// service worker and the server; no Node APIs here.

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
// Answers sent again from the store carry this header.
export const REPLAYED_HEADER = "Idempotent-Replayed";
// 8–128 characters of [A-Za-z0-9_-]: UUIDs, ULIDs, base64url.
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const isIdempotencyKey = (value: unknown): value is string =>
  typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);

// The `code` of the server's refusals, for clients that act on them.
export const IDEMPOTENCY_CODES = {
  invalid: "idempotency_key_invalid",
  mismatch: "idempotency_key_reused",
  processing: "idempotency_in_progress",
  applied: "idempotency_already_applied",
} as const;

// A random UUID v4. crypto.randomUUID needs a secure context; plain-http
// instances fall back to getRandomValues.
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Commands that are safe to repeat by nature (CRDT updates merge, the same
// update twice changes nothing) and frequent – several a second while
// someone types or draws. They go without a key, and the server ignores one.
export const unkeyedActions: ReadonlySet<string> = new Set(["document.sync", "row.document.sync", "whiteboard.sync"]);

// The key of one logical action, bound to the request body it sends: the
// same body object sent again (a retry, "Try again", a second submit of the
// same draft, the offline queue) goes with the same key.
const bodyKeys = new WeakMap<object, string>();
export function keyed<T extends object>(body: T, key: string = newIdempotencyKey()): T {
  bodyKeys.set(body, key);
  return body;
}
export function idempotencyKeyOf(body: unknown, create = false): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const action = (body as { action?: unknown }).action;
  if (typeof action === "string" && unkeyedActions.has(action)) return undefined;
  let key = bodyKeys.get(body);
  if (!key && create) bodyKeys.set(body, (key = newIdempotencyKey()));
  return key;
}

// One key per draft (a comment being written): submitting the same text
// twice – a double click, Enter and the button – sends the same key, so the
// comment is posted once. draftSent() after success starts a new action.
const drafts = new Map<string, { content: string; key: string }>();
export function draftKey(scope: string, content: string): string {
  const draft = drafts.get(scope);
  if (draft && draft.content === content) return draft.key;
  const key = newIdempotencyKey();
  drafts.set(scope, { content, key });
  return key;
}
export function draftSent(scope: string) {
  drafts.delete(scope);
}

// Headers for a change sent with fetch() directly (uploads): one key per
// call of the action; pass the key again when the same action is retried.
export const idempotencyHeaders = (key: string = newIdempotencyKey()): Record<string, string> => ({ [IDEMPOTENCY_HEADER]: key });
