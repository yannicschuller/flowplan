// E-mail inbound capture ("mail to inbox"): workspace owners create an
// address that turns incoming mail into pages (below a target page) or
// records (in a target database), attachments included. Mail arrives two
// ways:
//   - HTTP: a mail provider (Mailgun, Postmark, SendGrid Inbound Parse, a
//     Cloudflare Email Worker or anything posting the generic format) posts
//     to /api/inbound-mail/<token>; the token in the path authenticates, an
//     optional signing key adds an HMAC check.
//   - IMAP: with INBOUND_IMAP_* set, a worker polls one mailbox every two
//     minutes and routes mail sent to inbox+<token>@INBOUND_MAIL_DOMAIN.
// Only senders on the address's allow-list get in; others are logged in the
// audit trail and dropped. Each address takes at most 60 mails per hour,
// attachments count against the workspace quota and a daily budget per
// address, and a Message-ID is stored once.
import { pageCreatedEvent } from "./workflows/hooks";
import { emitWorkflowEvent } from "./workflows/events";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sanitize from "sanitize-html";
import { z } from "zod";
import { all, audit, id, lockFor, one, onTransactionRollback, run, transaction, nowText } from "./db";
import { appUrl, hash, HttpError } from "./auth";
import { pageRole } from "./permissions";
import { createPage } from "./seed";
import { cleanHtml, htmlState } from "./document-server";
import { replaceRowDocument } from "./row-documents";
import { rowCreated } from "./automations";
import { emitWebhook } from "./webhooks";
import { enforceQuota } from "./instance-ops";
import { takeAnonymousBudget } from "./anonymous-budget";
import { sanitizeFileName, stripLocation, verifiedMime } from "./upload-safety";
import { openSecret, sealSecret } from "./secret-box";
import { claimOnce } from "./replay-guard";
import { ct } from "./content-locale";
import { addresses, parseHeaders, parseMime, parseDate, type MimeAttachment } from "./mime-parse";
import { ImapClient, type ImapOptions } from "./imap";
import type { Field, Identity, Page } from "./types";
import { mapAsync } from "./each-async";
import { mailVerdict, sendgridVerdict, type MailVerdict } from "./mail-auth";
import { isLeader } from "./cluster/leader";

export const INBOUND_MAILS_PER_HOUR = 60;
export const INBOUND_FILE_BYTES = 10 * 1024 * 1024;
export const INBOUND_TOTAL_BYTES = 25 * 1024 * 1024;
export const INBOUND_MAX_ATTACHMENTS = 20;
// The request as a whole: attachments plus base64 and form overhead.
export const INBOUND_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_ADDRESSES = 50;
const MAX_SENDERS = 100;
const HOUR = 3_600_000;

export type InboundMail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
  date: Date | null;
  attachments: MimeAttachment[];
  // The sender check of the receiving server or provider (lib/mail-auth.ts).
  auth?: MailVerdict;
};
type AddressRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  label: string;
  token: string;
  secret: string;
  senders: string;
  created_by: string;
  created_at: number;
  last_received_at: number | null;
  last_error: string | null;
  received: number;
};

/* ---------- Addresses ---------- */

// 32 characters of a–z and 0–9 (160 bits): safe in a URL and in the local
// part of an e-mail address, which some servers lower-case.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export function newInboundToken() {
  const bytes = randomBytes(32);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}
export const inboundDomain = () => (process.env.INBOUND_MAIL_DOMAIN || "").trim().toLowerCase();
export const imapConfigured = () => !!(process.env.INBOUND_IMAP_HOST && process.env.INBOUND_IMAP_USER);
// inbox+<token>@domain; the local part before "+" comes from the IMAP user.
export function inboundEmail(token: string) {
  const domain = inboundDomain();
  if (!domain) return "";
  const user = (process.env.INBOUND_IMAP_USER || "inbox").split("@")[0] || "inbox";
  return `${user}+${token}@${domain}`;
}
export const inboundWebhookUrl = (token: string) => `${appUrl().replace(/\/$/, "")}/api/inbound-mail/${token}`;

async function requireOwner(user: Identity, workspaceId: string) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar.");
  const member = await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id);
  if (member?.role !== "owner") throw new HttpError(403, "Nur Eigentümer verwalten E-Mail-Eingänge.");
}

// "Example.org", "@example.org" or "ada@example.org", lower case.
export function normalizeSender(value: string) {
  const v = value.trim().toLowerCase().replace(/^@/, "");
  if (!v) return "";
  if (/^[^\s@<>"]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return v;
  throw new HttpError(400, "Ungültiger Absender in der Liste.");
}
export function senderAllowed(senders: string[], from: string) {
  const address = from.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = address.slice(at + 1);
  return senders.some((s) => (s.includes("@") ? s === address : s === domain));
}

// A workflow page as target: the mail starts its e-mail trigger (#168).
const targetKinds = new Set(["document", "database", "workflow"]);
async function checkTarget(user: Identity, workspaceId: string, pageId: string) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page || page.deleted_at || page.workspace_id !== workspaceId) throw new HttpError(404, "Seite nicht gefunden.");
  if (!targetKinds.has(page.kind) || page.synced || page.journal_date)
    throw new HttpError(400, "E-Mails landen nur unter einer Seite, in einer Datenbank oder bei einem Workflow.");
  const role = await pageRole(user, page);
  if (role !== "editor" && role !== "owner") throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  return page;
}

