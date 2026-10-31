// One message to a chat app (#63): the HTTP request each service expects
// and what its answer means. Pure apart from the transport, which is
// lib/safe-fetch.ts (pinned DNS, internal addresses refused unless the
// operator allows them, no redirects) and which tests replace.
//
//   Telegram  POST {api}/bot{token}/sendMessage – HTML text with the link
//   Gotify    POST {server}/message, X-Gotify-Key – title, message, priority,
//             extras client::notification.click.url
//   ntfy      POST {server}/ as JSON – topic, title, message, click,
//             priority, tags; Bearer token or Basic auth
//   Matrix    PUT {hs}/_matrix/client/v3/rooms/{room}/send/m.room.message/{txn}
//             – plain body and org.matrix.custom.html with the link
//
// Tokens only ever travel in the request (a header, or Telegram's URL path,
// as its API requires); nothing of the answer that could repeat them is kept.
import { safeSend } from "./safe-fetch";
import { matrixSendUrl } from "./notification-templates";
import type { MessengerFailure, MessengerService } from "./messenger-services";

export type MessengerMessage = {
  title: string;
  text: string;
  // Absolute link to the item (or the inbox).
  url: string;
  // The label of the link ("In Flowplan öffnen").
  open: string;
  // Security notices and operations alerts ring louder where a service can.
  urgent?: boolean;
};

// What is stored per connection: `config` in the clear, `secrets` sealed.
export type TelegramConfig = { apiUrl: string; chatId: string };
export type GotifyConfig = { server: string };
export type NtfyConfig = { server: string; topic: string; user?: string };
export type MatrixConfig = { homeserver: string; room: string };
export type MessengerConfig = Partial<TelegramConfig & GotifyConfig & NtfyConfig & MatrixConfig>;
export type MessengerSecrets = { token?: string; password?: string };

export type HttpRequest = { url: string; method: "POST" | "PUT"; headers: Record<string, string>; body: string };
export type HttpResponse = { status: number; body: string; headers?: Record<string, string> };
export type MessengerHttp = (request: HttpRequest, options: { allowPrivate: boolean; timeout?: number }) => Promise<HttpResponse>;

export const defaultHttp: MessengerHttp = (request, { allowPrivate, timeout = 10_000 }) =>
  safeSend(request.url, request.body, request.headers, { method: request.method, allowPrivate, timeout, maxBytes: 64 * 1024 });

const trimBase = (url: string) => url.replace(/\/+$/, "");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Flowplan-Notifications" };

export function telegramMethodUrl(apiUrl: string, token: string, method: string) {
  return `${trimBase(apiUrl)}/bot${token}/${method}`;
}

