// LDAP sign-in and group sync (lib/ldap.ts, lib/ldap-auth.ts) against a
// small fake directory speaking the BER subset over TCP.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import type { Identity } from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "flowplan-ldap-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id, one } = await import("../lib/db");
const ldap = await import("../lib/ldap");
const { ber, tlv, readTlv, children, readInt, decodeFilter, encodeFilter, parseLdapFilter, escapeFilterValue, escapeDnValue, firstRdnValue, userFilter } = ldap;
type LdapFilter = import("../lib/ldap").LdapFilter;

// ---- The fake directory ----

type Person = { password?: string; attrs: Record<string, string[]> };
const BASE = "dc=example,dc=org";
const directory = new Map<string, Person>();
const SERVICE = "cn=flowplan,ou=services,dc=example,dc=org";
function person(uid: string, extra: Record<string, string[]> = {}, password = "secret-pw") {
  directory.set(`uid=${uid},ou=people,${BASE}`, {
    password,
    attrs: { objectClass: ["inetOrgPerson"], uid: [uid], cn: [`${uid[0].toUpperCase()}${uid.slice(1)} Example`], mail: [`${uid}@example.org`], ...extra },
  });
}
directory.set(BASE, { attrs: { objectClass: ["domain"], dc: ["example"] } });
directory.set(SERVICE, { password: "service-pw", attrs: { objectClass: ["person"], cn: ["flowplan"] } });
person("alice", { memberOf: [`cn=staff,ou=groups,${BASE}`, `cn=Team\\2C Blue,ou=groups,${BASE}`] });
person("bob");
person("locked", { nsAccountLock: ["true"] });
person("eve");
const received = { filters: [] as string[], binds: [] as { dn: string; password: string }[] };

const show = (f: LdapFilter): string => {
  switch (f.type) {
    case "and":
      return `(&${f.filters.map(show).join("")})`;
    case "or":
      return `(|${f.filters.map(show).join("")})`;
    case "not":
      return `(!${show(f.filter)})`;
    case "present":
      return `(${f.attr}=*)`;
    case "substrings":
      return `(${f.attr}=${[f.initial, ...f.any, f.final].map((b) => (b ? escapeFilterValue(b.toString()) : "")).join("*")})`;
    default:
      return `(${f.attr}=${escapeFilterValue(f.value.toString())})`;
  }
};
function evaluate(f: LdapFilter, attrs: Record<string, string[]>): boolean {
  const values = (name: string) => Object.entries(attrs).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || [];
  switch (f.type) {
    case "and":
      return f.filters.every((x) => evaluate(x, attrs));
    case "or":
      return f.filters.some((x) => evaluate(x, attrs));
    case "not":
      return !evaluate(f.filter, attrs);
    case "present":
      return values(f.attr).length > 0;
    case "substrings":
      return values(f.attr).some((v) => {
        const s = v.toLowerCase();
        let at = 0;
        if (f.initial && !s.startsWith(f.initial.toString().toLowerCase())) return false;
        at = f.initial ? f.initial.length : 0;
        for (const a of f.any) {
          const i = s.indexOf(a.toString().toLowerCase(), at);
          if (i < 0) return false;
          at = i + a.length;
        }
        return !f.final || s.slice(at).endsWith(f.final.toString().toLowerCase());
      });
    default:
      return values(f.attr).some((v) => v.toLowerCase() === f.value.toString().toLowerCase());
  }
}
const result = (tag: number, code: number) => ber.seq(tag, ber.enumerated(code), ber.str(""), ber.str(""));
function serve(socket: Socket) {
  let buffer = Buffer.alloc(0);
  let bound = "";
  const send = (messageId: number, op: Buffer) => socket.write(ber.seq(0x30, ber.int(messageId), op));
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    for (let message = readTlv(buffer); message; message = readTlv(buffer)) {
      buffer = buffer.subarray(message.size);
      const [idTlv, op] = children(message.value);
      const messageId = readInt(idTlv.value);
      if (op.tag === 0x60) {
        const [, name, auth] = children(op.value);
        const dn = name.value.toString(),
          password = auth.value.toString();
        received.binds.push({ dn, password });
        const entry = [...directory.entries()].find(([k]) => k.toLowerCase() === dn.toLowerCase())?.[1];
        const ok = !!entry?.password && entry.password === password;
        bound = ok ? dn : "";
        send(messageId, result(0x61, ok ? 0 : 49));
      } else if (op.tag === 0x63) {
        const [base, scope, , , , , filterTlv, attrList] = children(op.value);
        const filter = decodeFilter(filterTlv);
        received.filters.push(show(filter));
        if (!bound) {
          send(messageId, result(0x65, 50));
          continue;
        }
        const baseDn = base.value.toString().toLowerCase();
        if (![...directory.keys()].some((k) => k.toLowerCase() === baseDn)) {
          send(messageId, result(0x65, 32));
          continue;
        }
        const wanted = children(attrList.value).map((a) => a.value.toString().toLowerCase());
        for (const [dn, entry] of directory) {
          const lower = dn.toLowerCase();
          const inScope = readInt(scope.value) === 0 ? lower === baseDn : lower.endsWith(`,${baseDn}`);
          if (!inScope || !evaluate(filter, entry.attrs)) continue;
          const attrs = Object.entries(entry.attrs).filter(([k]) => wanted.includes(k.toLowerCase()));
          send(
            messageId,
            ber.seq(
              0x64,
              ber.str(dn),
              ber.seq(0x30, ...attrs.map(([k, vs]) => ber.seq(0x30, ber.str(k), ber.seq(0x31, ...vs.map((v) => ber.str(v)))))),
            ),
          );
        }
        send(messageId, result(0x65, 0));
      } else if (op.tag === 0x42) socket.end();
      else send(messageId, result(0x78, 2));
    }
  });
}
const server = createServer(serve);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const port = (server.address() as { port: number }).port;
process.env.LDAP_URL = `ldap://127.0.0.1:${port}`;
process.env.LDAP_BASE_DN = BASE;
process.env.LDAP_BIND_DN = SERVICE;
process.env.LDAP_BIND_PASSWORD = "service-pw";
process.env.LDAP_TIMEOUT_MS = "3000";

