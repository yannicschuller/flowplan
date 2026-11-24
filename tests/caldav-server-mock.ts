// A small CalDAV server on 127.0.0.1 for the calendar sync's tests (#460):
// discovery (/.well-known/caldav → principal → calendar home), PROPFIND of
// the home and the calendars (displayname, colour, components, privileges,
// ctag, sync token), REPORT calendar-query (time range), calendar-multiget
// and sync-collection (RFC 6578), GET, PUT with If-Match / If-None-Match and
// DELETE with If-Match, Basic auth (401 otherwise). No network beyond the
// loopback interface; credentials are whatever the test generates.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

type MockEvent = { ics: string; etag: string };
export type MockCalendar = {
  name: string;
  color: string;
  components: string[];
  writable: boolean;
  events: Map<string, MockEvent>;
  // Every change with the token it got: the sync-collection log.
  log: { token: number; file: string }[];
};
export type MockOptions = {
  // Announce and answer sync-collection (otherwise only ctag/etag).
  syncCollection: boolean;
  // Answer a PUT without ETag (as servers that change the data do).
  omitEtagOnPut: boolean;
  // Tokens up to this number are refused as expired (valid-sync-token).
  expiredBefore: number;
  // Called after a GET of an event was answered: a change "in the calendar
  // app" between Flowplan's read and its write (If-Match → 412).
  afterGet?: (calendar: string, file: string) => void;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const multistatus = (inner: string, extra = "") =>
  `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">${inner}${extra}</D:multistatus>`;
const ok = (href: string, props: string) => `<D:response><D:href>${esc(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const gone = (href: string) => `<D:response><D:href>${esc(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
const etagOf = (ics: string) => `"${createHash("sha256").update(ics).digest("hex").slice(0, 16)}"`;
// The first DTSTART of an object as yyyymmdd, for time-range filters.
const dayOf = (ics: string) => /DTSTART[^:\r\n]*:(\d{8})/.exec(ics.replace(/\r?\n[ \t]/g, ""))?.[1] || "";

export class CalDavMock {
  readonly username: string;
  // Changeable: a password changed or revoked at the provider.
  password: string;
  readonly calendars = new Map<string, MockCalendar>();
  readonly requests: { method: string; path: string; ifMatch?: string; ifNoneMatch?: string; authorized: boolean }[] = [];
  options: MockOptions = { syncCollection: true, omitEtagOnPut: false, expiredBefore: 0 };
  private token = 1;
  private server: Server | null = null;
  origin = "";

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
    this.addCalendar("work", { name: "Arbeit", color: "#3366CCFF" });
    this.addCalendar("tasks", { name: "Aufgaben", components: ["VTODO"] });
    this.addCalendar("shared", { name: "Geteilt (nur lesen)", writable: false });
  }
  addCalendar(id: string, { name, color = "", components = ["VEVENT"], writable = true }: { name: string; color?: string; components?: string[]; writable?: boolean }) {
    this.calendars.set(id, { name, color, components, writable, events: new Map(), log: [] });
  }
  get home() {
    return `/dav/calendars/${this.username}/`;
  }
  calendarUrl(id: string) {
    return `${this.origin}${this.home}${id}/`;
  }
  private calendar(id: string) {
    const cal = this.calendars.get(id);
    if (!cal) throw new Error(`no calendar ${id}`);
    return cal;
  }
  ctag(id: string) {
    const cal = this.calendar(id);
    return `ctag-${cal.log.at(-1)?.token ?? 0}`;
  }
  // Changes "in the calendar app": the server's own writes.
  putEvent(id: string, file: string, ics: string) {
    const cal = this.calendar(id);
    const etag = etagOf(ics + this.token);
    cal.events.set(file, { ics, etag });
    cal.log.push({ token: ++this.token, file });
    return etag;
  }
  deleteEvent(id: string, file: string) {
    const cal = this.calendar(id);
    cal.events.delete(file);
    cal.log.push({ token: ++this.token, file });
  }
  event(id: string, file: string) {
    return this.calendar(id).events.get(file);
  }

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          this.handle(req, res, Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          res.writeHead(500).end(String(error));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: string) {
    const url = new URL(req.url || "/", this.origin);
    const path = decodeURIComponent(url.pathname);
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    const authorized = req.headers.authorization === expected;
    this.requests.push({
      method: req.method || "",
      path,
      ifMatch: req.headers["if-match"] as string | undefined,
      ifNoneMatch: req.headers["if-none-match"] as string | undefined,
      authorized,
    });
    const send = (status: number, text = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(text.startsWith("<?xml") ? { "content-type": "application/xml; charset=utf-8" } : {}), ...headers });
      res.end(text);
    };
    // The well-known address redirects before asking for credentials, as Nextcloud does.
    if (path === "/.well-known/caldav") return send(301, "", { location: "/dav/" });
    if (!authorized) return send(401, "Unauthorized", { "www-authenticate": 'Basic realm="mock"' });
    const principal = `/dav/principals/${this.username}/`;
    if (req.method === "PROPFIND" && (path === "/dav/" || path === principal)) {
      return send(
        207,
        multistatus(
          ok(
            path,
            `<D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>` +
              (path === principal ? `<C:calendar-home-set><D:href>${this.origin}${this.home}</D:href></C:calendar-home-set>` : ""),
          ),
        ),
      );
    }
    if (!path.startsWith(this.home)) return send(404);
    const [id, file] = path.slice(this.home.length).split("/");
    if (!id) {
      if (req.method !== "PROPFIND") return send(405);
      let out = ok(this.home, "<D:resourcetype><D:collection/></D:resourcetype>");
      if (req.headers.depth === "1") {
        out += ok(`${this.home}inbox/`, "<D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>");
        for (const [cid, cal] of this.calendars) out += ok(`${this.home}${cid}/`, this.calendarProps(cid, cal));
      }
      return send(207, multistatus(out));
    }
    const cal = this.calendars.get(id);
    if (!cal) return send(404);
    const collection = `${this.home}${id}/`;
    if (!file) {
      if (req.method === "PROPFIND") return send(207, multistatus(ok(collection, this.calendarProps(id, cal))));
      if (req.method !== "REPORT") return send(405);
      if (/sync-collection/.test(body)) {
        if (!this.options.syncCollection) return send(501);
        const raw = /<[^>]*sync-token>([^<]*)</.exec(body)?.[1] || "";
        const since = Number(raw.replace(/^.*\/sync\//, ""));
        if (!raw || !Number.isFinite(since) || since < this.options.expiredBefore)
          return send(403, `<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>`, { "content-type": "application/xml" });
        const files = [...new Set(cal.log.filter((c) => c.token > since).map((c) => c.file))];
        const out = files
          .map((f) => {
            const ev = cal.events.get(f);
            return ev ? ok(`${collection}${f}`, `<D:getetag>${esc(ev.etag)}</D:getetag>`) : gone(`${collection}${f}`);
          })
          .join("");
        return send(207, multistatus(out, `<D:sync-token>${this.syncToken(cal)}</D:sync-token>`));
      }
      const data = /calendar-data/.test(body);
      const props = (ev: MockEvent) => `<D:getetag>${esc(ev.etag)}</D:getetag>${data ? `<C:calendar-data>${esc(ev.ics)}</C:calendar-data>` : ""}`;
      if (/calendar-multiget/.test(body)) {
        const hrefs = [...body.matchAll(/<[^>]*href>([^<]+)</g)].map((m) => decodeURIComponent(m[1].trim()));
        const out = hrefs
          .map((href) => {
            const ev = cal.events.get(href.split("/").pop()!);
            return ev && href.startsWith(collection) ? ok(href, props(ev)) : gone(href);
          })
          .join("");
        return send(207, multistatus(out));
      }
      // calendar-query: VEVENTs starting in the range.
      const range = /time-range\s+start="(\d{8})T\d{6}Z"\s+end="(\d{8})T\d{6}Z"/.exec(body);
      const out = [...cal.events]
        // Series: always (a real server expands them; any occurrence may be in the range).
        .filter(([, ev]) => /BEGIN:VEVENT/.test(ev.ics) && (!range || /^RRULE:/m.test(ev.ics) || (dayOf(ev.ics) >= range[1] && dayOf(ev.ics) < range[2])))
        .map(([f, ev]) => ok(`${collection}${f}`, props(ev)))
        .join("");
      return send(207, multistatus(out));
    }
    const existing = cal.events.get(file);
    const ifMatch = req.headers["if-match"] as string | undefined;
    if (req.method === "GET") {
      if (!existing) return send(404);
      send(200, existing.ics, { etag: existing.etag, "content-type": "text/calendar" });
      this.options.afterGet?.(id, file);
      return;
    }
    if (req.method === "PROPFIND") return existing ? send(207, multistatus(ok(path, `<D:getetag>${esc(existing.etag)}</D:getetag>`))) : send(404);
    if (!cal.writable) return send(403);
    if (req.method === "PUT") {
      if (req.headers["if-none-match"] === "*" && existing) return send(412);
      if (ifMatch && (!existing || ifMatch !== existing.etag)) return send(412);
      const etag = this.putEvent(id, file, body);
      return send(existing ? 204 : 201, "", this.options.omitEtagOnPut ? {} : { etag });
    }
    if (req.method === "DELETE") {
      if (!existing) return send(404);
      if (ifMatch && ifMatch !== existing.etag) return send(412);
      this.deleteEvent(id, file);
      return send(204);
    }
    return send(405);
  }
  private syncToken(cal: MockCalendar) {
    return `http://mock/sync/${cal.log.at(-1)?.token ?? this.options.expiredBefore}`;
  }
  private calendarProps(id: string, cal: MockCalendar) {
    const privileges = cal.writable
      ? "<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>"
      : "<D:privilege><D:read/></D:privilege>";
    return (
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `<D:displayname>${esc(cal.name)}</D:displayname>` +
      (cal.color ? `<A:calendar-color>${cal.color}</A:calendar-color>` : "") +
      `<C:supported-calendar-component-set>${cal.components.map((c) => `<C:comp name="${c}"/>`).join("")}</C:supported-calendar-component-set>` +
      `<D:current-user-privilege-set>${privileges}</D:current-user-privilege-set>` +
      `<CS:getctag>${this.ctag(id)}</CS:getctag>` +
      (this.options.syncCollection ? `<D:sync-token>${this.syncToken(cal)}</D:sync-token>` : "")
    );
  }
}
