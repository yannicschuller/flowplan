// The address of the person behind a request, for rate limits. Proxies
// append the address they saw to X-Forwarded-For, so everything before the
// entries of our own proxies may be made up by the client. Counted from the
// right: FLOWPLAN_TRUSTED_PROXIES is the number of proxies in front of
// Flowplan (default 1, e.g. Traefik; 2 for Pangolin in front of Traefik;
// 0 trusts no header at all).
//
// Without a forwarded address the result is "" – unknown. Callers then
// fall back to their other keys (the account, the link) instead of putting
// everyone into one bucket: a shared bucket would let anyone lock the
// whole instance out, and a self-chosen header would let anyone slip out.
let warned = false;
export function clientAddress(headers: Headers) {
  const hops = Math.min(10, Math.max(0, Number.parseInt(process.env.FLOWPLAN_TRUSTED_PROXIES ?? "1", 10)));
  const trusted = Number.isNaN(hops) ? 1 : hops;
  if (trusted === 0) return "";
  const chain = (headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length) return chain[Math.max(0, chain.length - trusted)].slice(0, 100);
  const real = (headers.get("x-real-ip") || "").trim().slice(0, 100);
  if (real) return real;
  if (!warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn(
      "flowplan: a request arrived without X-Forwarded-For or X-Real-IP. Address-based limits (sign-in attempts, demo starts, anonymous answers) are off until the reverse proxy sends the client address; see FLOWPLAN_TRUSTED_PROXIES.",
    );
  }
  return "";
}
// A key for per-address limits, or none when the address is unknown.
export const addressKey = (prefix: string, address: string) => (address ? [`${prefix}:${address}`] : []);