const saveSchema = z.object({
  workspaceId: z.uuid(),
  id: z.uuid().optional(),
  pageId: z.uuid(),
  label: z.string().trim().max(100).default(""),
  senders: z.array(z.string().max(254)).max(MAX_SENDERS),
  // A new signing key; "" removes it, undefined keeps it.
  secret: z.string().max(500).optional(),
});

export async function saveInboundAddress(user: Identity, raw: unknown) {
  const input = saveSchema.parse(raw);
  await requireOwner(user, input.workspaceId);
  await checkTarget(user, input.workspaceId, input.pageId);
  const senders = [...new Set(input.senders.map(normalizeSender).filter(Boolean))];
  if (!senders.length) throw new HttpError(400, "Bitte mindestens einen erlaubten Absender angeben.");
  const now = Date.now();
  if (input.id) {
    const existing = await one<AddressRow>("SELECT * FROM inbound_addresses WHERE id=? AND workspace_id=?", input.id, input.workspaceId);
    if (!existing) throw new HttpError(404, "E-Mail-Eingang nicht gefunden.");
    const secret = input.secret === undefined ? existing.secret : input.secret ? sealSecret(input.secret, `inbound:${existing.id}`) : "";
    await run(
      "UPDATE inbound_addresses SET page_id=?,label=?,senders=?,secret=? WHERE id=?",
      input.pageId,
      input.label,
      JSON.stringify(senders),
      secret,
      existing.id,
    );
    await audit(user.id, "inbound.update", existing.id);
    return { id: existing.id };
  }
  // In the command's transaction: one workspace's new addresses are counted one at a time.
  await lockFor(`inbound-addresses:${input.workspaceId}`);
  if (Number((await one<{ n: number }>("SELECT COUNT(*) n FROM inbound_addresses WHERE workspace_id=?", input.workspaceId))?.n) >= MAX_ADDRESSES)
    throw new HttpError(409, "Höchstens 50 E-Mail-Eingänge pro Arbeitsbereich.");
  const addressId = id();
  await run(
    "INSERT INTO inbound_addresses(id,workspace_id,page_id,label,token,secret,senders,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    addressId,
    input.workspaceId,
    input.pageId,
    input.label,
    newInboundToken(),
    input.secret ? sealSecret(input.secret, `inbound:${addressId}`) : "",
    JSON.stringify(senders),
    user.id,
    now,
  );
  await audit(user.id, "inbound.create", addressId);
  return { id: addressId };
}

const refSchema = z.object({ workspaceId: z.uuid(), id: z.uuid() });
async function ownedAddress(user: Identity, raw: unknown) {
  const input = refSchema.parse(raw);
  await requireOwner(user, input.workspaceId);
  const row = await one<AddressRow>("SELECT * FROM inbound_addresses WHERE id=? AND workspace_id=?", input.id, input.workspaceId);
  if (!row) throw new HttpError(404, "E-Mail-Eingang nicht gefunden.");
  return row;
}
// A new token: the old address and webhook URL stop working at once.
export async function rotateInboundToken(user: Identity, raw: unknown) {
  const row = await ownedAddress(user, raw);
  const token = newInboundToken();
  await run("UPDATE inbound_addresses SET token=? WHERE id=?", token, row.id);
  await audit(user.id, "inbound.rotate", row.id);
  return { id: row.id, token };
}
export async function deleteInboundAddress(user: Identity, raw: unknown) {
  const row = await ownedAddress(user, raw);
  await run("DELETE FROM inbound_addresses WHERE id=?", row.id);
  await audit(user.id, "inbound.delete", row.id);
  return { ok: true as const };
}

export async function listInboundAddresses(user: Identity, workspaceId: string) {
  await requireOwner(user, workspaceId);
  const rows = await all<AddressRow & { title: string | null; kind: string | null; deleted_at: string | null }>(
    "SELECT a.*,p.title,p.kind,p.deleted_at FROM inbound_addresses a LEFT JOIN pages p ON p.id=a.page_id WHERE a.workspace_id=? ORDER BY a.created_at",
    workspaceId,
  );
  return {
    imap: imapConfigured(),
    domain: inboundDomain(),
    addresses: rows.map((r) => ({
      id: r.id,
      label: r.label,
      pageId: r.page_id,
      target: { title: r.title || "", kind: r.kind || "document", deleted: !!r.deleted_at },
      senders: JSON.parse(r.senders) as string[],
      signed: !!r.secret,
      token: r.token,
      webhookUrl: inboundWebhookUrl(r.token),
      email: inboundEmail(r.token),
      createdAt: r.created_at,
      lastReceivedAt: r.last_received_at,
      lastError: r.last_error,
      received: r.received,
    })),
  };
}

