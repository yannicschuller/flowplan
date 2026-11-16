// Sign-in through a trusted reverse proxy ("proxy auth", forward auth): a
// portal in front of Flowplan – YunoHost's SSOwat, Authelia, Authentik –
// signs the person in and names them in request headers (YNH_USER,
// Remote-User …). This module holds what needs no database: the settings
// (AUTH_PROXY_*), the address of the proxy the request came from, and the
// header values, checked. lib/proxy-auth.ts finds or creates the account and
// the session; lib/auth.ts ends a proxy session the headers no longer carry.
//
// Off unless AUTH_PROXY_USER_HEADER is set. The headers count only from a
// peer in AUTH_PROXY_TRUSTED_PROXIES (default 127.0.0.1 and ::1): the
// address of the TCP connection, never X-Forwarded-For. Next.js does not
// hand that address to route handlers or the proxy, so installPeerStamp()
// (instrumentation.ts) writes it into every request under a header name
// that is random per process – a client cannot send it, and requests that
// came in before it was installed carry none (the peer is then unknown and
// nothing is decided).
import { randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";

export type ProxyAuthConfig = {
  userHeader: string;
  emailHeader: string;
  nameHeader: string;
  groupsHeader: string;
  // The entries of AUTH_PROXY_TRUSTED_PROXIES that are addresses or networks.
  trustedProxies: string[];
  trusted: BlockList;
  loginUrl: string;
  logoutUrl: string;
  autoCreate: boolean;
  // The portal's name on the sign-in page ("Mit YunoHost anmelden").
  name: string;
  // The sign-in page offers the portal only (no password form).
  only: boolean;
  // Accounts that administer the instance (lowercase user names).
  adminUsers: string[];
  debug: boolean;
};

export type ProxyIdentity = {
  // Lowercase: user names at the portal do not differ by case.
  username: string;
  email: string;
  name: string;
  // null: AUTH_PROXY_GROUPS_HEADER is not set (the groups stay as they are).
  groups: string[] | null;
};

// An HTTP header name (RFC 9110 token).
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const DEFAULT_TRUSTED = "127.0.0.1,::1";

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`flowplan: ${message}`);
}

// "::ffff:127.0.0.1" → "127.0.0.1"; anything that is no address → "".
export function plainAddress(address: string) {
  const value = address.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  return isIP(value) ? value.toLowerCase() : "";
}

// "127.0.0.1", "::1", "172.18.0.0/16" – entries that are neither are left out.
function trustedList(raw: string) {
  const list = new BlockList();
  const entries: string[] = [];
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const [address, prefix, extra] = entry.split("/");
    const ip = plainAddress(address);
    const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
    const bits = prefix === undefined ? null : Number(prefix);
    if (!ip || extra !== undefined || (bits !== null && (!Number.isInteger(bits) || bits < 0 || bits > (family === "ipv6" ? 128 : 32)))) {
      warnOnce(`AUTH_PROXY_TRUSTED_PROXIES: "${entry.slice(0, 80)}" is no address or network and is ignored.`);
      continue;
    }
    if (bits === null) list.addAddress(ip, family);
    else list.addSubnet(ip, bits, family);
    entries.push(bits === null ? ip : `${ip}/${bits}`);
  }
  return { list, entries };
}

// An absolute http(s) address (or a path on this instance) – the portal's
// sign-in and sign-out pages.
function portalUrl(raw: string | undefined, name: string) {
  const value = (raw || "").trim();
  if (!value) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value.replace(/\{return(_b64)?\}/g, "x"));
    if (url.protocol === "https:" || url.protocol === "http:") return value;
  } catch {}
  warnOnce(`${name} is no http(s) address and is ignored.`);
  return "";
}

let cached: { key: string; config: ProxyAuthConfig | null } | null = null;
// The settings, or null while the feature is off.
export function proxyAuthConfig(env: NodeJS.ProcessEnv = process.env): ProxyAuthConfig | null {
  const key = JSON.stringify(
    ["USER_HEADER", "EMAIL_HEADER", "NAME_HEADER", "GROUPS_HEADER", "TRUSTED_PROXIES", "LOGIN_URL", "LOGOUT_URL", "AUTO_CREATE", "NAME", "ONLY", "ADMIN_USERS", "DEBUG"].map(
      (name) => env[`AUTH_PROXY_${name}`] ?? null,
    ),
  );
  if (cached?.key === key) return cached.config;
  const header = (name: string) => {
    const value = (env[`AUTH_PROXY_${name}`] || "").trim();
    if (!value) return "";
    if (HEADER_NAME.test(value)) return value.toLowerCase();
    warnOnce(`AUTH_PROXY_${name} is no valid header name and is ignored.`);
    return "";
  };
  const userHeader = header("USER_HEADER");
  let config: ProxyAuthConfig | null = null;
  if (userHeader) {
    const { list, entries } = trustedList(env.AUTH_PROXY_TRUSTED_PROXIES ?? DEFAULT_TRUSTED);
    config = {
      userHeader,
      emailHeader: header("EMAIL_HEADER"),
      nameHeader: header("NAME_HEADER"),
      groupsHeader: header("GROUPS_HEADER"),
      trustedProxies: entries,
      trusted: list,
      loginUrl: portalUrl(env.AUTH_PROXY_LOGIN_URL, "AUTH_PROXY_LOGIN_URL"),
      logoutUrl: portalUrl(env.AUTH_PROXY_LOGOUT_URL, "AUTH_PROXY_LOGOUT_URL"),
      autoCreate: env.AUTH_PROXY_AUTO_CREATE !== "false",
      name: (env.AUTH_PROXY_NAME || "").trim().slice(0, 40) || "SSO",
      only: env.AUTH_PROXY_ONLY === "true",
      adminUsers: (env.AUTH_PROXY_ADMIN_USERS || "")
        .split(/[\s,]+/)
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean),
      debug: env.AUTH_PROXY_DEBUG === "true",
    };
    if (!entries.length) warnOnce("AUTH_PROXY_TRUSTED_PROXIES names no address: sign-in through the proxy is off.");
  }
  cached = { key, config };
  return config;
}

