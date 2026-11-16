// Sign-in through a trusted reverse proxy (lib/proxy-auth.ts,
// lib/proxy-auth-config.ts): YunoHost's SSOwat and Authelia/Authentik
// forward auth name the person in request headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-proxy-auth-"));
for (const key of Object.keys(process.env)) if (key.startsWith("AUTH_PROXY_")) delete process.env[key];
const { run, one, id } = await import("../lib/db");
const { hash, identityFromToken, adminGroup } = await import("../lib/auth");
const config = await import("../lib/proxy-auth-config");
const { proxySignInStep, proxyStepCookies, withSessionCookie, sessionCookieValue, PROXY_ISSUER } = await import("../lib/proxy-auth");

// The peer address as the stamp writes it (installPeerStamp on a stand-in
// for http.Server).
class FakeServer {
  emit(_event: string, ..._args: unknown[]) {
    return true;
  }
}
config.installPeerStamp(FakeServer);
const peerHeader = config.peerHeaderName()!;

const YUNOHOST = {
  AUTH_PROXY_USER_HEADER: "YNH_USER",
  AUTH_PROXY_EMAIL_HEADER: "YNH_USER_EMAIL",
  AUTH_PROXY_NAME_HEADER: "YNH_USER_FULLNAME",
};
function configure(env: Record<string, string> = YUNOHOST) {
  for (const key of Object.keys(process.env)) if (key.startsWith("AUTH_PROXY_")) delete process.env[key];
  Object.assign(process.env, env);
}
// Node.js hands header bytes over as Latin-1 characters.
const latin1 = (text: string) => Buffer.from(text, "utf8").toString("latin1");
function request(values: Record<string, string>, options: { peer?: string | null; cookie?: string } = {}) {
  const headers = new Headers();
  const peer = options.peer === undefined ? "127.0.0.1" : options.peer;
  if (peer) headers.set(peerHeader, peer);
  for (const [name, value] of Object.entries(values)) headers.set(name, latin1(value));
  if (options.cookie) headers.set("cookie", `flowplan_session=${options.cookie}`);
  headers.set("user-agent", "test");
  return headers;
}
const person = (user: string, extra: Record<string, string> = {}) => ({ YNH_USER: user, YNH_USER_EMAIL: `${user.toLowerCase()}@example.test`, YNH_USER_FULLNAME: `${user} Example`, ...extra });
async function signIn(headers: Headers) {
  const step = await proxySignInStep(headers);
  assert.equal(step.kind, "signin");
  return (step as { token: string }).token;
}
const sessionRow = (token: string) => one<{ user_id: string; proxy_user: string | null; groups_json: string }>("SELECT user_id,proxy_user,groups_json FROM sessions WHERE token=?", hash(token));
const accountsNamed = async (name: string) => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE lower(name)=lower(?)", name))?.n || 0);

test("the headers are ignored while the feature is off", async () => {
  configure({});
  assert.equal(config.proxyAuthConfig(), null);
  assert.deepEqual(await proxySignInStep(request(person("off"))), { kind: "none" });
  assert.equal(await accountsNamed("off Example"), 0);
});

test("headers from a peer outside AUTH_PROXY_TRUSTED_PROXIES are ignored", async () => {
  configure();
  assert.deepEqual(await proxySignInStep(request(person("mallory"), { peer: "203.0.113.9" })), { kind: "none" });
  // A peer that is not known (no stamp, e.g. before it was installed) decides nothing either.
  assert.deepEqual(await proxySignInStep(request(person("mallory"), { peer: null })), { kind: "none" });
  // X-Forwarded-For never counts.
  assert.deepEqual(await proxySignInStep(request({ ...person("mallory"), "X-Forwarded-For": "127.0.0.1" }, { peer: "203.0.113.9" })), { kind: "none" });
  assert.equal(await accountsNamed("mallory Example"), 0);
});

test("a person without an account gets one and a session", async () => {
  configure();
  const headers = request(person("Alice"));
  const token = await signIn(headers);
  const session = await sessionRow(token);
  assert.equal(session?.proxy_user, "alice");
  const user = await one<{ name: string; email: string; email_verified: number; subject: string }>("SELECT name,email,email_verified,subject FROM users WHERE id=?", session!.user_id);
  assert.deepEqual(user, { name: "Alice Example", email: "alice@example.test", email_verified: 1, subject: "proxy:alice" });
  assert.ok(await one("SELECT 1 FROM user_identities WHERE user_id=? AND issuer=? AND subject='alice' AND provider='proxy'", session!.user_id, PROXY_ISSUER));
  const me = await identityFromToken(token, headers);
  assert.equal(me?.id, session!.user_id);
  assert.equal(me?.isAdmin, false);
  // The same person again: the same account (user names do not differ by case).
  const again = await signIn(request(person("alice")));
  assert.equal((await sessionRow(again))?.user_id, session!.user_id);
});

