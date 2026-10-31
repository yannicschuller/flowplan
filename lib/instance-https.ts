// Whether the instance is served over HTTPS (#62). Production instances run
// behind a reverse proxy with TLS, but an evaluation may open plain
// http://server:3000 – then the browser must not be told to upgrade every
// request to https (that address does not exist: no CSS, no JavaScript), and
// the sign-in page and the administration say calmly what is missing.
// No imports: proxy.ts uses this for every page.

const appUrl = (value = process.env.APP_URL) => value || "http://localhost:3000";
const protocol = (url: string) => {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
};

// Loopback addresses count as a secure context in browsers: http there is
// a local test, not a setup to warn about.
export function loopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1";
}

// The instance's own address (APP_URL) is https.
export const httpsInstance = (url = appUrl()) => protocol(url) === "https:";

// APP_URL is plain http on a host other than this machine: passwords cross
// the network unencrypted, and passkeys, the offline copy, the apps, camera
// and clipboard do not work (browsers allow them in secure contexts only).
export function plainHttpInstance(url = appUrl()) {
  if (protocol(url) !== "http:") return false;
  try {
    return !loopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// "upgrade-insecure-requests" in the Content Security Policy: when the
// instance's address is https, or this request reached a TLS proxy
// (X-Forwarded-Proto) or the server itself over https. On a plain-http
// instance the directive would send every script and style to an https
// address nobody answers.
export function upgradeInsecureRequests({
  url = appUrl(),
  forwardedProto,
  requestProtocol,
}: { url?: string; forwardedProto?: string | null; requestProtocol?: string | null } = {}) {
  if (httpsInstance(url)) return true;
  if (forwardedProto?.split(",")[0].trim().toLowerCase() === "https") return true;
  return requestProtocol === "https:";
}
