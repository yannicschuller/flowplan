// CalDAV in one tap on iPhone, iPad and Mac: a configuration profile
// (.mobileconfig) with one CalDAV account per chosen calendar view
// (lib/caldav.ts). The account settings create a link that works once and
// for ten minutes; opening it in Safari (the app hands it over, a computer
// shows it as QR code) downloads the profile, and the system installs it
// under Settings → "Profile downloaded".
//
// The accesses are only made when the profile is downloaded, so a link
// nobody opens leaves nothing behind. Each profile gets accesses of its
// own: an existing account on another device keeps working; "End access"
// (or a new password) in the calendar's subscribe dialog ends all of them. The passwords exist
// only inside the profile – the database keeps their hashes, the link only
// the hash of its own token.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { all, id, one, run, db } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { translate } from "./i18n";
import { userLocale } from "./user-locale";
import type { Identity, Page, View } from "./types";

const LINK_MS = 10 * 60_000;
const MAX_CALENDARS = 20;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

const prepared = new WeakSet<object>();
function ensureTable() {
  const d = db();
  if (prepared.has(d)) return;
  d.exec(
    "CREATE TABLE IF NOT EXISTS caldav_profile_links(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,calendars TEXT NOT NULL,expires INTEGER NOT NULL)",
  );
  prepared.add(d);
}

const calendarViews = (pageId: string) =>
  (JSON.parse(one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", pageId)?.views || "[]") as View[]).filter((v) => v.type === "calendar");

function refuse(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
}

// The calendar views of all the person's workspaces, for the settings.
export function profileCalendars(user: Identity) {
  refuse(user);
  const pages = all<Page & { workspace_name: string }>(
    `SELECT p.*,w.name workspace_name FROM pages p JOIN members m ON m.workspace_id=p.workspace_id AND m.user_id=?
       JOIN workspaces w ON w.id=p.workspace_id
     WHERE p.kind='database' AND p.deleted_at IS NULL ORDER BY w.name COLLATE NOCASE,p.title COLLATE NOCASE LIMIT 2000`,
    user.id,
  );
  const syncing = new Set(
    all<{ page_id: string; view_id: string }>("SELECT page_id,view_id FROM caldav_accesses WHERE user_id=?", user.id).map((a) => `${a.page_id}|${a.view_id}`),
  );
  return pages
    .filter((page) => pageRole(user, page))
    .flatMap((page) =>
      calendarViews(page.id).map((view) => ({
        pageId: page.id,
        viewId: view.id,
        page: page.title || "",
        view: view.name || "",
        workspace: page.workspace_name || "",
        syncing: syncing.has(`${page.id}|${view.id}`),
      })),
    )
    .slice(0, 200);
}

const selection = z
  .array(z.object({ pageId: z.uuid(), viewId: z.string().min(1).max(100) }))
  .min(1)
  .max(MAX_CALENDARS);

// A link that downloads the profile once, within ten minutes.
export function createProfileLink(user: Identity, input: unknown, now = Date.now()) {
  refuse(user);
  const calendars = selection.parse((input as { calendars?: unknown } | null)?.calendars);
  for (const calendar of calendars) {
    const page = requirePage(user, calendar.pageId);
    if (!calendarViews(page.id).some((v) => v.id === calendar.viewId)) throw new HttpError(404, "Kalenderansicht nicht gefunden.");
  }
  ensureTable();
  run("DELETE FROM caldav_profile_links WHERE expires<=?", now);
  const token = randomBytes(24).toString("base64url");
  run("INSERT INTO caldav_profile_links(token_hash,user_id,calendars,expires) VALUES(?,?,?,?)", hash(token), user.id, JSON.stringify(calendars), now + LINK_MS);
  return { url: `${appUrl()}/api/calendar-profile?token=${token}`, expires: now + LINK_MS };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const entry = (key: string, value: string | number | boolean) =>
  `<key>${key}</key>${typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : typeof value === "number" ? `<integer>${value}</integer>` : `<string>${xml(value)}</string>`}`;

// The profile behind a link (null: unknown, used or expired). The link is
// used up by this call.
export function redeemProfileLink(token: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  ensureTable();
  const link = one<{ token_hash: string; user_id: string; calendars: string; expires: number }>("SELECT * FROM caldav_profile_links WHERE token_hash=?", hash(token));
  if (!link || !run("DELETE FROM caldav_profile_links WHERE token_hash=?", link.token_hash).changes || link.expires <= now) return null;
  const account = one<Identity & { demo_until: string | null }>("SELECT * FROM users WHERE id=? AND disabled=0", link.user_id);
  if (!account || account.demo_until) return null;
  const user = { ...account, groups: [], isAdmin: false } as Identity;
  const say = translate(userLocale(user.id));
  const base = new URL(appUrl());
  const ssl = base.protocol === "https:";
  const port = Number(base.port) || (ssl ? 443 : 80);
  const accounts: string[] = [];
  for (const calendar of selection.parse(JSON.parse(link.calendars))) {
    // Access may have ended since the link was made.
    const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", calendar.pageId);
    const view = page && pageRole(user, page) ? calendarViews(page.id).find((v) => v.id === calendar.viewId) : undefined;
    if (!page || !view) continue;
    const password = randomBytes(18).toString("base64url");
    const access = id();
    run(
      "INSERT INTO caldav_accesses(id,user_id,page_id,view_id,token_hash,created_at) VALUES(?,?,?,?,?,?)",
      access,
      user.id,
      page.id,
      view.id,
      hash(password),
      now,
    );
    const name = `${page.title || say("Ohne Titel", "Untitled")} · ${view.name || say("Kalender", "Calendar")}`;
    accounts.push(
      `<dict>${[
        entry("CalDAVAccountDescription", `Flowplan – ${name}`),
        entry("CalDAVHostName", base.hostname),
        entry("CalDAVPort", port),
        entry("CalDAVPrincipalURL", `${base.origin}/api/caldav/principal/`),
        entry("CalDAVUseSSL", ssl),
        entry("CalDAVUsername", user.email || user.name),
        entry("CalDAVPassword", password),
        entry("PayloadDescription", say("Richtet einen Flowplan-Kalender mit CalDAV ein.", "Sets up a Flowplan calendar with CalDAV.")),
        entry("PayloadDisplayName", name),
        entry("PayloadIdentifier", `org.flowplan.caldav.${base.hostname}.${access}`),
        entry("PayloadType", "com.apple.caldav.account"),
        entry("PayloadUUID", randomUUID().toUpperCase()),
        entry("PayloadVersion", 1),
      ].join("")}</dict>`,
    );
  }
  if (!accounts.length) return null;
  const body = [
    `<key>PayloadContent</key><array>${accounts.join("")}</array>`,
    entry("PayloadDescription", say("Deine Flowplan-Kalender in Apple Kalender – Änderungen dort landen in Flowplan.", "Your Flowplan calendars in Apple Calendar – changes there land in Flowplan.")),
    entry("PayloadDisplayName", say(`Flowplan-Kalender (${base.hostname})`, `Flowplan calendars (${base.hostname})`)),
    // The same per person and instance: installing again replaces the
    // previous profile on that device.
    entry("PayloadIdentifier", `org.flowplan.caldav.${base.hostname}.${hash(user.id).slice(0, 16)}`),
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
