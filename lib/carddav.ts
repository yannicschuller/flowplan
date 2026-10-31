// CardDAV (RFC 6352) for contacts databases, read-only: a contacts
// database becomes an address book in Apple Contacts, Thunderbird or DAVx⁵.
// Like CalDAV (lib/caldav.ts) each person creates an access per database;
// the password is shown once (or only exists inside the iOS configuration
// profile) and only its hash is stored. Every request checks again that the
// person may read the database; records and properties follow their
// permissions (record access, field-level read rules).
//
// Discovery: /.well-known/carddav → /api/carddav/ (current-user-principal),
// /api/carddav/principal/ (addressbook-home-set), /api/carddav/addressbooks/
// and the address book /api/carddav/addressbooks/<access>/ with one
// <record>.vcf per contact (vCard 3.0, which every client reads).
//
// Served from proxy.ts, because route handlers do not accept PROPFIND and
// REPORT. Writing (PUT, DELETE) answers 403: changes are made in Flowplan.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { isContactsDatabase, requireContactsDatabase } from "./contacts";
import { contactsAsVCards, readableContactRows } from "./contacts-io";
import { serializeVCard } from "./vcard";
import { translate } from "./i18n";
import { userLocale } from "./user-locale";
import type { Identity, Page, Row } from "./types";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const BASE = "/api/carddav";
const LINK_MS = 10 * 60_000;

/* ---------- Accesses ---------- */

function refuse(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
}
function newAccess(userId: string, pageId: string) {
  const password = randomBytes(18).toString("base64url");
  const access = id();
  run("INSERT INTO carddav_accesses(id,user_id,page_id,token_hash,created_at) VALUES(?,?,?,?,?)", access, userId, pageId, hash(password), Date.now());
  return { access, password };
}
// A new access (earlier ones of this person for this database end).
export function createCardDavAccess(user: Identity, pageId: string) {
  refuse(user);
  const page = requirePage(user, pageId);
  requireContactsDatabase(page.id);
  run("DELETE FROM carddav_accesses WHERE user_id=? AND page_id=?", user.id, page.id);
  const { access, password } = newAccess(user.id, page.id);
  return {
    server: `${appUrl()}${BASE}/`,
    addressBook: `${appUrl()}${BASE}/addressbooks/${access}/`,
    username: user.email || user.name,
    password,
  };
}
export function revokeCardDavAccess(user: Identity, pageId: string) {
  run("DELETE FROM carddav_accesses WHERE user_id=? AND page_id=?", user.id, pageId);
}
export function hasCardDavAccess(user: Identity, pageId: string) {
  return !!one("SELECT 1 FROM carddav_accesses WHERE user_id=? AND page_id=?", user.id, pageId);
}

/* ---------- iPhone, iPad and Mac: a configuration profile ---------- */

// A link that downloads the profile once, within ten minutes (Safari has no
// session); the access is only made when the profile is downloaded.
export function createCardDavProfileLink(user: Identity, pageId: string, now = Date.now()) {
  refuse(user);
  const page = requirePage(user, pageId);
  requireContactsDatabase(page.id);
  run("DELETE FROM carddav_profile_links WHERE expires<=?", now);
  const token = randomBytes(24).toString("base64url");
  run("INSERT INTO carddav_profile_links(token_hash,user_id,page_id,expires) VALUES(?,?,?,?)", hash(token), user.id, page.id, now + LINK_MS);
  return { url: `${appUrl()}/api/contacts?profile=${token}`, expires: now + LINK_MS };
}
const plist = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const entry = (key: string, value: string | number | boolean) =>
  `<key>${key}</key>${typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : typeof value === "number" ? `<integer>${value}</integer>` : `<string>${plist(value)}</string>`}`;
