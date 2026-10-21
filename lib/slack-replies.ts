// Thread replies from Slack back into Flowplan: a Slack webhook with a bot
// token remembers the ts of every message it posts (webhook_messages); with
// the app's signing secret, Slack's Event Subscriptions send replies in
// those threads to /api/webhooks/slack/<id>, and each one becomes a comment
// on the record (or page), written as the person who set up the webhook.
import { createHmac, timingSafeEqual } from "node:crypto";
import { all, one } from "./db";
import { HttpError } from "./auth";
import { command } from "./api";
import { openSecret } from "./ai/secrets";
import { quietly } from "./webhooks";
import type { Identity } from "./types";

// Slack's signature: v0=HMAC-SHA256("v0:<timestamp>:<body>"), at most five
// minutes old.
export function verifySlackSignature(secret: string, timestamp: string | null, signature: string | null, body: string, now = Date.now()) {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from("v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Slack mrkdwn to plain text: <url|label> → label (url), <@U1> stays a
// handle, entities decoded.
export function slackToPlain(text: string) {
  return text
    .replace(/<([^<>|]+)\|([^<>]+)>/g, (_, url: string, label: string) => (url.startsWith("http") ? `${label} (${url})` : label))
    .replace(/<(https?:[^<>]+)>/g, "$1")
    .replace(/<[@#!]([^<>]+)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function receiveSlackEvent(hookId: string, headers: Headers, body: string) {
  const hook = one<{ id: string; format: string; credentials: string | null; created_by: string | null }>(
    "SELECT id,format,credentials,created_by FROM webhooks WHERE id=?",
    hookId,
  );
  if (!hook || hook.format !== "slack" || !hook.credentials) throw new HttpError(404, "Unbekannter Webhook.");
  let secret = "";
  try {
    secret = (JSON.parse(openSecret(hook.credentials, `webhook:${hook.id}`)) as { signingSecret?: string }).signingSecret || "";
  } catch {}
  if (!secret) throw new HttpError(404, "Unbekannter Webhook.");
  if (!verifySlackSignature(secret, headers.get("x-slack-request-timestamp"), headers.get("x-slack-signature"), body))
    throw new HttpError(401, "Ungültige Signatur.");
  const payload = JSON.parse(body) as {
    type?: string;
    challenge?: string;
    event?: { type?: string; subtype?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string };
  };
  if (payload.type === "url_verification") return { challenge: String(payload.challenge || "") };
  // Slack retries when the first answer was slow; the comment exists already.
  if (headers.get("x-slack-retry-num")) return { ok: true, ignored: "retry" };
  const event = payload.event;
  if (payload.type !== "event_callback" || event?.type !== "message" || event.subtype || event.bot_id) return { ok: true, ignored: "event" };
  if (!event.thread_ts || event.thread_ts === event.ts || typeof event.text !== "string") return { ok: true, ignored: "not a reply" };
  const message = one<{ page_id: string; row_id: string | null }>(
    "SELECT page_id,row_id FROM webhook_messages WHERE webhook_id=? AND ts=?",
    hook.id,
    event.thread_ts,
  );
  if (!message) return { ok: true, ignored: "unknown thread" };
  const person = hook.created_by ? one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", hook.created_by) : undefined;
  if (!person) return { ok: true, ignored: "no author" };
  const identity: Identity = {
    ...person,
    groups: all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", person.id).map((g) => g.group_id),
    isAdmin: false,
  };
  const text = slackToPlain(event.text).slice(0, 4990);
  if (!text) return { ok: true, ignored: "empty" };
  // As a comment of the webhook's owner (rights checked as for them); the
  // Slack webhook itself gets no echo of its own thread.
  quietly(hook.id, () =>
    command(identity, { action: "comment.create", pageId: message.page_id, rowId: message.row_id || undefined, body: `Slack: ${text}` }, true),
  );
  return { ok: true };
}
