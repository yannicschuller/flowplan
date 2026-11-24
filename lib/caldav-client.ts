// The CalDAV client of the two-way calendar sync (lib/calendar-sync.ts, #460):
// discovery (/.well-known/caldav → current-user-principal →
// calendar-home-set → the calendars), listing events (calendar-query with a
// time range, sync-collection of RFC 6578, calendar-multiget), writing them
// (PUT with If-Match / If-None-Match, DELETE with If-Match) and reading and
// writing the iCalendar of one event.
//
// It sends nothing itself: every request goes through the `send` the sync
// hands in, which adds the credentials, keeps to the connection's server and
// uses the SSRF-safe transport (lib/safe-fetch.ts). This file only builds
// requests and reads answers.
import { randomUUID } from "node:crypto";
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { Temporal } from "@js-temporal/polyfill";
import { validZone } from "./date-values";
import { fold, icsText, unText } from "./caldav";
import { expandRule, type Occurrence, type RuleStart } from "./ical-recurrence";

export type DavMethod = "PROPFIND" | "REPORT" | "GET" | "PUT" | "DELETE";
export type DavRequest = { method: DavMethod; url: string; headers: Record<string, string>; body?: string };
export type DavResponse = { status: number; body: string; headers: Record<string, string> };
export type DavSend = (request: DavRequest) => Promise<DavResponse>;

// The server refused the username or app password.
export class DavAuthError extends Error {}
// The sync token is no longer valid (RFC 6578 §3.2): list everything again.
export class DavTokenInvalid extends Error {}
// The event changed on the server since it was read (412): left for the next run.
export class DavChanged extends Error {}
// Any other unexpected answer; `status` for the error message.
export class DavFailed extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
  ) {
    super(`CalDAV ${what}: HTTP ${status}`);
  }
}

/* ---------- XML ---------- */

const DAV_NS = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"`;
const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlBody = (root: string, inner: string) => `<?xml version="1.0" encoding="utf-8"?>\n<${root} ${DAV_NS}>${inner}</${root.split(" ")[0]}>`;

// A namespace-agnostic element: servers pick their own prefixes (d:, D:,
// none with a default namespace), and the names read here do not clash.
export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };
function toNode(el: Element): XmlNode {
  const children: XmlNode[] = [];
  let text = "";
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (n.type === "tag" || n.type === "script" || n.type === "style") children.push(toNode(n as Element));
      else if (n.type === "text" || n.type === "cdata") text += n.type === "cdata" ? (n.children as ChildNode[]).map((c) => ("data" in c ? c.data : "")).join("") : n.data;
    }
  };
  walk(el.children);
  // The text of an element: its own and its children's (calendar-data, href).
  const deep = text + children.map((c) => c.text).join("");
  return { name: el.name.replace(/^.*:/, "").toLowerCase(), attrs: el.attribs || {}, children, text: deep };
}
export function parseXml(body: string): XmlNode | null {
  // No DTDs or entities beyond XML's own (htmlparser2 does not load any).
  const doc = parseDocument(body, { xmlMode: true, decodeEntities: true, recognizeCDATA: true });
  const root = doc.children.find((n) => n.type === "tag") as Element | undefined;
  return root ? toNode(root) : null;
}
export const child = (node: XmlNode | undefined, name: string) => node?.children.find((c) => c.name === name);
const children = (node: XmlNode | undefined, name: string) => node?.children.filter((c) => c.name === name) || [];
const statusCode = (text: string | undefined) => Number(/\s(\d{3})\s?/.exec(` ${text || ""} `)?.[1] || 0);

export type DavEntry = {
  href: string;
  // The status of the whole response (404 in a sync report: deleted).
  status: number;
  // The properties found (status 200).
  props: Map<string, XmlNode>;
};
export function parseMultistatus(body: string): { entries: DavEntry[]; syncToken: string } {
  const root = parseXml(body);
  if (!root || root.name !== "multistatus") return { entries: [], syncToken: "" };
  const entries = children(root, "response").map((response) => {
    const props = new Map<string, XmlNode>();
    for (const propstat of children(response, "propstat")) {
      const status = statusCode(child(propstat, "status")?.text);
      if (status && (status < 200 || status >= 300)) continue;
      for (const prop of child(propstat, "prop")?.children || []) props.set(prop.name, prop);
    }
    return { href: (child(response, "href")?.text || "").trim(), status: statusCode(child(response, "status")?.text) || 200, props };
  });
  return { entries, syncToken: (child(root, "sync-token")?.text || "").trim() };
}

/* ---------- Paths ---------- */

