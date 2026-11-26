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
import { isIP } from "node:net";
import { privateAddress } from "./safe-fetch";

let warned = false;
let warnedInternal = false;
// Behind more proxies than FLOWPLAN_TRUSTED_PROXIES counts, the chosen
// entry is an inner proxy's own address (a Docker network, 172.22.0.5)
// while an entry before it is a public one: every sign-in then shows the
// proxy's network and everybody shares one rate-limit bucket (#583). Said
// once in the log; the address used stays as configured.
function checkInternal(chain: string[], index: number) {
  if (warnedInternal || process.env.NODE_ENV !== "production" || index === 0) return;
  const chosen = chain[index];
  if (!isIP(chosen) || !privateAddress(chosen)) return;
  if (!chain.slice(0, index).some((hop) => isIP(hop) && !privateAddress(hop))) return;
  warnedInternal = true;
  console.warn(
    `flowplan: the client address taken from X-Forwarded-For (${chosen}) is an internal one while the header names a public address before it. Flowplan probably runs behind more proxies than FLOWPLAN_TRUSTED_PROXIES (${process.env.FLOWPLAN_TRUSTED_PROXIES ?? "1"}) says – sign-ins then show the proxy's network and everybody shares one rate limit. Count every reverse proxy in front of Flowplan (e.g. 2 for a tunnel or CDN in front of Traefik).`,
  );
}
// For tests.
export function resetClientAddressWarnings() {
  warned = false;
  warnedInternal = false;
}
export function clientAddress(headers: Headers) {
  const hops = Math.min(10, Math.max(0, Number.parseInt(process.env.FLOWPLAN_TRUSTED_PROXIES ?? "1", 10)));
  const trusted = Number.isNaN(hops) ? 1 : hops;
  if (trusted === 0) return "";
  const chain = (headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length) {
    const index = Math.max(0, chain.length - trusted);
    checkInternal(chain, index);
    return chain[index].slice(0, 100);
  }
  // X-Real-IP is one value, set by the proxy right in front of Flowplan to
  // the address it saw: the client only with exactly one proxy. Behind two
  // it names the outer proxy at best (or whatever the client sent, when the
  // inner one passes it on), so it counts only with FLOWPLAN_TRUSTED_PROXIES=1.
  const real = trusted === 1 ? (headers.get("x-real-ip") || "").trim().slice(0, 100) : "";
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