test("an existing session of the same person stays", async () => {
  configure();
  const headers = request(person("erin"));
  const token = await signIn(headers);
  assert.deepEqual(await proxySignInStep(request(person("erin"), { cookie: token })), { kind: "none" });
  assert.ok(await sessionRow(token));
});

test("the full name is decoded as UTF-8; control characters and absurd lengths are refused", async () => {
  configure();
  const token = await signIn(request(person("jurgen", { YNH_USER_FULLNAME: "Jürgen Łukasz 王小明" })));
  const user = await one<{ name: string }>("SELECT u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?", hash(token));
  assert.equal(user?.name, "Jürgen Łukasz 王小明");
  assert.equal(config.decodeHeaderText(latin1("Zoë")), "Zoë");
  // Not UTF-8: Latin-1 as it came.
  assert.equal(config.decodeHeaderText("Zoë"), "Zoë");
  const cfg = config.proxyAuthConfig()!;
  const read = (values: Record<string, string>) => config.readProxyIdentity(request(values), cfg);
  assert.equal(read({ YNH_USER: "a\u0001b" }), null);
  assert.equal(read({ YNH_USER: "x".repeat(129) }), null);
  assert.equal(read({ YNH_USER: "a, b" }), null, "a header that came twice");
  assert.equal(read({ YNH_USER: "   " }), null);
  const odd = read({ YNH_USER: " kim ", YNH_USER_FULLNAME: "Kim\u0085Lee", YNH_USER_EMAIL: "not an address" });
  assert.deepEqual(odd, { username: "kim", name: "kim", email: "", groups: null });
});

test("an LDAP account is found by its user name", async () => {
  configure();
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, "ldap:uid=bob,ou=people,dc=example,dc=org", "Bob Directory", "bob@directory.test");
  await run("INSERT INTO ldap_accounts(user_id,dn,username,groups_json,created_at) VALUES(?,?,?,?,?)", uid, "uid=bob,ou=people,dc=example,dc=org", "bob", JSON.stringify(["staff"]), Date.now());
  const token = await signIn(request(person("Bob")));
  const session = await sessionRow(token);
  assert.equal(session?.user_id, uid);
  // Its directory groups come along.
  assert.deepEqual(JSON.parse(session!.groups_json), ["staff"]);
  assert.ok(await one("SELECT 1 FROM user_identities WHERE user_id=? AND issuer=? AND subject='bob'", uid, PROXY_ISSUER));
});

test("an SSO account is linked by its confirmed e-mail address", async () => {
  configure();
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, "https://id.example|sub-9", "Sam SSO", "sam@example.test");
  await run("INSERT INTO user_identities(id,user_id,provider,issuer,subject,email,created_at) VALUES(?,?,'oidc',?,?,?,?)", id(), uid, "https://id.example", "sub-9", "sam@example.test", Date.now());
  const token = await signIn(request(person("sam")));
  assert.equal((await sessionRow(token))?.user_id, uid);
});

test("an account with e-mail and password is never taken over by its address", async () => {
  configure();
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, "Carol Local", "carol@example.test");
  await run("INSERT INTO local_accounts(user_id,email,password_hash,created_at) VALUES(?,?,?,?)", uid, "carol@example.test", "scrypt$x", Date.now());
  assert.deepEqual(await proxySignInStep(request(person("carol"))), { kind: "none" });
  assert.equal(await one("SELECT 1 FROM sessions WHERE user_id=?", uid), undefined);
  assert.equal(await one("SELECT 1 FROM user_identities WHERE issuer=? AND subject='carol'", PROXY_ISSUER), undefined);
  assert.equal(await accountsNamed("carol Example"), 0);
});

test("a disabled account is refused; without AUTH_PROXY_AUTO_CREATE nobody new gets in", async () => {
  configure();
  const token = await signIn(request(person("dora")));
  const uid = (await sessionRow(token))!.user_id;
  await run("UPDATE users SET disabled=1 WHERE id=?", uid);
  assert.deepEqual(await proxySignInStep(request(person("dora"))), { kind: "none" });
  configure({ ...YUNOHOST, AUTH_PROXY_AUTO_CREATE: "false" });
  assert.deepEqual(await proxySignInStep(request(person("newcomer"))), { kind: "none" });
  assert.equal(await accountsNamed("newcomer Example"), 0);
});