// One spelling per resource: servers answer with "%40" or "@", full URLs or
// paths. Null for another origin.
export function canonicalUrl(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  const path = url.pathname
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return segment;
      }
    })
    .join("/");
  return `${url.origin}${path}`;
}
// Event ids are their paths; the calendar's origin is added for requests.
export const pathOf = (url: string) => new URL(url).pathname;
const isCollection = (url: string) => url.endsWith("/");

/* ---------- Discovery ---------- */

export type DavCalendar = { url: string; name: string; color: string; writable: boolean; ctag: string; syncToken: string };
const PROPFIND_PRINCIPAL = xmlBody("d:propfind", "<d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/></d:prop>");
const PROPFIND_CALENDARS = xmlBody(
  "d:propfind",
  "<d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:getctag/><d:sync-token/></d:prop>",
);
const PROPFIND_STATE = xmlBody("d:propfind", "<d:prop><d:resourcetype/><cs:getctag/><d:sync-token/><d:displayname/></d:prop>");

const hrefIn = (prop: XmlNode | undefined) => (child(prop, "href")?.text || "").trim();

export class CalDavClient {
  constructor(
    private readonly send: DavSend,
    // Asked for every address a redirect points to during discovery.
    private readonly allowed: (url: URL) => Promise<void> = async () => {},
  ) {}