const { ldapPasswordLogin, directoryPasswordLogin, syncLdapAccounts, testLdapConnection, ldapStatus } = await import("../lib/ldap-auth");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { afterPassword, pendingToken } = await import("../lib/two-factor");
const { twoFactorRequired } = await import("../lib/two-factor-policy");
const { hashPassword } = await import("../lib/local-auth");

// ---- BER and filters ----

test("BER: the LDAPMessage of a simple bind, lengths and integers", () => {
  const bind = ber.seq(0x30, ber.int(1), ber.seq(0x60, ber.int(3), ber.str("cn=a"), ber.str("p", 0x80)));
  assert.equal(bind.toString("hex"), "3011020101600c0201030404636e3d61800170");
  assert.equal(tlv(0x04, Buffer.alloc(300)).subarray(0, 4).toString("hex"), "0482012c");
  assert.equal(ber.int(128).toString("hex"), "02020080");
  assert.equal(readInt(Buffer.from([0xff])), -1);
  assert.equal(readInt(Buffer.from([0x01, 0x00])), 256);
  assert.equal(readTlv(Buffer.from("3005020101", "hex")), null);
  assert.throws(() => readTlv(Buffer.from("3080", "hex")), /Indefinite/);
  assert.throws(() => readTlv(Buffer.from("3084ffffffff", "hex")), /too large/);
});

