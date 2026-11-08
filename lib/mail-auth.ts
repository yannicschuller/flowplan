// Whether an incoming e-mail's sender is authenticated (docs/specs/workflows.md
// §9.7): "pass", "fail" or "unknown", from the verdict of the receiving
// server or provider – Authentication-Results (RFC 8601), Mailgun's and
// SendGrid's fields. `From` is easy to forge, so a pass only counts when it
// is aligned with the From domain: DMARC decides when it is there; else a
// passing DKIM signature (header.d) or SPF check (smtp.mailfrom) of the
// From domain or a parent of it. A pass for another domain (the sender's
// own) proves nothing about From and stays "unknown"; any failure of the
// From domain is "fail".
//
// Which header counts: an attacker can put an Authentication-Results header
// into the message; the receiving server adds its own on top. With
// INBOUND_MAIL_AUTHSERV_ID only headers of that server count; without, only
// the topmost one. No database access here.

export type MailVerdict = "pass" | "fail" | "unknown";

// The domain of an address – or the value itself when it is a bare domain
// (smtp.mailfrom may name only the domain).
const domainOf = (address: string) => {
  const v = address.trim().toLowerCase().replace(/^<|[>\s]+$/g, "");
  const at = v.lastIndexOf("@");
  if (at >= 0) return v.slice(at + 1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : "";
};
// Relaxed alignment (DMARC): the same domain, or one is a subdomain of the other.
const aligned = (domain: string, from: string) => !!domain && !!from && (domain === from || from.endsWith(`.${domain}`) || domain.endsWith(`.${from}`));

type Result = { method: string; result: string; props: Record<string, string> };
// The results of one Authentication-Results value: "authserv-id; method=result prop=value …; …".
export function parseAuthResults(value: string): { authserv: string; results: Result[] } {
  const text = value.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const [authserv, ...parts] = text.split(";");
  const results: Result[] = [];
  for (const part of parts) {
    const tokens = part.trim().split(" ").filter(Boolean);
    const head = /^([a-z0-9-]+)=([a-z]+)$/i.exec(tokens[0] || "");
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const t of tokens.slice(1)) {
      const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)?)=(.+)$/i.exec(t);
      if (m) props[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, "").toLowerCase();
    }
    results.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props });
  }
  return { authserv: (authserv || "").trim().split(" ")[0].toLowerCase(), results };
}

export function verdictFromResults(results: Result[], from: string): MailVerdict {
  const fromDomain = domainOf(from);
  const dmarc = results.find((r) => r.method === "dmarc");
  if (dmarc) {
    if (dmarc.result === "pass") return "pass";
    if (dmarc.result === "fail") return "fail";
  }
  let pass = false,
    fail = false;
  for (const r of results) {
    const domain =
      r.method === "dkim" ? r.props["header.d"] || domainOf(r.props["header.i"] || "") : r.method === "spf" ? domainOf(r.props["smtp.mailfrom"] || "") || r.props["smtp.helo"] || "" : "";
    if (r.method !== "dkim" && r.method !== "spf") continue;
    if (!aligned(domain, fromDomain)) {
      // A failure without a domain we can compare is still a failure.
      if (!domain && r.result === "fail") fail = true;
      continue;
    }
    if (r.result === "pass") pass = true;
    else if (r.result === "fail" || r.result === "softfail" || r.result === "permerror") fail = true;
  }
  return fail ? "fail" : pass ? "pass" : "unknown";
}

// The verdict from the headers of a message (in their order, topmost first).
export function mailVerdict(headers: Map<string, string[]> | [string, string][], from: string, authservId = process.env.INBOUND_MAIL_AUTHSERV_ID?.trim().toLowerCase() || ""): MailVerdict {
  const all = (name: string) =>
    headers instanceof Map ? headers.get(name) || [] : headers.filter(([k]) => String(k).toLowerCase() === name).map(([, v]) => String(v));
  const values = all("authentication-results").map(parseAuthResults);
  const trusted = authservId ? values.filter((v) => v.authserv === authservId) : values.slice(0, 1);
  if (trusted.length) return verdictFromResults(trusted.flatMap((v) => v.results), from);
  // Mailgun's own headers: a failure counts, a pass cannot be aligned.
  const mailgun = [...all("x-mailgun-spf"), ...all("x-mailgun-dkim-check-result")].map((v) => v.trim().toLowerCase());
  if (mailgun.some((v) => v === "fail")) return "fail";
  return "unknown";
}

// SendGrid Inbound Parse: SPF ("pass", "fail" …, without a domain) and dkim
// ("{@example.org : pass}").
export function sendgridVerdict(spf: string, dkim: string, from: string): MailVerdict {
  const fromDomain = domainOf(from);
  let pass = false,
    fail = /^(fail|softfail)$/i.test(spf.trim());
  for (const m of dkim.matchAll(/@([a-z0-9.-]+)\s*:\s*([a-z]+)/gi)) {
    if (!aligned(m[1].toLowerCase(), fromDomain)) continue;
    if (m[2].toLowerCase() === "pass") pass = true;
    else if (m[2].toLowerCase() === "fail") fail = true;
  }
  return fail ? "fail" : pass ? "pass" : "unknown";
}
