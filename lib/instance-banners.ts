// Banners people click away once (Administration → Maintenance & notices):
// unlike the lasting notice for everyone, each person sees a banner until
// they close it or follow its link – then never again, on no device. For
// news like the apps or a community: text, an optional link, a colour, who
// sees it (everyone or administrators), where (everywhere or only in the
// browser, not in the apps) and optionally from when until when. Banners
// that went out can be paused, shown again to everyone or deleted; the
// administration sees how many closed and how many followed the link.
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { adminUserIds, HttpError } from "./auth";
import type { Identity } from "./types";

export const BANNER_TONES = ["info", "promo", "success", "warning"] as const;
export const BANNER_AUDIENCES = ["all", "admins"] as const;
// "browser": not in the Flowplan apps (desktop, iPhone, Android) – e.g. a
// banner that advertises the apps themselves.
export const BANNER_SURFACES = ["everywhere", "browser"] as const;
export const MAX_BANNERS = 50;

export type Banner = {
  id: string;
  title: string;
  message: string;
  linkUrl: string | null;
  linkLabel: string | null;
  tone: (typeof BANNER_TONES)[number];
  audience: (typeof BANNER_AUDIENCES)[number];
  surface: (typeof BANNER_SURFACES)[number];
  startsAt: number | null;
  endsAt: number | null;
};
export type AdminBanner = Banner & {
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  closed: number;
  clicked: number;
  // People who would see it (signed-in accounts of its audience).
  reach: number;
  state: "active" | "planned" | "ended" | "paused";
};

type BannerRow = {
  id: string;
  title: string;
  message: string;
  link_url: string | null;
  link_label: string | null;
  tone: string;
  audience: string;
  surface: string;
  starts_at: number | null;
  ends_at: number | null;
  paused: number;
  created_at: number;
  updated_at: number;
};

// Links: https addresses, or a place in this instance ("/…", "#…").
export function safeBannerLink(value: string) {
  const link = value.trim();
  if (!link) return null;
  if (/^#[^\s]*$/.test(link) || /^\/(?!\/)[^\s]*$/.test(link)) return link;
  try {
    const url = new URL(link);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return url.toString();
  } catch {}
  return undefined;
}

const input = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().max(80).default(""),
  message: z.string().trim().min(1).max(300),
  linkUrl: z.string().trim().max(500).default(""),
  linkLabel: z.string().trim().max(40).default(""),
  tone: z.enum(BANNER_TONES).default("info"),
  audience: z.enum(BANNER_AUDIENCES).default("all"),
  surface: z.enum(BANNER_SURFACES).default("everywhere"),
  startsAt: z.number().int().positive().nullable().default(null),
  endsAt: z.number().int().positive().nullable().default(null),
  paused: z.boolean().default(false),
});

const toBanner = (r: BannerRow): Banner => ({
  id: r.id,
  title: r.title,
  message: r.message,
  linkUrl: r.link_url,
  linkLabel: r.link_label,
  tone: (BANNER_TONES as readonly string[]).includes(r.tone) ? (r.tone as Banner["tone"]) : "info",
  audience: r.audience === "admins" ? "admins" : "all",
  surface: r.surface === "browser" ? "browser" : "everywhere",
  startsAt: r.starts_at,
  endsAt: r.ends_at,
});

const requireAdmin = (user: Identity) => {
  if (!user.isAdmin || user.apiScope) throw new HttpError(403, "Nur für Administratoren.");
};

function stateOf(r: BannerRow, now: number): AdminBanner["state"] {
  if (r.ends_at && r.ends_at <= now) return "ended";
  if (r.paused) return "paused";
  if (r.starts_at && r.starts_at > now) return "planned";
  return "active";
}

export function listBanners(user: Identity, now = Date.now()): AdminBanner[] {
  requireAdmin(user);
  const people = one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE disabled=0")?.n ?? 0;
  const rows = all<BannerRow & { closed: number; clicked: number }>(
    `SELECT b.*,COUNT(s.user_id) closed,COALESCE(SUM(s.clicked),0) clicked FROM instance_banners b
     LEFT JOIN instance_banner_seen s ON s.banner_id=b.id GROUP BY b.id ORDER BY b.created_at DESC`,
  );
  const admins = rows.some((r) => r.audience === "admins") ? adminCount() : 0;
  return rows.map((r) => ({
    ...toBanner(r),
    paused: !!r.paused,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closed: Number(r.closed) || 0,
    clicked: Number(r.clicked) || 0,
    reach: r.audience === "admins" ? admins : people,
    state: stateOf(r, now),
  }));
}
const adminCount = () => adminUserIds().length;