test("RFC 4515 filters parse, encode and decode", () => {
  for (const f of [
    "(cn=Babs Jensen)",
    "(!(cn=Tim Howes))",
    "(&(objectClass=Person)(|(sn=Jensen)(cn=Babs J*)))",
    "(o=univ*of*mich*)",
    "(cn=*)",
    "(o=Parens R Us \\28for all your parenthetical needs\\29)",
    "(cn=\\2a)",
    "(filename=C:\\5cMyFile)",
  ]) {
    const parsed = parseLdapFilter(f);
    const encoded = encodeFilter(parsed);
    assert.deepEqual(decodeFilter(readTlv(encoded)!), parsed, f);
  }
  const parens = parseLdapFilter("(o=Parens R Us \\28for all your parenthetical needs\\29)");
  assert.equal(parens.type === "equal" && parens.value.toString(), "Parens R Us (for all your parenthetical needs)");
  assert.equal(parseLdapFilter("(cn=\\2a)").type, "equal");
  assert.equal(parseLdapFilter("(o=univ*of*mich*)").type, "substrings");
  for (const bad of ["(cn=a", "(cn=a))", "(=a)", "(cn=\\zz)", "((cn=a))"]) assert.throws(() => parseLdapFilter(bad), bad);
});

test("escaping: sign-in names never change a filter, DN values stay values", () => {
  const attack = "*)(uid=*))(|(uid=*";
  assert.equal(escapeFilterValue(attack), "\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a");
  const f = userFilter("(|(uid={user})(mail={user}))", attack);
  assert.equal(f.type, "or");
  if (f.type === "or") {
    assert.equal(f.filters.length, 2);
    for (const item of f.filters) assert.ok(item.type === "equal" && item.value.toString() === attack);
  }
  assert.equal(escapeFilterValue("a\\b\0"), "a\\5cb\\00");
  assert.equal(escapeDnValue("Smith, John+Jr <x>;=\"y\""), "Smith\\, John\\+Jr \\<x\\>\\;\\=\\\"y\\\"");
  assert.equal(escapeDnValue(" #lead trail "), "\\ #lead trail\\ ");
  assert.equal(firstRdnValue("cn=Team\\2C Blue,ou=groups,dc=x"), "Team, Blue");
  assert.equal(firstRdnValue("CN=Admins\\, Global,OU=x"), "Admins, Global");
  assert.equal(firstRdnValue("plain-name"), null);
});

// ---- The client against the fake directory ----

test("bind: right password, wrong password, unknown and empty", async () => {
  const entry = await ldap.ldapAuthenticate("alice", "secret-pw");
  assert.equal(entry.dn, `uid=alice,ou=people,${BASE}`);
  assert.equal(ldap.first(entry, "mail"), "alice@example.org");
  await assert.rejects(ldap.ldapAuthenticate("alice", "wrong"), (e: InstanceType<typeof ldap.LdapError>) => e.invalidCredentials);
  await assert.rejects(ldap.ldapAuthenticate("nobody", "secret-pw"), (e: InstanceType<typeof ldap.LdapError>) => e.invalidCredentials);
  // By e-mail address through the default filter.
  assert.equal((await ldap.ldapAuthenticate("bob@example.org", "secret-pw")).dn, `uid=bob,ou=people,${BASE}`);
  // An empty password would be an unauthenticated bind: never sent.
  const before = received.binds.length;
  await assert.rejects(ldap.ldapAuthenticate("alice", ""), (e: InstanceType<typeof ldap.LdapError>) => e.invalidCredentials);
  assert.equal(received.binds.length, before);
  assert.ok(!received.binds.some((b) => b.password === ""));
});

test("filter injection finds nobody", async () => {
  const attack = "*)(uid=*))(|(uid=*";
  await assert.rejects(ldap.ldapAuthenticate(attack, "secret-pw"), (e: InstanceType<typeof ldap.LdapError>) => e.invalidCredentials);
  assert.equal(received.filters.at(-1), `(|(uid=${escapeFilterValue(attack)})(mail=${escapeFilterValue(attack)}))`);
  // A bare wildcard is a literal star, not "anyone".
  await assert.rejects(ldap.ldapAuthenticate("*", "secret-pw"), (e: InstanceType<typeof ldap.LdapError>) => e.invalidCredentials);
});

test("unreachable server and connection test", async () => {
  const ok = await testLdapConnection();
  assert.equal(ok.ok, true);
  assert.equal(ldapStatus().lastTest?.ok, true);
  const down = await ldap.ldapTest({ ...ldap.ldapConfig()!, url: "ldap://127.0.0.1:1", timeoutMs: 1000 });
  assert.equal(down.ok, false);
  const wrongBase = await ldap.ldapTest({ ...ldap.ldapConfig()!, baseDn: "dc=nowhere" });
  assert.equal(wrongBase.ok, false);
  await assert.rejects(ldap.LdapConnection.open({ url: "http://x", startTls: false, timeoutMs: 1000 }), /ldap/);
});

