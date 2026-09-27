// The address of the person behind a request, for rate limits. Proxies
// append the address they saw to X-Forwarded-For, so everything before the
// entries of our own proxies may be made up by the client. Counted from the
// right: FLOWPLAN_TRUSTED_PROXIES is the number of proxies in front of
// Flowplan (default 1, e.g. Traefik; 2 for Pangolin in front of Traefik).
export function clientAddress(headers: Headers) {
  const hops = Math.min(
    10,
    Math.max(1, Number.parseInt(process.env.FLOWPLAN_TRUSTED_PROXIES || "1", 10) || 1),
  );
  const chain = (headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length) return chain[Math.max(0, chain.length - hops)].slice(0, 100);
  return (headers.get("x-real-ip") || "local").slice(0, 100);
}