  private async request(method: DavMethod, url: string, body: string, headers: Record<string, string> = {}) {
    return this.send({
      method,
      url,
      headers: { ...(body ? { "content-type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}), ...headers },
      body,
    });
  }
  private async multistatus(what: string, method: DavMethod, url: string, body: string, depth: "0" | "1") {
    const answer = await this.request(method, url, body, { depth, accept: "application/xml, text/xml" });
    if (answer.status === 401) throw new DavAuthError();
    if (answer.status !== 207) throw new DavFailed(what, answer.status);
    return parseMultistatus(answer.body);
  }

  // PROPFIND that follows redirects (/.well-known/caldav answers with one),
  // at most five, each target checked by `allowed`.
  private async propfindFollowing(start: URL, body: string) {
    let url = start;
    for (let hop = 0; hop <= 5; hop++) {
      const answer = await this.request("PROPFIND", url.toString(), body, { depth: "0", accept: "application/xml, text/xml" });
      if (answer.status === 401) throw new DavAuthError();
      if (answer.status >= 300 && answer.status < 400 && answer.headers.location) {
        url = new URL(answer.headers.location, url);
        await this.allowed(url);
        continue;
      }
      return { url, status: answer.status, result: answer.status === 207 ? parseMultistatus(answer.body) : null };
    }
    return { url, status: 310, result: null };
  }

  // The calendar home of the account behind the credentials, from the
  // address the person typed: the server, a principal or the home itself.
  async discover(input: URL): Promise<{ principal: string; home: string }> {
    const wellKnown = new URL("/.well-known/caldav", input);
    const candidates = input.pathname === "/" || input.pathname === "" ? [wellKnown, new URL("/", input)] : [input, wellKnown];
    let principal: string | null = null,
      home: string | null = null;
    for (const candidate of candidates) {
      const found = await this.propfindFollowing(candidate, PROPFIND_PRINCIPAL);
      const props = found.result?.entries[0]?.props;
      if (!props) continue;
      const homeHref = hrefIn(props.get("calendar-home-set"));
      const principalHref = hrefIn(props.get("current-user-principal"));
      if (homeHref) home = canonicalUrl(homeHref, found.url.toString());
      if (principalHref) principal = canonicalUrl(principalHref, found.url.toString());
      if (home || principal) break;
    }
    if (!home && principal) {
      const found = await this.propfindFollowing(new URL(principal), PROPFIND_PRINCIPAL);
      const homeHref = hrefIn(found.result?.entries[0]?.props.get("calendar-home-set"));
      if (homeHref) home = canonicalUrl(homeHref, found.url.toString());
    }
    if (!home) throw new DavFailed("discovery", 404);
    if (!isCollection(home)) home += "/";
    return { principal: principal || home, home };
  }

  // The event calendars of a calendar home (VEVENT among the components,
  // not subscriptions, inboxes or task lists).
  async calendars(home: string): Promise<DavCalendar[]> {
    const { entries } = await this.multistatus("calendar list", "PROPFIND", home, PROPFIND_CALENDARS, "1");
    const out: DavCalendar[] = [];
    for (const entry of entries) {
      const url = canonicalUrl(entry.href, home);
      const type = entry.props.get("resourcetype");
      if (!url || !child(type, "calendar")) continue;
      const components = entry.props.get("supported-calendar-component-set");
      if (components && components.children.length && !children(components, "comp").some((c) => (c.attrs.name || "").toUpperCase() === "VEVENT")) continue;
      const privileges = entry.props.get("current-user-privilege-set");
      const granted = new Set(children(privileges, "privilege").flatMap((p) => p.children.map((c) => c.name)));
      const writable = !privileges || granted.has("write") || granted.has("write-content") || granted.has("all");
      const color = (entry.props.get("calendar-color")?.text || "").trim();
      out.push({
        url: isCollection(url) ? url : `${url}/`,
        name: (entry.props.get("displayname")?.text || "").trim() || decodeURIComponent(url.replace(/\/$/, "").split("/").pop() || url),
        color: /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color) ? color.slice(0, 7) : "",
        writable,
        ctag: (entry.props.get("getctag")?.text || "").trim(),
        syncToken: (entry.props.get("sync-token")?.text || "").trim(),
      });
    }
    return out;
  }

  // ctag and sync token of one calendar.
  async state(calendar: string) {
    const { entries } = await this.multistatus("calendar state", "PROPFIND", calendar, PROPFIND_STATE, "0");
    const props = entries[0]?.props;
    return { ctag: (props?.get("getctag")?.text || "").trim(), syncToken: (props?.get("sync-token")?.text || "").trim() };
  }

  // The events of a time range (UTC, "20260101T000000Z"): href → etag, with
  // their iCalendar when `data`.
  async query(calendar: string, start: string, end: string, data: boolean) {
    const body = xmlBody(
      "c:calendar-query",
      `<d:prop><d:getetag/>${data ? "<c:calendar-data/>" : ""}</d:prop>` +
        `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter>`,
    );
    const { entries } = await this.multistatus("event list", "REPORT", calendar, body, "1");
    return this.resources(calendar, entries);
  }

  // Changes since a sync token (RFC 6578): changed hrefs with their etag,
  // deleted ones with an empty etag, and the next token.
  async changes(calendar: string, token: string) {
    const changed = new Map<string, string>();
    for (let round = 0; round < 20; round++) {
      const body = xmlBody("d:sync-collection", `<d:sync-token>${xmlText(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop>`);
      const answer = await this.request("REPORT", calendar, body, { depth: "0", accept: "application/xml, text/xml" });
      if (answer.status === 401) throw new DavAuthError();
      // An expired or unknown token: 403/409 (valid-sync-token), some servers 400 or 412.
      if ([400, 403, 409, 410, 412].includes(answer.status)) throw new DavTokenInvalid();
      if (answer.status !== 207) throw new DavFailed("sync report", answer.status);
      const result = parseMultistatus(answer.body);
      let truncated = false;
      for (const entry of result.entries) {
        const url = canonicalUrl(entry.href, calendar);
        if (!url) continue;
        // 507 on the collection itself: more changes follow with the new token.
        if (url === calendar || `${url}/` === calendar) {
          if (entry.status === 507) truncated = true;
          continue;
        }
        changed.set(url, entry.status === 404 ? "" : (entry.props.get("getetag")?.text || "").trim() || "?");
      }
      if (!result.syncToken) throw new DavTokenInvalid();
      token = result.syncToken;
      if (!truncated) return { changed, token };
    }
    return { changed, token };
  }

  // Events by their address (calendar-multiget), 100 per request; missing
  // ones come back with an empty etag.
  async multiget(calendar: string, urls: string[], data: boolean) {
    const out = new Map<string, { etag: string; ics: string }>();
    for (let i = 0; i < urls.length; i += 100) {
      const batch = urls.slice(i, i + 100);
      const body = xmlBody(
        "c:calendar-multiget",
        `<d:prop><d:getetag/>${data ? "<c:calendar-data/>" : ""}</d:prop>${batch.map((u) => `<d:href>${xmlText(pathOf(u))}</d:href>`).join("")}`,
      );
      const { entries } = await this.multistatus("event fetch", "REPORT", calendar, body, "1");
      for (const [url, value] of this.resources(calendar, entries)) out.set(url, value);
      for (const url of batch) if (!out.has(url)) out.set(url, { etag: "", ics: "" });
    }
    return out;
  }
  private resources(calendar: string, entries: DavEntry[]) {
    const out = new Map<string, { etag: string; ics: string }>();
    for (const entry of entries) {
      const url = canonicalUrl(entry.href, calendar);
      if (!url || isCollection(url) || `${url}/` === calendar) continue;
      if (entry.status === 404 || !entry.props.size) {
        out.set(url, { etag: "", ics: "" });
        continue;
      }
      out.set(url, { etag: (entry.props.get("getetag")?.text || "").trim(), ics: entry.props.get("calendar-data")?.text || "" });
    }
    return out;
  }

  async get(url: string) {
    const answer = await this.request("GET", url, "", { accept: "text/calendar" });
    if (answer.status === 401) throw new DavAuthError();
    if (answer.status === 404 || answer.status === 410) return null;
    if (answer.status !== 200) throw new DavFailed("event read", answer.status);
    return { ics: answer.body, etag: answer.headers.etag || "" };
  }
  private async etagOf(url: string) {
    const { entries } = await this.multistatus("etag", "PROPFIND", url, xmlBody("d:propfind", "<d:prop><d:getetag/></d:prop>"), "0");
    return (entries[0]?.props.get("getetag")?.text || "").trim();
  }
  // A new event (If-None-Match: *) or a change of one (If-Match). Returns
  // the new etag; DavChanged when the server has another version.
  async put(url: string, ics: string, match: { etag?: string; create?: boolean }) {
    const headers: Record<string, string> = match.create ? { "if-none-match": "*" } : match.etag ? { "if-match": match.etag } : {};
    const answer = await this.request("PUT", url, ics, headers);
    if (answer.status === 401) throw new DavAuthError();
    if (answer.status === 412) throw new DavChanged();
    if (answer.status === 404 || answer.status === 410) return null;
    if (![200, 201, 204].includes(answer.status)) throw new DavFailed("event write", answer.status);
    // Servers that change what they store send no etag (RFC 4791 §5.3.4).
    const location = answer.headers.location ? canonicalUrl(answer.headers.location, url) : null;
    const saved = location && !isCollection(location) ? location : url;
    return { url: saved, etag: answer.headers.etag || (await this.etagOf(saved).catch(() => "")) };
  }
  async remove(url: string, etag?: string) {
    const answer = await this.request("DELETE", url, "", etag ? { "if-match": etag } : {});
    if (answer.status === 401) throw new DavAuthError();
    if (answer.status === 412) throw new DavChanged();
    if (![200, 202, 204, 404, 410].includes(answer.status)) throw new DavFailed("event delete", answer.status);
  }
}

/* ---------- iCalendar ---------- */

type Property = { name: string; params: Record<string, string>; value: string };
// "DTSTART;TZID="Europe/Berlin":20261006T080000" → name, params, value;
// quoted parameter values may contain ":" and ";".
function property(line: string): Property | null {
  let i = 0,
    quoted = false;
  const head: string[] = [];
  let current = "";
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === ";" || ch === ":")) {
      head.push(current);
      current = "";
      if (ch === ":") break;
      continue;
    }
    current += ch;
  }
  if (i >= line.length) return null;
  const [name, ...rest] = head;
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}
const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

