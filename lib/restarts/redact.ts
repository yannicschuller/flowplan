// Masking for the saved server log (lib/restarts/log-file.ts, the
// restart history of Administration → Überwachung → Neustarts). A line is
// redacted before it is written to disk and again before it is stored with
// a restart: the values of secret environment variables (names with TOKEN,
// SECRET, PASSWORD, KEY, CREDENTIAL – S3 keys, the encryption key, OIDC and
// SMTP passwords …), bearer tokens, credentials in URLs, key=value pairs
// that name a secret, the known key shapes (lib/ai/redact.ts), e-mail
// addresses and IP addresses (v4 and v6; Flowplan never stores addresses).
// docker/entrypoint.sh masks Litestream's lines the same way in awk.
import { redactSecrets } from "../ai/redact";

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL/i;
// Names that hold a path or a switch, not the secret itself.
const NOT_SECRET = /_(FILE|PATH|DIR)$/i;
// Shorter values ("on", "1", "s3") would mask ordinary words.
const MIN_SECRET = 6;

// The secret values of an environment, longest first (a secret that
// contains another one is masked whole).
export function logSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name) || NOT_SECRET.test(name)) continue;
    const v = value.trim();
    if (v.length >= MIN_SECRET && !/^(true|false|on|off)$/i.test(v)) values.add(v);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

const MASK = "[redacted]";
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // https://user:password@host, postgres://user:password@host
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, `$1${MASK}@`],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // password=…, "secret": "…", api_key: …, Authorization: …
  [/\b(pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key(?:[-_]id)?|secret[-_]?key|authorization|credentials?|private[-_]?key)(["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, `$1$2${MASK}`],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]"],
];
// IPv6 first (an IPv4-mapped address ends in a dotted quad): a run of hex
// groups with "::" or seven colons – never a time like 14:05:09.
const IPV6 = /(?<![0-9A-Za-z:.])(?=[0-9A-Fa-f:.]*:[0-9A-Fa-f.]*:)[0-9A-Fa-f:]{2,39}(?:\.\d{1,3}){0,3}(?![0-9A-Za-z:])/g;
const IPV4 = /(?<![0-9A-Za-z.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![0-9A-Za-z]|\.\d)/g;

export function maskAddresses(line: string): string {
  return line
    .replace(IPV6, (m) => (m.includes("::") || (m.match(/:/g)?.length ?? 0) >= 7 ? "[ip]" : m))
    .replace(IPV4, "[ip]");
}

export function redactLogLine(line: string, secrets: string[] = logSecrets()): string {
  let out = String(line ?? "");
  for (const secret of secrets) out = out.split(secret).join(MASK);
  // Their encoded spellings and the known key shapes.
  out = redactSecrets(out, secrets);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as string);
  return maskAddresses(out);
}