export async function inboundAddressByToken(token: string) {
  if (!/^[a-z0-9]{32,64}$/.test(token)) return undefined;
  return await one<AddressRow>("SELECT * FROM inbound_addresses WHERE token=?", token);
}

/* ---------- Signatures ---------- */

const sameHex = (expected: string, actual: string) => {
  const a = Buffer.from(expected, "utf8"),
    b = Buffer.from(actual.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
export type SignatureFields = { timestamp: string; token: string; signature: string };
// With a signing key, a delivery needs either X-Flowplan-Signature
// (sha256=HMAC of the raw body, like Flowplan's own webhooks) or Mailgun's
// signature fields (HMAC of timestamp + token, at most 15 minutes old, each
// token once – lib/replay-guard.ts).
export async function verifyInboundSignature(
  address: Pick<AddressRow, "id" | "secret">,
  body: Buffer,
  header: string | null,
  fields?: SignatureFields,
  now = Date.now(),
) {
  if (!address.secret) return;
  let key: string;
  try {
    key = openSecret(address.secret, `inbound:${address.id}`);
  } catch {
    throw new HttpError(401, "Signatur ungültig.");
  }
  const sent = (header || "").replace(/^sha256=/i, "");
  if (sent && sameHex(createHmac("sha256", key).update(body).digest("hex"), sent)) return;
  if (fields?.signature && /^\d+$/.test(fields.timestamp) && Math.abs(now / 1000 - Number(fields.timestamp)) < 900) {
    if (sameHex(createHmac("sha256", key).update(fields.timestamp + fields.token).digest("hex"), fields.signature)) {
      // Mailgun signs timestamp and token, not the mail: a token is good
      // once, for as long as its signature is valid. Mailgun's own retry
      // carries the same mail and passes.
      const fingerprint = createHash("sha256").update(body).digest("hex");
      const ttl = Math.max(900_000, Number(fields.timestamp) * 1000 + 900_000 - now);
      if ((await claimOnce(`mailgun:${address.id}:${fields.token}`, fingerprint, ttl, now)) !== "other") return;
    }
  }
  throw new HttpError(401, "Signatur ungültig.");
}

/* ---------- Provider formats ---------- */

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => addresses(str(x))) : addresses(str(v)));
const fromBase64 = (v: unknown) => Buffer.from(str(v), "base64");
const cid = (v: unknown) => str(v).trim().replace(/^<|>$/g, "");
const toAttachment = (filename: string, contentType: string, data: Buffer, contentId = "", inline = false): MimeAttachment => ({
  filename: filename || "attachment",
  contentType: (contentType || "application/octet-stream").split(";")[0].trim().toLowerCase(),
  data,
  contentId,
  inline: inline || !!contentId,
});
function fromMime(raw: Buffer | string): InboundMail {
  const m = parseMime(raw);
  return { from: m.from, to: [...m.to, ...m.cc, ...envelopeRecipients(m.headers)], subject: m.subject, text: m.text, html: m.html, messageId: m.messageId, date: m.date, attachments: m.attachments, auth: mailVerdict(m.headers, m.from) };
}
function envelopeRecipients(headers: Map<string, string[]>) {
  return ["delivered-to", "x-original-to", "envelope-to", "x-envelope-to"].flatMap((name) => (headers.get(name) || []).flatMap(addresses));
}

// Postmark inbound JSON.
function postmark(b: Record<string, unknown>): InboundMail {
  const headers = Array.isArray(b.Headers) ? (b.Headers as { Name?: string; Value?: string }[]) : [];
  const head = (name: string) => headers.find((h) => str(h.Name).toLowerCase() === name)?.Value || "";
  const full = (v: unknown) => (Array.isArray(v) ? (v as { Email?: string }[]).map((x) => str(x.Email).toLowerCase()).filter(Boolean) : []);
  const from = str((b.FromFull as { Email?: string } | undefined)?.Email).toLowerCase() || addresses(str(b.From))[0] || "";
  return {
    auth: mailVerdict(headers.map((h) => [str(h.Name), str(h.Value)] as [string, string]), from),
    from,
    to: [...(full(b.ToFull).length ? full(b.ToFull) : list(b.To)), ...full(b.CcFull), ...list(b.OriginalRecipient)],
    subject: str(b.Subject),
    text: str(b.TextBody),
    html: str(b.HtmlBody),
    messageId: cid(head("message-id")) || str(b.MessageID),
    date: parseDate(str(b.Date)),
    attachments: (Array.isArray(b.Attachments) ? (b.Attachments as Record<string, unknown>[]) : []).map((a) =>
      toAttachment(str(a.Name), str(a.ContentType), fromBase64(a.Content), cid(a.ContentID)),
    ),
  };
}
// The generic JSON format (also what a Cloudflare Email Worker can send):
// either `raw` (the whole message, as text or base64 in `rawBase64`) or the
// parsed fields.
function genericJson(b: Record<string, unknown>): InboundMail {
  if (typeof b.raw === "string" && b.raw) return fromMime(b.raw);
  if (typeof b.rawBase64 === "string" && b.rawBase64) return fromMime(fromBase64(b.rawBase64));
  const from = addresses(str(b.from))[0] || "";
  return {
    auth: typeof b.authenticationResults === "string" ? mailVerdict([["authentication-results", b.authenticationResults]], from) : "unknown",
    from,
    to: [...list(b.to), ...list(b.cc)],
    subject: str(b.subject),
    text: str(b.text),
    html: str(b.html),
    messageId: cid(b.messageId ?? b["message-id"] ?? b.messageID),
    date: parseDate(str(b.date)),
    attachments: (Array.isArray(b.attachments) ? (b.attachments as Record<string, unknown>[]) : []).map((a) =>
      toAttachment(str(a.filename ?? a.name), str(a.contentType ?? a.type), fromBase64(a.content ?? a.data), cid(a.contentId ?? a.cid), a.inline === true),
    ),
  };
}