export function saveBanner(user: Identity, body: unknown, now = Date.now()) {
  requireAdmin(user);
  const b = input.parse(body);
  const link = safeBannerLink(b.linkUrl);
  if (link === undefined) throw new HttpError(400, "Der Link muss mit https:// beginnen oder auf eine Seite dieser Instanz zeigen.");
  if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) throw new HttpError(400, "Das Ende muss nach dem Beginn liegen.");
  if (b.endsAt && b.endsAt <= now && !b.id) throw new HttpError(400, "Das Ende liegt in der Vergangenheit.");
  const values = [b.title, b.message, link, link ? b.linkLabel || null : null, b.tone, b.audience, b.surface, b.startsAt, b.endsAt, b.paused ? 1 : 0, now] as const;
  if (b.id) {
    if (!one("SELECT 1 FROM instance_banners WHERE id=?", b.id)) throw new HttpError(404, "Banner nicht gefunden.");
    run(
      "UPDATE instance_banners SET title=?,message=?,link_url=?,link_label=?,tone=?,audience=?,surface=?,starts_at=?,ends_at=?,paused=?,updated_at=? WHERE id=?",
      ...values,
      b.id,
    );
    audit(user.id, "admin.banner.update", b.id, b.message.slice(0, 80));
    return b.id;
  }
  if ((one<{ n: number }>("SELECT COUNT(*) n FROM instance_banners")?.n ?? 0) >= MAX_BANNERS)
    throw new HttpError(400, `Höchstens ${MAX_BANNERS} Banner – lösche zuerst alte.`);
  const bannerId = id();
  run(
    "INSERT INTO instance_banners(title,message,link_url,link_label,tone,audience,surface,starts_at,ends_at,paused,updated_at,id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ...values,
    bannerId,
    user.id,
    now,
  );
  audit(user.id, "admin.banner.create", bannerId, b.message.slice(0, 80));
  return bannerId;
}

export function deleteBanner(user: Identity, bannerId: string) {
  requireAdmin(user);
  run("DELETE FROM instance_banners WHERE id=?", bannerId);
  audit(user.id, "admin.banner.delete", bannerId, "");
}
// Everyone sees it again, also those who closed it.
export function showBannerAgain(user: Identity, bannerId: string) {
  requireAdmin(user);
  run("DELETE FROM instance_banner_seen WHERE banner_id=?", bannerId);
  audit(user.id, "admin.banner.reset", bannerId, "");
}

// The banners for this person right now, newest first, at most three.
export function bannersFor(user: Identity, now = Date.now()): Banner[] {
  if (user.apiScope || user.demo) return [];
  return all<BannerRow>(
    `SELECT b.* FROM instance_banners b
     WHERE b.paused=0 AND (b.starts_at IS NULL OR b.starts_at<=?) AND (b.ends_at IS NULL OR b.ends_at>?)
       AND (b.audience='all' OR ?=1)
       AND NOT EXISTS (SELECT 1 FROM instance_banner_seen s WHERE s.banner_id=b.id AND s.user_id=?)
     ORDER BY b.created_at DESC LIMIT 3`,
    now,
    now,
    user.isAdmin ? 1 : 0,
    user.id,
  ).map(toBanner);
}

// Closed, or its link followed: gone for this person.
export function dismissBanner(user: Identity, bannerId: string, clicked: boolean, now = Date.now()) {
  if (user.apiScope) throw new HttpError(403, "Nicht mit einem API-Token.");
  if (!one("SELECT 1 FROM instance_banners WHERE id=?", bannerId)) return { ok: false };
  run(
    "INSERT INTO instance_banner_seen(banner_id,user_id,dismissed_at,clicked) VALUES(?,?,?,?) ON CONFLICT(banner_id,user_id) DO UPDATE SET clicked=MAX(clicked,excluded.clicked)",
    bannerId,
    user.id,
    now,
    clicked ? 1 : 0,
  );
  return { ok: true };
}