export type IcsEvent = {
  uid: string;
  title: string;
  description: string;
  allDay: boolean;
  // All-day: dates with an inclusive end; timed: UTC to the minute ("2026-10-06T08:00Z").
  start: string;
  end: string;
  updated: string;
  cancelled: boolean;
  // A series (RRULE, RDATE) or one with changed occurrences (icsOccurrences expands it).
  recurring: boolean;
  // People invited (ATTENDEE with a mailto: address, not rooms or resources).
  attendees: { email: string; name: string }[];
};

const minute = (instant: Temporal.Instant) => `${instant.round({ smallestUnit: "minute", roundingMode: "floor" }).toString().slice(0, 16)}Z`;
// The IANA zone of a TZID: the name itself, the VTIMEZONE's X-LIC-LOCATION
// (Thunderbird, Outlook) or the end of a path-like id ("/mozilla.org/…/Europe/Berlin").
function zoneOf(tzid: string | undefined, locations: Map<string, string>, fallback: string) {
  if (!tzid) return fallback;
  if (validZone(tzid)) return tzid;
  const located = locations.get(tzid);
  if (located && validZone(located)) return located;
  const parts = tzid.split("/").filter(Boolean);
  for (let n = Math.min(3, parts.length); n >= 1; n--) {
    const candidate = parts.slice(-n).join("/");
    if (validZone(candidate)) return candidate;
  }
  return fallback;
}
type When = { allDay: true; date: Temporal.PlainDate } | { allDay: false; instant: Temporal.Instant };
function when(p: Property | undefined, locations: Map<string, string>, zone: string): When | null {
  if (!p) return null;
  const value = p.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || p.params.VALUE === "DATE") {
    const d = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!d) return null;
    return { allDay: true, date: Temporal.PlainDate.from(`${d[1]}-${d[2]}-${d[3]}`) };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(value);
  if (!t) return null;
  const local = `${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}`;
  if (t[7]) return { allDay: false, instant: Temporal.Instant.from(`${local}Z`) };
  // A TZID, or a floating time: in the calendar view's zone.
  return { allDay: false, instant: Temporal.PlainDateTime.from(local).toZonedDateTime(zoneOf(p.params.TZID, locations, zone)).toInstant() };
}
// "P1D", "PT1H30M", "-PT15M", "P2W".
function duration(value: string) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return Temporal.Duration.from({
    days: sign * (Number(m[2] || 0) * 7 + Number(m[3] || 0)),
    hours: sign * Number(m[4] || 0),
    minutes: sign * Number(m[5] || 0),
    seconds: sign * Number(m[6] || 0),
  });
}
const stampOf = (p: Property | undefined) => {
  const t = p && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(p.value.trim());
  return t ? `${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}Z` : "";
};