export function redeemCardDavProfileLink(token: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const link = one<{ token_hash: string; user_id: string; page_id: string; expires: number }>("SELECT * FROM carddav_profile_links WHERE token_hash=?", hash(token));
  if (!link || !run("DELETE FROM carddav_profile_links WHERE token_hash=?", link.token_hash).changes || link.expires <= now) return null;
  const account = one<Identity & { demo_until: number | null }>("SELECT * FROM users WHERE id=? AND disabled=0", link.user_id);
  if (!account || account.demo_until) return null;
  const user = { ...account, groups: [], isAdmin: false } as Identity;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", link.page_id);
  if (!page || !pageRole(user, page) || !isContactsDatabase(page.id)) return null;
  const say = translate(userLocale(user.id));
  const base = new URL(appUrl());
  const ssl = base.protocol === "https:";
  const { access, password } = newAccess(user.id, page.id);
  const name = page.title || say("Kontakte", "Contacts");
  const account_ = `<dict>${[
    entry("CardDAVAccountDescription", `Flowplan – ${name}`),
    entry("CardDAVHostName", base.hostname),
    entry("CardDAVPort", Number(base.port) || (ssl ? 443 : 80)),
    entry("CardDAVPrincipalURL", `${base.origin}${BASE}/principal/`),
    entry("CardDAVUseSSL", ssl),
    entry("CardDAVUsername", user.email || user.name),
    entry("CardDAVPassword", password),
    entry("PayloadDescription", say("Richtet ein Flowplan-Adressbuch mit CardDAV ein.", "Sets up a Flowplan address book with CardDAV.")),
    entry("PayloadDisplayName", name),
    entry("PayloadIdentifier", `org.flowplan.carddav.${base.hostname}.${access}`),
    entry("PayloadType", "com.apple.carddav.account"),
    entry("PayloadUUID", randomUUID().toUpperCase()),
    entry("PayloadVersion", 1),
  ].join("")}</dict>`;
  const body = [
    `<key>PayloadContent</key><array>${account_}</array>`,
    entry("PayloadDescription", say("Deine Flowplan-Kontakte in Apple Kontakte (nur lesen).", "Your Flowplan contacts in Apple Contacts (read-only).")),
    entry("PayloadDisplayName", say(`Flowplan-Kontakte (${name})`, `Flowplan contacts (${name})`)),
    entry("PayloadIdentifier", `org.flowplan.carddav.${base.hostname}.${hash(`${user.id}|${page.id}`).slice(0, 16)}`),
    entry("PayloadOrganization", "Flowplan"),
    entry("PayloadRemovalDisallowed", false),
    entry("PayloadType", "Configuration"),
    entry("PayloadUUID", randomUUID().toUpperCase()),
    entry("PayloadVersion", 1),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>
`;
}

/* ---------- Context of a request ---------- */

type Context = { access: string; user: Identity; page: Page };

function authenticate(request: Request): Context | null {
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  if (!password || password.length > 200) return null;
  const access = one<{ id: string; user_id: string; page_id: string }>("SELECT * FROM carddav_accesses WHERE token_hash=?", hash(password));
  if (!access) return null;
  const account = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0 AND demo_until IS NULL", access.user_id);
  if (!account) return null;
  const user = { ...account, groups: [], isAdmin: false } as Identity;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", access.page_id);
  // Access may have ended since: the page, the person's rights, the kind.
  if (!page || page.kind !== "database" || !pageRole(user, page) || !isContactsDatabase(page.id)) return null;
  return { access: access.id, user, page };
}
const contacts = (ctx: Context) => readableContactRows(ctx.user, ctx.page);
const etag = (r: Pick<Row, "id" | "version">) => `"${r.version}-${r.id.slice(0, 8)}"`;
const ctag = (rows: Row[]) => hash(`${rows.map((r) => etag(r)).join(",")}|${one<{ version: number }>("SELECT version FROM databases WHERE page_id=?", rows[0]?.page_id || "")?.version || 0}`).slice(0, 24);

/* ---------- WebDAV ---------- */

const NS = 'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';
const DAV_HEADER = "1, 3, addressbook";
const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${body}</d:multistatus>`, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8", DAV: DAV_HEADER },
  });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const response = (href: string, props: string) =>
  `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const principalProps = () =>
  `<d:current-user-principal><d:href>${BASE}/principal/</d:href></d:current-user-principal>` +
  `<card:addressbook-home-set><d:href>${BASE}/addressbooks/</d:href></card:addressbook-home-set>` +
  `<d:principal-URL><d:href>${BASE}/principal/</d:href></d:principal-URL>` +
  `<d:resourcetype><d:collection/><d:principal/></d:resourcetype>`;
function bookProps(ctx: Context, rows: Row[]) {
  return (
    `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>` +
    `<d:displayname>${esc(ctx.page.title || "Flowplan")}</d:displayname>` +
    `<card:supported-address-data><card:address-data-type content-type="text/vcard" version="3.0"/></card:supported-address-data>` +
    `<cs:getctag>${ctag(rows)}</cs:getctag><d:sync-token>${ctag(rows)}</d:sync-token>` +
    `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>` +
    `<d:owner><d:href>${BASE}/principal/</d:href></d:owner>`
  );
}
function hrefsOf(body: string) {
  return [...body.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map((m) => {
    try {
      return decodeURIComponent(m[1].trim());
    } catch {
      return m[1].trim();
    }
  });
}
const card = (ctx: Context, row: Row) => serializeVCard(contactsAsVCards(ctx.user, ctx.page, [row])[0], "3.0");

export async function handleCardDav(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/.well-known/carddav")) return Response.redirect(`${url.origin}${BASE}/`, 301);
  const allow = "OPTIONS, GET, HEAD, PROPFIND, REPORT";
  if (request.method === "OPTIONS") return new Response(null, { headers: { Allow: allow, DAV: DAV_HEADER } });
  const ctx = authenticate(request);
  if (!ctx)
    return new Response("Anmeldung erforderlich", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Flowplan CardDAV", charset="UTF-8"', DAV: DAV_HEADER },
    });
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean);
  const body = ["PROPFIND", "REPORT"].includes(request.method) ? (await request.text()).slice(0, 1_000_000) : "";
  const depth = request.headers.get("depth") || "0";
  const home = `${BASE}/addressbooks/`;
  const collection = `${home}${ctx.access}/`;
  try {
    if (request.method === "PROPFIND" && (parts.length === 0 || parts[0] === "principal"))
      return xml(response(parts.length ? `${BASE}/principal/` : `${BASE}/`, principalProps()));
    if (request.method === "PROPFIND" && parts[0] === "addressbooks" && parts.length === 1) {
      let out = response(home, `<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>${BASE}/principal/</d:href></d:current-user-principal>`);
      if (depth !== "0") out += response(collection, bookProps(ctx, contacts(ctx)));
      return xml(out);
    }
    if (parts[0] !== "addressbooks" || parts[1] !== ctx.access || parts.length > 3) return new Response("Nicht gefunden", { status: 404 });
    const rowId = parts[2]?.replace(/\.vcf$/, "");
    if (!rowId) {
      if (request.method === "PROPFIND") {
        const rows = contacts(ctx);
        let out = response(collection, bookProps(ctx, rows));
        if (depth !== "0")
          for (const r of rows) out += response(`${collection}${r.id}.vcf`, `<d:getetag>${esc(etag(r))}</d:getetag><d:getcontenttype>text/vcard; charset=utf-8</d:getcontenttype><d:resourcetype/>`);
        return xml(out);
      }
      if (request.method === "REPORT") {
        const rows = contacts(ctx);
        const wanted = /addressbook-multiget/.test(body) ? new Set(hrefsOf(body).map((h) => h.split("/").pop()!.replace(/\.vcf$/, ""))) : null;
        const withData = /address-data/.test(body) || !!wanted;
        const chosen = rows.filter((r) => !wanted || wanted.has(r.id));
        // All cards at once (one read of the notes and photos).
        const cards = withData ? contactsAsVCards(ctx.user, ctx.page, chosen).map((c) => serializeVCard(c, "3.0")) : [];
        return xml(
          chosen
            .map((r, i) => response(`${collection}${r.id}.vcf`, `<d:getetag>${esc(etag(r))}</d:getetag>${withData ? `<card:address-data>${esc(cards[i])}</card:address-data>` : ""}`))
            .join(""),
        );
      }
      if (request.method === "GET" || request.method === "HEAD")
        return new Response(request.method === "HEAD" ? null : `Flowplan: ${ctx.page.title}`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (["PUT", "DELETE", "MKCOL", "PROPPATCH", "MOVE", "COPY"].includes(request.method)) return new Response("Nur lesen", { status: 403, headers: { DAV: DAV_HEADER } });
      return new Response(null, { status: 405, headers: { Allow: allow } });
    }
    const row = contacts(ctx).find((r) => r.id === rowId);
    if (request.method === "GET" || request.method === "HEAD" || request.method === "PROPFIND") {
      if (!row) return new Response("Nicht gefunden", { status: 404 });
      if (request.method === "PROPFIND") return xml(response(`${collection}${row.id}.vcf`, `<d:getetag>${esc(etag(row))}</d:getetag><d:getcontenttype>text/vcard; charset=utf-8</d:getcontenttype>`));
      return new Response(request.method === "HEAD" ? null : card(ctx, row), { headers: { "Content-Type": "text/vcard; charset=utf-8", ETag: etag(row) } });
    }
    // Read-only address book: changes are made in Flowplan.
    if (["PUT", "DELETE", "PROPPATCH", "MOVE", "COPY"].includes(request.method)) return new Response("Nur lesen", { status: 403, headers: { DAV: DAV_HEADER } });
    return new Response(null, { status: 405, headers: { Allow: allow } });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("CardDAV", e);
    return new Response(e instanceof HttpError ? e.message : "Fehler", { status });
  }
}