async function fileData(value: FormDataEntryValue | null) {
  return value && typeof value !== "string" ? Buffer.from(await value.arrayBuffer()) : null;
}
const formText = (form: FormData, ...names: string[]) => {
  for (const name of names) {
    const v = form.get(name);
    if (typeof v === "string" && v) return v;
  }
  return "";
};
// Mailgun "store and notify"/forward: body-plain, body-html, attachment-N,
// content-id-map; body-mime for the MIME route.
async function mailgun(form: FormData): Promise<InboundMail> {
  const mime = formText(form, "body-mime");
  if (mime) return fromMime(mime);
  let headers: [string, string][] = [];
  try {
    headers = JSON.parse(formText(form, "message-headers") || "[]");
  } catch {
    headers = [];
  }
  const head = (name: string) => headers.find((h) => Array.isArray(h) && str(h[0]).toLowerCase() === name)?.[1] || "";
  let cidMap: Record<string, string> = {};
  try {
    cidMap = JSON.parse(formText(form, "content-id-map") || "{}");
  } catch {
    cidMap = {};
  }
  const byField = new Map(Object.entries(cidMap).map(([c, field]) => [field, cid(c)]));
  const attachments: MimeAttachment[] = [];
  for (const [name, value] of form.entries()) {
    if (!/^attachment-\d+$/.test(name) || typeof value === "string") continue;
    attachments.push(toAttachment(value.name, value.type, Buffer.from(await value.arrayBuffer()), byField.get(name) || ""));
  }
  const from = addresses(formText(form, "from", "From", "sender"))[0] || "";
  return {
    auth: mailVerdict(headers.filter((h) => Array.isArray(h)).map((h) => [str(h[0]), str(h[1])] as [string, string]), from),
    from,
    to: [...addresses(formText(form, "To", "to")), ...addresses(formText(form, "Cc", "cc")), ...addresses(formText(form, "recipient"))],
    subject: formText(form, "subject", "Subject"),
    text: formText(form, "body-plain", "stripped-text"),
    html: formText(form, "body-html", "stripped-html"),
    messageId: cid(formText(form, "Message-Id", "message-id") || head("message-id")),
    date: parseDate(formText(form, "Date", "date") || head("date")),
    attachments,
  };
}
// SendGrid Inbound Parse: from, to, subject, text, html, headers,
// attachment-info and attachmentN files; `email` in raw mode.
async function sendgrid(form: FormData): Promise<InboundMail> {
  const raw = formText(form, "email");
  if (raw) return fromMime(raw);
  const headers = parseHeaders(formText(form, "headers"));
  let info: Record<string, { filename?: string; name?: string; type?: string; "content-id"?: string }> = {};
  try {
    info = JSON.parse(formText(form, "attachment-info") || "{}");
  } catch {
    info = {};
  }
  let envelope: { to?: string[] } = {};
  try {
    envelope = JSON.parse(formText(form, "envelope") || "{}");
  } catch {
    envelope = {};
  }
  const attachments: MimeAttachment[] = [];
  for (const [name, value] of form.entries()) {
    if (!/^attachment\d+$/.test(name) || typeof value === "string") continue;
    const meta = info[name] || {};
    attachments.push(
      toAttachment(meta.filename || meta.name || value.name, meta.type || value.type, Buffer.from(await value.arrayBuffer()), cid(meta["content-id"])),
    );
  }
  const from = addresses(formText(form, "from"))[0] || "";
  return {
    auth: headers.get("authentication-results")?.length ? mailVerdict(headers, from) : sendgridVerdict(formText(form, "SPF"), formText(form, "dkim"), from),
    from,
    to: [...addresses(formText(form, "to")), ...addresses(formText(form, "cc")), ...(envelope.to || []).flatMap((t) => addresses(str(t)))],
    subject: formText(form, "subject"),
    text: formText(form, "text"),
    html: formText(form, "html"),
    messageId: cid(headers.get("message-id")?.[0]),
    date: parseDate(headers.get("date")?.[0] || ""),
    attachments,
  };
}
async function genericForm(form: FormData): Promise<InboundMail> {
  const raw = formText(form, "raw");
  if (raw) return fromMime(raw);
  const attachments: MimeAttachment[] = [];
  for (const [, value] of form.entries()) {
    if (typeof value === "string") continue;
    attachments.push(toAttachment(value.name, value.type, (await fileData(value))!));
  }
  return {
    from: addresses(formText(form, "from"))[0] || "",
    to: [...addresses(formText(form, "to")), ...addresses(formText(form, "cc"))],
    subject: formText(form, "subject"),
    text: formText(form, "text"),
    html: formText(form, "html"),
    messageId: cid(formText(form, "messageId", "message-id")),
    date: parseDate(formText(form, "date")),
    attachments,
  };
}