type Calendar = { events: Property[][]; locations: Map<string, string> };
function readCalendar(ics: string): Calendar {
  const locations = new Map<string, string>();
  const events: Property[][] = [];
  const stack: string[] = [];
  let tz = "";
  for (const line of unfold(ics)) {
    if (!line.trim()) continue;
    const p = property(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      if (stack.join("/") === "VCALENDAR/VEVENT") events.push([]);
      continue;
    }
    if (p.name === "END") {
      stack.pop();
      continue;
    }
    const path = stack.join("/");
    if (path === "VCALENDAR/VEVENT") events.at(-1)!.push(p);
    else if (path === "VCALENDAR/VTIMEZONE") {
      if (p.name === "TZID") tz = p.value;
      if (p.name === "X-LIC-LOCATION" && tz) locations.set(tz, p.value.trim());
    }
  }
  return { events, locations };
}
const isSeries = (cal: Calendar, master: Property[]) =>
  cal.events.length > 1 || master.some((p) => p.name === "RRULE" || p.name === "RDATE" || p.name === "RECURRENCE-ID");
const masterOf = (cal: Calendar) => cal.events.find((e) => !e.some((p) => p.name === "RECURRENCE-ID")) || cal.events[0];

// One VEVENT's content; `fallback`: the series' main event, for what an
// override leaves out.
function eventOf(props: Property[], cal: Calendar, zone: string, recurring: boolean, fallback?: Property[]): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name) || fallback?.find((p) => p.name === name);
  const own = (name: string) => props.find((p) => p.name === name);
  try {
    const start = when(own("DTSTART"), cal.locations, zone);
    if (!start) return null;
    let end = when(own("DTEND"), cal.locations, zone);
    const length = own("DURATION") ? duration(own("DURATION")!.value) : null;
    let startText: string, endText: string;
    if (start.allDay) {
      // All-day ends are exclusive in iCalendar; the database keeps the last day.
      let last = start.date;
      if (end?.allDay) last = end.date.subtract({ days: 1 });
      else if (!end && length) last = start.date.add({ days: Math.max(1, Math.round(length.total({ unit: "days", relativeTo: start.date }))) - 1 });
      if (Temporal.PlainDate.compare(last, start.date) < 0) last = start.date;
      startText = start.date.toString();
      endText = last.toString();
    } else {
      if (!end && length) end = { allDay: false, instant: start.instant.add({ seconds: Math.round(length.total({ unit: "seconds", relativeTo: start.instant.toZonedDateTimeISO("UTC") })) }) };
      // No length (or none that is positive): an hour, as the Google and
      // Microsoft adapters read it – a record's timed range cannot be empty.
      const last = end && !end.allDay && Temporal.Instant.compare(end.instant, start.instant) > 0 ? end.instant : start.instant.add({ hours: 1 });
      startText = minute(start.instant);
      endText = minute(last);
    }
    return {
      uid: get("UID")?.value.trim() || "",
      title: unText(get("SUMMARY")?.value || "").trim().slice(0, 500),
      description: unText(get("DESCRIPTION")?.value || ""),
      allDay: start.allDay,
      start: startText,
      end: endText,
      updated: stampOf(own("LAST-MODIFIED")) || stampOf(own("DTSTAMP")) || stampOf(fallback?.find((p) => p.name === "LAST-MODIFIED")) || new Date(0).toISOString(),
      cancelled: (own("STATUS")?.value || "").trim().toUpperCase() === "CANCELLED",
      recurring,
      attendees: (props.some((p) => p.name === "ATTENDEE") ? props : fallback || [])
        .filter((p) => p.name === "ATTENDEE" && /^mailto:/i.test(p.value.trim()) && !["RESOURCE", "ROOM"].includes((p.params.CUTYPE || "").toUpperCase()))
        .map((p) => ({ email: p.value.trim().slice(7).toLowerCase(), name: (p.params.CN || "").slice(0, 200) }))
        .filter((a) => a.email.includes("@"))
        .slice(0, 200),
    };
  } catch {
    return null;
  }
}

// The event of an iCalendar object (for a series: its main event), or null
// when it has none (a task) or one this engine cannot read. Floating times
// are in `zone`.
export function parseIcsEvent(ics: string, zone: string): IcsEvent | null {
  const cal = readCalendar(ics);
  if (!cal.events.length) return null;
  const master = masterOf(cal);
  return eventOf(master, cal, zone, isSeries(cal, master));
}

