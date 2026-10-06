// Two-way calendar sync over CalDAV: a calendar view becomes a calendar in
// Apple Calendar, Thunderbird or DAVx⁵ (Android) – changes there (new
// events, moved times, renamed or deleted events) write back to the
// database. Each person creates an access per view; the password is shown
// once and only its hash is stored. Records follow the person's rights:
// they only see what they may read and only change what they may edit.
//
// Served from proxy.ts, because route handlers do not accept the WebDAV
// methods PROPFIND and REPORT.
import { createHash, randomBytes } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { visibleRows, assertRowAccess } from "./row-access";
import { queryRows } from "./database";
import { calendarRange, calendarSchema } from "./database-calendar";
import { scheduleFields } from "./database-timeline";
import { cellText } from "./cell-text";
import { parseRecurrence } from "./recurrence";
import { rowChanged, rowCreated } from "./automations";
import { trashRow } from "./row-trash";
import { maintainRowOrders } from "./row-order-server";
import type { Field, Identity, Page, Row, View } from "./types";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const BASE = "/api/caldav";

/* ---------- Accesses ---------- */

export function createCalDavAccess(user: Identity, pageId: string, viewId: string) {
  const page = requirePage(user, pageId);
  const view = viewOf(page.id, viewId);
  if (!view) throw new HttpError(404, "Kalenderansicht nicht gefunden.");
  const password = randomBytes(18).toString("base64url");
  run("DELETE FROM caldav_accesses WHERE user_id=? AND page_id=? AND view_id=?", user.id, page.id, viewId);
  const access = id();
  run(
    "INSERT INTO caldav_accesses(id,user_id,page_id,view_id,token_hash,created_at) VALUES(?,?,?,?,?,?)",
    access,
    user.id,
    page.id,
    viewId,
    hash(password),
    Date.now(),
  );
  return {
    server: `${appUrl()}${BASE}`,
    calendar: `${appUrl()}${BASE}/calendars/${access}/`,
    username: user.email || user.name,
    password,
  };
}
export function revokeCalDavAccess(user: Identity, pageId: string, viewId: string) {
  run("DELETE FROM caldav_accesses WHERE user_id=? AND page_id=? AND view_id=?", user.id, pageId, viewId);
}
export function hasCalDavAccess(user: Identity, pageId: string, viewId: string) {
  return !!one("SELECT 1 FROM caldav_accesses WHERE user_id=? AND page_id=? AND view_id=?", user.id, pageId, viewId);
}

function viewOf(pageId: string, viewId: string) {
  const raw = one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", pageId);
  return (JSON.parse(raw?.views || "[]") as View[]).find((v) => v.id === viewId && v.type === "calendar");
}

/* ---------- Context of a request ---------- */

type Context = { access: string; user: Identity; page: Page; view: View; fields: Field[]; zone: string; canWrite: boolean };

function authenticate(request: Request): Context | null {
  const header = request.headers.get("authorization") || "";
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  if (!password || password.length > 200) return null;
  const access = one<{ id: string; user_id: string; page_id: string; view_id: string }>(
    "SELECT * FROM caldav_accesses WHERE token_hash=?",
    hash(password),
  );
  if (!access) return null;
  const account = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0 AND demo_until IS NULL", access.user_id);
  if (!account) return null;
  const user = { ...account, groups: [], isAdmin: false } as Identity;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", access.page_id);
  const role = page ? pageRole(user, page) : null;
  const view = page ? viewOf(page.id, access.view_id) : undefined;
  if (!page || !role || !view) return null;
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)!.fields) as Field[];
  const zone = calendarSchema.safeParse(view.calendar).success ? (view.calendar as { timeZone: string }).timeZone : "UTC";
  return { access: access.id, user, page, view, fields, zone, canWrite: (role === "owner" || role === "editor") && !page.locked };
}

