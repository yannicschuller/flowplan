// Two-way sync between a database view and a Google, Microsoft 365 or CalDAV
// calendar. Each person connects their own account (OAuth 2.0 authorization
// code with PKCE, refresh token sealed at rest; for CalDAV server address,
// username and app password, sealed the same way) and maps a view with a date
// property to one of their calendars. Every ten minutes – or on "Jetzt
// synchronisieren" – the engine pulls what changed in the calendar
// (Google syncToken, Microsoft Graph deltaLink, CalDAV sync-collection or
// ctag/etag comparison; CalDAV series expanded into occurrences by
// lib/ical-recurrence.ts) and pushes what changed in
// the database: title ↔ title, date range ↔ start/end (all-day or timed,
// with time zones), record document (plain text) ↔ description with a link
// back to the record. When both sides changed, the later change wins and an
// audit line records it. Only records the connecting person may read and
// edit leave Flowplan or are changed by the calendar.
//
// Push notifications (Google watch channels, Graph subscriptions) are not
// used: both need a public HTTPS endpoint the provider can reach and
// validate, which many self-hosted instances do not have. The ten-minute
// poll is cheap because both APIs return only changes.
//
// Every request goes through safeSend (lib/safe-fetch.ts); tests swap the
// transport with calendarSyncTesting().
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { all, audit, id, one, run, transaction, nowText } from "./db";
import { HttpError, appUrl, hash } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { visibleRows } from "./row-access";
import { journalLocked, requireUnlocked } from "./journal-extras";
import { assertFieldsWritable } from "./field-access";
import { queryRows } from "./database";
import { calendarRange, calendarSchema } from "./database-calendar";
import { scheduleFields } from "./database-timeline";
import { cellText } from "./cell-text";
import { rowChanged, rowCreated } from "./automations";
import { trashRow } from "./row-trash";
import { maintainRowOrders } from "./row-order-server";
import { escaped } from "./document-server";
import { replaceRowDocument } from "./row-documents";
import { openSecret, sealSecret } from "./secret-box";
import { privateAddress, safeSend } from "./safe-fetch";
import { CalDavClient, DavAuthError, DavChanged, DavFailed, DavTokenInvalid, canonicalUrl, excludeIcsOccurrence, icsOccurrences, newIcsEvent, patchIcsEvent, ridStart, type DavRequest } from "./caldav-client";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ct } from "./content-locale";
import { validZone } from "./date-values";
import type { Field, Identity, Page, Row, View } from "./types";
import { flatMapAsync } from "./each-async";
import { leaderDuty } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import { allow } from "./action-limits";
import { hostAllowed } from "./messengers";

// Google and Microsoft sign in with OAuth; CalDAV with an app password.
export const oauthProviders = ["google", "microsoft"] as const;
export const calendarProviders = [...oauthProviders, "caldav"] as const;
export type CalendarProvider = (typeof calendarProviders)[number];
type OAuthProvider = (typeof oauthProviders)[number];
export const SYNC_INTERVAL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
// Events further back or ahead are not imported; records outside are not
// pushed unless they are already linked.
const WINDOW_PAST_DAYS = 90;
const WINDOW_FUTURE_DAYS = 365;
// A full listing again after this long (Graph delta links keep the window
// they were started with).
const FULL_SYNC_MS = 30 * DAY_MS;
const MAX_EVENTS = 5000;
const MAX_PUSHES = 500;
const MAX_RETRIES = 4;

/* ---------- Transport ---------- */

export type CalendarRequest = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "PROPFIND" | "REPORT";
  url: string;
  headers: Record<string, string>;
  body?: string;
  // CalDAV servers in the own network, when the instance allows it (FLOWPLAN_CALDAV_ALLOW_PRIVATE).
  allowPrivate?: boolean;
};
export type CalendarResponse = { status: number; body: string; headers?: Record<string, string> };
export type CalendarTransport = (request: CalendarRequest) => Promise<CalendarResponse>;
// Answers are read up to 8 MB; a longer one is refused, not cut off.
const MAX_ANSWER = 8_000_000;
const defaultTransport: CalendarTransport = (r) =>
  safeSend(r.url, r.body || "", r.headers, {
    method: r.method,
    allowPrivate: !!r.allowPrivate,
    timeout: 20_000,
    totalTimeout: 120_000,
    maxBytes: MAX_ANSWER + 1,
  });