/* Occurrences of a series */

// The id of an occurrence: its original start, "20261006T080000Z" or
// "20261006" (all-day) – as RECURRENCE-ID names it, in UTC.
export const ridOf = (w: When | Occurrence) =>
  w.allDay ? w.date.toString().replace(/-/g, "") : w.instant.round({ smallestUnit: "second", roundingMode: "floor" }).toString().replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";
export function ridStart(rid: string): Occurrence | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(rid);
  if (!m) return null;
  if (!m[4]) return { allDay: true, date: Temporal.PlainDate.from(`${m[1]}-${m[2]}-${m[3]}`) };
  return { allDay: false, instant: Temporal.Instant.from(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) };
}
// The dates of RDATE / EXDATE lines (several values per line; PERIOD values are left out).
function dateList(props: Property[], name: string, cal: Calendar, zone: string): When[] {
  return props
    .filter((p) => p.name === name && p.params.VALUE !== "PERIOD")
    .flatMap((p) => p.value.split(",").map((value) => when({ ...p, value: value.trim() }, cal.locations, zone)))
    .filter((w): w is When => !!w);
}

export type IcsOccurrence = IcsEvent & {
  // "" for a single event; the original start for an occurrence of a series.
  rid: string;
};
export type IcsWindow = { from: Temporal.Instant; to: Temporal.Instant };
// The events of an iCalendar object within a window: a single event as it
// is, a series as its occurrences (RRULE, RDATE, EXDATE and RECURRENCE-ID
// overrides; at most `max`). `unsupported` names a rule part this engine
// does not expand – then no occurrences are given.
export function icsOccurrences(ics: string, zone: string, window: IcsWindow, max = 500): { occurrences: IcsOccurrence[]; series: boolean; unsupported: string | null } | null {
  const cal = readCalendar(ics);
  if (!cal.events.length) return null;
  const master = masterOf(cal);
  const series = isSeries(cal, master);
  if (!series) {
    const event = eventOf(master, cal, zone, false);
    return event ? { occurrences: [{ ...event, rid: "" }], series, unsupported: null } : null;
  }
  const base = master.some((p) => p.name === "RECURRENCE-ID") ? null : eventOf(master, cal, zone, true);
  let start: When | null = null;
  try {
    start = base ? when(master.find((p) => p.name === "DTSTART"), cal.locations, zone) : null;
  } catch {
    start = null;
  }
  if (master.some((p) => p.name === "EXRULE")) return { occurrences: [], series, unsupported: "EXRULE" };
  const rules = master.filter((p) => p.name === "RRULE");
  if (rules.length > 1) return { occurrences: [], series, unsupported: "RRULE twice" };
  const startProp = master.find((p) => p.name === "DTSTART");
  // Occurrences reaching into the window from before it.
  const length =
    base && start
      ? start.allDay
        ? Temporal.PlainDate.from(base.start).until(Temporal.PlainDate.from(base.end))
        : Temporal.Instant.from(`${base.start.slice(0, 16)}:00Z`).until(Temporal.Instant.from(`${base.end.slice(0, 16)}:00Z`))
      : null;
  const starts = new Map<string, Occurrence>();
  if (base && start && startProp) {
    const from: Occurrence = start.allDay
      ? { allDay: true, date: window.from.toZonedDateTimeISO("UTC").toPlainDate().subtract({ days: (length as Temporal.Duration).days + 1 }) }
      : { allDay: false, instant: window.from.subtract({ milliseconds: (length as Temporal.Duration).total({ unit: "milliseconds" }) }) };
    const to: Occurrence = start.allDay ? { allDay: true, date: window.to.toZonedDateTimeISO("UTC").toPlainDate() } : { allDay: false, instant: window.to };
    if (rules.length) {
      const ruleStart: RuleStart = start.allDay
        ? { allDay: true, date: start.date }
        : {
            allDay: false,
            zone: /Z$/i.test(startProp.value.trim()) ? "UTC" : zoneOf(startProp.params.TZID, cal.locations, zone),
            dateTime: Temporal.PlainDateTime.from(startProp.value.trim().replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).*$/, "$1-$2-$3T$4:$5:$6")),
          };
      const expansion = expandRule(rules[0].value, ruleStart, from, to, max);
      if (expansion.unsupported) return { occurrences: [], series, unsupported: expansion.unsupported };
      for (const o of expansion.starts) starts.set(ridOf(o), o);
    } else {
      const first: Occurrence = start.allDay ? { allDay: true, date: start.date } : { allDay: false, instant: start.instant };
      starts.set(ridOf(first), first);
    }
    for (const extra of dateList(master, "RDATE", cal, zone)) if (extra.allDay === start.allDay) starts.set(ridOf(extra), extra as Occurrence);
    for (const gone of dateList(master, "EXDATE", cal, zone)) starts.delete(ridOf(gone));
  }
  // Overrides replace their occurrence (and may move one into the window).
  const overrides = new Map<string, Property[]>();
  for (const props of cal.events) {
    const rid = props.find((p) => p.name === "RECURRENCE-ID");
    if (!rid) continue;
    try {
      const w = when(rid, cal.locations, zone);
      if (w) overrides.set(ridOf(w), props);
    } catch {}
  }
  const inWindow = (e: IcsEvent) =>
    e.allDay
      ? e.end >= window.from.toZonedDateTimeISO("UTC").toPlainDate().toString() && e.start <= window.to.toZonedDateTimeISO("UTC").toPlainDate().toString()
      : Date.parse(e.end) >= window.from.epochMilliseconds && Date.parse(e.start) <= window.to.epochMilliseconds;
  const out: IcsOccurrence[] = [];
  for (const [rid, o] of starts) {
    if (overrides.has(rid) || !base || !length) continue;
    let event: IcsEvent;
    if (o.allDay) event = { ...base, start: o.date.toString(), end: o.date.add(length).toString() };
    else event = { ...base, start: minute(o.instant), end: minute(o.instant.add(length as Temporal.Duration)) };
    if (inWindow(event)) out.push({ ...event, rid });
  }
  for (const [rid, props] of overrides) {
    // An override of a date EXDATE removed stays removed.
    if (base && start && !starts.has(rid) && dateList(master, "EXDATE", cal, zone).some((w) => ridOf(w) === rid)) continue;
    const event = eventOf(props, cal, zone, true, base ? master : undefined);
    if (event && inWindow(event)) out.push({ ...event, rid });
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { occurrences: out.slice(0, max), series, unsupported: null };
}

