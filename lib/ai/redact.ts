// Providers sometimes echo request headers or the key itself in error
// bodies. Everything that leaves lib/ai as a message goes through this:
// the known secrets are cut out, and anything that looks like a key or an
// authorization header is masked too.
const PATTERNS: RegExp[] = [
  // Authorization: Bearer …, x-api-key: …, x-goog-api-key: …
  /\b(authorization|x-api-key|x-goog-api-key|api[-_]?key|proxy-authorization)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;}]+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // ?key=… in URLs
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi,
  // Common key shapes: OpenAI/Anthropic/OpenRouter sk-…, Google AIza…, generic long tokens with a prefix.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:gsk|xai|pplx|hf|fp|ghp|glpat)[-_][A-Za-z0-9_-]{12,}/g,
];

export function redactSecrets(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[…]");
    // Also URL-encoded and base64 spellings.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("[…]");
    const b64 = Buffer.from(secret).toString("base64").replace(/=+$/, "");
    if (b64.length >= 8) out = out.split(b64).join("[…]");
  }
  out = out.replace(PATTERNS[0], (_m, name: string, sep: string) => `${name}${sep}[…]`);
  out = out.replace(PATTERNS[1], "Bearer […]");
  out = out.replace(PATTERNS[2], (_m, head: string) => `${head}[…]`);
  for (const pattern of PATTERNS.slice(3)) out = out.replace(pattern, "[…]");
  return out;
}