let transport: CalendarTransport = defaultTransport;
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Tests replace the network and the waiting between retries.
export function calendarSyncTesting(options: { transport?: CalendarTransport | null; sleep?: ((ms: number) => Promise<void>) | null }) {
  if (options.transport !== undefined) transport = options.transport || defaultTransport;
  if (options.sleep !== undefined) sleep = options.sleep || ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/* ---------- Providers ---------- */

type ProviderConfig = {
  clientId: string;
  clientSecret: string;
  authorize: string;
  token: string;
  scope: string;
  extra: Record<string, string>;
  issuer: (iss: string) => boolean;
};
function tenant() {
  const value = process.env.MS_CALENDAR_TENANT || "common";
  return /^[A-Za-z0-9.-]{1,100}$/.test(value) ? value : "common";
}
function providerConfig(provider: CalendarProvider): ProviderConfig | null {
  if (provider === "caldav") return null;
  if (provider === "google") {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || "",
      clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "";
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      scope: "openid email https://www.googleapis.com/auth/calendar",
      // A refresh token on every consent, also when the account was connected before.
      extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      issuer: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
    };
  }
  const clientId = process.env.MS_CALENDAR_CLIENT_ID || "",
    clientSecret = process.env.MS_CALENDAR_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  const base = `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;
  return {
    clientId,
    clientSecret,
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    scope: "openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite",
    extra: { response_mode: "query", prompt: "select_account" },
    issuer: (iss) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(iss),
  };
}
// The providers that connect through an OAuth redirect (the route's /connect/:provider).
export const providerSchema = z.enum(oauthProviders);
function requireProvider(provider: CalendarProvider) {
  const config = providerConfig(provider);
  if (!config) throw new HttpError(503, "Diese Kalenderverbindung ist auf dieser Instanz nicht eingerichtet.");
  return config;
}
// CalDAV needs no app registration: on unless FLOWPLAN_CALDAV_SYNC=off.
export const caldavEnabled = () => (process.env.FLOWPLAN_CALDAV_SYNC || "").trim().toLowerCase() !== "off";
export const providerConfigured = (provider: CalendarProvider) => (provider === "caldav" ? caldavEnabled() : !!providerConfig(provider));
const redirectUri = (provider: CalendarProvider) => `${appUrl()}/api/calendar-sync/callback/${provider}`;

/* ---------- OAuth connection ---------- */

type ConnectionRow = {
  id: string;
  user_id: string;
  provider: CalendarProvider;
  account: string;
  refresh_token: string;
  access_token: string | null;
  access_expires: number;
  last_error: string | null;
  created_at: number;
};
const refreshAad = (connectionId: string) => `calendar-sync:${connectionId}`;
const accessAad = (connectionId: string) => `calendar-sync-access:${connectionId}`;
const FLOW_MS = 10 * 60_000;

// The provider's sign-in page for this person, and the value of the cookie
// that ties the answer to this browser.
export async function startCalendarConnection(user: Identity, provider: OAuthProvider) {
  if (user.demo || user.apiScope) throw new HttpError(403, "Kalender lassen sich nur im Browser verbinden.");
  const config = requireProvider(provider);
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(24).toString("base64url"),
    nonce = randomBytes(24).toString("base64url"),
    flow = randomBytes(32).toString("base64url");
  await run("DELETE FROM calendar_oauth_flows WHERE expires<? OR user_id=?", Date.now(), user.id);
  await run(
    "INSERT INTO calendar_oauth_flows(id,user_id,provider,state,verifier,nonce,expires) VALUES(?,?,?,?,?,?,?)",
    hash(flow),
    user.id,
    provider,
    state,
    verifier,
    nonce,
    Date.now() + FLOW_MS,
  );
  const url = new URL(config.authorize);
  const params: Record<string, string> = {
    client_id: config.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: config.scope,
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...config.extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.toString(), flow };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function claimsOf(idToken: unknown) {
  if (typeof idToken !== "string") return null;
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
async function tokenRequest(config: ProviderConfig, form: Record<string, string>) {
  const response = await transport({
    method: "POST",
    url: config.token,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...form }).toString(),
  });
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(response.body || "{}");
  } catch {}
  return { status: response.status, data };
}

// The answer of the provider: the flow of this browser and person, the
// state and (in the ID token) the nonce must match; the code is exchanged
// with the PKCE verifier. Returns the connection's id.
export async function finishCalendarConnection(user: Identity, provider: OAuthProvider, flow: string | undefined, params: URLSearchParams) {
  const config = requireProvider(provider);
  if (!flow) throw new HttpError(400, "Die Kalenderverbindung ist abgelaufen. Bitte erneut verbinden.");
  const stored = await one<{ user_id: string; provider: string; state: string; verifier: string; nonce: string; expires: number }>(
    "SELECT * FROM calendar_oauth_flows WHERE id=?",
    hash(flow),
  );
  await run("DELETE FROM calendar_oauth_flows WHERE id=?", hash(flow));
  if (!stored || stored.expires < Date.now() || stored.user_id !== user.id || stored.provider !== provider)
    throw new HttpError(400, "Die Kalenderverbindung ist abgelaufen. Bitte erneut verbinden.");
  if (!same(params.get("state") || "", stored.state)) throw new HttpError(400, "Ungültige Antwort des Kalenderanbieters.");
  if (params.get("error")) throw new HttpError(403, "Der Zugriff auf den Kalender wurde nicht erlaubt.");
  const code = params.get("code");
  if (!code) throw new HttpError(400, "Ungültige Antwort des Kalenderanbieters.");
  const token = await tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
    code_verifier: stored.verifier,
  });
  if (token.status !== 200 || typeof token.data.access_token !== "string")
    throw new HttpError(502, "Der Kalenderanbieter hat die Anmeldung abgelehnt.");
  const claims = claimsOf(token.data.id_token);
  const audience = claims?.aud;
  if (
    !claims ||
    typeof claims.nonce !== "string" ||
    !same(claims.nonce, stored.nonce) ||
    !(audience === config.clientId || (Array.isArray(audience) && audience.includes(config.clientId))) ||
    !config.issuer(String(claims.iss || "")) ||
    !(typeof claims.exp === "number" && claims.exp * 1000 > Date.now())
  )
    throw new HttpError(400, "Ungültige Antwort des Kalenderanbieters.");
  const refresh = token.data.refresh_token;
  if (typeof refresh !== "string" || !refresh)
    throw new HttpError(502, "Kein Aktualisierungstoken erhalten. Bitte den Zugriff erneut erlauben.");
  const account = String(claims.email || claims.preferred_username || claims.upn || "").slice(0, 300);
  const existing = await one<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id=? AND provider=? AND account=?", user.id, provider, account);
  const cid = existing?.id || id();
  const expires = Date.now() + Math.max(60, Number(token.data.expires_in) || 3600) * 1000;
  if (existing)
    await run(
      "UPDATE calendar_connections SET refresh_token=?,access_token=?,access_expires=?,last_error=NULL WHERE id=?",
      sealSecret(refresh, refreshAad(cid)),
      sealSecret(token.data.access_token as string, accessAad(cid)),
      expires,
      cid,
    );
  else
    await run(
      "INSERT INTO calendar_connections(id,user_id,provider,account,refresh_token,access_token,access_expires,created_at) VALUES(?,?,?,?,?,?,?,?)",
      cid,
      user.id,
      provider,
      account,
      sealSecret(refresh, refreshAad(cid)),
      sealSecret(token.data.access_token as string, accessAad(cid)),
      expires,
      Date.now(),
    );
  await audit(user.id, "calendar.connect", cid, provider);
  return cid;
}

const REVOKED = "Die Verbindung wurde beim Kalenderanbieter beendet. Bitte neu verbinden.";
async function accessToken(conn: ConnectionRow) {
  if (conn.access_token && conn.access_expires > Date.now() + 60_000) {
    try {
      return openSecret(conn.access_token, accessAad(conn.id));
    } catch {
      /* refresh below */
    }
  }
  const config = requireProvider(conn.provider);
  let refresh: string;
  try {
    refresh = openSecret(conn.refresh_token, refreshAad(conn.id));
  } catch {
    throw new HttpError(409, REVOKED);
  }
  const answer = await tokenRequest(config, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    ...(conn.provider === "microsoft" ? { scope: config.scope } : {}),
  });
  if (answer.status !== 200 || typeof answer.data.access_token !== "string") {
    if (answer.status === 400 || answer.status === 401) {
      await run("UPDATE calendar_connections SET last_error=? WHERE id=?", REVOKED, conn.id);
      throw new HttpError(409, REVOKED);
    }
    throw new HttpError(502, "Der Kalenderanbieter ist gerade nicht erreichbar.");
  }
  const access = answer.data.access_token as string;
  conn.access_token = sealSecret(access, accessAad(conn.id));
  conn.access_expires = Date.now() + Math.max(60, Number(answer.data.expires_in) || 3600) * 1000;
  // Microsoft rotates refresh tokens.
  if (typeof answer.data.refresh_token === "string" && answer.data.refresh_token)
    conn.refresh_token = sealSecret(answer.data.refresh_token, refreshAad(conn.id));
  await run(
    "UPDATE calendar_connections SET access_token=?,access_expires=?,refresh_token=?,last_error=NULL WHERE id=?",
    conn.access_token,
    conn.access_expires,
    conn.refresh_token,
    conn.id,
  );
  return access;
}

// One API call with the person's access token: a 401 refreshes the token
// once; 429, 5xx and Google's rate-limit 403 wait and try again (1, 2, 4 …
// seconds, at most four times).
type Answer = { status: number; data: Record<string, unknown> | null };
async function call(conn: ConnectionRow, method: CalendarRequest["method"], url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(conn);
    const response = await transport({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? "" : JSON.stringify(body),
    });
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      conn.access_expires = 0;
      continue;
    }
    const limited =
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(response.body));
    if (limited && attempt < MAX_RETRIES) {
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      continue;
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {}
    return { status: response.status, data };
  }
}
function failed(answer: Answer, what: string): never {
  console.error(`Calendar sync: ${what} failed with HTTP ${answer.status}`);
  if (answer.status === 429 || answer.status === 403) throw new HttpError(429, "Der Kalenderanbieter begrenzt gerade die Anfragen. Die Synchronisierung versucht es später erneut.");
  throw new HttpError(502, "Der Kalenderanbieter meldet einen Fehler.");
}

/* ---------- Events ---------- */

// What both sides share: all-day events as dates with an inclusive end,
// timed ones as UTC instants to the minute ("2026-10-06T08:00Z").
export type EventContent = { title: string; allDay: boolean; start: string; end: string; description: string };
export type Attendee = { email: string; name: string };
// `plain`: the description read as plain text, when it was read as HTML. Our
// own text can look like HTML ("<b>"), so its echo is matched against both.
// `etag`: the version of a CalDAV event, for If-Match on the next change.
export type RemoteEvent = EventContent & { id: string; deleted: boolean; updated: string; attendees: Attendee[]; plain?: string; etag?: string };
type CalendarInfo = { id: string; name: string; primary: boolean; color?: string };

const addDays = (date: string, days: number) => Temporal.PlainDate.from(date.slice(0, 10)).add({ days }).toString();
const minute = (instant: Temporal.Instant) => `${instant.round({ smallestUnit: "minute", roundingMode: "floor" }).toString().slice(0, 16)}Z`;
export function normalizeText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// The link back to the record at the end of a description.
const FOOTER = /\s*— Flowplan: \S+\s*$/;
export const stripFooter = (text: string) => normalizeText(text.replace(FOOTER, ""));
export function htmlToText(html: string) {
  return normalizeText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}
const textToHtml = (text: string) =>
  normalizeText(text)
    .split("\n")
    .map((line) => `<p>${escaped(line)}</p>`)
    .join("");
export function contentHash(c: EventContent) {
  return createHash("sha256")
    .update(JSON.stringify([c.title.trim(), c.allDay, c.start, c.end, normalizeText(c.description)]))
    .digest("hex")
    .slice(0, 32);
}

// `known`: the linked events of the mapping with their etag (CalDAV compares
// them; the APIs with change tokens do not need them). `etag` on update and
// remove: the version last seen (CalDAV's If-Match).
type Adapter = {
  calendars(conn: ConnectionRow): Promise<CalendarInfo[]>;
  changes(conn: ConnectionRow, calendarId: string, token: string | null, known: Map<string, string | null>, zone: string): Promise<{ events: RemoteEvent[]; token: string }>;
  create(conn: ConnectionRow, calendarId: string, event: EventContent, zone: string, rowId: string, link: string): Promise<RemoteEvent>;
  update(conn: ConnectionRow, calendarId: string, eventId: string, event: EventContent, zone: string, rowId: string, link: string, etag: string | null): Promise<RemoteEvent | null>;
  remove(conn: ConnectionRow, calendarId: string, eventId: string, etag: string | null, zone: string): Promise<void>;
};
// The event changed in the calendar while it was being written (CalDAV 412):
// left as it is; the next run reads the change and applies the conflict rule.
class ChangedMeanwhile extends Error {}
// The token was refused (410 Gone): start again with a full listing.
class TokenExpired extends Error {}
const windowStart = (now: number) => new Date(now - WINDOW_PAST_DAYS * DAY_MS).toISOString();
const windowEnd = (now: number) => new Date(now + WINDOW_FUTURE_DAYS * DAY_MS).toISOString();

/* Google Calendar API v3 */

type GoogleTime = { date?: string; dateTime?: string; timeZone?: string };
type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  updated?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  attendees?: { email?: string; displayName?: string; resource?: boolean }[];
};
// Google descriptions are HTML when edited in its web UI; our pushes are plain
// text that may contain "<u8>" or "<anna@example.org>". Only the tags Google
// writes mark a description as HTML.
const HTML_TAG = /<\/?(?:br|p|div|a|b|i|u|strong|em|ul|ol|li|span|h[1-6])(?:\s[^>]*)?\/?>/i;
export function fromGoogle(item: GoogleEvent): RemoteEvent {
  const base = { id: String(item.id), updated: item.updated || new Date(0).toISOString() };
  if (item.status === "cancelled" || !item.start)
    return { ...base, deleted: true, title: "", allDay: false, start: "", end: "", description: "", attendees: [] };
  const allDay = !!item.start.date;
  let start: string, end: string;
  if (allDay) {
    start = item.start.date!;
    end = item.end?.date ? addDays(item.end.date, -1) : start;
    if (end < start) end = start;
  } else {
    const first = Temporal.Instant.from(item.start.dateTime!);
    start = minute(first);
    end = minute(item.end?.dateTime ? Temporal.Instant.from(item.end.dateTime) : first.add({ hours: 1 }));
  }
  const description = item.description || "";
  const html = HTML_TAG.test(description);
  return {
    ...base,
    deleted: false,
    title: (item.summary || "").slice(0, 500),
    allDay,
    start,
    end,
    description: stripFooter(html ? htmlToText(description) : description),
    ...(html ? { plain: stripFooter(description) } : {}),
    attendees: (item.attendees || [])
      .filter((a) => a.email && !a.resource)
      .map((a) => ({ email: String(a.email).toLowerCase(), name: a.displayName || "" }))
      .slice(0, 200),
  };
}
function toGoogle(event: EventContent, zone: string, rowId: string, link: string) {
  const time = (value: string, allDay: boolean): Record<string, string | null> =>
    allDay ? { date: value, dateTime: null, timeZone: null } : { date: null, dateTime: `${value.slice(0, 16)}:00Z`, timeZone: zone };
  return {
    summary: event.title,
    description: describe(event.description, link),
    start: time(event.start, event.allDay),
    end: time(event.allDay ? addDays(event.end, 1) : event.end, event.allDay),
    extendedProperties: { private: { flowplanRow: rowId } },
  };
}
const describe = (text: string, link: string) => `${normalizeText(text)}${text.trim() ? "\n\n" : ""}— Flowplan: ${link}`;
const GOOGLE = "https://www.googleapis.com/calendar/v3";
const googleEvents = (calendarId: string) => `${GOOGLE}/calendars/${encodeURIComponent(calendarId)}/events`;
const google: Adapter = {
  async calendars(conn) {
    const answer = await call(conn, "GET", `${GOOGLE}/users/me/calendarList?minAccessRole=writer&maxResults=250`);
    if (answer.status !== 200) failed(answer, "calendar list");
    return ((answer.data?.items as { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[]) || []).map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      primary: !!c.primary,
    }));
  },
  async changes(conn, calendarId, token) {
    const events: RemoteEvent[] = [];
    let page = "";
    for (let n = 0; n < 40; n++) {
      const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
      if (token) params.set("syncToken", token);
      else params.set("timeMin", windowStart(Date.now()));
      if (page) params.set("pageToken", page);
      const answer = await call(conn, "GET", `${googleEvents(calendarId)}?${params}`);
      if (answer.status === 410 && token) throw new TokenExpired();
      if (answer.status !== 200) failed(answer, "event list");
      for (const item of (answer.data?.items as GoogleEvent[]) || []) {
        try {
          events.push(fromGoogle(item));
        } catch {
          /* an event with a date this engine cannot read */
        }
      }
      if (typeof answer.data?.nextPageToken === "string" && events.length < MAX_EVENTS) {
        page = answer.data.nextPageToken;
        continue;
      }
      return { events, token: String(answer.data?.nextSyncToken || token || "") };
    }
    throw new HttpError(502, "Der Kalenderanbieter meldet einen Fehler.");
  },
  async create(conn, calendarId, event, zone, rowId, link) {
    const answer = await call(conn, "POST", googleEvents(calendarId), toGoogle(event, zone, rowId, link));
    if (answer.status !== 200 && answer.status !== 201) failed(answer, "create");
    return fromGoogle(answer.data as GoogleEvent);
  },
  async update(conn, calendarId, eventId, event, zone, rowId, link) {
    const answer = await call(conn, "PATCH", `${googleEvents(calendarId)}/${encodeURIComponent(eventId)}`, toGoogle(event, zone, rowId, link));
    if (answer.status === 404 || answer.status === 410) return null;
    if (answer.status !== 200) failed(answer, "update");
    return fromGoogle(answer.data as GoogleEvent);
  },
  async remove(conn, calendarId, eventId) {
    const answer = await call(conn, "DELETE", `${googleEvents(calendarId)}/${encodeURIComponent(eventId)}`);
    if (![200, 204, 404, 410].includes(answer.status)) failed(answer, "delete");
  },
};

/* Microsoft Graph v1.0 */

type GraphTime = { dateTime: string; timeZone?: string };
type GraphEvent = {
  id: string;
  "@removed"?: unknown;
  subject?: string;
  body?: { contentType?: string; content?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  start?: GraphTime;
  end?: GraphTime;
  lastModifiedDateTime?: string;
  attendees?: { emailAddress?: { address?: string; name?: string }; type?: string }[];
};
function graphInstant(time: GraphTime) {
  const local = time.dateTime.slice(0, 19);
  const zone = time.timeZone || "UTC";
  if (!/^utc$/i.test(zone) && validZone(zone)) return Temporal.PlainDateTime.from(local).toZonedDateTime(zone).toInstant();
  return Temporal.Instant.from(`${local}Z`);
}
export function fromGraph(item: GraphEvent): RemoteEvent {
  const base = { id: String(item.id), updated: item.lastModifiedDateTime || new Date(0).toISOString() };
  if (item["@removed"] || item.isCancelled || !item.start)
    return { ...base, deleted: true, title: "", allDay: false, start: "", end: "", description: "", attendees: [] };
  const allDay = !!item.isAllDay;
  let start: string, end: string;
  if (allDay) {
    start = item.start.dateTime.slice(0, 10);
    end = item.end ? addDays(item.end.dateTime.slice(0, 10), -1) : start;
    if (end < start) end = start;
  } else {
    const first = graphInstant(item.start);
    start = minute(first);
    end = minute(item.end ? graphInstant(item.end) : first.add({ hours: 1 }));
  }
  const body = item.body?.content || "";
  return {
    ...base,
    deleted: false,
    title: (item.subject || "").slice(0, 500),
    allDay,
    start,
    end,
    description: stripFooter(item.body?.contentType === "html" ? htmlToText(body) : body),
    attendees: (item.attendees || [])
      .filter((a) => a.emailAddress?.address && a.type !== "resource")
      .map((a) => ({ email: String(a.emailAddress!.address).toLowerCase(), name: a.emailAddress!.name || "" }))
      .slice(0, 200),
  };
}
function toGraph(event: EventContent, link: string) {
  const time = (value: string) => ({ dateTime: event.allDay ? `${value}T00:00:00` : `${value.slice(0, 16)}:00`, timeZone: "UTC" });
  return {
    subject: event.title,
    body: { contentType: "text", content: describe(event.description, link) },
    isAllDay: event.allDay,
    start: time(event.start),
    end: time(event.allDay ? addDays(event.end, 1) : event.end),
  };
}
const GRAPH = "https://graph.microsoft.com/v1.0";
// Times in UTC and descriptions as text, whatever the mailbox prefers.
const GRAPH_PREFER = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text", odata.maxpagesize=100' };
const graphLink = (url: unknown) => typeof url === "string" && url.startsWith(`${GRAPH}/`);
const microsoft: Adapter = {
  async calendars(conn) {
    const answer = await call(conn, "GET", `${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100`);
    if (answer.status !== 200) failed(answer, "calendar list");
    return ((answer.data?.value as { id: string; name?: string; canEdit?: boolean; isDefaultCalendar?: boolean }[]) || [])
      .filter((c) => c.canEdit !== false)
      .map((c) => ({ id: c.id, name: c.name || c.id, primary: !!c.isDefaultCalendar }));
  },
  async changes(conn, calendarId, token) {
    const events: RemoteEvent[] = [];
    const now = Date.now();
    let url =
      token && graphLink(token)
        ? token
        : `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?startDateTime=${encodeURIComponent(windowStart(now))}&endDateTime=${encodeURIComponent(windowEnd(now))}`;
    for (let n = 0; n < 100; n++) {
      const answer = await call(conn, "GET", url, undefined, GRAPH_PREFER);
      if (answer.status === 410 && token) throw new TokenExpired();
      if (answer.status !== 200) failed(answer, "delta");
      for (const item of (answer.data?.value as GraphEvent[]) || []) {
        try {
          events.push(fromGraph(item));
        } catch {
          /* an event with a date this engine cannot read */
        }
      }
      const next = answer.data?.["@odata.nextLink"];
      if (graphLink(next) && events.length < MAX_EVENTS) {
        url = next as string;
        continue;
      }
      const delta = answer.data?.["@odata.deltaLink"];
      return { events, token: graphLink(delta) ? (delta as string) : token || "" };
    }
    throw new HttpError(502, "Der Kalenderanbieter meldet einen Fehler.");
  },
  async create(conn, calendarId, event, _zone, _rowId, link) {
    const answer = await call(conn, "POST", `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`, toGraph(event, link), GRAPH_PREFER);
    if (answer.status !== 200 && answer.status !== 201) failed(answer, "create");
    return fromGraph(answer.data as GraphEvent);
  },
  async update(conn, _calendarId, eventId, event, _zone, _rowId, link) {
    const answer = await call(conn, "PATCH", `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, toGraph(event, link), GRAPH_PREFER);
    if (answer.status === 404 || answer.status === 410) return null;
    if (answer.status !== 200) failed(answer, "update");
    return fromGraph(answer.data as GraphEvent);
  },
  async remove(conn, _calendarId, eventId) {
    const answer = await call(conn, "DELETE", `${GRAPH}/me/events/${encodeURIComponent(eventId)}`);
    if (![200, 204, 404, 410].includes(answer.status)) failed(answer, "delete");
  },
};
/* CalDAV (Nextcloud, iCloud, Fastmail, mailbox.org, Radicale …) */

