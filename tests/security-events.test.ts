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
const { securityAction, securityOverview, securityExport, securityIncident, securityIncidents } = await import("../lib/security-admin");
const { failed, limited } = await import("../lib/local-auth");

// Events are written right after the current synchronous work.
// The events are written after the current work; on Postgres over the network.
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await events.securityWritesSettled();
};
const reset = async () => {
  await run("DELETE FROM security_events");
  await run("DELETE FROM security_incidents");
  await run("DELETE FROM security_blocks");
  await run("DELETE FROM login_failures");
  events.invalidateSecurityBlocks();
};
const person = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: true, disabled: 0, created_at: "" } as Identity;
};
const headersFrom = (address: string, extra: Record<string, string> = {}) =>
  new Headers({ "x-forwarded-for": address, "user-agent": "Mozilla/5.0 (Macintosh; Mac OS X 14_0) Chrome/130.0", ...extra });

test("addresses become a network and a keyed hash, never stored themselves", async () => {
  await reset();
  assert.equal(events.networkOf("203.0.113.77"), "203.0.113.0/24");
  assert.equal(events.networkOf("::ffff:198.51.100.9"), "198.51.100.0/24");
  assert.equal(events.networkOf("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(events.networkOf("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(events.networkOf("not an address"), "");
  assert.equal(events.maskSubject("maria@example.com"), "ma***@example.com");
  assert.equal(await events.addressHash("203.0.113.77"), await events.addressHash("::ffff:203.0.113.77"));
  assert.notEqual(await events.addressHash("203.0.113.77"), await events.addressHash("203.0.113.78"));
  events.securityEvent("login.failure", { address: "203.0.113.77", subject: "maria@example.com", detail: "password" });
  await settle();
  const row = await one<Record<string, string>>("SELECT * FROM security_events");
  assert.ok(row);
  assert.equal(row.network, "203.0.113.0/24");
  assert.equal(row.subject, "ma***@example.com");
  assert.ok(!JSON.stringify(row).includes("203.0.113.77"));
  assert.ok(!JSON.stringify(row).includes("maria@"));
});

test("an event inside a rolled-back transaction stays", async () => {
  await reset();
  await run("BEGIN");
  events.securityEvent("login.refused", { address: "198.51.100.4", detail: "limit" });
  await run("ROLLBACK");
  await settle();
  assert.equal((await all("SELECT 1 FROM security_events WHERE kind='login.refused'")).length, 1);
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
  await reset();
  for (let i = 0; i < SECURITY_THRESHOLDS.accountFailures + 3; i++)
    await failed([`ip:203.0.113.${10 + (i % 3)}`, "email:anna@example.test"]);
  await settle();
  const guessing = await all<{ rule: string; count: number }>("SELECT rule,count FROM security_incidents");
  assert.equal(guessing.length, 1);
  assert.equal(guessing[0].rule, "brute_force_account");
  assert.equal(guessing[0].count, 4);
  const anna = await person("Anna");
  events.securityEvent("login.success", { actorId: anna.id, subject: "Anna@example.test", headers: headersFrom("203.0.113.10") });
  await settle();
  assert.ok(await one("SELECT 1 FROM security_incidents WHERE rule='login_after_failures' AND key=?", anna.id));
});

test("many accounts from one address is credential stuffing", async () => {
  await reset();
  for (let i = 0; i < SECURITY_THRESHOLDS.stuffingAccounts; i++) await failed(["ip:192.0.2.50", `email:person${i}@example.test`]);
  await settle();
  const incident = await one<{ id: string; severity: string; network: string }>("SELECT id,severity,network FROM security_incidents WHERE rule='credential_stuffing'");
  assert.ok(incident);
  // Every account on its own, though their masked names look alike.
  assert.equal((await securityIncident(incident.id)).accounts.length, SECURITY_THRESHOLDS.stuffingAccounts);
  assert.equal(incident.severity, "critical");
  assert.equal(incident.network, "192.0.2.0/24");
});

test("a new device is told to the person; two countries in two hours are impossible travel", async () => {
  await reset();
  process.env.FLOWPLAN_COUNTRY_HEADER = "x-country";
  const ben = await person("Ben");
  const t0 = Date.now() - 60_000;
  events.securityEvent("login.success", { actorId: ben.id, headers: headersFrom("198.51.100.1", { "x-country": "DE" }), at: t0 });
  await settle();
  events.securityEvent("login.success", {
    actorId: ben.id,
    headers: new Headers({ "x-forwarded-for": "198.51.100.2", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1", "x-country": "BR" }),
  });
  await settle();
  await settle();
  assert.ok(await one("SELECT 1 FROM security_incidents WHERE rule='impossible_travel' AND key=?", ben.id));
  const notice = await one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='security'", ben.id);
  assert.match(notice?.body || "", /Neue Anmeldung/);
  assert.match(notice?.body || "", /iPhone/);
  // The inbox shows it in the person's language (#206).
  const { englishMessage, localizedMessage } = await import("../lib/i18n-errors");
  await (await import("../lib/i18n-catalogs-server")).ensureCatalog("fr");
  const english = englishMessage(notice!.body);
  assert.match(english, /^New sign-in to your account: .*iPhone.*\. Wasn't you\?/);
  assert.match(localizedMessage(notice!.body, "fr"), /^Nouvelle connexion à votre compte : .*iPhone/);
  delete process.env.FLOWPLAN_COUNTRY_HEADER;
});

test("activity log entries that matter become events; admin rights are an incident", async () => {
  await reset();
  const admin = await person("Admin");
  await audit(admin.id, "space.markdown.export", "space-1");
  await audit(admin.id, "ldap.enable", "instance", "ldap.example.test");
  await audit(admin.id, "page.create", "page-1");
  await settle();
  const kinds = (await all<{ kind: string }>("SELECT kind FROM security_events ORDER BY id")).map((e) => e.kind);
  assert.deepEqual(kinds, ["data.export", "admin.settings"]);
  assert.ok(await one("SELECT 1 FROM security_incidents WHERE rule='privilege_change'"));
});

// The production build evaluates lib/security-events.ts once per route
// bundle that includes it; every copy registered its listener again, and one
// deleted account became four "account.deleted" events.
test("a second copy of the module (another route bundle) does not write each event again", async () => {
  await reset();
  const admin = await person("Bundles");
  await import(`../lib/security-events.ts?bundle=${Date.now()}`);
  await import(`../lib/security-events.ts?bundle=${Date.now() + 1}`);
  await audit(admin.id, "account.delete", admin.id);
  await settle();
  const kinds = (await all<{ kind: string }>("SELECT kind FROM security_events")).map((e) => e.kind);
  assert.deepEqual(kinds, ["account.deleted"]);
});

test("probing: many refused API requests from one address make one event", async () => {
  const recorded: string[] = [];
  for (let i = 0; i < SECURITY_THRESHOLDS.probes + 10; i++) await noteRefusal("192.0.2.99", 404, `/api/pages/${i}`, 1_000_000 + i, (d) => recorded.push(d));
  await noteRefusal("192.0.2.99", 200, "/api/pages/x", 1_000_100, (d) => recorded.push(d));
  await noteRefusal("192.0.2.98", 404, "/page", 1_000_100, (d) => recorded.push(d));
  assert.equal(recorded.length, 1);
  assert.match(recorded[0], /404 \/api\/pages\/0/);
});

test("probing: a tab whose session ended keeps polling – no event (#535)", async () => {
  const recorded: string[] = [];
  const note = (status: number, path: string, at: number) => noteRefusal("192.0.2.120", status, path, at, (d) => recorded.push(d));
  const ws = "5aa9f3fa-1912-4c2b-9e8a-0123456789ab";
  for (let i = 0; i < SECURITY_THRESHOLDS.probes * 3; i++) {
    // The live stream, the activity ping, the notices and the timed refresh.
    await note(401, `/api/live?workspace=${ws}`, 3_000_000 + i);
    await note(401, "/api/activity", 3_000_000 + i);
    await note(401, "/api/maintenance", 3_000_000 + i);
    await note(401, `/api/bootstrap?workspace=${ws}`, 3_000_000 + i);
    await note(401, "/api/ai/quota", 3_000_000 + i);
  }
  assert.deepEqual(recorded, []);
});

test("probing: polling a deleted record or a forbidden page counts once (#535)", async () => {
  const recorded: string[] = [];
  const page = "5aa9f3fa-1912-4c2b-9e8a-0123456789ab",
    row = "6bb9f3fa-1912-4c2b-9e8a-0123456789ab";
  for (let i = 0; i < SECURITY_THRESHOLDS.probes * 3; i++) {
    await noteRefusal("2001:db8:77::5", 404, `/api/pages/${page}/rows/${row}`, 4_000_000 + i * 100, (d) => recorded.push(d));
    await noteRefusal("2001:db8:77::5", 403, `/api/ai/block?target=${page}&kind=page`, 4_000_000 + i * 100, (d) => recorded.push(d));
    await noteRefusal("2001:db8:77::5", 404, `/api/pages/${page}?t=${i}`, 4_000_000 + i * 100, (d) => recorded.push(d));
  }
  assert.deepEqual(recorded, []);
});

test("probing: many different IDs still count – also with 401 and among polling (#535)", async () => {
  const recorded: string[] = [];
  for (let i = 0; i < SECURITY_THRESHOLDS.probes; i++) {
    // Noise of an open tab in between does not hide it, nor add to it.
    await noteRefusal("192.0.2.121", 401, "/api/live?workspace=x", 5_000_000 + i, (d) => recorded.push(d));
    await noteRefusal("192.0.2.121", 404, "/api/pages/same", 5_000_000 + i, (d) => recorded.push(d));
    await noteRefusal("192.0.2.121", 401, `/api/files/${i}`, 5_000_000 + i, (d) => recorded.push(d));
  }
  assert.equal(recorded.length, 1);
  // 59 different files plus /api/pages/same: the 60th different request fires it.
  assert.match(recorded[0], new RegExp(`^${SECURITY_THRESHOLDS.probes} verschiedene Anfragen mit 401/403/404 \\(\\d+ insgesamt\\), z\\. B\\. 404 /api/pages/same$`));
  // The same path with another answer is another request.
  const other: string[] = [];
  for (let i = 0; i < SECURITY_THRESHOLDS.probes / 2; i++) {
    await noteRefusal("192.0.2.122", 403, `/api/admin/users/${i}`, 6_000_000 + i, (d) => other.push(d));
    await noteRefusal("192.0.2.122", 404, `/api/admin/users/${i}`, 6_000_000 + i, (d) => other.push(d));
  }
  assert.equal(other.length, 1);
  // A new window starts over.
  const later: string[] = [];
  for (let i = 0; i < SECURITY_THRESHOLDS.probes - 1; i++) await noteRefusal("192.0.2.123", 404, `/api/pages/${i}`, 7_000_000 + i, (d) => later.push(d));
  await noteRefusal("192.0.2.123", 404, "/api/pages/last", 7_000_000 + SECURITY_THRESHOLDS.probeWindow + 1, (d) => later.push(d));
  assert.deepEqual(later, []);
});

test("probing keeps the refused paths with their answers on the incident", async () => {
  await reset();
  const uuid = "5aa9f3fa-1912-4c2b-9e8a-0123456789ab";
  for (let i = 0; i < SECURITY_THRESHOLDS.probes; i++) {
    const [status, path] = i % 3 === 0 ? [401, `/api/files/${i}`] : i % 3 === 1 ? [404, `/api/pages/${uuid.slice(0, -2)}${String(i).padStart(2, "0")}`] : [403, `/api/admin/users/${i}`];
    await noteRefusal("198.51.100.77", status, path, 2_000_000 + i, (detail) =>
      events.securityEvent("request.probing", { headers: headersFrom("198.51.100.77"), detail }),
    );
  }
  await settle();
  const incident = await one<{ id: string }>("SELECT id FROM security_incidents WHERE rule='probing'");
  assert.ok(incident);
  const d = await securityIncident(incident.id);
  assert.deepEqual(d.evidence?.statuses, { "401": 20, "404": 20, "403": 20 });
  assert.deepEqual(
    d.evidence?.paths.map((p) => `${p.status} ${p.path} ${p.count}`).sort(),
    ["401 /api/files/:n 20", "403 /api/admin/users/:n 20", "404 /api/pages/:id 20"],
  );
  assert.match(d.reason.de, /401, 403 oder 404/);
  assert.equal(d.events[0].kind, "request.probing");
  assert.deepEqual(d.networks.map((n) => n.value), ["198.51.100.0/24"]);
  await assert.rejects(async () => await securityIncident("nope"), /Ungültiger Vorfall/);
});

test("an incident shows the accounts tried, the successful sign-in and its events", async () => {
  await reset();
  const carla = await person("Carla");
  for (let i = 0; i < SECURITY_THRESHOLDS.accountFailures; i++) await failed(["ip:203.0.113.20", "email:carla@example.test"]);
  await settle();
  events.securityEvent("login.success", { actorId: carla.id, subject: "carla@example.test", headers: headersFrom("203.0.113.20") });
  await settle();
  const guessing = await one<{ id: string }>("SELECT id FROM security_incidents WHERE rule='brute_force_account'");
  assert.ok(guessing);
  const d = await securityIncident(guessing.id);
  assert.equal(d.total, SECURITY_THRESHOLDS.accountFailures + 1);
  assert.equal(d.accounts.length, 1);
  assert.equal(d.accounts[0].n, SECURITY_THRESHOLDS.accountFailures);
  assert.deepEqual(d.successes, [{ who: "Carla", n: 1 }]);
  assert.equal(d.events[0].kind, "login.success");
  assert.ok(d.kinds.some((k) => k.value === "login.failure" && k.n === SECURITY_THRESHOLDS.accountFailures));
  assert.equal(d.blocked.length, 0);
});

test("dangerous HTML is recognised", () => {
  assert.equal(events.dangerousHtml("<p>Hallo <b>Welt</b></p>"), false);
  assert.equal(events.dangerousHtml('<img src=x onerror="alert(1)">'), true);
  assert.equal(events.dangerousHtml("<script>alert(1)</script>"), true);
  assert.equal(events.dangerousHtml('<a href="javascript:alert(1)">x</a>'), true);
  assert.equal(events.dangerousHtml("<p>Mit onboarding=gut</p>"), false);
});

test("blocks: an address or network is refused at sign-in, the own one cannot be blocked", async () => {
  await reset();
  const admin = await person("Root");
  await failed(["ip:203.0.113.200", "email:x@example.test"]);
  await settle();
  const short = (await one<{ address_key: string }>("SELECT address_key FROM security_events"))!.address_key.slice(0, 12);
  await assert.rejects(async () => await securityAction(admin, { action: "block.add", kind: "address", value: short, hours: 1, reason: "" }, headersFrom("203.0.113.200")), /eigene Adresse/);
  await assert.rejects(async () => await securityAction(admin, { action: "block.add", kind: "network", value: "10.0.0.0/24", hours: 1, reason: "" }, headersFrom("10.0.0.5")), /eigenes Netz/);
  const overview = await securityAction(admin, { action: "block.add", kind: "address", value: short, hours: 1, reason: "Test" }, headersFrom("198.51.100.1"));
  assert.equal(overview.blocks.length, 1);
  assert.equal(await events.blockedAddress("203.0.113.200"), true);
  assert.equal(await events.blockedAddress("203.0.113.201"), false);
  assert.equal(await limited(["ip:203.0.113.200", "email:x@example.test"]), true);
  await securityAction(admin, { action: "block.add", kind: "network", value: "2001:db8:5::/48", hours: null, reason: "" }, headersFrom("198.51.100.1"));
  assert.equal(await events.blockedAddress("2001:db8:5:1::7"), true);
  assert.equal(await events.blockedRequest(new Headers({ "x-forwarded-for": "2001:db8:5::9" })), true);
  const id = (await securityOverview()).blocks.find((b) => b.kind === "network")!.id;
  await securityAction(admin, { action: "block.remove", id }, headersFrom("198.51.100.1"));
  assert.equal(await events.blockedAddress("2001:db8:5:1::7"), false);
});

test("the overview sums up; incidents are resolved; the export holds no addresses", async () => {
  await reset();
  const admin = await person("Chef");
  for (let i = 0; i < SECURITY_THRESHOLDS.addressFailures; i++) await failed(["ip:192.0.2.7", `email:a${i % 2}@example.test`]);
  await settle();
  const overview = await securityOverview();
  assert.equal(overview.summary.failedSignIns, SECURITY_THRESHOLDS.addressFailures);
  assert.ok(overview.summary.openIncidents >= 1);
  assert.equal(overview.addresses[0].network, "192.0.2.0/24");
  assert.equal(overview.hourly.length, 24);
  assert.equal(overview.hourly.at(-1)!.failures, SECURITY_THRESHOLDS.addressFailures);
  const after = await securityAction(admin, { action: "incident.resolveAll" }, headersFrom("198.51.100.1"));
  assert.equal(after.summary.openIncidents, 0);
  const csv = await securityExport("csv");
  assert.match(csv.body, /login\.failure/);
  assert.ok(!csv.body.includes("192.0.2.7"));
});

test("the CSV export defuses formulas and keeps line breaks inside a cell", async () => {
  await reset();
  await run("INSERT INTO security_events(at,kind,severity,detail) VALUES(?,?,?,?)", Date.now(), "login.failure", "warn", "\t=cmd|' /C calc'!A0\rnext");
  await run("INSERT INTO security_events(at,kind,severity,detail) VALUES(?,?,?,?)", Date.now() - 1, "login.failure", "warn", " @SUM(1)");
  const body = (await securityExport("csv")).body;
  assert.ok(body.includes(`"'\t=cmd|' /C calc'!A0\rnext"`), body);
  assert.ok(body.includes(`"' @SUM(1)"`), body);
});

test("old events go after the retention", async () => {
  await reset();
  await run("INSERT INTO security_events(at,kind,severity) VALUES(?,?,?)", Date.now() - 100 * 86_400_000, "login.failure", "warn");
  await run("INSERT INTO security_events(at,kind,severity) VALUES(?,?,?)", Date.now(), "login.failure", "warn");
  await events.sweepSecurityEvents();
  assert.equal((await all("SELECT 1 FROM security_events")).length, 1);
});

test("every rule has steps, and every link of a step leads to a real section", async () => {
  const { securityPlaybooks } = await import("../lib/security-playbooks");
  const { securityRules } = await import("../lib/security-kinds");
  const { parseSettingsHash } = await import("../lib/settings-sections");
  for (const rule of Object.keys(securityRules)) {
    const p = securityPlaybooks[rule as keyof typeof securityPlaybooks];
    assert.ok(p && p.steps.length >= 2, rule);
    assert.ok(p.meaning.de && p.meaning.en && p.harmless.de && p.harmless.en, rule);
    for (const step of p.steps) {
      assert.ok(step.de && step.en, rule);
      if (step.link) {
        const route = parseSettingsHash(step.link.href);
        assert.ok(route?.section && !route.redirected, `${rule}: ${step.link.href}`);
      }
    }
  }
});

test("an encryption key reset is a warning of its own; several in an hour are critical", async () => {
  await reset();
  const a = await person("Ada");
  await audit(a.id, "e2ee.identity.reset", a.id);
  await settle();
  const one1 = await all<{ rule: string; severity: string }>("SELECT rule,severity FROM security_incidents");
  assert.deepEqual(one1, [{ rule: "e2ee_reset", severity: "warn" }]);
  assert.equal(await one("SELECT 1 FROM security_incidents WHERE rule='privilege_change'"), undefined);
  // The same account again: the same incident, counted.
  await audit(a.id, "e2ee.identity.reset", a.id);
  await settle();
  assert.equal((await all("SELECT 1 FROM security_incidents WHERE rule='e2ee_reset'")).length, 1);
  // Two more accounts within the hour: one critical incident for the instance.
  for (const name of ["Ben", "Cleo"]) {
    const p = await person(name);
    await audit(p.id, "e2ee.identity.reset", p.id);
  }
  await settle();
  const critical = await all<{ severity: string }>("SELECT severity FROM security_incidents WHERE rule='e2ee_mass_reset'");
  assert.deepEqual(critical, [{ severity: "critical" }]);
  assert.equal((await all("SELECT 1 FROM security_incidents WHERE rule='e2ee_reset'")).length, 3);
  assert.equal(SECURITY_THRESHOLDS.e2eeResetAccounts, 3);
  // Both incident pages load, with their own explanation and the events behind them.
  for (const rule of ["e2ee_reset", "e2ee_mass_reset"]) {
    const row = await one<{ id: string }>("SELECT id FROM security_incidents WHERE rule=? LIMIT 1", rule);
    const d = await securityIncident(row!.id);
    assert.ok(JSON.stringify(d).includes("e2ee.identity.reset"), rule);
  }
});

test("incidents: paged, open first, searchable and filtered (#535)", async () => {
  await reset();
  const dora = await person("Dora");
  const now = Date.now();
  const add = async (rule: string, severity: string, detail: string, at: number, extra: { resolved?: boolean; actor?: string; network?: string; address?: string } = {}) =>
    await run(
      "INSERT INTO security_incidents(id,rule,key,severity,actor_id,network,address_key,detail,first_at,last_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id(),
      rule,
      `k${at}`,
      severity,
      extra.actor ?? null,
      extra.network ?? "",
      extra.address ?? "",
      detail,
      at,
      at,
      extra.resolved ? at + 1 : null,
    );
  // 45 resolved probing incidents, 3 open ones of other rules.
  for (let i = 0; i < 45; i++) await add("probing", "warn", `60 verschiedene Anfragen mit 401/403/404, z. B. 404 /api/pages/${i}`, now - i * 1000, { resolved: true, network: "203.0.113.0/24", address: `abcdef${String(i).padStart(6, "0")}ffff` });
  await add("privilege_change", "critical", "scim.token.create", now - 999_999);
  await add("brute_force_account", "warn", "dora@example.test: 10", now - 5, { actor: dora.id });
  await add("mass_export", "warn", "100% of 25_", now - 6);

  const first = await securityIncidents({});
  assert.equal(first.items.length, 20);
  assert.deepEqual([first.total, first.open, first.done, first.more], [48, 3, 45, true]);
  // Open ones first, critical before warnings, then the newest.
  assert.deepEqual(first.items.slice(0, 3).map((i) => i.rule), ["privilege_change", "brute_force_account", "mass_export"]);
  assert.ok(first.items.slice(3).every((i) => i.resolvedAt));
  assert.deepEqual((await securityOverview()).incidents.items.map((i) => i.id), first.items.map((i) => i.id));

  const third = await securityIncidents({ offset: "40", limit: "20" });
  assert.deepEqual([third.items.length, third.more], [8, false]);
  const ids = new Set([...first.items, ...(await securityIncidents({ offset: 20 })).items, ...third.items].map((i) => i.id));
  assert.equal(ids.size, 48);

  const search = async (q: string, more: Record<string, string> = {}) => await securityIncidents({ q, ...more });
  // The rule's title in German and English, a path, an event, a network, a person, an address.
  assert.equal((await search("abtasten")).total, 45);
  assert.equal((await search("Probing")).total, 45);
  assert.deepEqual((await search("/api/pages/7")).items.map((i) => i.detail), ["60 verschiedene Anfragen mit 401/403/404, z. B. 404 /api/pages/7"]);
  assert.deepEqual((await search("scim.token.create")).items.map((i) => i.rule), ["privilege_change"]);
  assert.equal((await search("203.0.113")).total, 45);
  assert.deepEqual((await search("dora")).items.map((i) => i.rule), ["brute_force_account"]);
  assert.equal((await search("abcdef000003")).total, 1);
  // LIKE wildcards are text.
  assert.deepEqual((await search("0%")).items.map((i) => i.rule), ["mass_export"]);
  assert.equal((await search("a_i")).total, 0);
  assert.equal((await search("nothing like this")).total, 0);
  // Status and severity; the counts follow the search.
  const open = await securityIncidents({ status: "open" });
  assert.deepEqual([open.items.length, open.total, open.open, open.done], [3, 3, 3, 45]);
  assert.equal((await securityIncidents({ status: "done", q: "pages/1" })).total, 11);
  const critical = await securityIncidents({ severity: "critical" });
  assert.deepEqual([critical.total, critical.open, critical.done], [1, 1, 0]);
  await assert.rejects(async () => await securityIncidents({ status: "nope" }));
  await assert.rejects(async () => await securityIncidents({ limit: 501 }));
});
