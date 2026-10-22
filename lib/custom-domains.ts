// Custom domains for publications: an owner gives a published page its own
// host name (docs.example.org), proves control over it with a DNS TXT record
// (_flowplan-verify.<host>) or a file the domain serves
// (/.well-known/flowplan-verify.txt), and the proxy (proxy.ts,
// lib/custom-domain-routing.ts) then serves that publication – and nothing
// else – under the host. TLS stays with the reverse proxy; Caddy asks
// GET /api/domains/allowed?domain= before it requests a certificate.
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { all, audit, one, run } from "./db";
import { HttpError, appUrl } from "./auth";
import { requirePage } from "./permissions";
import { instanceSettings } from "./instance-settings";
import { txtRecords } from "./dns-txt";
import { safeFetch } from "./safe-fetch";
import { publicFile, publicTree } from "./publication";
import { VERIFY_PATH, type HostState } from "./custom-domain-routing";
import type { Identity } from "./types";

export const VERIFY_PREFIX = "_flowplan-verify";
const uuid = z.uuid();

export function appHost() {
  try {
    return new URL(appUrl()).hostname.toLowerCase();
  } catch {
    return "localhost";
  }
}
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// A host name as typed (with or without https:// and path) in its stored
// form, or an error: no IP addresses, no ports, no local names, not the
// instance's own host.
export function normalizeHost(raw: unknown) {
  let text = z.string().trim().min(1).max(300).parse(raw).toLowerCase();
  if (text.includes("://")) {
    try {
      text = new URL(text).hostname;
    } catch {
      throw new HttpError(400, "Ungültiger Domainname.");
    }
  }
  text = text.replace(/\.$/, "");
  const labels = text.split(".");
  if (
    text.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => LABEL.test(label)) ||
    /^\d+$/.test(labels[labels.length - 1]) ||
    ["localhost", "local", "internal", "test", "invalid", "example"].includes(labels[labels.length - 1])
  )
    throw new HttpError(400, "Ungültiger Domainname.");
  if (text === appHost()) throw new HttpError(400, "Diese Domain gehört zur Instanz selbst.");
  return text;
}

type DomainRow = {
  host: string;
  page_id: string;
  token: string;
  verified_at: number | null;
  checked_at: number | null;
  last_error: string | null;
};
function requireEnabled() {
  if (!instanceSettings().customDomains)
    throw new HttpError(403, "Eigene Domains sind auf dieser Instanz nicht freigeschaltet.");
}
// A publication that can be shown under a domain: published, no password.
function requirePublished(pageId: string) {
  const row = one<{ public_token: string | null; published: number; password: number }>(
    "SELECT p.public_token,pub.page_id IS NOT NULL published,pub.password_hash IS NOT NULL password FROM pages p LEFT JOIN publications pub ON pub.page_id=p.id WHERE p.id=? AND p.deleted_at IS NULL",
    pageId,
  );
  if (!row?.public_token || !row.published) throw new HttpError(400, "Diese Seite ist nicht veröffentlicht.");
  if (row.password)
    throw new HttpError(400, "Veröffentlichungen mit Passwort lassen sich nicht unter einer eigenen Domain zeigen.");
  return row.public_token;
}

// ---- Look ----