test("a proxy session ends when the header names someone else or nobody", async () => {
  configure();
  const first = await signIn(request(person("frank")));
  // Switched user at the portal: Frank's session ends, Grace's begins.
  const step = await proxySignInStep(request(person("grace"), { cookie: first }));
  assert.equal(step.kind, "signin");
  assert.equal(await sessionRow(first), undefined);
  const second = (step as { token: string }).token;
  assert.equal((await sessionRow(second))?.proxy_user, "grace");
  // Signed out at the portal: the header is gone.
  assert.deepEqual(await proxySignInStep(request({}, { cookie: second })), { kind: "end" });
  assert.equal(await sessionRow(second), undefined);
  // The same for requests that do not pass proxy.ts (lib/auth.ts).
  const third = await signIn(request(person("grace")));
  assert.ok(await identityFromToken(third, request(person("grace"))));
  assert.equal(await identityFromToken(third, request({})), null);
  assert.equal(await sessionRow(third), undefined);
  const fourth = await signIn(request(person("grace")));
  assert.equal(await identityFromToken(fourth, request(person("frank"))), null);
  // From a peer that is not trusted, the session does not count.
  const fifth = await signIn(request(person("grace")));
  assert.equal(await identityFromToken(fifth, request(person("grace"), { peer: "198.51.100.4" })), null);
  // An unknown peer decides nothing; turning the feature off ends it.
  const sixth = await signIn(request(person("grace")));
  assert.ok(await identityFromToken(sixth, request({}, { peer: null })));
  configure({});
  assert.equal(await identityFromToken(sixth, request(person("grace"))), null);
});

test("sessions from other sign-ins do not depend on the headers", async () => {
  configure();
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, "Hana", "hana@example.test");
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,last_seen) VALUES(?,?,?,?,?,?)",
    hash("password-session"),
    uid,
    "[]",
    Date.now() + 3_600_000,
    Date.now(),
    Date.now(),
  );
  assert.ok(await identityFromToken("password-session", request({})));
  assert.ok(await identityFromToken("password-session", request(person("ivan"))));
  assert.deepEqual(await proxySignInStep(request(person("ivan"), { cookie: "password-session" })), { kind: "none" });
  assert.deepEqual(await proxySignInStep(request({}, { cookie: "password-session" })), { kind: "none" });
  assert.ok(await one("SELECT 1 FROM sessions WHERE token=?", hash("password-session")));
  // Scripts with an API token never get a cookie.
  const scripted = request(person("ivan"));
  scripted.set("authorization", "Bearer fp_x");
  assert.deepEqual(await proxySignInStep(scripted), { kind: "none" });
});

test("groups from AUTH_PROXY_GROUPS_HEADER and AUTH_PROXY_ADMIN_USERS give admin rights", async () => {
  configure({
    AUTH_PROXY_USER_HEADER: "Remote-User",
    AUTH_PROXY_EMAIL_HEADER: "Remote-Email",
    AUTH_PROXY_NAME_HEADER: "Remote-Name",
    AUTH_PROXY_GROUPS_HEADER: "Remote-Groups",
    AUTH_PROXY_ADMIN_USERS: "Root",
  });
  const authelia = (user: string, groups: string) => request({ "Remote-User": user, "Remote-Email": `${user}@example.test`, "Remote-Name": user, "Remote-Groups": groups });
  const token = await signIn(authelia("judy", `dev, ${adminGroup()} |dev`));
  assert.deepEqual(JSON.parse((await sessionRow(token))!.groups_json), ["dev", adminGroup()]);
  assert.equal((await identityFromToken(token, authelia("judy", `dev,${adminGroup()}`)))?.isAdmin, true);
  // The groups change at the proxy: the session follows.
  const cookieHeaders = authelia("judy", "dev");
  cookieHeaders.set("cookie", `flowplan_session=${token}`);
  assert.deepEqual(await proxySignInStep(cookieHeaders), { kind: "none" });
  assert.deepEqual(JSON.parse((await sessionRow(token))!.groups_json), ["dev"]);
  const root = await signIn(authelia("root", ""));
  assert.equal((await identityFromToken(root, authelia("root", "")))?.isAdmin, true);
});