// ---- Flowplan accounts ----

const admin = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", admin, `local:${admin}`, "Admin", "admin@example.org");
run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,created_at) VALUES(?,?,?,1,?)", admin, "admin@example.org", await hashPassword("local-password"), Date.now());
const owner = { id: admin, name: "Admin", email: "admin@example.org", groups: [], isAdmin: true, disabled: 0, created_at: "" } as unknown as Identity;
const wid = createWorkspace(admin, "Firma");
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "staff", role: "editor" });
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "Team, Blue", role: "viewer" });
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: `cn=ops,ou=groups,${BASE}`, role: "owner" });
const role = (userId: string) => one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, userId)?.role ?? null;
const disabled = (userId: string) => one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId)!.disabled;

test("LDAP sign-in creates a directory account; its groups feed the SSO mappings", async () => {
  const { userId, groups } = await ldapPasswordLogin("alice", "secret-pw", "203.0.113.5", "de");
  assert.ok(groups.includes("staff") && groups.includes("Team, Blue") && groups.includes(`cn=staff,ou=groups,${BASE}`));
  const user = one<{ subject: string; name: string; email: string }>("SELECT subject,name,email FROM users WHERE id=?", userId)!;
  assert.equal(user.subject, `ldap:uid=alice,ou=people,${BASE}`);
  assert.equal(user.email, "alice@example.org");
  // The route syncs memberships at sign-in; the directory groups alone do it too.
  const { syncSsoMemberships } = await import("../lib/sso-mappings");
  syncSsoMemberships(userId, []);
  assert.equal(role(userId), "editor");
  // The same person again: the same account.
  assert.equal((await ldapPasswordLogin("alice@example.org", "secret-pw", "203.0.113.5", "de")).userId, userId);
  await assert.rejects(ldapPasswordLogin("alice", "wrong", "203.0.113.5", "de"), /stimmt nicht/);
});

test("local accounts keep their password; others go to the directory", async () => {
  const local = await directoryPasswordLogin({ email: "admin@example.org", password: "local-password" }, "203.0.113.6", "de");
  assert.equal(local.userId, admin);
  await assert.rejects(directoryPasswordLogin({ email: "admin@example.org", password: "secret-pw" }, "203.0.113.6", "de"), /stimmt nicht/);
  const viaLdap = await directoryPasswordLogin({ email: "bob", password: "secret-pw" }, "203.0.113.6", "de");
  assert.ok(one("SELECT 1 FROM ldap_accounts WHERE user_id=?", viaLdap.userId));
  // A directory entry with the address of a local account never takes it over.
  person("admin2", { mail: ["admin@example.org"] });
  await assert.rejects(ldapPasswordLogin("admin2", "secret-pw", "203.0.113.6", "de"), /Konto mit Passwort/);
  directory.delete(`uid=admin2,ou=people,${BASE}`);
});

test("an existing SSO account with the same address is linked", async () => {
  const sso = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", sso, `https://idp|${sso}`, "Eve", "eve@example.org");
  assert.equal((await ldapPasswordLogin("eve", "secret-pw", "203.0.113.7", "de")).userId, sso);
});

test("disabled in the directory: no sign-in; an admin's disable stays", async () => {
  await assert.rejects(ldapPasswordLogin("locked", "secret-pw", "203.0.113.8", "de"), /deaktiviert/);
  const bob = one<{ user_id: string }>("SELECT user_id FROM ldap_accounts WHERE dn=?", `uid=bob,ou=people,${BASE}`)!.user_id;
  run("UPDATE users SET disabled=1 WHERE id=?", bob);
  await assert.rejects(ldapPasswordLogin("bob", "secret-pw", "203.0.113.8", "de"), /deaktiviert/);
  run("UPDATE users SET disabled=0 WHERE id=?", bob);
});

