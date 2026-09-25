import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { HttpError } from "./auth";

// Fetches public HTTPS resources for link previews without reaching
// internal services: every hop is resolved, private and special addresses
// are refused, and the connection uses exactly the checked address.
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
export function privateAddress(ip: string) {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]);
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("64:ff9b:") ||
    lower.startsWith("2001:db8")
  );
}
type Fetched = { url: string; status: number; type: string; body: string };
function once(url: URL, maxBytes: number, timeout: number) {
  return new Promise<Fetched & { location?: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        timeout,
        headers: {
          "user-agent": "Flowplan-LinkPreview/1.0",
          accept: "application/json, text/html;q=0.9",
        },
        // Resolve, check and pin the address that is used.
        lookup: (host, options, callback) =>
          dnsLookup(host, { all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            const list = addresses as { address: string; family: number }[];
            if (!list.length || list.some((a) => privateAddress(a.address)))
              return callback(
                new Error("Interne Adressen sind nicht erlaubt."),
                "",
                4,
              );
            if ((options as { all?: boolean }).all)
              return (
                callback as unknown as (
                  e: null,
                  a: { address: string; family: number }[],
                ) => void
              )(null, [list[0]]);
            callback(null, list[0].address, list[0].family);
          }),
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({
            url: url.href,
            status,
            type: "",
            body: "",
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
        res.on("end", () =>
          resolve({
            url: url.href,
            status,
            type: String(res.headers["content-type"] || ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung.")));
    req.on("error", reject);
    req.end();
  });
}
export async function safeFetch(
  raw: string,
  { maxBytes = 1_000_000, timeout = 5000 } = {},
): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Ungültige Adresse.");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || url.username || url.password)
      throw new HttpError(400, "Nur öffentliche HTTPS-Adressen sind erlaubt.");
    if (
      isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
      privateAddress(url.hostname.replace(/^\[|\]$/g, ""))
    )
      throw new HttpError(400, "Interne Adressen sind nicht erlaubt.");
    let result;
    try {
      result = await once(url, maxBytes, timeout);
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
