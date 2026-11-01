// Link-like database properties (url, email, phone) shown as links that open
// (issue #67). Only http(s), mailto and tel are followed; anything else –
// javascript:, data:, relative paths, half-typed addresses – stays plain text.

export type LinkFieldType = "url" | "email" | "phone";
export const LINK_FIELD_TYPES: readonly string[] = ["url", "email", "phone"];
export const isLinkField = (type: string): type is LinkFieldType => LINK_FIELD_TYPES.includes(type);

const EMAIL = /^[^@\s/?#<>"'`\\:]+@[^@\s/?#<>"'`\\:]+\.[^@\s/?#<>"'`\\:.]+$/;

// An http(s) address with a host and without credentials, normalized; or null.
export function webHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2000 || /[\s<>"'`\\]/.test(value)) return null;
  if (/^mailto:/i.test(value)) return mailHref(value.slice(7));
  if (!/^https?:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password)
    return null;
  return url.href;
}
// mailto: for one plain address (no headers, no second recipient).
export function mailHref(raw: string): string | null {
  const value = raw.trim();
  return value.length <= 320 && EMAIL.test(value) ? `mailto:${value}` : null;
}
// tel: for a number with at least three digits; only digits and a leading +.
export function telHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 64 || !/^\+?[\d\s()./-]+$/.test(value)) return null;
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 3) return null;
  return `tel:${value.startsWith("+") ? "+" : ""}${digits}`;
}
// Where a cell of this type links to, or null to show it as plain text.
export function cellHref(type: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (type === "url") return webHref(value);
  if (type === "email") return mailHref(value.replace(/^mailto:/i, ""));
  if (type === "phone") return telHref(value);
  return null;
}
// The shortened text of a link: host (without "www.") and path, without a
// trailing slash, cut with "…" after `max` characters; addresses and numbers
// as they are.
export function linkLabel(href: string, max = 40): string {
  let label = href;
  if (/^mailto:/i.test(href)) label = href.slice(7);
  else if (/^tel:/i.test(href)) label = href.slice(4);
  else {
    try {
      const url = new URL(href);
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      label = url.hostname.replace(/^www\./i, "") + (url.port ? `:${url.port}` : "") + safeDecode(path) + (url.search || url.hash ? "…" : "");
    } catch {}
  }
  return label.length > max ? `${label.slice(0, Math.max(1, max - 1))}…` : label;
}
function safeDecode(path: string) {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