test("trusted proxies: addresses, networks, IPv4 in IPv6; the warning beyond this machine", () => {
  configure({ AUTH_PROXY_USER_HEADER: "Remote-User", AUTH_PROXY_TRUSTED_PROXIES: "127.0.0.1, ::1 172.18.0.0/16 bogus 10.0.0.1/40" });
  const cfg = config.proxyAuthConfig()!;
  assert.deepEqual(cfg.trustedProxies, ["127.0.0.1", "::1", "172.18.0.0/16"]);
  assert.equal(config.trustedPeer("::ffff:127.0.0.1", cfg), true);
  assert.equal(config.trustedPeer("172.18.4.2", cfg), true);
  assert.equal(config.trustedPeer("172.19.0.1", cfg), false);
  assert.equal(config.trustedPeer("", cfg), false);
  assert.deepEqual(config.wideTrustedProxies(cfg), ["172.18.0.0/16"]);
  configure({ AUTH_PROXY_USER_HEADER: "Remote-User" });
  assert.deepEqual(config.proxyAuthConfig()!.trustedProxies, ["127.0.0.1", "::1"]);
  assert.deepEqual(config.wideTrustedProxies(config.proxyAuthConfig()!), []);
  assert.deepEqual(config.wideTrustedProxies({ trustedProxies: ["127.0.0.0/8", "0.0.0.0/0"] }), ["0.0.0.0/0"]);
  // A header name that is none: off.
  configure({ AUTH_PROXY_USER_HEADER: "Remote User" });
  assert.equal(config.proxyAuthConfig(), null);
});

test("the stamp writes the connection's address and overwrites what a client sent", () => {
  assert.match(peerHeader, /^x-flowplan-peer-[0-9a-f]{24}$/);
  const forged = { headers: { [peerHeader]: "127.0.0.1", host: "x" } as Record<string, string | undefined>, socket: { remoteAddress: "203.0.113.7" } };
  new FakeServer().emit("request", forged);
  assert.equal(forged.headers[peerHeader], "203.0.113.7");
  // No address (a closed socket): no stamp, so the peer is unknown.
  const closed = { headers: { [peerHeader]: "127.0.0.1" } as Record<string, string | undefined>, socket: null };
  new FakeServer().emit("request", closed);
  assert.equal(closed.headers[peerHeader], undefined);
  // Other events pass untouched; a second install keeps the first name.
  const other = { headers: { [peerHeader]: "127.0.0.1" } as Record<string, string | undefined> };
  new FakeServer().emit("connection", other);
  assert.equal(other.headers[peerHeader], "127.0.0.1");
  assert.equal(config.installPeerStamp(class {}), peerHeader);
});

test("the portal addresses and the cookie handling", () => {
  assert.equal(
    config.portalAddress("https://example.org/yunohost/sso/?r={return_b64}", "https://example.org/flowplan/"),
    `https://example.org/yunohost/sso/?r=${encodeURIComponent(Buffer.from("https://example.org/flowplan/").toString("base64"))}`,
  );
  assert.equal(config.portalAddress("https://auth.example.org/?rd={return}", "https://a.example/#page=1"), "https://auth.example.org/?rd=https%3A%2F%2Fa.example%2F%23page%3D1");
  assert.equal(config.portalAddress("https://example.org/yunohost/sso/?action=logout", "x"), "https://example.org/yunohost/sso/?action=logout");
  configure({ ...YUNOHOST, AUTH_PROXY_LOGIN_URL: "javascript:alert(1)", AUTH_PROXY_LOGOUT_URL: "https://example.org/yunohost/sso/?action=logout" });
  assert.equal(config.proxyAuthConfig()!.loginUrl, "");
  assert.equal(config.proxyAuthConfig()!.logoutUrl, "https://example.org/yunohost/sso/?action=logout");
  assert.equal(withSessionCookie("a=1; flowplan_session=old; b=2", "new"), "a=1; b=2; flowplan_session=new");
  assert.equal(withSessionCookie("flowplan_session=old", null), "");
  assert.equal(sessionCookieValue("x=1; flowplan_session=abc"), "abc");
  const headers = new Headers({ cookie: "flowplan_session=old; theme=dark" });
  const jar: Record<string, string> = {};
  proxyStepCookies({ kind: "signin", token: "tok", maxAge: 60 })!.request(headers);
  proxyStepCookies({ kind: "signin", token: "tok", maxAge: 60 })!.response({ cookies: { set: (n: string, v: string) => (jar[n] = v), delete: (n: string) => delete jar[n] } });
  assert.equal(headers.get("cookie"), "theme=dark; flowplan_session=tok");
  assert.deepEqual(jar, { flowplan_session: "tok" });
  assert.equal(proxyStepCookies({ kind: "none" }), null);
});
