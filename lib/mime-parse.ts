// A small MIME parser for incoming e-mail (lib/inbound-mail.ts), without
// dependencies: header unfolding, encoded words (RFC 2047) and parameter
// continuations (RFC 2231), nested multipart bodies, quoted-printable and
// base64, the charsets UTF-8, ISO-8859-1 and whatever else the runtime's
// TextDecoder knows (falling back to Latin-1). Inline images keep their
// Content-ID, so the HTML part can point at the stored files.

export type MimeHeaders = Map<string, string[]>;
export type MimeAttachment = {
  filename: string;
  contentType: string;
  data: Buffer;
  contentId: string;
  inline: boolean;
};
export type ParsedMail = {
  headers: MimeHeaders;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: Date | null;
  messageId: string;
  text: string;
  html: string;
  attachments: MimeAttachment[];
};

// Nesting deeper than this is not mail anyone writes; it stops parse bombs.
const MAX_DEPTH = 12;
const MAX_PARTS = 300;

/* ---------- Charsets and transfer encodings ---------- */

export function decodeCharset(data: Buffer, charset = "utf-8") {
  const name = charset.trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  if (name === "us-ascii" || name === "ascii") return data.toString("latin1");
  if (name === "iso-8859-1" || name === "latin1" || name === "latin-1") return data.toString("latin1");
  try {
    return new TextDecoder(name).decode(data);
  } catch {
    // Unknown charset: Latin-1 keeps every byte readable.
    return name.startsWith("utf") ? data.toString("utf8") : data.toString("latin1");
  }
}

export function decodeQuotedPrintable(input: string): Buffer {
  // Soft line breaks end with "=" and disappear.
  const text = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "=" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = text.charCodeAt(i);
      // Raw 8-bit text in a QP part: keep its bytes.
      if (code > 0xff) bytes.push(...Buffer.from(c, "utf8"));
      else bytes.push(code);
    }
  }
  return Buffer.from(bytes);
}

function decodeTransfer(body: Buffer, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase();
  if (e === "base64") return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return decodeQuotedPrintable(body.toString("latin1"));
  return body;
}

/* ---------- Headers ---------- */

// =?charset?B|Q?text?= words; whitespace between two encoded words goes.
export function decodeWords(value: string) {
  return value
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, "$1")
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_, charset: string, kind: string, text: string) => {
      const cs = charset.split("*")[0];
      const data =
        kind.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : decodeQuotedPrintable(text.replace(/_/g, " "));
      return decodeCharset(data, cs);
    });
}

export function parseHeaders(block: string): MimeHeaders {
  const headers: MimeHeaders = new Map();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = headers.get(name) || [];
    list.push(value);
    headers.set(name, list);
  }
  return headers;
}
const header = (headers: MimeHeaders, name: string) => headers.get(name)?.[0] || "";

// "text/plain; charset=utf-8; name*0=…" → value and parameters, with
// RFC 2231 continuations and charsets put together.
export function parseParams(value: string) {
  const parts: string[] = [];
  let current = "",
    quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' && value[i - 1] !== "\\") quoted = !quoted;
    if (c === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  const main = (parts.shift() || "").trim().toLowerCase();
  const raw = new Map<string, { value: string; extended: boolean }[]>();
  const plain = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    let key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    const continued = key.match(/^(.+?)\*(\d+)(\*)?$/);
    const extended = key.endsWith("*") && !continued;
    if (continued) {
      const list = raw.get(continued[1]) || [];
      list[Number(continued[2])] = { value: val, extended: !!continued[3] };
      raw.set(continued[1], list);
    } else if (extended) {
      key = key.slice(0, -1);
      raw.set(key, [{ value: val, extended: true }]);
    } else plain.set(key, val);
  }
  const params = new Map(plain);
  for (const [key, list] of raw) {
    let charset = "utf-8";
    const bytes: Buffer[] = [];
    list.forEach((piece, index) => {
      if (!piece) return;
      let v = piece.value;
      if (piece.extended && index === 0) {
        const m = v.match(/^([^']*)'[^']*'(.*)$/);
        if (m) {
          charset = m[1] || charset;
          v = m[2];
        }
      }
      bytes.push(piece.extended ? Buffer.from(v.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16))), "latin1") : Buffer.from(v, "utf8"));
    });
    params.set(key, decodeCharset(Buffer.concat(bytes), charset));
  }
  for (const [key, val] of params) params.set(key, decodeWords(val));
  return { value: main, params };
}

// "Ada <ada@example.org>, bob@example.org" → the bare addresses, lower case.
export function addresses(value: string): string[] {
  const out: string[] = [];
  const decoded = decodeWords(value)
    // Quoted display names may contain commas and angle brackets.
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/\([^)]*\)/g, "");
  for (const part of decoded.split(/[,;]/)) {
    const angle = part.match(/<([^<>\s]+@[^<>\s]+)>/);
    const bare = part.match(/[^\s<>"]+@[^\s<>",]+/);
    const address = (angle?.[1] || bare?.[0] || "").trim().toLowerCase();
    if (address) out.push(address);
  }
  return out;
}