export type InboundPayload = { mail: InboundMail; provider: string; signature?: SignatureFields };
// Turns a provider's POST into one mail. The format is recognised from the
// content type and the field names.
export async function parseInboundPayload(contentType: string, body: Buffer): Promise<InboundPayload> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "message/rfc822" || type === "text/plain") return { mail: fromMime(body), provider: "mime" };
  if (type === "application/json" || type.endsWith("+json")) {
    let b: unknown;
    try {
      b = JSON.parse(body.toString("utf8"));
    } catch {
      throw new HttpError(400, "Ungültige Anfrage.");
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Ungültige Anfrage.");
    const o = b as Record<string, unknown>;
    if ("FromFull" in o || "TextBody" in o || "HtmlBody" in o || "MessageID" in o) return { mail: postmark(o), provider: "postmark" };
    return { mail: genericJson(o), provider: "generic" };
  }
  if (type === "multipart/form-data" || type === "application/x-www-form-urlencoded") {
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new HttpError(400, "Ungültige Anfrage.");
    }
    const signature = form.get("signature")
      ? { timestamp: formText(form, "timestamp"), token: formText(form, "token"), signature: formText(form, "signature") }
      : undefined;
    if (form.has("body-plain") || form.has("body-html") || form.has("body-mime") || form.has("recipient") || form.has("attachment-count"))
      return { mail: await mailgun(form), provider: "mailgun", signature };
    if (form.has("envelope") || form.has("attachment-info") || form.has("email") || form.has("charsets"))
      return { mail: await sendgrid(form), provider: "sendgrid", signature };
    return { mail: await genericForm(form), provider: "generic", signature };
  }
  throw new HttpError(415, "Format nicht unterstützt.");
}

/* ---------- Content ---------- */

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const textHtml = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