// What a CalDAV connection keeps, sealed as one value in refresh_token: the
// address the person typed, the calendar home found from it, and the
// credentials. Requests go only to the home's origin.
type CalDavSecret = { server: string; home: string; username: string; password: string };
const caldavAad = (connectionId: string) => `calendar-sync-caldav:${connectionId}`;
const CALDAV_REJECTED = "Der CalDAV-Server hat Benutzername oder App-Passwort abgelehnt. Bitte neu verbinden.";
// Plain http and addresses in the own network only when the instance allows
// it, as for chat apps and webhooks.
export function caldavAllowPrivate() {
  const own = process.env.FLOWPLAN_CALDAV_ALLOW_PRIVATE?.trim();
  return (own || process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE) === "true";
}
// https everywhere; http (and with it Basic auth in the clear) only to a
// server in the own network and only when allowed. safeSend checks the
// addresses of https requests itself.
// FLOWPLAN_CALDAV_ALLOWED_HOSTS: the servers people may connect ("cloud.example.org,
// *.icloud.com"; "*." for its subdomains); empty for every public server.
export const caldavAllowedHosts = () =>
  (process.env.FLOWPLAN_CALDAV_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
async function checkDavUrl(url: URL) {
  if (url.username || url.password || url.hash) throw new HttpError(400, "Zugangsdaten gehören nicht in die Server-Adresse.");
  // Checked for every request, also the targets of discovery's redirects.
  const allowed = caldavAllowedHosts();
  if (allowed.length && !hostAllowed(url.hostname.replace(/^\[|\]$/g, ""), allowed) && !allowed.includes(url.host.toLowerCase()))
    throw new HttpError(400, ct(`Der CalDAV-Server „${url.hostname}“ ist auf dieser Instanz nicht freigegeben.`, `The CalDAV server “${url.hostname}” is not allowed on this instance.`));
  if (url.protocol === "https:") return;
  if (url.protocol !== "http:" || !caldavAllowPrivate()) throw new HttpError(400, "Die Server-Adresse muss mit https:// beginnen.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length || !addresses.every(privateAddress))
    throw new HttpError(400, "Unverschlüsselt (http://) nur zu einem Server im eigenen Netz – sonst bitte https:// verwenden.");
}
// The requests of one connection: Basic auth, only to `origins` (null while
// discovering), 429 and 5xx retried like the APIs, answers at most 8 MB.
function davSend(credentials: { username: string; password: string }, origins: string[] | null) {
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
  return async (r: DavRequest) => {
    const url = new URL(r.url);
    if (origins && !origins.includes(url.origin)) throw new HttpError(400, "Unbekannter Kalender.");
    await checkDavUrl(url);
    for (let attempt = 0; ; attempt++) {
      let response: CalendarResponse;
      try {
        response = await transport({
          method: r.method,
          url: url.toString(),
          headers: { ...r.headers, authorization, "user-agent": "Flowplan-CalendarSync/1.0" },
          body: r.body || "",
          allowPrivate: caldavAllowPrivate(),
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // The message names no credentials; it is not logged all the same.
        if (/Interne Adressen/.test((error as Error).message)) throw new HttpError(400, "Interne Adressen sind nicht erlaubt.");
        throw new HttpError(502, "Der Kalenderserver ist nicht erreichbar.");
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (Buffer.byteLength(response.body || "") >= MAX_ANSWER) throw new HttpError(502, "Die Antwort des Kalenderservers ist zu groß.");
      const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      return { status: response.status, body: response.body || "", headers };
    }
  };
}
function caldavSecret(conn: ConnectionRow): CalDavSecret {
  try {
    const secret = JSON.parse(openSecret(conn.refresh_token, caldavAad(conn.id))) as CalDavSecret;
    if (secret.home && secret.username && typeof secret.password === "string") return secret;
  } catch {}
  throw new HttpError(409, CALDAV_REJECTED);
}
// Errors of the CalDAV client as the engine knows them.
async function withDav<T>(conn: ConnectionRow, fn: (client: CalDavClient, secret: CalDavSecret) => Promise<T>): Promise<T> {
  const secret = caldavSecret(conn);
  const client = new CalDavClient(davSend(secret, [new URL(secret.home).origin]));
  try {
    const result = await fn(client, secret);
    if (conn.last_error) {
      await run("UPDATE calendar_connections SET last_error=NULL WHERE id=?", conn.id);
      conn.last_error = null;
    }
    return result;
  } catch (error) {
    throw await davError(error, conn.id);
  }
}
async function davError(error: unknown, connectionId: string | null) {
  if (error instanceof DavAuthError) {
    if (connectionId) await run("UPDATE calendar_connections SET last_error=? WHERE id=?", CALDAV_REJECTED, connectionId);
    return new HttpError(409, CALDAV_REJECTED);
  }
  if (error instanceof DavChanged) return new ChangedMeanwhile();
  if (error instanceof DavTokenInvalid) return new TokenExpired();
  if (error instanceof DavFailed) {
    console.error(`Calendar sync: CalDAV ${error.what} failed with HTTP ${error.status}`);
    if (error.status === 429) return new HttpError(429, "Der Kalenderanbieter begrenzt gerade die Anfragen. Die Synchronisierung versucht es später erneut.");
    if (error.status === 403) return new HttpError(403, "Der Kalenderserver erlaubt diese Änderung nicht.");
    if (error.what === "discovery") return new HttpError(400, "Unter dieser Adresse wurde kein CalDAV-Kalender gefunden.");
    return new HttpError(502, "Der Kalenderanbieter meldet einen Fehler.");
  }
  return error;
}
// The calendar of a mapping, on the connection's server.
function davCalendar(secret: CalDavSecret, calendarId: string) {
  const url = canonicalUrl(calendarId, secret.home);
  if (!url) throw new HttpError(400, "Unbekannter Kalender.");
  return url.endsWith("/") ? url : `${url}/`;
}
const davTime = (iso: string) => `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
const goneEvent = (id: string): RemoteEvent => ({ id, deleted: true, title: "", allDay: false, start: "", end: "", description: "", attendees: [], updated: new Date(0).toISOString() });
// Event ids: the resource's path, and for an occurrence of a series its
// original start after "#" ("/cal/team.ics#20261006T080000Z") – as Google
// and Microsoft give each occurrence an id of its own.
const resourceOf = (eventId: string) => eventId.split("#")[0];
const ridIn = (eventId: string) => eventId.split("#")[1] || "";
const MAX_OCCURRENCES = 500;
// Series this engine cannot expand: said once per resource and process.
const unsupportedSeries = new Set<string>();
// Our own writes to a resource: the etag before → after. The occurrences of
// a series share one resource; the etag stored with one of them is still
// "ours" after a write to another one in the same run.
const ownWrites = new Map<string, Map<string, string>>();
function wrote(url: string, before: string, after: string) {
  if (!before || !after) return;
  if (ownWrites.size > 2000) ownWrites.clear();
  const chain = ownWrites.get(url) || new Map<string, string>();
  chain.set(before, after);
  ownWrites.set(url, chain);
}
function sameVersion(url: string, stored: string, current: string) {
  let etag = stored;
  for (let n = 0; n < 50 && etag; n++) {
    if (etag === current) return true;
    etag = ownWrites.get(url)?.get(etag) || "";
  }
  return false;
}
const davWindow = (now: number) => ({ from: Temporal.Instant.fromEpochMilliseconds(now - WINDOW_PAST_DAYS * DAY_MS), to: Temporal.Instant.fromEpochMilliseconds(now + WINDOW_FUTURE_DAYS * DAY_MS) });
// The events of one resource: a single event, or the occurrences of a series
// in the window. Null: a series this engine does not expand (left alone).
function davEvents(url: string, ics: string, etag: string, zone: string): RemoteEvent[] | null {
  const path = new URL(url).pathname;
  const parsed = icsOccurrences(ics, zone, davWindow(Date.now()), MAX_OCCURRENCES);
  if (!parsed) return [];
  if (parsed.unsupported) {
    if (!unsupportedSeries.has(path)) {
      unsupportedSeries.add(path);
      console.error(`Calendar sync: CalDAV series not expanded (${parsed.unsupported.slice(0, 40)})`);
    }
    return null;
  }
  return parsed.occurrences.map((o) => {
    const id = o.rid ? `${path}#${o.rid}` : path;
    if (o.cancelled) return goneEvent(id);
    return {
      id,
      deleted: false,
      title: o.title,
      allDay: o.allDay,
      start: o.start,
      end: o.end,
      description: stripFooter(o.description),
      updated: o.updated,
      attendees: o.attendees,
      etag,
    };
  });
}
// Whether the original start of an occurrence id lies in the sync window:
// only then does its absence mean it was removed.
function ridInWindow(rid: string) {
  const o = ridStart(rid);
  if (!o) return false;
  const w = davWindow(Date.now());
  const ms = o.allDay ? Date.parse(`${o.date}T00:00:00Z`) : o.instant.epochMilliseconds;
  return ms >= w.from.epochMilliseconds - DAY_MS && ms <= w.to.epochMilliseconds;
}
const caldav: Adapter = {
  async calendars(conn) {
    return withDav(conn, async (client, secret) =>
      (await client.calendars(secret.home))
        .filter((c) => c.writable)
        .map((c, i) => ({ id: c.url, name: c.name, primary: i === 0, ...(c.color ? { color: c.color } : {}) })),
    );
  },
  async changes(conn, calendarId, token, known, zone) {
    return withDav(conn, async (client, secret) => {
      const calendar = davCalendar(secret, calendarId);
      // The linked events by resource, with the etags stored for them.
      const knownUrls = new Map<string, { ids: string[]; etags: Set<string | null> }>();
      for (const [eventId, etag] of known) {
        const url = canonicalUrl(resourceOf(eventId), calendar);
        if (!url) continue;
        const entry = knownUrls.get(url) || { ids: [], etags: new Set() };
        entry.ids.push(eventId);
        entry.etags.add(etag);
        knownUrls.set(url, entry);
      }
      const changedSince = (url: string, etag: string) => {
        const entry = knownUrls.get(url);
        return !entry || [...entry.etags].some((e) => !e || !sameVersion(url, e, etag));
      };
      const events: RemoteEvent[] = [];
      const read = (url: string, value: { etag: string; ics: string }) => {
        const linked = knownUrls.get(url)?.ids || [];
        if (!value.etag) {
          // Deleted: the resource, and with it every linked occurrence.
          for (const id of linked.length ? linked : [new URL(url).pathname]) events.push(goneEvent(id));
          return;
        }
        const found = davEvents(url, value.ics, value.etag, zone);
        if (!found) return;
        events.push(...found);
        // Linked occurrences no longer there (EXDATE, a shorter series) are
        // removed – those outside the window only moved out of sight.
        const seen = new Set(found.map((e) => e.id));
        for (const id of linked) if (!seen.has(id) && (!ridIn(id) || ridInWindow(ridIn(id)))) events.push(goneEvent(id));
      };
      // RFC 6578: only what changed since the token.
      if (token?.startsWith("s:")) {
        let changes: Awaited<ReturnType<CalDavClient["changes"]>> | null = null;
        try {
          changes = await client.changes(calendar, token.slice(2));
        } catch (error) {
          // Announced but not answered: compare etags instead.
          if (!(error instanceof DavFailed && [405, 501].includes(error.status))) throw error;
        }
        if (changes) {
          const wanted: string[] = [];
          for (const [url, etag] of changes.changed) {
            if (!etag) read(url, { etag: "", ics: "" });
            else if (etag === "?" || changedSince(url, etag)) wanted.push(url);
          }
          for (const [url, value] of await client.multiget(calendar, wanted.slice(0, MAX_EVENTS), true)) read(url, value);
          return { events, token: `s:${changes.token}` };
        }
        token = null;
      }
      // Otherwise the ctag says whether anything changed, the etags what.
      const state = await client.state(calendar);
      if (token?.startsWith("c:") && state.ctag && token.slice(2) === state.ctag) return { events, token };
      const full = !token;
      const now = Date.now();
      const listing = await client.query(calendar, davTime(windowStart(now)), davTime(windowEnd(now)), full);
      // Linked events outside the listing: deleted, or moved out of the window.
      const missing = [...knownUrls.keys()].filter((url) => !listing.has(url));
      const checked = missing.length ? await client.multiget(calendar, missing, false) : new Map<string, { etag: string; ics: string }>();
      const wanted: string[] = [];
      for (const [url, value] of [...listing, ...checked]) {
        if (!value.etag || value.ics) read(url, value);
        else if (changedSince(url, value.etag)) wanted.push(url);
        if (events.length + wanted.length >= MAX_EVENTS) break;
      }
      for (const [url, value] of await client.multiget(calendar, wanted, true)) read(url, value);
      return { events, token: state.syncToken ? `s:${state.syncToken}` : `c:${state.ctag}` };
    });
  },
  async create(conn, calendarId, event, _zone, rowId, link) {
    return withDav(conn, async (client, secret) => {
      const uid = randomUUID();
      const url = `${davCalendar(secret, calendarId)}${uid}.ics`;
      const saved = await client.put(url, newIcsEvent({ ...event, description: describe(event.description, link) }, { uid, link, rowId }), { create: true });
      if (!saved) throw new DavFailed("event write", 404);
      return { ...event, id: new URL(saved.url).pathname, deleted: false, updated: new Date().toISOString(), attendees: [], etag: saved.etag };
    });
  },
  // A single event, or one occurrence of a series (its override; the series
  // itself is not changed from Flowplan, as with Google and Microsoft).
  async update(conn, calendarId, eventId, event, zone, _rowId, link, etag) {
    return withDav(conn, async (client, secret) => {
      const url = canonicalUrl(resourceOf(eventId), davCalendar(secret, calendarId));
      if (!url) return null;
      const rid = ridIn(eventId);
      const current = await client.get(url);
      if (!current) return null;
      // Changed there since it was last read: the next run applies the conflict rule.
      if (etag && current.etag && !sameVersion(url, etag, current.etag)) throw new DavChanged();
      if (rid) {
        // The occurrence must still be part of the series.
        const parsed = icsOccurrences(current.ics, zone, davWindow(Date.now()), MAX_OCCURRENCES);
        const exists = parsed?.occurrences.some((o) => o.rid === rid) || (parsed && !parsed.unsupported && !ridInWindow(rid));
        if (!exists) return null;
      }
      let ics: string;
      try {
        ics = patchIcsEvent(current.ics, { ...event, description: describe(event.description, link) }, rid, zone);
      } catch {
        return null;
      }
      const saved = await client.put(url, ics, { etag: current.etag || etag || undefined });
      if (!saved) return null;
      wrote(url, current.etag, saved.etag);
      return { ...event, id: rid ? eventId : new URL(saved.url).pathname, deleted: false, updated: new Date().toISOString(), attendees: [], etag: saved.etag };
    });
  },
  // A single event is deleted; an occurrence of a series gets an EXDATE.
  async remove(conn, calendarId, eventId, etag, zone) {
    await withDav(conn, async (client, secret) => {
      const url = canonicalUrl(resourceOf(eventId), davCalendar(secret, calendarId));
      if (!url) return;
      const rid = ridIn(eventId);
      if (!rid) return void (await client.remove(url, etag || undefined));
      const current = await client.get(url);
      if (!current) return;
      if (etag && current.etag && !sameVersion(url, etag, current.etag)) throw new DavChanged();
      const saved = await client.put(url, excludeIcsOccurrence(current.ics, rid, zone), { etag: current.etag || etag || undefined });
      if (saved) wrote(url, current.etag, saved.etag);
    });
  },
};

const connectInput = z.object({
  url: z.string().trim().min(1).max(2000),
  username: z.string().trim().min(1).max(300),
  password: z.string().min(1).max(1000),
});
// Connects a CalDAV account: finds the calendar home from the address
// (/.well-known/caldav, principal, home), checks that it holds a calendar
// the account may write, and stores everything sealed. The same account
// again (username and server) replaces the stored password.
export async function connectCalDav(user: Identity, input: unknown) {
  if (user.demo || user.apiScope) throw new HttpError(403, "Kalender lassen sich nur im Browser verbinden.");
  if (!caldavEnabled()) throw new HttpError(503, "Diese Kalenderverbindung ist auf dieser Instanz nicht eingerichtet.");
  const b = connectInput.parse(input);
  // Each attempt asks a server of the person's choice: not a password guesser.
  if (!allow(`caldav-connect:${user.id}`, 20, 60 * 60_000)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  let start: URL;
  try {
    start = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(b.url) ? b.url : `https://${b.url}`);
  } catch {
    throw new HttpError(400, "Ungültige Server-Adresse.");
  }
  if (start.search) throw new HttpError(400, "Ungültige Server-Adresse.");
  await checkDavUrl(start);
  const credentials = { username: b.username, password: b.password };
  // Discovery may be redirected (/.well-known/caldav, iCloud's partitions);
  // every target is checked like the address itself.
  const client = new CalDavClient(davSend(credentials, null), checkDavUrl);
  let home: string, calendars;
  try {
    home = (await client.discover(start)).home;
    calendars = (await client.calendars(home)).filter((c) => c.writable);
  } catch (error) {
    throw await davError(error, null);
  }
  if (!calendars.length) throw new HttpError(400, "Dieses Konto hat keinen Kalender, in den Flowplan schreiben darf.");
  // "anna@cloud.example.org", or "anna@icloud.com (caldav.icloud.com)".
  const account = (b.username.includes("@") ? `${b.username} (${start.host})` : `${b.username}@${start.host}`).slice(0, 300);
  const existing = await one<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id=? AND provider='caldav' AND account=?", user.id, account);
  const cid = existing?.id || id();
  const sealed = sealSecret(JSON.stringify({ server: start.toString(), home, ...credentials } satisfies CalDavSecret), caldavAad(cid));
  if (existing) await run("UPDATE calendar_connections SET refresh_token=?,access_token=NULL,access_expires=0,last_error=NULL WHERE id=?", sealed, cid);
  else
    await run(
      "INSERT INTO calendar_connections(id,user_id,provider,account,refresh_token,access_token,access_expires,created_at) VALUES(?,?,?,?,?,NULL,0,?)",
      cid,
      user.id,
      "caldav",
      account,
      sealed,
      Date.now(),
    );
  await audit(user.id, "calendar.connect", cid, "caldav");
  return { id: cid, account, calendars: calendars.map((c, i) => ({ id: c.url, name: c.name, primary: i === 0 })) };
}

const adapters: Record<CalendarProvider, Adapter> = { google, microsoft, caldav };

/* ---------- Connections and mappings ---------- */

async function ownConnection(user: Identity, connectionId: unknown) {
  const conn = await one<ConnectionRow>("SELECT * FROM calendar_connections WHERE id=? AND user_id=?", z.uuid().parse(connectionId), user.id);
  if (!conn) throw new HttpError(404, "Kalenderverbindung nicht gefunden.");
  return conn;
}
export async function listExternalCalendars(user: Identity, connectionId: unknown) {
  const conn = await ownConnection(user, connectionId);
  return adapters[conn.provider].calendars(conn);
}
async function viewsOf(pageId: string) {
  const d = await one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", pageId);
  if (!d) throw new HttpError(400, "Keine Datenbank.");
  return { fields: JSON.parse(d.fields) as Field[], views: JSON.parse(d.views) as View[] };
}
const mappingInput = z.object({
  connectionId: z.uuid(),
  pageId: z.uuid(),
  viewId: z.string().min(1).max(100),
  calendarId: z.string().min(1).max(1000),
  calendarName: z.string().max(300).optional(),
});
// One external calendar per view and person; a calendar belongs to one view.
export async function saveCalendarMapping(user: Identity, input: unknown) {
  const b = mappingInput.parse(input);
  const conn = await ownConnection(user, b.connectionId);
  // A CalDAV calendar is an address on the connection's server.
  if (conn.provider === "caldav") b.calendarId = davCalendar(caldavSecret(conn), b.calendarId);
  const page = await requirePage(user, b.pageId, true);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  await requireUnlocked(user, page);
  const { fields, views } = await viewsOf(page.id);
  const view = views.find((v) => v.id === b.viewId);
  if (!view) throw new HttpError(404, "Ansicht nicht gefunden.");
  if (!scheduleFields(fields, view).start) throw new HttpError(400, "Diese Ansicht hat kein Datum.");
  const taken = await one<{ id: string; page_id: string; view_id: string }>(
    "SELECT id,page_id,view_id FROM calendar_sync_mappings WHERE connection_id=? AND calendar_id=?",
    conn.id,
    b.calendarId,
  );
  if (taken && (taken.page_id !== page.id || taken.view_id !== view.id))
    throw new HttpError(409, "Dieser Kalender ist schon mit einer anderen Ansicht verbunden.");
  const current = await one<{ id: string; connection_id: string; calendar_id: string }>(
    "SELECT id,connection_id,calendar_id FROM calendar_sync_mappings WHERE user_id=? AND page_id=? AND view_id=?",
    user.id,
    page.id,
    view.id,
  );
  if (current && current.connection_id === conn.id && current.calendar_id === b.calendarId) {
    await run("UPDATE calendar_sync_mappings SET calendar_name=? WHERE id=?", b.calendarName || "", current.id);
    return { id: current.id };
  }
  if (current) await run("DELETE FROM calendar_sync_mappings WHERE id=?", current.id);
  const mid = id();
  await run(
    "INSERT INTO calendar_sync_mappings(id,connection_id,user_id,page_id,view_id,calendar_id,calendar_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
    mid,
    conn.id,
    user.id,
    page.id,
    view.id,
    b.calendarId,
    b.calendarName || "",
    Date.now(),
  );
  return { id: mid };
}
export async function deleteCalendarMapping(user: Identity, input: unknown) {
  const mid = z.object({ id: z.uuid() }).parse(input).id;
  if (!(await run("DELETE FROM calendar_sync_mappings WHERE id=? AND user_id=?", mid, user.id)).changes)
    throw new HttpError(404, "Kalenderzuordnung nicht gefunden.");
}
export async function disconnectCalendar(user: Identity, input: unknown) {
  const cid = z.object({ connectionId: z.uuid() }).parse(input).connectionId;
  if (!(await run("DELETE FROM calendar_connections WHERE id=? AND user_id=?", cid, user.id)).changes)
    throw new HttpError(404, "Kalenderverbindung nicht gefunden.");
  await audit(user.id, "calendar.disconnect", cid);
}
// What the settings and the mapping dialog show.
export async function calendarSyncStatus(user: Identity, pageId?: string | null) {
  return {
    providers: calendarProviders.map((p) => ({ id: p, configured: providerConfigured(p) })),
    connections: (await all<{ id: string; provider: CalendarProvider; account: string; last_error: string | null; created_at: number }>(
      "SELECT id,provider,account,last_error,created_at FROM calendar_connections WHERE user_id=? ORDER BY created_at",
      user.id,
    )).map((c) => ({ id: c.id, provider: c.provider, account: c.account, lastError: c.last_error, createdAt: c.created_at })),
    mappings: (await all<{
      id: string;
      connection_id: string;
      page_id: string;
      title: string;
      view_id: string;
      calendar_id: string;
      calendar_name: string;
      last_sync_at: number | null;
      last_error: string | null;
      items: number;
    }>(
      `SELECT m.id,m.connection_id,m.page_id,p.title,m.view_id,m.calendar_id,m.calendar_name,m.last_sync_at,m.last_error,
         (SELECT COUNT(*) FROM calendar_sync_items i WHERE i.mapping_id=m.id) AS items
       FROM calendar_sync_mappings m JOIN pages p ON p.id=m.page_id
       WHERE m.user_id=? AND p.deleted_at IS NULL ${pageId ? "AND m.page_id=?" : ""} ORDER BY m.created_at`,
      ...(pageId ? [user.id, pageId] : [user.id]),
    )).map((m) => ({
      id: m.id,
      connectionId: m.connection_id,
      pageId: m.page_id,
      pageTitle: m.title,
      viewId: m.view_id,
      calendarId: m.calendar_id,
      calendarName: m.calendar_name,
      lastSyncAt: m.last_sync_at,
      lastError: m.last_error,
      events: m.items,
    })),
  };
}
// Attendees of the calendar events behind a record (meeting notes).
export async function syncedAttendees(rowId: string): Promise<Attendee[]> {
  const seen = new Map<string, Attendee>();
  for (const item of await all<{ attendees: string }>("SELECT attendees FROM calendar_sync_items WHERE row_id=?", rowId))
    try {
      for (const a of JSON.parse(item.attendees) as Attendee[]) if (a.email && !seen.has(a.email)) seen.set(a.email, a);
    } catch {}
  return [...seen.values()];
}

/* ---------- Sync engine ---------- */

type MappingRow = {
  id: string;
  connection_id: string;
  user_id: string;
  page_id: string;
  view_id: string;
  calendar_id: string;
  sync_token: string | null;
  failures: number;
};
type Item = { row_id: string; event_id: string; hash: string; etag: string | null };
type Context = {
  mapping: MappingRow;
  conn: ConnectionRow;
  adapter: Adapter;
  user: Identity;
  page: Page;
  view: View;
  fields: Field[];
  zone: string;
  canWrite: boolean;
};
export type SyncResult = {
  pulled: number;
  created: number;
  updated: number;
  deleted: number;
  pushed: number;
  removed: number;
  conflicts: number;
  skipped: number;
};

async function identityOf(userId: string): Promise<Identity | null> {
  const account = await one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0 AND demo_until IS NULL", userId);
  if (!account) return null;
  const groups = (await all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", userId)).map((g) => g.group_id);
  return { ...account, groups, isAdmin: false } as Identity;
}
async function contextOf(mapping: MappingRow): Promise<Context> {
  const conn = await one<ConnectionRow>("SELECT * FROM calendar_connections WHERE id=?", mapping.connection_id);
  if (!conn) throw new HttpError(404, "Kalenderverbindung nicht gefunden.");
  const user = await identityOf(mapping.user_id);
  if (!user) throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", mapping.page_id);
  const role = page ? (await pageRole(user, page)) : null;
  if (!page || !role) throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  // Behind a journal PIN the calendar stays closed, as its feed and CalDAV do.
  if (await journalLocked(user, page)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
  const { fields, views } = await viewsOf(page.id);
  const view = views.find((v) => v.id === mapping.view_id);
  if (!view || !scheduleFields(fields, view).start) throw new HttpError(404, "Ansicht nicht gefunden.");
  const calendar = calendarSchema.safeParse(view.calendar);
  return {
    mapping,
    conn,
    adapter: adapters[conn.provider],
    user,
    page,
    view,
    fields,
    zone: calendar.success ? calendar.data.timeZone : "UTC",
    canWrite: (role === "owner" || role === "editor") && !page.locked,
  };
}
type LiveRow = Row & { role?: string };
async function rowsOf(ctx: Context, ids?: string[]): Promise<LiveRow[]> {
  const raw = ids
    ? (await flatMapAsync(ids, async (rid) => {
        const r = await one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", rid, ctx.page.id);
        return r ? [r] : [];
      }))
    : (await all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=?", ctx.page.id));
  const parsed = raw.map((r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row);
  return (await visibleRows(ctx.user, ctx.page, parsed)) as LiveRow[];
}
const editable = (ctx: Context, row: LiveRow) => ctx.canWrite && (row.role === "owner" || row.role === "editor");
const rowText = (row: Row) => {
  const content = row.content || "";
  return content.startsWith("<") ? htmlToText(content) : normalizeText(content);
};
export function localContent(row: Row, fields: Field[], view: View, zone: string): EventContent | null {
  const range = calendarRange(row, fields, view, zone);
  if (!range) return null;
  return {
    title: cellText(row.cells[fields[0]?.id || ""]).slice(0, 500),
    allDay: !range.timed,
    start: range.timed ? minute(Temporal.Instant.from(range.start)) : range.start,
    end: range.timed ? minute(Temporal.Instant.from(range.end)) : range.end,
    description: rowText(row),
  };
}
function patchOf(ctx: Context, event: EventContent) {
  const { start, end } = scheduleFields(ctx.fields, ctx.view);
  const patch: Record<string, unknown> = { [ctx.fields[0].id]: event.title || ct("Termin", "Event") };
  patch[start!.id] = event.start;
  if (end) patch[end.id] = event.allDay && event.end === event.start ? "" : event.end;
  return patch;
}
const stamp = (sqlTime: string) => Date.parse(`${sqlTime.replace(" ", "T")}${/Z|[+-]\d\d:\d\d$/.test(sqlTime) ? "" : "Z"}`) || 0;
async function saveItem(ctx: Context, rowId: string, eventId: string, hashValue: string, attendees?: Attendee[], etag?: string) {
  await run(
    `INSERT INTO calendar_sync_items(mapping_id,row_id,event_id,hash,attendees,synced_at,etag) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(mapping_id,row_id) DO UPDATE SET event_id=excluded.event_id,hash=excluded.hash,synced_at=excluded.synced_at,etag=excluded.etag${attendees ? ",attendees=excluded.attendees" : ""}`,
    ctx.mapping.id,
    rowId,
    eventId,
    hashValue,
    JSON.stringify(attendees || []),
    Date.now(),
    etag || null,
  );
}
const dropItem = async (ctx: Context, rowId: string) => await run("DELETE FROM calendar_sync_items WHERE mapping_id=? AND row_id=?", ctx.mapping.id, rowId);
async function conflict(ctx: Context, rowId: string, detail: Record<string, unknown>) {
  await audit(ctx.user.id, "calendar.sync.conflict", rowId, JSON.stringify({ mapping: ctx.mapping.id, event: detail.event, ...detail }));
}

// A calendar change applied to the database.
async function applyRemote(ctx: Context, event: RemoteEvent, items: Map<string, Item>, result: SyncResult) {
  const item = items.get(event.id);
  if (event.deleted) {
    if (!item) return;
    items.delete(event.id);
    const [row] = await rowsOf(ctx, [item.row_id]);
    const local = row && localContent(row, ctx.fields, ctx.view, ctx.zone);
    if (!row) return await dropItem(ctx, item.row_id);
    if (local && contentHash(local) !== item.hash) {
      // Changed here since the last sync: the record stays and goes out again.
      await conflict(ctx, row.id, { event: event.id, winner: "local", reason: "deleted-in-calendar" });
      result.conflicts++;
      return await dropItem(ctx, row.id);
    }
    if (!editable(ctx, row)) return await dropItem(ctx, row.id);
    await transaction(async () => {
      await trashRow(ctx.user, ctx.page, row.id);
      await maintainRowOrders(ctx.page.id);
      await dropItem(ctx, row.id);
    }, ctx.user);
    result.deleted++;
    return;
  }
  // Our own plain text that looked like HTML: read it as the text it is.
  if (event.plain !== undefined && item) {
    const [known] = await rowsOf(ctx, [item.row_id]);
    const local = known && localContent(known, ctx.fields, ctx.view, ctx.zone);
    if (local && normalizeText(event.plain) === normalizeText(local.description)) event = { ...event, description: event.plain };
  }
  const remoteHash = contentHash(event);
  if (!item) {
    // New in the calendar: a new record, within the sync window.
    const now = Date.now();
    const startMs = Date.parse(event.allDay ? `${event.start}T00:00:00Z` : event.start);
    const endMs = Date.parse(event.allDay ? `${event.end}T23:59:59Z` : event.end);
    if (!ctx.canWrite || endMs < now - WINDOW_PAST_DAYS * DAY_MS || startMs > now + WINDOW_FUTURE_DAYS * DAY_MS) {
      result.skipped++;
      return;
    }
    const patch = patchOf(ctx, event);
    await assertFieldsWritable(ctx.user, ctx.page, ctx.fields, Object.keys(patch));
    const rid = id();
    await transaction(async () => {
      await run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
        rid,
        ctx.page.id,
        JSON.stringify(patch),
        Date.now(),
        ctx.user.id,
        ctx.user.id,
      );
      await rowCreated(ctx.user, ctx.page, rid);
      if (event.description) await replaceRowDocument(rid, textToHtml(event.description), ctx.user.id);
      await saveItem(ctx, rid, event.id, remoteHash, event.attendees, event.etag);
    }, ctx.user);
    items.set(event.id, { row_id: rid, event_id: event.id, hash: remoteHash, etag: event.etag || null });
    result.created++;
    return;
  }
  // The version seen now (CalDAV): what a push of the record names in If-Match.
  if (event.etag) {
    await run("UPDATE calendar_sync_items SET attendees=?,etag=? WHERE mapping_id=? AND row_id=?", JSON.stringify(event.attendees), event.etag, ctx.mapping.id, item.row_id);
    item.etag = event.etag;
  } else await run("UPDATE calendar_sync_items SET attendees=? WHERE mapping_id=? AND row_id=?", JSON.stringify(event.attendees), ctx.mapping.id, item.row_id);
  // Unchanged in the calendar (also our own change coming back).
  if (remoteHash === item.hash) return;
  const [row] = await rowsOf(ctx, [item.row_id]);
  if (!row) return; // deleted here: the push removes the event
  const local = localContent(row, ctx.fields, ctx.view, ctx.zone);
  const localHash = local ? contentHash(local) : null;
  if (localHash === remoteHash) {
    await saveItem(ctx, row.id, event.id, remoteHash, event.attendees, event.etag || item.etag || undefined);
    item.hash = remoteHash;
    return;
  }
  if (localHash !== item.hash) {
    // Changed on both sides since the last sync: the later change wins.
    const localAt = stamp(row.updated_at),
      remoteAt = Date.parse(event.updated) || 0;
    const winner = localAt > remoteAt ? "local" : "remote";
    await conflict(ctx, row.id, { event: event.id, winner, local: new Date(localAt).toISOString(), remote: new Date(remoteAt).toISOString() });
    result.conflicts++;
    if (winner === "local") return; // the push sends the record
  }
  if (!editable(ctx, row)) {
    result.skipped++;
    return;
  }
  const patch = patchOf(ctx, event);
  await assertFieldsWritable(ctx.user, ctx.page, ctx.fields, Object.keys(patch));
  await transaction(async () => {
    const stored = (await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row.id))!;
    const before = JSON.parse(stored.cells),
      after = { ...before, ...patch };
    await run("UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?", JSON.stringify(after), nowText(), ctx.user.id, row.id);
    await rowChanged(ctx.user, ctx.page, row.id, before, after, ctx.fields);
    if (normalizeText(event.description) !== (local ? normalizeText(local.description) : ""))
      await replaceRowDocument(row.id, textToHtml(event.description), ctx.user.id);
    await saveItem(ctx, row.id, event.id, remoteHash, event.attendees, event.etag || item.etag || undefined);
  }, ctx.user);
  item.hash = remoteHash;
  result.updated++;
}

// Database changes sent to the calendar.
async function pushLocal(ctx: Context, items: Map<string, Item>, result: SyncResult) {
  const byRow = new Map([...items.values()].map((i) => [i.row_id, i]));
  const rows = await rowsOf(ctx);
  const inView = new Set(queryRows(rows, ctx.fields, ctx.view).map((r) => r.id));
  const now = Date.now();
  let budget = MAX_PUSHES;
  for (const row of rows) {
    if (budget <= 0) break;
    const item = byRow.get(row.id);
    byRow.delete(row.id);
    if (!item && !inView.has(row.id)) continue;
    if (!editable(ctx, row)) {
      // No longer the person's to change: the event stays as it is.
      if (item) await dropItem(ctx, row.id);
      continue;
    }
    const local = localContent(row, ctx.fields, ctx.view, ctx.zone);
    if (!local) {
      // The date was removed: the event goes.
      if (item) {
        budget--;
        if (!(await meanwhile(result, () => ctx.adapter.remove(ctx.conn, ctx.mapping.calendar_id, item.event_id, item.etag, ctx.zone)))) continue;
        await dropItem(ctx, row.id);
        result.removed++;
      }
      continue;
    }
    const localHash = contentHash(local);
    if (item && item.hash === localHash) continue;
    if (!item) {
      const endMs = Date.parse(local.allDay ? `${local.end}T23:59:59Z` : local.end);
      const startMs = Date.parse(local.allDay ? `${local.start}T00:00:00Z` : local.start);
      if (endMs < now - WINDOW_PAST_DAYS * DAY_MS || startMs > now + WINDOW_FUTURE_DAYS * DAY_MS) continue;
    }
    budget--;
    const link = `${appUrl()}/#page=${ctx.page.id}&row=${row.id}`;
    let saved: RemoteEvent | null = null;
    if (item)
      try {
        saved = await ctx.adapter.update(ctx.conn, ctx.mapping.calendar_id, item.event_id, local, ctx.zone, row.id, link, item.etag);
      } catch (error) {
        if (!(error instanceof ChangedMeanwhile)) throw error;
        result.conflicts++;
        continue;
      }
    // Gone in the calendar without us noticing: created again.
    if (!saved) saved = await ctx.adapter.create(ctx.conn, ctx.mapping.calendar_id, local, ctx.zone, row.id, link);
    await saveItem(ctx, row.id, saved.id, localHash, undefined, saved.etag);
    result.pushed++;
  }
  // Linked records that are gone (deleted here) or hidden from the person now.
  for (const item of byRow.values()) {
    if (budget <= 0) break;
    if (await one("SELECT 1 FROM rows WHERE id=? AND page_id=?", item.row_id, ctx.page.id)) {
      await dropItem(ctx, item.row_id);
      continue;
    }
    budget--;
    if (!(await meanwhile(result, () => ctx.adapter.remove(ctx.conn, ctx.mapping.calendar_id, item.event_id, item.etag, ctx.zone)))) continue;
    await dropItem(ctx, item.row_id);
    result.removed++;
  }
}
// A write the calendar refused because the event changed there meanwhile
// (CalDAV 412): counted as a conflict and left for the next run, which reads
// the change first. False when that happened.
async function meanwhile(result: SyncResult, write: () => Promise<void>) {
  try {
    await write();
    return true;
  } catch (error) {
    if (!(error instanceof ChangedMeanwhile)) throw error;
    result.conflicts++;
    return false;
  }
}

// The stored token with the time of the last full listing.
function readToken(raw: string | null) {
  try {
    const parsed = JSON.parse(raw || "") as { token?: string; since?: number };
    if (parsed.token && parsed.since && Date.now() - parsed.since < FULL_SYNC_MS) return parsed as { token: string; since: number };
  } catch {}
  return null;
}

// One sync run of a mapping. Errors of single events are counted, not
// fatal; an error of the calendar itself ends the run (the worker backs off).
export async function syncCalendarMapping(mappingId: string): Promise<SyncResult> {
  const mapping = await one<MappingRow>("SELECT * FROM calendar_sync_mappings WHERE id=?", mappingId);
  if (!mapping) throw new HttpError(404, "Kalenderzuordnung nicht gefunden.");
  const result: SyncResult = { pulled: 0, created: 0, updated: 0, deleted: 0, pushed: 0, removed: 0, conflicts: 0, skipped: 0 };
  try {
    const ctx = await contextOf(mapping);
    const stored = readToken(mapping.sync_token);
    const items = new Map(
      (await all<Item>("SELECT row_id,event_id,hash,etag FROM calendar_sync_items WHERE mapping_id=?", mapping.id)).map((i) => [i.event_id, i]),
    );
    const known = new Map([...items.values()].map((i) => [i.event_id, i.etag]));
    let changes: { events: RemoteEvent[]; token: string };
    let since = stored?.since || Date.now();
    try {
      changes = await ctx.adapter.changes(ctx.conn, mapping.calendar_id, stored?.token || null, known, ctx.zone);
    } catch (error) {
      if (!(error instanceof TokenExpired)) throw error;
      since = Date.now();
      changes = await ctx.adapter.changes(ctx.conn, mapping.calendar_id, null, known, ctx.zone);
    }
    if (!stored) since = Date.now();
    result.pulled = changes.events.length;
    for (const event of changes.events) {
      try {
        await applyRemote(ctx, event, items, result);
      } catch (error) {
        result.skipped++;
        if (!(error instanceof HttpError)) console.error("Calendar sync: event", error);
      }
    }
    await run("UPDATE calendar_sync_mappings SET sync_token=? WHERE id=?", JSON.stringify({ token: changes.token, since }), mapping.id);
    await pushLocal(ctx, items, result);
    await run(
      "UPDATE calendar_sync_mappings SET last_sync_at=?,last_error=NULL,failures=0,next_at=? WHERE id=?",
      Date.now(),
      Date.now() + SYNC_INTERVAL_MS,
      mapping.id,
    );
    return result;
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Die Synchronisierung ist fehlgeschlagen.";
    if (!(error instanceof HttpError)) console.error("Calendar sync", error);
    // Back off: 20 minutes, 40, 80 … at most a day.
    const failures = mapping.failures + 1;
    await run(
      "UPDATE calendar_sync_mappings SET last_error=?,failures=?,next_at=? WHERE id=?",
      message,
      failures,
      Date.now() + Math.min(DAY_MS, SYNC_INTERVAL_MS * 2 ** failures),
      mapping.id,
    );
    throw error instanceof HttpError ? error : new HttpError(502, message);
  }
}
// "Jetzt synchronisieren" of the person who set the mapping up.
export async function syncOwnMapping(user: Identity, input: unknown) {
  const mid = z.object({ id: z.uuid() }).parse(input).id;
  if (!(await one("SELECT 1 FROM calendar_sync_mappings WHERE id=? AND user_id=?", mid, user.id))) throw new HttpError(404, "Kalenderzuordnung nicht gefunden.");
  return syncCalendarMapping(mid);
}

const runtime = globalThis as unknown as { flowplanCalendarTimer?: ReturnType<typeof setInterval>; flowplanCalendarBusy?: boolean };
export async function syncDueCalendars(now = Date.now()) {
  if (runtime.flowplanCalendarBusy || (await workersPaused())) return;
  runtime.flowplanCalendarBusy = true;
  try {
    for (const m of await all<{ id: string }>("SELECT id FROM calendar_sync_mappings WHERE next_at<=? ORDER BY next_at LIMIT 50", now))
      await syncCalendarMapping(m.id).catch(() => {});
  } finally {
    runtime.flowplanCalendarBusy = false;
  }
}
// Checks every minute for mappings that are due (each every ten minutes).
export function startCalendarSyncWorker() {
  if (runtime.flowplanCalendarTimer) return;
  runtime.flowplanCalendarTimer = setInterval(() => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!calendarProviders.some(providerConfigured)) return;
    void leaderDuty("calendar-sync", () => syncDueCalendars()).catch((error) => console.error("Calendar sync worker", error));
  }, 60_000);
  runtime.flowplanCalendarTimer.unref?.();
}