// The request for one message; `txn` makes a Matrix retry idempotent.
export function buildRequest(
  service: MessengerService,
  config: MessengerConfig,
  secrets: MessengerSecrets,
  message: MessengerMessage,
  txn: string,
): HttpRequest {
  switch (service) {
    case "telegram":
      return {
        url: telegramMethodUrl(config.apiUrl!, secrets.token!, "sendMessage"),
        method: "POST",
        headers: json,
        body: JSON.stringify({
          chat_id: config.chatId,
          text: `<b>${escapeHtml(message.title)}</b>\n${escapeHtml(message.text)}\n\n<a href="${escapeHtml(message.url)}">${escapeHtml(message.open)}</a>`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      };
    case "gotify":
      return {
        url: `${trimBase(config.server!)}/message`,
        method: "POST",
        headers: { ...json, "X-Gotify-Key": secrets.token! },
        body: JSON.stringify({
          title: message.title,
          message: `${message.text}\n\n${message.url}`,
          priority: message.urgent ? 8 : 5,
          extras: {
            "client::display": { contentType: "text/plain" },
            "client::notification": { click: { url: message.url } },
          },
        }),
      };
    case "ntfy": {
      const headers: Record<string, string> = { ...json };
      if (config.user && secrets.password) headers.Authorization = `Basic ${Buffer.from(`${config.user}:${secrets.password}`).toString("base64")}`;
      else if (secrets.token) headers.Authorization = `Bearer ${secrets.token}`;
      return {
        // JSON publishing (POST to the server's root): titles with any
        // characters, no header encoding.
        url: `${trimBase(config.server!)}/`,
        method: "POST",
        headers,
        body: JSON.stringify({
          topic: config.topic,
          title: message.title,
          message: message.text,
          click: message.url,
          priority: message.urgent ? 4 : 3,
          tags: [message.urgent ? "warning" : "bell"],
        }),
      };
    }
    case "matrix":
      return {
        url: matrixSendUrl(config.homeserver!, config.room!, txn),
        method: "PUT",
        headers: { ...json, Authorization: `Bearer ${secrets.token}` },
        body: JSON.stringify({
          // m.text, not m.notice: clients mute notices by default.
          msgtype: "m.text",
          body: `${message.title}\n${message.text}\n${message.url}`,
          format: "org.matrix.custom.html",
          formatted_body: `<strong>${escapeHtml(message.title)}</strong><br>${escapeHtml(message.text)}<br><a href="${escapeHtml(message.url)}">${escapeHtml(message.open)}</a>`,
        }),
      };
  }
}

export type SendOutcome = { ok: true } | { ok: false; reason: MessengerFailure; status?: number; retryAfter?: number };

// "auth:401" – what is stored and shown (lib/messenger-services.ts).
export const failureCode = (outcome: SendOutcome) =>
  outcome.ok ? null : `${outcome.reason}${outcome.status ? `:${outcome.status}` : ""}`;

const parse = (body: string) => {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// What an answer means. Telegram answers 400 "chat not found" and 403 for
// a bot the person blocked; Matrix carries retry_after_ms, Telegram
// parameters.retry_after, others the Retry-After header.
export function classify(service: MessengerService, response: HttpResponse): SendOutcome {
  const { status } = response;
  const data = parse(response.body);
  if (status >= 200 && status < 300 && !(service === "telegram" && data.ok === false)) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, reason: "auth", status };
  if (status === 404 || status === 410) return { ok: false, reason: "notfound", status };
  if (status === 400 && service === "telegram" && /chat not found|user not found|chat_id is empty/i.test(String(data.description || "")))
    return { ok: false, reason: "notfound", status };
  if (status === 429) {
    const header = Number(response.headers?.["retry-after"]);
    const telegram = Number((data.parameters as { retry_after?: number } | undefined)?.retry_after);
    const matrix = Number(data.retry_after_ms) / 1000;
    const retryAfter = [telegram, matrix, header].find((n) => Number.isFinite(n) && n > 0);
    return { ok: false, reason: "rate_limited", status, retryAfter: retryAfter ? Math.min(3600, Math.ceil(retryAfter)) : undefined };
  }
  if (status >= 500 || !status) return { ok: false, reason: "server", status: status || undefined };
  return { ok: false, reason: "rejected", status };
}

// A failed connection: refused internal address or anything on the way.
export function classifyError(error: unknown): SendOutcome {
  const message = String((error as Error)?.message || error);
  if (/Interne Adressen|Nur https/i.test(message)) return { ok: false, reason: "private" };
  return { ok: false, reason: "unreachable" };
}

export async function sendMessage(
  http: MessengerHttp,
  service: MessengerService,
  config: MessengerConfig,
  secrets: MessengerSecrets,
  message: MessengerMessage,
  txn: string,
  allowPrivate: boolean,
): Promise<SendOutcome> {
  let request: HttpRequest;
  try {
    request = buildRequest(service, config, secrets, message, txn);
  } catch {
    return { ok: false, reason: "rejected" };
  }
  try {
    return classify(service, await http(request, { allowPrivate }));
  } catch (error) {
    return classifyError(error);
  }
}