// Mail HTML is foreign content: structure and links stay; scripts, styles,
// forms and frames go, and images only remain when they are attachments of
// this mail (cid:), never remote (no tracking pixels).
export function mailBodyHtml(html: string, inlineFiles: Map<string, string>) {
  return sanitize(html, {
    allowedTags: ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "td", "th", "img"],
    allowedAttributes: { a: ["href"], img: ["src", "alt"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head", "template"],
    transformTags: {
      img: (tagName, attribs) => {
        const src = (attribs.src || "").trim();
        const file = /^cid:/i.test(src) ? inlineFiles.get(src.slice(4).replace(/^<|>$/g, "").toLowerCase()) : undefined;
        const kept: Record<string, string> = file ? { src: file, alt: attribs.alt || "" } : {};
        return { tagName, attribs: kept };
      },
      a: (tagName, attribs) => ({ tagName, attribs: (attribs.href ? { href: attribs.href } : {}) as Record<string, string> }),
    },
    // allowedSchemesByTag has no relative paths; /api/files/… is added
    // after the scheme check through the transform, so filter here.
    exclusiveFilter: (frame) => frame.tag === "img" && !/^\/api\/files\/[a-f0-9-]+$/.test(frame.attribs.src || ""),
  });
}

/* ---------- Receiving ---------- */

export type ReceiveResult =
  | { status: "stored"; pageId: string; rowId?: string; files: number; skipped: string[] }
  | { status: "duplicate" }
  | { status: "rejected"; reason: "sender" };

async function creatorIdentity(userId: string): Promise<Identity | null> {
  const user = await one<{ id: string; subject: string; name: string; email: string; disabled: number }>(
    "SELECT id,subject,name,email,disabled FROM users WHERE id=?",
    userId,
  );
  if (!user || user.disabled) return null;
  return { ...user, groups: [], isAdmin: false } as unknown as Identity;
}
async function noteError(addressId: string, message: string) {
  await run("UPDATE inbound_addresses SET last_error=? WHERE id=?", message.slice(0, 300), addressId);
}

// Counted on its own, before the work: refused and rejected mail count too.
async function takeRate(addressId: string, now: number) {
  await run("DELETE FROM inbound_deliveries WHERE at<?", now - HOUR);
  const n = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM inbound_deliveries WHERE address_id=? AND at>?", addressId, now - HOUR))?.n || 0);
  if (n >= INBOUND_MAILS_PER_HOUR) throw new HttpError(429, "Zu viele E-Mails an diese Adresse. Bitte später erneut versuchen.");
  await run("INSERT INTO inbound_deliveries(address_id,at) VALUES(?,?)", addressId, now);
}

const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

// `via`: "imap" when the mail came from the own mailbox (its server's
// verdict counts), else "http" – a provider's verdict only counts when the
// delivery itself was signed (the address has a signing key).
export async function receiveInboundMail(token: string, mail: InboundMail, now = Date.now(), via: "http" | "imap" = "http"): Promise<ReceiveResult> {
  const address = await inboundAddressByToken(token);
  if (!address) throw new HttpError(404, "E-Mail-Eingang nicht gefunden.");
  await takeRate(address.id, now);
  const from = (mail.from || "").trim().toLowerCase();
  if (!senderAllowed(JSON.parse(address.senders) as string[], from)) {
    // Logged, not stored.
    await audit(address.created_by, "inbound.rejected", address.id, `sender: ${from.slice(0, 254) || "?"}`);
    await noteError(address.id, `Absender abgelehnt: ${from.slice(0, 254) || "?"}`);
    return { status: "rejected", reason: "sender" };
  }
  const messageId = (mail.messageId || "").trim().slice(0, 500) || `sha256:${hash([from, mail.subject, mail.date?.toISOString() || "", mail.text, mail.html].join("\n"))}`;
  if (await one("SELECT 1 FROM inbound_messages WHERE address_id=? AND message_id=?", address.id, messageId)) return { status: "duplicate" };
  try {
    const target = await one<{ kind: string }>("SELECT kind FROM pages WHERE id=?", address.page_id);
    if (target?.kind === "workflow") {
      const verdict: MailVerdict = via === "imap" || address.secret ? (mail.auth ?? "unknown") : "unknown";
      return await transaction(async () => await workflowMail(address, mail, from, messageId, verdict, now));
    }
    return await transaction(async () => await storeMail(address, mail, from, messageId, now));
  } catch (error) {
    if (error instanceof HttpError) await noteError(address.id, error.message);
    throw error;
  }
}

async function storeMail(address: AddressRow, mail: InboundMail, from: string, messageId: string, now: number): Promise<ReceiveResult> {
  const user = await creatorIdentity(address.created_by);
  const target = await one<Page>("SELECT * FROM pages WHERE id=?", address.page_id);
  // The address acts with the rights of the person who created it.
  const role = user && target && !target.deleted_at ? (await pageRole(user, target)) : null;
  if (!user || !target || target.deleted_at || target.locked || (role !== "editor" && role !== "owner"))
    throw new HttpError(409, "Das Ziel dieses E-Mail-Eingangs ist nicht mehr beschreibbar.");
  // Attachments: at most 20, 10 MB each, 25 MB together; the rest is named
  // in the text instead.
  const skipped: string[] = [];
  const kept: (MimeAttachment & { mime: string })[] = [];
  let total = 0;
  for (const a of mail.attachments) {
    const name = sanitizeFileName(a.filename, "Anhang");
    if (kept.length >= INBOUND_MAX_ATTACHMENTS || a.data.length > INBOUND_FILE_BYTES || total + a.data.length > INBOUND_TOTAL_BYTES || !a.data.length) {
      skipped.push(name);
      continue;
    }
    const mime = verifiedMime(a.contentType, a.data);
    const data = stripLocation(a.data, mime);
    total += data.length;
    kept.push({ ...a, filename: name, data, mime });
  }
  if (total) {
    await enforceQuota(address.workspace_id, total);
    await takeAnonymousBudget(`mail:${address.token}`, total, undefined, now);
  }
  const database = target.kind === "database";
  const subject = mail.subject.replace(/\s+/g, " ").trim();
  const title = (subject || ct(`E-Mail von ${from}`, `E-mail from ${from}`)).slice(0, 300);
  const fields: Field[] = database
    ? JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", target.id))?.fields || "[]")
    : [];
  const filesField = fields.find((f) => f.type === "files");
  const emailField = fields.find((f) => f.type === "email");
  const owner = database ? target.id : (await createPage(target.workspace_id, target.space_id, user.id, title, "document", target.id));
  // Files go where the new content lives: the new page, or the database.
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  if (kept.length) mkdirSync(dir, { recursive: true });
  const stored = await mapAsync(kept, async (a) => {
    const fid = id(),
      path = resolve(dir, fid);
    writeFileSync(path, a.data);
    onTransactionRollback(() => unlinkSync(path));
    await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, owner, a.filename, a.mime, a.data.length, null);
    return { ...a, url: `/api/files/${fid}` };
  });
  const inlineFiles = new Map(
    stored.filter((a) => a.contentId && a.mime.startsWith("image/")).map((a) => [a.contentId.toLowerCase(), a.url]),
  );
  let body = mail.html.trim() ? mailBodyHtml(mail.html, inlineFiles) : textHtml(mail.text);
  if (!body.replace(/<[^>]*>/g, "").trim() && !/<img/.test(body) && mail.text.trim()) body = textHtml(mail.text);
  const used = new Set([...body.matchAll(/\/api\/files\/([a-f0-9-]+)/g)].map((m) => `/api/files/${m[1]}`));
  // Attachments the text does not show: as a list below it, or in the
  // files property of the database.
  const rest = stored.filter((a) => !used.has(a.url));
  const listed = database && filesField ? [] : rest;
  const date = mail.date && mail.date.getTime() <= now ? mail.date : new Date(now);
  const meta = `<p><strong>${esc(ct("Von", "From"))}:</strong> ${esc(from)}<br><strong>${esc(ct("Datum", "Date"))}:</strong> ${esc(date.toISOString().slice(0, 16).replace("T", " "))} UTC</p>`;
  const attachmentsHtml = listed.length
    ? `<hr><p><strong>${esc(ct("Anhänge", "Attachments"))}</strong></p>` +
      listed.map((a) => (a.mime.startsWith("image/") ? `<p><img src="${a.url}" alt="${esc(a.filename)}"></p>` : `<p><a href="${a.url}">${esc(a.filename)}</a></p>`)).join("")
    : "";
  const skippedHtml = skipped.length
    ? `<p><em>${esc(ct("Nicht übernommene Anhänge (zu groß oder zu viele)", "Attachments not kept (too large or too many)"))}: ${esc(skipped.join(", "))}</em></p>`
    : "";
  const html = meta + body + attachmentsHtml + skippedHtml;
  let rowId: string | undefined;
  if (database) {
    rowId = id();
    const cells: Record<string, unknown> = { [fields[0]?.id || "title"]: title };
    if (emailField && from) cells[emailField.id] = from;
    if (filesField && rest.length) cells[filesField.id] = rest.map((a) => a.url);
    await run(
      "INSERT INTO rows(id,page_id,cells,position,created_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?)",
      rowId,
      target.id,
      JSON.stringify(cells),
      now,
      sqlTime(date),
      user.id,
      user.id,
    );
    await replaceRowDocument(rowId, html, user.id);
    await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), target.id);
    await rowCreated(user, target, rowId);
    const payload = { pageId: target.id, rowId, cells, source: "email" };
    await emitWebhook(target.workspace_id, "row.created", payload);
  } else {
    const safe = cleanHtml(html);
    await run("UPDATE documents SET html=?,state=?,updated_at=? WHERE page_id=?", safe, htmlState(safe), nowText(), owner);
    await emitWebhook(target.workspace_id, "page.created", { pageId: owner, title, parentId: target.id, source: "email" });
    await pageCreatedEvent(owner, user.id);
  }
  await run(
    "INSERT INTO inbound_messages(address_id,message_id,page_id,row_id,received_at) VALUES(?,?,?,?,?)",
    address.id,
    messageId,
    owner,
    rowId || null,
    now,
  );
  await run("UPDATE inbound_addresses SET last_received_at=?,last_error=NULL,received=received+1 WHERE id=?", now, address.id);
  await audit(address.created_by, "inbound.received", address.id, `${from} → ${rowId ? `row ${rowId}` : `page ${owner}`}`);
  return { status: "stored", pageId: owner, ...(rowId ? { rowId } : {}), files: stored.length, skipped };
}