test("too many wrong passwords are limited", async () => {
  for (let i = 0; i < 8; i++) await assert.rejects(ldapPasswordLogin("eve", `wrong-${i}`, "198.51.100.1", "de"));
  await assert.rejects(ldapPasswordLogin("eve", "secret-pw", "198.51.100.1", "de"), /Zu viele/);
});

test("the hourly sync updates groups, disables and enables again", async () => {
  const alice = one<{ user_id: string }>("SELECT user_id FROM ldap_accounts WHERE dn=?", `uid=alice,ou=people,${BASE}`)!.user_id;
  const bob = one<{ user_id: string }>("SELECT user_id FROM ldap_accounts WHERE dn=?", `uid=bob,ou=people,${BASE}`)!.user_id;
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)",
    id(),
    alice,
    JSON.stringify(["staff"]),
    Date.now() + 3600_000,
    Date.now(),
  );
  // Alice moves from staff to ops.
  directory.get(`uid=alice,ou=people,${BASE}`)!.attrs.memberOf = [`cn=ops,ou=groups,${BASE}`, "cn=flowplan-admins,ou=groups,dc=example,dc=org"];
  // Bob leaves.
  const bobEntry = directory.get(`uid=bob,ou=people,${BASE}`)!;
  directory.delete(`uid=bob,ou=people,${BASE}`);
  const first = await syncLdapAccounts();
  assert.equal(first.ok, true, first.error || "");
  assert.equal(first.disabled, 1);
  assert.equal(role(alice), "owner");
  assert.deepEqual(JSON.parse(one<{ groups_json: string }>("SELECT groups_json FROM sessions WHERE user_id=?", alice)!.groups_json).includes("flowplan-admins"), true);
  assert.equal(one<{ is_admin: number }>("SELECT is_admin FROM ldap_accounts WHERE user_id=?", alice)!.is_admin, 1);
  assert.equal(disabled(bob), 1);
  assert.equal(ldapStatus().lastSync?.disabled, 1);
  // Back in the directory: enabled again by the next sync.
  directory.set(`uid=bob,ou=people,${BASE}`, bobEntry);
  const second = await syncLdapAccounts();
  assert.equal(second.enabled, 1);
  assert.equal(disabled(bob), 0);
  // Locked in the directory.
  bobEntry.attrs.pwdAccountLockedTime = ["000001010000Z"];
  await syncLdapAccounts();
  assert.equal(disabled(bob), 1);
  delete bobEntry.attrs.pwdAccountLockedTime;
  // A wrong base DN is an error, not "everyone left".
  process.env.LDAP_BASE_DN = "dc=nowhere";
  const broken = await syncLdapAccounts();
  assert.equal(broken.ok, false);
  assert.equal(disabled(alice), 0);
  process.env.LDAP_BASE_DN = BASE;
  // Sign-in after the directory unlocked: enabled again.
  await ldapPasswordLogin("bob", "secret-pw", "203.0.113.9", "de");
  assert.equal(disabled(bob), 0);
});

test("the two-factor policy applies to LDAP accounts as to passwords", async () => {
  const alice = one<{ user_id: string }>("SELECT user_id FROM ldap_accounts WHERE dn=?", `uid=alice,ou=people,${BASE}`)!.user_id;
  const bob = one<{ user_id: string }>("SELECT user_id FROM ldap_accounts WHERE dn=?", `uid=bob,ou=people,${BASE}`)!.user_id;
  const { saveInstanceSettings } = await import("../lib/instance-settings");
  saveInstanceSettings({ twoFactor: "admins" });
  // Alice is in the admin group, Bob is not.
  assert.equal(twoFactorRequired(alice), true);
  assert.equal(twoFactorRequired(bob), false);
  saveInstanceSettings({ twoFactor: "off" });
  run("INSERT INTO user_totp(user_id,secret,enabled,created_at) VALUES(?,?,1,?)", alice, "sealed", Date.now());
  const next = afterPassword(alice, false, "de");
  assert.ok("pending" in next);
  assert.ok(pendingToken(alice, false).split(".").length === 5);
});