/* ---------- Bodies ---------- */

function splitHead(data: Buffer) {
  const text = data.toString("latin1");
  const m = text.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) {
    // Only headers (or only a body when the first line is no header).
    return /^[!-9;-~]+:/.test(text) ? { head: text, body: Buffer.alloc(0) } : { head: "", body: data };
  }
  return { head: text.slice(0, m.index), body: data.subarray(m.index + m[0].length) };
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString("latin1");
  const marker = `--${boundary}`;
  const parts: Buffer[] = [];
  let pos = text.indexOf(marker);
  while (pos !== -1) {
    let start = pos + marker.length;
    if (text.startsWith("--", start)) break;
    // Skip the rest of the boundary line.
    const lineEnd = text.indexOf("\n", start);
    if (lineEnd === -1) break;
    start = lineEnd + 1;
    const next = text.indexOf(`\n${marker}`, start);
    const end = next === -1 ? text.length : next;
    let chunk = text.slice(start, end);
    if (chunk.endsWith("\r")) chunk = chunk.slice(0, -1);
    parts.push(Buffer.from(chunk, "latin1"));
    if (next === -1 || parts.length > MAX_PARTS) break;
    pos = next + 1;
  }
  return parts;
}

type Collected = { text: string[]; html: string[]; attachments: MimeAttachment[]; parts: number };

function walk(data: Buffer, out: Collected, depth: number, inheritedType = "text/plain") {
  if (depth > MAX_DEPTH || ++out.parts > MAX_PARTS) return;
  const { head, body } = splitHead(data);
  const headers = parseHeaders(head);
  const type = parseParams(header(headers, "content-type") || inheritedType);
  const disposition = parseParams(header(headers, "content-disposition"));
  if (type.value.startsWith("multipart/")) {
    const boundary = type.params.get("boundary");
    if (!boundary) return;
    const childDefault = type.value === "multipart/digest" ? "message/rfc822" : "text/plain";
    const parts = splitMultipart(body, boundary);
    if (type.value === "multipart/alternative") {
      // The richest version of each kind; plain text and HTML both count.
      const nested: Collected = { text: [], html: [], attachments: [], parts: out.parts };
      for (const part of parts) {
        const one: Collected = { text: [], html: [], attachments: [], parts: nested.parts };
        walk(part, one, depth + 1, childDefault);
        nested.parts = one.parts;
        if (one.text.length) nested.text = one.text;
        if (one.html.length) nested.html = one.html;
        nested.attachments.push(...one.attachments);
      }
      out.parts = nested.parts;
      out.text.push(...nested.text);
      out.html.push(...nested.html);
      out.attachments.push(...nested.attachments);
    } else for (const part of parts) walk(part, out, depth + 1, childDefault);
    return;
  }
  const decoded = decodeTransfer(body, header(headers, "content-transfer-encoding"));
  const filename = disposition.params.get("filename") || type.params.get("name") || "";
  const contentId = header(headers, "content-id").replace(/^<|>$/g, "").trim();
  const isAttachment = disposition.value === "attachment" || (!!filename && disposition.value !== "inline");
  if (!isAttachment && (type.value === "text/plain" || type.value === "text/html") && !(disposition.value === "inline" && filename)) {
    const text = decodeCharset(decoded, type.params.get("charset") || "utf-8");
    (type.value === "text/html" ? out.html : out.text).push(text);
    return;
  }
  // A forwarded message stays one file (.eml), not its pieces.
  out.attachments.push({
    filename: filename || (type.value === "message/rfc822" ? "message.eml" : contentId ? `inline-${out.attachments.length + 1}` : `attachment-${out.attachments.length + 1}`),
    contentType: type.value || "application/octet-stream",
    data: decoded,
    contentId,
    inline: disposition.value === "inline" || (!!contentId && disposition.value !== "attachment"),
  });
}

export function parseDate(value: string) {
  if (!value) return null;
  const date = new Date(value.replace(/\s*\([^)]*\)\s*$/, ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseMime(input: Buffer | string): ParsedMail {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const { head } = splitHead(data);
  const headers = parseHeaders(head);
  const out: Collected = { text: [], html: [], attachments: [], parts: 0 };
  walk(data, out, 0);
  const list = (name: string) => (headers.get(name) || []).flatMap(addresses);
  return {
    headers,
    from: addresses(header(headers, "from"))[0] || "",
    to: list("to"),
    cc: list("cc"),
    subject: decodeWords(header(headers, "subject")).trim(),
    date: parseDate(header(headers, "date")),
    messageId: header(headers, "message-id").replace(/^<|>$/g, "").trim(),
    text: out.text.join("\n\n"),
    html: out.html.join("\n"),
    attachments: out.attachments,
  };
}