// Mail to a workflow (#168, docs/specs/workflows.md §9.7): nothing is
// filed – the workflow decides. Attachments become files of the workflow
// page (against the quota); the event carries the mail and the sender
// check. The sender is never mapped to an account: runs run as the person
// the workflow runs as.
async function workflowMail(address: AddressRow, mail: InboundMail, from: string, messageId: string, verdict: MailVerdict, now: number): Promise<ReceiveResult> {
  const target = await one<Page>("SELECT * FROM pages WHERE id=?", address.page_id);
  if (!target || target.deleted_at) throw new HttpError(409, "Das Ziel dieses E-Mail-Eingangs ist nicht mehr beschreibbar.");
  const skipped: string[] = [];
  const kept: (MimeAttachment & { mime: string })[] = [];
  let total = 0;
  for (const a of mail.attachments) {
    const name = sanitizeFileName(a.filename, "Anhang");
    if (kept.length >= INBOUND_MAX_ATTACHMENTS || a.data.length > INBOUND_FILE_BYTES || total + a.data.length > INBOUND_TOTAL_BYTES || !a.data.length) {
      skipped.push(name);
      continue;
    }
    const mime = verifiedMime(a.contentType, a.data);
    const data = stripLocation(a.data, mime);
    total += data.length;
    kept.push({ ...a, filename: name, data, mime });
  }
  if (total) {
    await enforceQuota(address.workspace_id, total);
    await takeAnonymousBudget(`mail:${address.token}`, total, undefined, now);
  }
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  if (kept.length) mkdirSync(dir, { recursive: true });
  const files = await mapAsync(kept, async (a) => {
    const fid = id(),
      path = resolve(dir, fid);
    writeFileSync(path, a.data);
    onTransactionRollback(() => unlinkSync(path));
    await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, target.id, a.filename, a.mime, a.data.length, null);
    return { name: a.filename, size: a.data.length, mime: a.mime, file: fid, url: `/api/files/${fid}` };
  });
  const date = mail.date && mail.date.getTime() <= now ? mail.date : new Date(now);
  await emitWorkflowEvent("mail.received", {
    workspaceId: address.workspace_id,
    scopeId: address.id,
    payload: {
      workflow: target.id,
      mail: {
        from,
        to: mail.to.slice(0, 50),
        subject: mail.subject.replace(/\s+/g, " ").trim().slice(0, 500),
        text: (mail.text || "").slice(0, 50_000),
        html: mail.html ? mailBodyHtml(mail.html, new Map()).slice(0, 100_000) : "",
        date: date.toISOString(),
        messageId,
        attachments: files,
        skipped,
      },
      authenticated: verdict,
    },
    dedupeKey: `mail:${address.id}:${messageId}`.slice(0, 600),
  });
  await run("INSERT INTO inbound_messages(address_id,message_id,page_id,row_id,received_at) VALUES(?,?,?,?,?)", address.id, messageId, target.id, null, now);
  await run("UPDATE inbound_addresses SET last_received_at=?,last_error=NULL,received=received+1 WHERE id=?", now, address.id);
  await audit(address.created_by, "inbound.received", address.id, `${from} → workflow ${target.id} (${verdict})`);
  return { status: "stored", pageId: target.id, files: files.length, skipped };
}