export type IcsContent = { title: string; description: string; allDay: boolean; start: string; end: string };
const compactDate = (date: string) => date.slice(0, 10).replace(/-/g, "");
const compactUtc = (value: string) => `${value.slice(0, 16).replace(/[-:]/g, "")}00Z`;
const nowUtc = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
function timeLines(event: IcsContent) {
  if (event.allDay)
    return [
      `DTSTART;VALUE=DATE:${compactDate(event.start)}`,
      `DTEND;VALUE=DATE:${compactDate(Temporal.PlainDate.from(event.end.slice(0, 10)).add({ days: 1 }).toString())}`,
    ];
  return [`DTSTART:${compactUtc(event.start)}`, `DTEND:${compactUtc(event.end)}`];
}

// A new event: times in UTC (no VTIMEZONE needed), the record's id and link.
export function newIcsEvent(event: IcsContent, extra: { uid?: string; link: string; rowId: string }) {
  const stamp = nowUtc();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Flowplan//Calendar sync//EN",
    "BEGIN:VEVENT",
    `UID:${extra.uid || randomUUID()}`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    ...timeLines(event),
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText(event.description)}`,
    `URL:${extra.link}`,
    `X-FLOWPLAN-ROW:${extra.rowId}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// Writing into an existing object: its lines with the top-level VEVENT
// each belongs to (-1: none) and whether it is a property of that VEVENT
// itself (not of a VALARM inside it).
type Scanned = { text: string; p: Property | null; event: number; own: boolean; begin: boolean; end: boolean };
function scan(ics: string) {
  const out: Scanned[] = [];
  const stack: string[] = [];
  let event = -1,
    count = 0;
  for (const text of unfold(ics)) {
    if (!text.length) continue;
    const p = property(text);
    if (p?.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      const top = stack.join("/") === "VCALENDAR/VEVENT";
      if (top) event = count++;
      out.push({ text, p, event: stack.length >= 2 && stack[1] === "VEVENT" ? event : -1, own: false, begin: top, end: false });
      continue;
    }
    if (p?.name === "END") {
      const top = stack.join("/") === "VCALENDAR/VEVENT";
      out.push({ text, p, event: stack.length >= 2 && stack[1] === "VEVENT" ? event : -1, own: false, begin: false, end: top });
      stack.pop();
      continue;
    }
    const inEvent = stack.length >= 2 && stack[1] === "VEVENT";
    out.push({ text, p, event: inEvent ? event : -1, own: inEvent && stack.length === 2, begin: false, end: false });
  }
  return out;
}
const join = (lines: string[]) => lines.map(fold).join("\r\n") + "\r\n";
// The top-level VEVENTs: index → its RECURRENCE-ID as an occurrence id ("" for the main one).
function eventIds(lines: Scanned[], ics: string, zone: string) {
  const cal = readCalendar(ics);
  const ids = new Map<number, string>();
  for (const l of lines) if (l.begin) ids.set(l.event, "");
  for (const l of lines)
    if (l.own && l.p?.name === "RECURRENCE-ID") {
      try {
        const w = when(l.p, cal.locations, zone);
        ids.set(l.event, w ? ridOf(w) : "?");
      } catch {
        ids.set(l.event, "?");
      }
    }
  return ids;
}
const contentLines = (event: IcsContent, sequence: number) => {
  const stamp = nowUtc();
  return [...timeLines(event), `SUMMARY:${icsText(event.title)}`, `DESCRIPTION:${icsText(event.description)}`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, `SEQUENCE:${sequence + 1}`];
};
// A date of the series written the way its DTSTART is (RECURRENCE-ID, EXDATE):
// a date, UTC, the same TZID, or floating in `zone`.
function likeStart(name: string, startProp: Property, rid: string, ics: string, zone: string) {
  const o = ridStart(rid)!;
  if (o.allDay) return `${name};VALUE=DATE:${rid}`;
  const value = startProp.value.trim();
  if (/Z$/i.test(value)) return `${name}:${rid}`;
  const tzid = startProp.params.TZID;
  const local = o.instant
    .toZonedDateTimeISO(zoneOf(tzid, readCalendar(ics).locations, zone))
    .toPlainDateTime()
    .toString()
    .replace(/[-:]/g, "")
    .slice(0, 15);
  return tzid ? `${name};TZID=${/[;:,]/.test(tzid) ? `"${tzid}"` : tzid}:${local}` : `${name}:${local}`;
}

