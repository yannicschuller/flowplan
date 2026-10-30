import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-security-"));
process.env.FLOWPLAN_TRUSTED_PROXIES = "1";
const { run, id, all, one, audit } = await import("../lib/db");
const events = await import("../lib/security-events");
const { noteRefusal, SECURITY_THRESHOLDS } = await import("../lib/security-detect");
const { securityAction, securityOverview, securityExport } = await import("../lib/security-admin");
const { failed, limited } = await import("../lib/local-auth");

// Events are written right after the current synchronous work.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const reset = () => {
  run("DELETE FROM security_events");
  run("DELETE FROM security_incidents");
  run("DELETE FROM security_blocks");
  run("DELETE FROM login_failures");
  events.invalidateSecurityBlocks();
};
const person = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: true, disabled: 0, created_at: "" } as Identity;
};
const headersFrom = (address: string, extra: Record<string, string> = {}) =>
  new Headers({ "x-forwarded-for": address, "user-agent": "Mozilla/5.0 (Macintosh; Mac OS X 14_0) Chrome/130.0", ...extra });

test("addresses become a network and a keyed hash, never stored themselves", async () => {
  reset();
  assert.equal(events.networkOf("203.0.113.77"), "203.0.113.0/24");
  assert.equal(events.networkOf("::ffff:198.51.100.9"), "198.51.100.0/24");
  assert.equal(events.networkOf("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(events.networkOf("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(events.networkOf("not an address"), "");
  assert.equal(events.maskSubject("maria@example.com"), "ma***@example.com");
  assert.equal(events.addressHash("203.0.113.77"), events.addressHash("::ffff:203.0.113.77"));
  assert.notEqual(events.addressHash("203.0.113.77"), events.addressHash("203.0.113.78"));
  events.securityEvent("login.failure", { address: "203.0.113.77", subject: "maria@example.com", detail: "password" });
  await settle();
  const row = one<Record<string, string>>("SELECT * FROM security_events");
  assert.ok(row);
  assert.equal(row.network, "203.0.113.0/24");
  assert.equal(row.subject, "ma***@example.com");
  assert.ok(!JSON.stringify(row).includes("203.0.113.77"));
  assert.ok(!JSON.stringify(row).includes("maria@"));
});

test("an event inside a rolled-back transaction stays", async () => {
  reset();
  run("BEGIN");
  events.securityEvent("login.refused", { address: "198.51.100.4", detail: "limit" });
  run("ROLLBACK");
  await settle();
  assert.equal(all("SELECT 1 FROM security_events WHERE kind='login.refused'").length, 1);
});

test("the log line carries the address unless anonymous; OTLP records follow the log record", () => {
  const event = {
    at: Date.UTC(2026, 9, 30, 12),
    kind: "login.failure" as const,
    severity: "warn" as const,
    actorId: null,
    subject: "ma***@example.com",
    subjectKey: "x",
    network: "203.0.113.0/24",
    addressKey: "y",
    country: "DE",
    device: "Chrome · macOS",
    detail: "password",
  };
  const full = events.securityLogRecord(event, "203.0.113.77", "on");
  assert.equal(full.ip, "203.0.113.77");
  assert.equal(full.level, "warn");
  assert.equal(full.event, "login.failure");
  assert.equal(events.securityLogRecord(event, "203.0.113.77", "anonymous").ip, undefined);
  const record = events.otlpRecord(event, "203.0.113.77");
  assert.equal(record.severityNumber, 13);
  assert.equal(record.timeUnixNano, `${event.at}000000`);
  assert.ok(record.attributes.some((a) => a.key === "flowplan.network" && a.value.stringValue === "203.0.113.0/24"));
  assert.deepEqual(events.otlpHeaders("api-key=abc,x-scope=flow%20plan"), { "api-key": "abc", "x-scope": "flow plan" });
});

test("password guessing on one account, then a correct guess, open incidents once each", async () => {
  reset();
  for (let i = 0; i < SECURITY_THRESHOLDS.accountFailures + 3; i++)
    failed([`ip:203.0.113.${10 + (i % 3)}`, "email:anna@example.test"]);
  await settle();
  const guessing = all<{ rule: string; count: number }>("SELECT rule,count FROM security_incidents");
  assert.equal(guessing.length, 1);
  assert.equal(guessing[0].rule, "brute_force_account");
  assert.equal(guessing[0].count, 4);
  const anna = person("Anna");
  events.securityEvent("login.success", { actorId: anna.id, subject: "Anna@example.test", headers: headersFrom("203.0.113.10") });
  await settle();
  assert.ok(one("SELECT 1 FROM security_incidents WHERE rule='login_after_failures' AND key=?", anna.id));
});

test("many accounts from one address is credential stuffing", async () => {
  reset();
  for (let i = 0; i < SECURITY_THRESHOLDS.stuffingAccounts; i++) failed(["ip:192.0.2.50", `email:person${i}@example.test`]);
  await settle();
  const incident = one<{ severity: string; network: string }>("SELECT severity,network FROM security_incidents WHERE rule='credential_stuffing'");
  assert.ok(incident);
  assert.equal(incident.severity, "critical");
  assert.equal(incident.network, "192.0.2.0/24");
});

test("a new device is told to the person; two countries in two hours are impossible travel", async () => {
  reset();
  process.env.FLOWPLAN_COUNTRY_HEADER = "x-country";
  const ben = person("Ben");
  const t0 = Date.now() - 60_000;
  events.securityEvent("login.success", { actorId: ben.id, headers: headersFrom("198.51.100.1", { "x-country": "DE" }), at: t0 });
  await settle();
  events.securityEvent("login.success", {
    actorId: ben.id,
    headers: new Headers({ "x-forwarded-for": "198.51.100.2", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1", "x-country": "BR" }),
  });
  await settle();
  await settle();
  assert.ok(one("SELECT 1 FROM security_incidents WHERE rule='impossible_travel' AND key=?", ben.id));
  const notice = one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='security'", ben.id);
  assert.match(notice?.body || "", /Neue Anmeldung/);
  assert.match(notice?.body || "", /iPhone/);
  delete process.env.FLOWPLAN_COUNTRY_HEADER;
});

test("activity log entries that matter become events; admin rights are an incident", async () => {
  reset();
  const admin = person("Admin");
  audit(admin.id, "space.markdown.export", "space-1");
  audit(admin.id, "ldap.enable", "instance", "ldap.example.test");
  audit(admin.id, "page.create", "page-1");
  await settle();
  const kinds = all<{ kind: string }>("SELECT kind FROM security_events ORDER BY id").map((e) => e.kind);
  assert.deepEqual(kinds, ["data.export", "admin.settings"]);
  assert.ok(one("SELECT 1 FROM security_incidents WHERE rule='privilege_change'"));
});

test("probing: many refused API requests from one address make one event", () => {
  const recorded: string[] = [];
  for (let i = 0; i < SECURITY_THRESHOLDS.probes + 10; i++) noteRefusal("192.0.2.99", 404, `/api/pages/${i}`, 1_000_000 + i, (d) => recorded.push(d));
  noteRefusal("192.0.2.99", 200, "/api/pages/x", 1_000_100, (d) => recorded.push(d));
  noteRefusal("192.0.2.98", 404, "/page", 1_000_100, (d) => recorded.push(d));
  assert.equal(recorded.length, 1);
  assert.match(recorded[0], /404 \/api\/pages\/0/);
});

test("dangerous HTML is recognised", () => {
  assert.equal(events.dangerousHtml("<p>Hallo <b>Welt</b></p>"), false);
  assert.equal(events.dangerousHtml('<img src=x onerror="alert(1)">'), true);
  assert.equal(events.dangerousHtml("<script>alert(1)</script>"), true);
  assert.equal(events.dangerousHtml('<a href="javascript:alert(1)">x</a>'), true);
  assert.equal(events.dangerousHtml("<p>Mit onboarding=gut</p>"), false);
});

test("blocks: an address or network is refused at sign-in, the own one cannot be blocked", async () => {
  reset();
  const admin = person("Root");
  failed(["ip:203.0.113.200", "email:x@example.test"]);
  await settle();
  const short = one<{ address_key: string }>("SELECT address_key FROM security_events")!.address_key.slice(0, 12);
  assert.throws(() => securityAction(admin, { action: "block.add", kind: "address", value: short, hours: 1, reason: "" }, headersFrom("203.0.113.200")), /eigene Adresse/);
  assert.throws(() => securityAction(admin, { action: "block.add", kind: "network", value: "10.0.0.0/24", hours: 1, reason: "" }, headersFrom("10.0.0.5")), /eigenes Netz/);
  const overview = securityAction(admin, { action: "block.add", kind: "address", value: short, hours: 1, reason: "Test" }, headersFrom("198.51.100.1"));
  assert.equal(overview.blocks.length, 1);
  assert.equal(events.blockedAddress("203.0.113.200"), true);
  assert.equal(events.blockedAddress("203.0.113.201"), false);
  assert.equal(limited(["ip:203.0.113.200", "email:x@example.test"]), true);
  securityAction(admin, { action: "block.add", kind: "network", value: "2001:db8:5::/48", hours: null, reason: "" }, headersFrom("198.51.100.1"));
  assert.equal(events.blockedAddress("2001:db8:5:1::7"), true);
  assert.equal(events.blockedRequest(new Headers({ "x-forwarded-for": "2001:db8:5::9" })), true);
  const id = securityOverview().blocks.find((b) => b.kind === "network")!.id;
  securityAction(admin, { action: "block.remove", id }, headersFrom("198.51.100.1"));
  assert.equal(events.blockedAddress("2001:db8:5:1::7"), false);
});

test("the overview sums up; incidents are resolved; the export holds no addresses", async () => {
  reset();
  const admin = person("Chef");
  for (let i = 0; i < SECURITY_THRESHOLDS.addressFailures; i++) failed(["ip:192.0.2.7", `email:a${i % 2}@example.test`]);
  await settle();
  const overview = securityOverview();
  assert.equal(overview.summary.failedSignIns, SECURITY_THRESHOLDS.addressFailures);
  assert.ok(overview.summary.openIncidents >= 1);
  assert.equal(overview.addresses[0].network, "192.0.2.0/24");
  assert.equal(overview.hourly.length, 24);
  assert.equal(overview.hourly.at(-1)!.failures, SECURITY_THRESHOLDS.addressFailures);
  const after = securityAction(admin, { action: "incident.resolveAll" }, headersFrom("198.51.100.1"));
  assert.equal(after.summary.openIncidents, 0);
  const csv = securityExport("csv");
  assert.match(csv.body, /login\.failure/);
  assert.ok(!csv.body.includes("192.0.2.7"));
});

test("old events go after the retention", () => {
  reset();
  run("INSERT INTO security_events(at,kind,severity) VALUES(?,?,?)", Date.now() - 100 * 86_400_000, "login.failure", "warn");
  run("INSERT INTO security_events(at,kind,severity) VALUES(?,?,?)", Date.now(), "login.failure", "warn");
  events.sweepSecurityEvents();
  assert.equal(all("SELECT 1 FROM security_events").length, 1);
});