const imageRef = z
  .string()
  .trim()
  .max(500)
  .regex(/^(https:\/\/[^\s"'<>()\\]+|\/api\/files\/[0-9a-f-]{36})$/i, "Bild als HTTPS-Adresse oder hochgeladene Datei angeben.");
export const publicationThemeSchema = z.object({
  logo: imageRef.or(z.literal("")).optional(),
  favicon: imageRef.or(z.literal("")).optional(),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i, "Farbe als #rrggbb angeben.").or(z.literal("")).optional(),
  footer: z.string().trim().max(300).optional(),
  hideBranding: z.boolean().optional(),
});
export type PublicationTheme = z.infer<typeof publicationThemeSchema>;
export function publicationTheme(pageId: string): PublicationTheme {
  const row = one<{ theme: string }>("SELECT theme FROM publication_themes WHERE page_id=?", pageId);
  if (!row) return {};
  try {
    const parsed = publicationThemeSchema.safeParse(JSON.parse(row.theme));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
export function savePublicationTheme(user: Identity, input: Record<string, unknown>) {
  const page = requirePage(user, uuid.parse(input.pageId), true);
  requirePublished(page.id);
  const theme = publicationThemeSchema.parse(input.theme ?? {});
  run(
    "INSERT INTO publication_themes(page_id,theme,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET theme=excluded.theme,updated_at=excluded.updated_at",
    page.id,
    JSON.stringify(theme),
    Date.now(),
  );
  audit(user.id, "publication.theme", page.id);
  return domainSettings(user, page.id);
}

// The look as a published page uses it: uploaded images through the
// publication's own file address (only when the publication serves them).
export function renderedTheme(token: string, pageId: string) {
  const theme = publicationTheme(pageId);
  const image = (value: string | undefined) => {
    if (!value) return undefined;
    const file = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(value);
    if (!file) return value;
    try {
      publicFile(token, file[1]);
      return `/api/share/${token}/files/${file[1]}`;
    } catch {
      return undefined;
    }
  };
  return {
    logo: image(theme.logo),
    favicon: image(theme.favicon),
    accent: theme.accent || undefined,
    footer: theme.footer || "",
    hideBranding: !!theme.hideBranding,
  };
}

// ---- Domains ----

export function domainSettings(user: Identity, pageId: string) {
  const page = requirePage(user, uuid.parse(pageId));
  const row = one<DomainRow>("SELECT * FROM custom_domains WHERE page_id=?", page.id);
  return {
    enabled: instanceSettings().customDomains,
    appHost: appHost(),
    domain: row
      ? {
          host: row.host,
          verified: !!row.verified_at,
          verifiedAt: row.verified_at,
          checkedAt: row.checked_at,
          lastError: row.last_error,
          record: { type: "TXT", name: `${VERIFY_PREFIX}.${row.host}`, value: row.token },
          file: { url: `https://${row.host}${VERIFY_PATH}`, content: row.token },
        }
      : null,
    theme: publicationTheme(page.id),
  };
}
export function addDomain(user: Identity, input: Record<string, unknown>) {
  requireEnabled();
  const page = requirePage(user, uuid.parse(input.pageId), true);
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  requirePublished(page.id);
  const host = normalizeHost(input.host);
  const taken = one<{ page_id: string }>("SELECT page_id FROM custom_domains WHERE host=?", host);
  if (taken && taken.page_id !== page.id) throw new HttpError(409, "Diese Domain wird bereits verwendet.");
  const current = one<DomainRow>("SELECT * FROM custom_domains WHERE page_id=?", page.id);
  if (current?.host !== host) {
    run("DELETE FROM custom_domains WHERE page_id=?", page.id);
    run(
      "INSERT INTO custom_domains(host,page_id,token,created_by,created_at) VALUES(?,?,?,?,?)",
      host,
      page.id,
      `flowplan-verify-${randomBytes(16).toString("hex")}`,
      user.id,
      Date.now(),
    );
    audit(user.id, "domain.add", page.id, host);
  }
  return domainSettings(user, page.id);
}
export function removeDomain(user: Identity, input: Record<string, unknown>) {
  const page = requirePage(user, uuid.parse(input.pageId), true);
  const row = one<DomainRow>("SELECT * FROM custom_domains WHERE page_id=?", page.id);
  if (row) {
    run("DELETE FROM custom_domains WHERE page_id=?", page.id);
    audit(user.id, "domain.remove", page.id, row.host);
  }
  return domainSettings(user, page.id);
}

type HttpCheck = (url: string) => Promise<{ status: number; body: string }>;
const defaultHttpCheck: HttpCheck = (url) => safeFetch(url, { maxBytes: 2000, timeout: 5000, accept: "text/plain" });
let httpCheck: HttpCheck = defaultHttpCheck;
// Tests replace the network.
export function setDomainHttpCheck(next: HttpCheck | null) {
  httpCheck = next || defaultHttpCheck;
}
// Checks the TXT record, then the verification file. A domain once verified
// stays verified until it is removed; failed checks only note the reason.
export async function verifyDomain(user: Identity, input: Record<string, unknown>) {
  requireEnabled();
  const pageId = uuid.parse(input.pageId);
  requirePage(user, pageId, true);
  const row = one<DomainRow>("SELECT * FROM custom_domains WHERE page_id=?", pageId);
  if (!row) throw new HttpError(404, "Für diese Veröffentlichung ist keine Domain eingetragen.");
  let method: "dns" | "http" | null = null;
  let reason = "";
  try {
    if ((await txtRecords(`${VERIFY_PREFIX}.${row.host}`)).some((value) => value.trim() === row.token)) method = "dns";
  } catch (error) {
    reason = `DNS: ${(error as Error).message}`;
  }
  if (!method) {
    try {
      const response = await httpCheck(`https://${row.host}${VERIFY_PATH}`);
      if (response.status === 200 && response.body.trim() === row.token) method = "http";
    } catch {}
  }
  // Rights and the row may have changed while the checks ran.
  requirePage(user, pageId, true);
  const still = one<DomainRow>("SELECT * FROM custom_domains WHERE page_id=? AND host=?", pageId, row.host);
  if (!still) throw new HttpError(404, "Für diese Veröffentlichung ist keine Domain eingetragen.");
  const now = Date.now();
  if (method) {
    run("UPDATE custom_domains SET verified_at=COALESCE(verified_at,?),checked_at=?,last_error=NULL WHERE host=?", now, now, row.host);
    audit(user.id, "domain.verify", pageId, `${row.host} ${method}`);
  } else
    run(
      "UPDATE custom_domains SET checked_at=?,last_error=? WHERE host=?",
      now,
      (reason || "Weder TXT-Eintrag noch Prüfdatei gefunden.").slice(0, 300),
      row.host,
    );
  return { ...domainSettings(user, pageId), method };
}

// ---- Serving ----

// What the proxy does with a request for `host` (lib/custom-domain-routing.ts).
export function hostState(rawHost: string): HostState {
  const host = rawHost.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || host === appHost() || !instanceSettings().customDomains) return { status: "none" };
  const row = one<DomainRow & { public_token: string | null; deleted_at: string | null; published: number | null; password: number | null }>(
    "SELECT d.*,p.public_token,p.deleted_at,pub.page_id IS NOT NULL published,pub.password_hash IS NOT NULL password FROM custom_domains d JOIN pages p ON p.id=d.page_id LEFT JOIN publications pub ON pub.page_id=d.page_id WHERE d.host=?",
    host,
  );
  if (!row) return { status: "none" };
  if (!row.verified_at) return { status: "pending", verifyToken: row.token };
  if (!row.public_token || row.deleted_at || !row.published || row.password) return { status: "gone", verifyToken: row.token };
  return { status: "verified", verifyToken: row.token, token: row.public_token };
}
// Caddy's on-demand TLS asks before it requests a certificate.
export function domainAllowed(rawHost: unknown) {
  try {
    return hostState(normalizeHost(rawHost)).status === "verified";
  } catch {
    return false;
  }
}
// The verified domain of a publication (canonical addresses).
export function publicationHost(pageId: string) {
  if (!instanceSettings().customDomains) return null;
  return one<{ host: string }>("SELECT host FROM custom_domains WHERE page_id=? AND verified_at IS NOT NULL", pageId)?.host || null;
}
// The host a request came in on, when it is the verified domain of the
// publication behind `token`.
export function customHostFor(rawHost: string | null | undefined, token: string) {
  if (!rawHost) return null;
  const state = hostState(rawHost);
  return state.status === "verified" && state.token === token ? rawHost.toLowerCase().replace(/:\d+$/, "") : null;
}

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function domainSitemap(rawHost: string) {
  const state = hostState(rawHost);
  if (state.status !== "verified") return null;
  const host = rawHost.toLowerCase().replace(/:\d+$/, "");
  const { root, pages } = publicTree(state.token);
  const urls = pages.map((page) => {
    const loc = `https://${host}/${page.id === root.id ? "" : page.id}`;
    const lastmod = page.updated_at ? `<lastmod>${xml(new Date(page.updated_at.replace(" ", "T") + "Z").toISOString().slice(0, 10))}</lastmod>` : "";
    return `<url><loc>${xml(loc)}</loc>${lastmod}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
export function domainRobots(rawHost: string) {
  const state = hostState(rawHost);
  if (state.status !== "verified") return null;
  const host = rawHost.toLowerCase().replace(/:\d+$/, "");
  return `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://${host}/sitemap.xml\n`;
}
// Every verified domain (admin overview).
export function verifiedDomains() {
  return all<{ host: string; page_id: string }>("SELECT host,page_id FROM custom_domains WHERE verified_at IS NOT NULL ORDER BY host");
}