// Trusted proxies beyond this machine (anything but 127.0.0.0/8 and ::1):
// then everyone who can reach Flowplan's port from there can name any user.
export function wideTrustedProxies(config: Pick<ProxyAuthConfig, "trustedProxies">) {
  const loopback = new BlockList();
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  loopback.addAddress("::1", "ipv6");
  return config.trustedProxies.filter((entry) => {
    const [ip, bits] = entry.split("/");
    const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
    if (bits !== undefined && Number(bits) < (family === "ipv6" ? 128 : 8)) return true;
    return !loopback.check(ip, family);
  });
}

// ---- The peer address ----

const PEER_KEY = Symbol.for("flowplan.peerHeader");
type PeerGlobal = { [PEER_KEY]?: string };

// The header the peer address is written to, once installPeerStamp() ran.
export const peerHeaderName = () => (globalThis as PeerGlobal)[PEER_KEY] || null;

type StampedRequest = { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } | null };
type EmitterPrototype = { emit: (this: unknown, event: string | symbol, ...args: unknown[]) => boolean };

// Writes the connection's address into every request the Node.js HTTP
// server receives, before Next.js reads the headers. `server` is
// http.Server (passed in, so this module stays importable everywhere).
export function installPeerStamp(server: { prototype: unknown }) {
  const g = globalThis as PeerGlobal;
  if (g[PEER_KEY]) return g[PEER_KEY]!;
  const name = `x-flowplan-peer-${randomBytes(12).toString("hex")}`;
  const proto = server.prototype as EmitterPrototype;
  const emit = proto.emit;
  proto.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
    if (event === "request" || event === "upgrade" || event === "checkContinue" || event === "checkExpectation") {
      const req = args[0] as StampedRequest | undefined;
      if (req?.headers) {
        delete req.headers[name];
        const address = req.socket?.remoteAddress;
        if (address) req.headers[name] = address;
      }
    }
    return emit.call(this, event, ...args);
  };
  g[PEER_KEY] = name;
  return name;
}

// The address of the connection this request came on; null when unknown
// (the stamp is not installed, or the request came in before it).
export function requestPeer(headers: Headers): string | null {
  const name = peerHeaderName();
  const value = name ? headers.get(name) : null;
  return value ? plainAddress(value) || null : null;
}

export function trustedPeer(address: string, config: Pick<ProxyAuthConfig, "trusted">) {
  const ip = plainAddress(address);
  if (!ip) return false;
  return config.trusted.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

// ---- The header values ----

// Node.js reads header bytes as Latin-1: "JÃ¼rgen" for the UTF-8 bytes of
// "Jürgen" that SSOwat passes on. Valid UTF-8 is decoded as such; anything
// else stays as it came (then it was Latin-1).
export function decodeHeaderText(value: string) {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}

// Control characters (C0, DEL, C1) and line separators never belong in a name.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function headerText(headers: Headers, name: string, max: number) {
  if (!name) return "";
  const raw = headers.get(name);
  if (!raw || raw.length > max * 4) return "";
  const value = decodeHeaderText(raw).trim();
  if (!value || value.length > max || CONTROL.test(value)) return "";
  return value;
}

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;
// What the proxy says about the person, checked; null without a usable user
// name. Call only for a request from a trusted peer.
export function readProxyIdentity(headers: Headers, config: ProxyAuthConfig): ProxyIdentity | null {
  // A comma: the header came twice (Node.js joins them) – ambiguous.
  const username = headerText(headers, config.userHeader, 128);
  if (!username || username.includes(",")) return null;
  const email = headerText(headers, config.emailHeader, 254);
  const name = headerText(headers, config.nameHeader, 200);
  let groups: string[] | null = null;
  if (config.groupsHeader) {
    const raw = headers.get(config.groupsHeader) || "";
    groups =
      raw.length > 16_384
        ? []
        : [
            ...new Set(
              // Authelia separates them with commas, Authentik with "|".
              decodeHeaderText(raw)
                .split(/[,|]/)
                .map((g) => g.trim())
                .filter((g) => g && g.length <= 256 && !CONTROL.test(g)),
            ),
          ].slice(0, 500);
  }
  return {
    username: username.toLowerCase(),
    email: EMAIL.test(email) ? email : "",
    name: name || username,
    groups,
  };
}

// Whether a session that proxy auth created for `proxyUser` ends with this
// request: the feature is off, the request did not come through a trusted
// proxy, or the proxy names someone else (or nobody: signed out at the
// portal). An unknown peer decides nothing.
export function proxySessionEnds(proxyUser: string, headers: Headers, config = proxyAuthConfig()) {
  if (!config) return true;
  const peer = requestPeer(headers);
  if (peer === null) return false;
  if (!trustedPeer(peer, config)) return true;
  return readProxyIdentity(headers, config)?.username !== proxyUser;
}

// The portal's sign-in or sign-out address with the address to come back
// to: {return} URL-encoded, {return_b64} as base64 (YunoHost's ?r=).
export function portalAddress(template: string, returnUrl: string) {
  return template
    .replace(/\{return\}/g, encodeURIComponent(returnUrl))
    .replace(/\{return_b64\}/g, encodeURIComponent(Buffer.from(returnUrl, "utf8").toString("base64")));
}

export function proxyDebug(config: ProxyAuthConfig | null, message: string) {
  if (config?.debug) console.log(`flowplan proxy auth: ${message}`);
}