/* ---------- IMAP ---------- */

export function imapOptionsFromEnv(): ImapOptions | null {
  const host = process.env.INBOUND_IMAP_HOST,
    user = process.env.INBOUND_IMAP_USER;
  if (!host || !user) return null;
  const tls = process.env.INBOUND_IMAP_TLS !== "false";
  return {
    host,
    port: Number(process.env.INBOUND_IMAP_PORT) || (tls ? 993 : 143),
    user,
    password: process.env.INBOUND_IMAP_PASSWORD || "",
    tls,
  };
}
// The token of inbox+<token>@… among the recipients.
export async function tokenFromRecipients(recipients: string[]) {
  for (const r of recipients) {
    const m = r.toLowerCase().match(/\+([a-z0-9]{32,64})@/);
    if (m && await inboundAddressByToken(m[1])) return m[1];
  }
  return "";
}
const IMAP_BATCH = 50;
// Larger messages are not fetched; their attachments could not be kept.
const IMAP_MESSAGE_BYTES = INBOUND_REQUEST_BYTES;

// One poll: every unseen message is routed by its +token. Stored,
// duplicate, rejected and unroutable mail is marked as seen; a full hour
// (429) or day (413) leaves it unseen for the next round.
export async function pollInboundMailbox(options = imapOptionsFromEnv()) {
  if (!options) return { processed: 0 };
  const client = new ImapClient(options);
  let processed = 0;
  try {
    await client.connect();
    await client.login();
    await client.select(process.env.INBOUND_IMAP_FOLDER || "INBOX");
    for (const uid of (await client.searchUnseen()).slice(0, IMAP_BATCH)) {
      const raw = await client.fetchMessage(uid);
      if (!raw || raw.length > IMAP_MESSAGE_BYTES) {
        await client.markSeen(uid);
        continue;
      }
      const mail = fromMime(raw);
      const token = await tokenFromRecipients(mail.to);
      if (!token) {
        await client.markSeen(uid);
        continue;
      }
      try {
        await receiveInboundMail(token, mail, Date.now(), "imap");
        processed++;
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 429 || status === 413) continue;
        console.error("E-Mail-Eingang fehlgeschlagen:", String((error as Error)?.message || error));
      }
      await client.markSeen(uid);
    }
  } finally {
    await client.logout();
  }
  return { processed };
}

const runtime = globalThis as unknown as { flowplanInboundTimer?: ReturnType<typeof setInterval>; flowplanInboundBusy?: boolean };
export function startInboundMailWorker() {
  if (runtime.flowplanInboundTimer || !imapOptionsFromEnv()) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (runtime.flowplanInboundBusy || !isLeader()) return;
    runtime.flowplanInboundBusy = true;
    try {
      await pollInboundMailbox();
    } catch (error) {
      console.error("IMAP-Abruf fehlgeschlagen:", String((error as Error)?.message || error));
    } finally {
      runtime.flowplanInboundBusy = false;
    }
  };
  runtime.flowplanInboundTimer = setInterval(() => void tick(), 120_000);
  runtime.flowplanInboundTimer.unref();
  setTimeout(() => void tick(), 15_000).unref();
}
