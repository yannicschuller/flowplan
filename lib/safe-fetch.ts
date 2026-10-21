import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { HttpError } from "./auth";

// Fetches public HTTPS resources (link previews, embeds, profile pictures)
// without reaching internal services: every hop is resolved, private and
// special addresses are refused, and the connection uses exactly the
// checked address. `allowPrivate` exists only for local test setups.
const MAX_REDIRECTS = 3;
function ipv4Private(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
// The eight 16-bit groups of an IPv6 address ("::" expanded, a trailing
// dotted IPv4 part converted), or null.
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(":") : []);
  const head = part(halves[0]),
    tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}
const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
export function privateAddress(ip: string) {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const g = ipv6Groups(ip);
  if (!g) return true;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::, ::1, IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d),
  // in any spelling: judged by the IPv4 address inside.
  if (zeroUpTo(6)) return g[6] === 0 && g[7] <= 1 ? true : ipv4Private(embeddedV4(g[6], g[7]));
  if (zeroUpTo(5) && g[5] === 0xffff) return ipv4Private(embeddedV4(g[6], g[7]));
  // 6to4 carries an IPv4 address too.
  if (g[0] === 0x2002) return ipv4Private(embeddedV4(g[1], g[2]));
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local
    (g[0] & 0xffc0) === 0xfe80 || // link local
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x64 && g[1] === 0xff9b) || // NAT64
    (g[0] === 0x2001 && g[1] === 0xdb8) || // documentation
    (g[0] === 0x2001 && g[1] === 0) // Teredo
  );
}
type Fetched = { url: string; status: number; type: string; body: string; data: Buffer; headers: Record<string, string> };
type Options = {
  maxBytes?: number;
  timeout?: number;
  accept?: string;
  allowPrivate?: boolean;
  // API calls (issue sync): another method, extra headers and a body.
  // Requests with own headers (credentials) or another method than GET
  // follow no redirects; the 3xx answer is returned as it is.
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
const flatHeaders = (headers: Record<string, string | string[] | undefined>) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")]));
// DNS lookup that refuses internal addresses and hands the request the very
// address it checked (no second lookup that could point elsewhere).
export function pinnedLookup(allowPrivate: boolean) {
  return (host: string, options: object, callback: (...args: never[]) => void) =>
    dnsLookup(host, { all: true }, (error, addresses) => {
      const done = callback as unknown as (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void;
      if (error) return done(error, "", 4);
      const list = addresses as { address: string; family: number }[];
      if (!list.length || (!allowPrivate && list.some((a) => privateAddress(a.address))))
        return done(new Error("Interne Adressen sind nicht erlaubt."), "", 4);
      if ((options as { all?: boolean }).all) return done(null, [list[0]]);
      done(null, list[0].address, list[0].family);
    });
}
// A POST to an outside address (webhooks), with the same pinned lookup and
// no redirects. Resolves with the status code. With allowPrivate (webhooks
// to the own network) plain http and internal addresses are fine.
export function safePost(raw: string, body: string, headers: Record<string, string>, allowPrivate = false, timeout = 10_000) {
  return new Promise<number>((resolve, reject) => {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return reject(new Error("Nur https-Adressen sind erlaubt."));
    const request = url.protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(
      url,
      { method: "POST", timeout, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: pinnedLookup(allowPrivate) as never },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung.")));
    req.on("error", reject);
    req.end(body);
  });
}
function once(url: URL, maxBytes: number, timeout: number, accept: string, allowPrivate: boolean, extra: Pick<Options, "method" | "headers" | "body"> = {}) {
  return new Promise<Fetched & { location?: string }>((resolve, reject) => {
    const request = url.protocol === "http:" ? httpRequest : httpsRequest;
    const method = extra.method || "GET";
    const req = request(
      url,
      {
        method,
        timeout,
        headers: {
          "user-agent": "Flowplan-LinkPreview/1.0",
          accept,
          ...extra.headers,
          ...(extra.body !== undefined ? { "content-length": String(Buffer.byteLength(extra.body)) } : {}),
        },
        // Resolve, check and pin the address that is used.
        lookup: pinnedLookup(allowPrivate),
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && method === "GET" && !extra.headers) {
          res.resume();
          return resolve({
            url: url.href,
            status,
            type: "",
            body: "",
            data: Buffer.alloc(0),
            headers: flatHeaders(res.headers),
            location: res.headers.location,
          });
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error("Antwort zu groß."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          resolve({
            url: url.href,
            status,
            type: String(res.headers["content-type"] || ""),
            body: data.toString("utf8"),
            data,
            headers: flatHeaders(res.headers),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung.")));
    req.on("error", reject);
    req.end(extra.body);
  });
}
export async function safeFetch(
  raw: string,
  {
    maxBytes = 1_000_000,
    timeout = 5000,
    accept = "application/json, text/html;q=0.9",
    allowPrivate = false,
    method,
    headers,
    body,
  }: Options = {},
): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Ungültige Adresse.");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (
      !(url.protocol === "https:" || (allowPrivate && url.protocol === "http:")) ||
      url.username ||
      url.password
    )
      throw new HttpError(400, "Nur öffentliche HTTPS-Adressen sind erlaubt.");
    if (
      !allowPrivate &&
      isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
      privateAddress(url.hostname.replace(/^\[|\]$/g, ""))
    )
      throw new HttpError(400, "Interne Adressen sind nicht erlaubt.");
    let result;
    try {
      result = await once(url, maxBytes, timeout, accept, allowPrivate, { method, headers, body });
    } catch (error) {
      throw new HttpError(
        502,
        `Die Seite konnte nicht geladen werden: ${(error as Error).message}`,
      );
    }
    if (!result.location) return result;
    url = new URL(result.location, url);
  }
  throw new HttpError(502, "Zu viele Weiterleitungen.");
}