// A change of an existing event: title, description and times of its main
// VEVENT – or, with `rid`, of that occurrence of the series (its override,
// written when there is none) – are replaced; everything else (alarms,
// attendees, location, categories, the repeat rule, other occurrences)
// stays as it is.
const REPLACED = new Set(["SUMMARY", "DESCRIPTION", "DTSTART", "DTEND", "DURATION", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "X-ALT-DESC"]);
// Not carried from the main event into a new override.
const SERIES_ONLY = new Set([...REPLACED, "RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID"]);
export function patchIcsEvent(ics: string, event: IcsContent, rid = "", zone = "UTC") {
  const lines = scan(ics);
  const ids = eventIds(lines, ics, zone);
  const target = [...ids].find(([, id]) => id === rid)?.[0];
  const master = [...ids].find(([, id]) => id === "")?.[0];
  if (target === undefined) {
    if (!rid || master === undefined) throw new Error("No VEVENT to change.");
    // A new override: the main event's other properties and alarms, the
    // occurrence's own times and texts.
    const main = lines.filter((l) => l.event === master);
    const startProp = main.find((l) => l.own && l.p?.name === "DTSTART")?.p;
    if (!startProp) throw new Error("No DTSTART.");
    const body = main.filter((l) => !l.begin && !l.end && !(l.own && l.p && SERIES_ONLY.has(l.p.name))).map((l) => l.text);
    const sequence = Number(main.find((l) => l.own && l.p?.name === "SEQUENCE")?.p?.value) || 0;
    const block = ["BEGIN:VEVENT", likeStart("RECURRENCE-ID", startProp, rid, ics, zone), ...body, ...contentLines(event, sequence), "END:VEVENT"];
    const out = lines.map((l) => l.text);
    const close = out.map((t) => t.toUpperCase()).lastIndexOf("END:VCALENDAR");
    out.splice(close < 0 ? out.length : close, 0, ...block);
    return join(out);
  }
  const out: string[] = [];
  let sequence = 0;
  for (const l of lines) {
    if (l.event === target && l.own && l.p && REPLACED.has(l.p.name)) {
      if (l.p.name === "SEQUENCE") sequence = Number(l.p.value) || 0;
      continue;
    }
    if (l.event === target && l.end) out.push(...contentLines(event, sequence));
    out.push(l.text);
  }
  return join(out);
}

// An occurrence of a series removed: an EXDATE on the main event, and its
// override (if any) gone.
export function excludeIcsOccurrence(ics: string, rid: string, zone = "UTC") {
  const lines = scan(ics);
  const ids = eventIds(lines, ics, zone);
  const master = [...ids].find(([, id]) => id === "")?.[0];
  const drop = new Set([...ids].filter(([, id]) => id === rid).map(([index]) => index));
  const out: string[] = [];
  const startProp = master === undefined ? null : lines.find((l) => l.event === master && l.own && l.p?.name === "DTSTART")?.p;
  for (const l of lines) {
    if (l.event >= 0 && drop.has(l.event)) continue;
    if (master !== undefined && l.event === master && l.end && startProp) out.push(likeStart("EXDATE", startProp, rid, ics, zone));
    out.push(l.text);
  }
  return join(out);
}