function events(ctx: Context) {
  const rows = all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=?", ctx.page.id).map(
    (r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row,
  );
  return queryRows(visibleRows(ctx.user, ctx.page, rows), ctx.fields, ctx.view).filter((r) => calendarRange(r, ctx.fields, ctx.view, ctx.zone));
}
const etag = (r: Pick<Row, "id" | "version">) => `"${r.version}-${r.id.slice(0, 8)}"`;
const ctag = (rows: Row[]) => hash(rows.map((r) => etag(r)).join(",")).slice(0, 24);

/* ---------- iCalendar ---------- */

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const unText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const compact = (date: string) => date.slice(0, 10).replace(/-/g, "");
const addDays = (date: string, days: number) => {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
function fold(line: string) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char) > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function eventIcs(ctx: Context, row: Row) {
  const range = calendarRange(row, ctx.fields, ctx.view, ctx.zone)!;
  const title = cellText(row.cells[ctx.fields[0]?.id || ""]) || "Ohne Titel";
  const link = `${appUrl()}/#page=${ctx.page.id}&row=${row.id}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Flowplan//CalDAV//DE",
    "BEGIN:VEVENT",
    `UID:${row.id}`,
    `DTSTAMP:${utc(new Date().toISOString())}`,
    `SUMMARY:${icsText(title)}`,
    `URL:${link}`,
    `DESCRIPTION:${icsText(link)}`,
  ];
  if (range.timed) lines.push(`DTSTART:${utc(range.start)}`, `DTEND:${utc(range.end)}`);
  else lines.push(`DTSTART;VALUE=DATE:${compact(range.start)}`, `DTEND;VALUE=DATE:${compact(addDays(range.end, 1))}`);
  const rule = parseRecurrence((row as Row & { recurrence?: string }).recurrence);
  if (rule) {
    const parts = [`FREQ=${rule.freq.toUpperCase()}`, `INTERVAL=${rule.interval}`];
    if (rule.count) parts.push(`COUNT=${rule.count}`);
    if (rule.until) parts.push(`UNTIL=${compact(rule.until)}${range.timed ? "T235959Z" : ""}`);
    lines.push(`RRULE:${parts.join(";")}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// The first VEVENT of an iCalendar body: title, start and end as values
// for date properties ("2026-10-06" or "2026-10-06T08:00Z").
export function parseEvent(body: string) {
  const unfolded = body.replace(/\r?\n[ \t]/g, "");
  const block = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/.exec(unfolded)?.[1];
  if (!block) throw new HttpError(400, "Kein Termin im Kalenderdaten-Text.");
  const prop = (name: string) => {
    const m = new RegExp(`^${name}((?:;[^:\\r\\n]*)?):(.*)$`, "mi").exec(block);
    return m ? { params: m[1], value: m[2].trim() } : null;
  };
  const when = (p: { params: string; value: string } | null) => {
    if (!p) return null;
    const date = /^(\d{4})(\d{2})(\d{2})$/.exec(p.value);
    if (date || /VALUE=DATE(?!-)/i.test(p.params)) {
      const d = /^(\d{4})(\d{2})(\d{2})/.exec(p.value)!;
      return { allDay: true, value: `${d[1]}-${d[2]}-${d[3]}` };
    }
    const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(p.value);
    if (!t) throw new HttpError(400, "Unbekanntes Datumsformat.");
    const local = `${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}`;
    if (t[7]) return { allDay: false, value: `${local.slice(0, 16)}Z` };
    const zone = /TZID=([^;:]+)/i.exec(p.params)?.[1]?.replace(/^"|"$/g, "");
    try {
      const instant = zone ? Temporal.PlainDateTime.from(local).toZonedDateTime(zone).toInstant() : Temporal.Instant.from(`${local}Z`);
      return { allDay: false, value: `${instant.toString().slice(0, 16)}Z` };
    } catch {
      return { allDay: false, value: `${local.slice(0, 16)}Z` };
    }
  };
  const start = when(prop("DTSTART"));
  if (!start) throw new HttpError(400, "Termin ohne Beginn.");
  let end = when(prop("DTEND"));
  // All-day ends are exclusive in iCalendar; the database keeps the last day.
  if (end?.allDay) end = { ...end, value: addDays(end.value, -1) };
  return {
    uid: prop("UID")?.value || "",
    title: unText(prop("SUMMARY")?.value || "").slice(0, 500),
    start,
    end: end && end.value !== start.value ? end : null,
  };
}

/* ---------- WebDAV ---------- */

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${body}</d:multistatus>`, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8", DAV: "1, 2, calendar-access" },
  });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const response = (href: string, props: string) =>
  `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

function calendarProps(ctx: Context, rows: Row[]) {
  const privileges = ctx.canWrite
    ? "<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>"
    : "<d:privilege><d:read/></d:privilege>";
  return (
    `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
    `<d:displayname>${esc(`${ctx.page.title || "Flowplan"} – ${ctx.view.name}`)}</d:displayname>` +
    `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
    `<cs:getctag>${ctag(rows)}</cs:getctag><d:sync-token>${ctag(rows)}</d:sync-token>` +
    `<d:current-user-privilege-set>${privileges}</d:current-user-privilege-set>` +
    `<d:owner><d:href>${BASE}/principal/</d:href></d:owner>`
  );
}
const principalProps = () =>
  `<d:current-user-principal><d:href>${BASE}/principal/</d:href></d:current-user-principal>` +
  `<c:calendar-home-set><d:href>${BASE}/calendars/</d:href></c:calendar-home-set>` +
  `<d:principal-URL><d:href>${BASE}/principal/</d:href></d:principal-URL>` +
  `<d:resourcetype><d:collection/></d:resourcetype>`;

function hrefsOf(body: string) {
  return [...body.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map((m) => decodeURIComponent(m[1].trim()));
}

export async function handleCalDav(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/.well-known/caldav")) return Response.redirect(`${url.origin}${BASE}/`, 301);
  if (request.method === "OPTIONS")
    return new Response(null, {
      headers: { Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT", DAV: "1, 2, calendar-access" },
    });
  const ctx = authenticate(request);
  if (!ctx)
    return new Response("Anmeldung erforderlich", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Flowplan CalDAV", charset="UTF-8"', DAV: "1, 2, calendar-access" },
    });
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean);
  const body = ["PROPFIND", "REPORT", "PUT"].includes(request.method) ? (await request.text()).slice(0, 2_000_000) : "";
  const depth = request.headers.get("depth") || "0";
  const home = `${BASE}/calendars/`;
  const collection = `${home}${ctx.access}/`;
  try {
    // Discovery: root and principal point to the calendar home.
    if (request.method === "PROPFIND" && (parts.length === 0 || parts[0] === "principal"))
      return xml(response(parts.length ? `${BASE}/principal/` : `${BASE}/`, principalProps()));
    if (request.method === "PROPFIND" && parts[0] === "calendars" && parts.length === 1) {
      let out = response(home, `<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>${BASE}/principal/</d:href></d:current-user-principal>`);
      if (depth !== "0") out += response(collection, calendarProps(ctx, events(ctx)));
      return xml(out);
    }
    if (parts[0] !== "calendars" || parts[1] !== ctx.access) return new Response("Nicht gefunden", { status: 404 });
    const rowId = parts[2]?.replace(/\.ics$/, "");
    if (!rowId) {
      if (request.method === "PROPFIND") {
        const rows = events(ctx);
        let out = response(collection, calendarProps(ctx, rows));
        if (depth !== "0")
          for (const r of rows) out += response(`${collection}${r.id}.ics`, `<d:getetag>${esc(etag(r))}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8; component=vevent</d:getcontenttype><d:resourcetype/>`);
        return xml(out);
      }
      if (request.method === "REPORT") {
        const rows = events(ctx);
        const wanted = /calendar-multiget/.test(body) ? new Set(hrefsOf(body).map((h) => h.split("/").pop()!.replace(/\.ics$/, ""))) : null;
        const withData = /calendar-data/.test(body) || !!wanted;
        return xml(
          rows
            .filter((r) => !wanted || wanted.has(r.id))
            .map((r) => response(`${collection}${r.id}.ics`, `<d:getetag>${esc(etag(r))}</d:getetag>${withData ? `<c:calendar-data>${esc(eventIcs(ctx, r))}</c:calendar-data>` : ""}`))
            .join(""),
        );
      }
      if (request.method === "GET" || request.method === "HEAD")
        return new Response(request.method === "HEAD" ? null : `Flowplan: ${ctx.page.title} – ${ctx.view.name}`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      return new Response(null, { status: 405 });
    }
    // A single event.
    const row = events(ctx).find((r) => r.id === rowId);
    if (request.method === "GET" || request.method === "HEAD" || request.method === "PROPFIND") {
      if (!row) return new Response("Nicht gefunden", { status: 404 });
      if (request.method === "PROPFIND") return xml(response(`${collection}${row.id}.ics`, `<d:getetag>${esc(etag(row))}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8; component=vevent</d:getcontenttype>`));
      return new Response(request.method === "HEAD" ? null : eventIcs(ctx, row), { headers: { "Content-Type": "text/calendar; charset=utf-8", ETag: etag(row) } });
    }
    if (!ctx.canWrite) return new Response("Nur lesen", { status: 403 });
    if (request.method === "DELETE") {
      if (!row) return new Response(null, { status: 404 });
      transaction(() => {
        trashRow(ctx.user, ctx.page, row.id);
        maintainRowOrders(ctx.page.id);
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === "PUT") {
      const ifMatch = request.headers.get("if-match");
      if (row && ifMatch && ifMatch !== "*" && ifMatch !== etag(row)) return new Response("Geändert", { status: 412 });
      if (!row && request.headers.get("if-none-match") !== "*" && one("SELECT 1 FROM rows WHERE id=?", rowId)) return new Response("Geändert", { status: 412 });
      const event = parseEvent(body);
      const { start, end } = scheduleFields(ctx.fields, ctx.view);
      if (!start) return new Response("Diese Ansicht hat kein Datum", { status: 409 });
      const patch: Record<string, unknown> = { [start.id]: event.start.value };
      if (end) patch[end.id] = event.end?.value ?? "";
      if (event.title) patch[ctx.fields[0].id] = event.title;
      const saved = transaction(() => {
        if (row) {
          const stored = one<Row & { cells: string }>("SELECT * FROM rows WHERE id=?", row.id)!;
          assertRowAccess(ctx.user, ctx.page, stored, true);
          const before = JSON.parse(stored.cells as unknown as string);
          const after = { ...before, ...patch };
          run("UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?", JSON.stringify(after), ctx.user.id, row.id);
          rowChanged(ctx.user, ctx.page, row.id, before, after, ctx.fields);
          return row.id;
        }
        // A new event: a new record (the client's name becomes its id when it is one).
        const rid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rowId) && !one("SELECT 1 FROM row_trash WHERE id=?", rowId) ? rowId : id();
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
          rid,
          ctx.page.id,
          JSON.stringify({ [ctx.fields[0].id]: event.title || "Termin", ...patch }),
          Date.now(),
          ctx.user.id,
          ctx.user.id,
        );
        rowCreated(ctx.user, ctx.page, rid);
        return rid;
      });
      const stored = one<{ id: string; version: number }>("SELECT id,version FROM rows WHERE id=?", saved)!;
      const headers: Record<string, string> = { ETag: etag(stored) };
      if (saved !== rowId) headers.Location = `${collection}${saved}.ics`;
      return new Response(null, { status: row ? 204 : 201, headers });
    }
    return new Response(null, { status: 405, headers: { Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT" } });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("CalDAV", e);
    return new Response(e instanceof HttpError ? e.message : "Fehler", { status });
  }
}
