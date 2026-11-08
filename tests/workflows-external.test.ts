// Workflows wave 2 (#168, docs/specs/workflows.md §6.6, §9.4–9.7, §15): the
// HTTP node (fixed host, URL encoding, credentials only to their host and
// never in run data, Idempotency-Key, retries, redirects, the switches) and
// SSRF – every internal address refused, as for link previews and chat
// apps; inbound webhooks (signature, age, replay, token only, rotation,
// pause), inbound e-mail to a workflow (allow-list, the sender check against
// spoofing), e-mail (per day, outside addresses), chat (released webhooks
// only), the journal-day trigger, and secrets in exports and copies. The
// same on SQLite and PostgreSQL.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-ext-"));
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.FLOWPLAN_WORKFLOW_HTTP_ALLOW_PRIVATE = "true";
const { run, one, all, id } = await import("../lib/db");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { receiveWorkflowHook, hookSignature } = await import("../lib/workflows/inbound");
const { receiveInboundMail, parseInboundPayload } = await import("../lib/inbound-mail");
const { mailVerdict, parseAuthResults, verdictFromResults, sendgridVerdict } = await import("../lib/mail-auth");
const { securityWritesSettled } = await import("../lib/security-events");
const { workflowArchive } = await import("../lib/workflows/archive");
const S = await import("./helpers/workflow-setup");
const { act, get, owner, editor, viewer, node, edge, chain, workflow, runsOf, stepsOf, outputOf, manual, makeDatabase, wid, space } = S;

const admin = { ...owner, isAdmin: true };
const dbId = await makeDatabase("Tickets");
const lastRun = async (pageId: string) => (await runsOf(pageId)).at(-1)!;
const TOKEN = "tok_SECRET_9f8e7d6c5b4a";

/* ---------- Two local servers (different hosts: 127.0.0.1 and localhost) ---------- */

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
function server(handler: (req: IncomingMessage, body: string, seen: Seen[]) => { status?: number; headers?: Record<string, string>; body?: string }) {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method || "", url: req.url || "", headers: req.headers, body });
      const out = handler(req, body, seen);
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
      res.end(out.body ?? JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization || null, key: req.headers["idempotency-key"] || null, body }));
    });
  });
  return new Promise<{ base: string; port: number; seen: Seen[]; close: () => void }>((resolve) =>
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, port, seen, close: () => s.close() });
    }),
  );
}
const other = await server(() => ({}));
let flaky = 0;
const api = await server((req) => {
  if (req.url?.startsWith("/redirect")) return { status: 302, headers: { location: `http://localhost:${other.port}/landed` }, body: "" };
  if (req.url?.startsWith("/flaky")) return flaky++ === 0 ? { status: 503, headers: { "retry-after": "1" }, body: "busy" } : {};
  if (req.url?.startsWith("/missing")) return { status: 404, body: "nope" };
  if (req.url?.startsWith("/cookie")) return { headers: { "set-cookie": "s=1", "x-request-id": "r1" } };
  return {};
});
after(() => {
  api.close();
  other.close();
});

async function credential(host: string, kind = "bearer", secret: Record<string, string> = { token: TOKEN }) {
  return async (pageId: string) => (await act({ action: "workflow.credential.set", pageId, name: "API", kind, host, secret })).id as string;
}
async function httpWorkflow(title: string, config: Record<string, unknown>, onError?: { retry: number; then: string }) {
  const t = node("trigger.manual", { inputs: [{ name: "id", type: "text", required: false }, { name: "n", type: "text", required: false }] }, "Start");
  const h = node("http.request", { method: "GET", ...config }, "Anfrage", onError ? { onError } : {});
  const { pageId } = await workflow(title, chain(t, h), owner, false);
  return { pageId, t, h };
}
const activate = async (pageId: string) => {
  const r = await act({ action: "workflow.activate", pageId });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
};

test("http: a credential goes to its host only, never into run data; redirects elsewhere go without it", async () => {
  const { pageId, t, h } = await httpWorkflow("HTTP", { url: `${api.base}/items/{{Start.inputs.id}}` });
  const host = `127.0.0.1:${api.port}`;
  const cred = await (await credential(host))(pageId);
  // A placeholder in the path is URL-encoded: it cannot change the host.
  await act({ action: "workflow.draft", pageId, graph: chain(t, { ...h, config: { method: "GET", url: `${api.base}/items/{{${t.id}.inputs.id}}`, credential: cred } }) });
  await activate(pageId);
  await manual(pageId, { id: "../../@evil.test/x?y=1#z" });
  await drainWorkflows();
  const r = await lastRun(pageId);
  assert.equal(r.status, "succeeded", r.error || "");
  const call = api.seen.at(-1)!;
  assert.equal(call.url, "/items/..%2F..%2F%40evil.test%2Fx%3Fy%3D1%23z");
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers["user-agent"], "Flowplan-Workflow/1.0");
  assert.equal(call.headers["idempotency-key"], `${r.id}:${h.id}:`);
  // The answer echoes the token: redacted in what the run keeps.
  const stored = JSON.stringify(await all("SELECT input,output,error FROM workflow_steps WHERE run_id=?", r.id));
  assert.ok(!stored.includes(TOKEN), "no secret in the run");
  assert.equal((await outputOf(r.id, h.id)).status, 200);
  // A redirect to another host: followed, without the credential.
  await act({ action: "workflow.draft", pageId, graph: chain(t, { ...h, config: { method: "GET", url: `${api.base}/redirect`, credential: cred } }) });
  await activate(pageId);
  await manual(pageId);
  await drainWorkflows();
  assert.equal((await lastRun(pageId)).status, "succeeded");
  assert.equal(other.seen.at(-1)!.url, "/landed");
  assert.equal(other.seen.at(-1)!.headers.authorization, undefined);
  // A credential for another host is refused by the check.
  const foreign = (await act({ action: "workflow.credential.set", pageId, name: "Fremd", kind: "bearer", host: "api.example.org", secret: { token: "x123456" } })).id;
  await act({ action: "workflow.draft", pageId, graph: chain(t, { ...h, config: { method: "GET", url: `${api.base}/x`, credential: foreign } }) });
  const refused = await act({ action: "workflow.activate", pageId });
  assert.ok(refused.issues.some((i: { code: string }) => i.code === "credential_host"));
  // Listed by name, kind and host – never the secret; changing the host needs a new one.
  const list = await get(`workflows/${pageId}/credentials`);
  assert.ok(!JSON.stringify(list).includes(TOKEN));
  await assert.rejects(act({ action: "workflow.credential.set", pageId, id: cred, name: "API", kind: "bearer", host: "other.example.org" }), /neuen Host/);
  await assert.rejects(get(`workflows/${pageId}/credentials`, viewer), /Keine Berechtigung/);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.credential.set' AND resource_id=?", pageId));
  // Never in the archive, the state, a copy.
  const archive = JSON.stringify(await workflowArchive(pageId));
  assert.ok(!archive.includes(TOKEN) && !archive.includes("sealed"));
  assert.ok(!JSON.stringify(await get(`workflows/${pageId}`)).includes(TOKEN));
});

test("http: JSON bodies typed, headers without CR/LF, retries keep the Idempotency-Key, 4xx is external, dry runs send nothing", async () => {
  const { pageId, t, h } = await httpWorkflow("HTTP 2", { url: `${api.base}/flaky` }, { retry: 2, then: "fail" });
  await act({
    action: "workflow.draft",
    pageId,
    graph: chain(t, {
      ...h,
      config: { method: "POST", url: `${api.base}/flaky`, bodyKind: "json", body: `{"n": {{${t.id}.inputs.n | number}}, "s": "{{${t.id}.inputs.id}}"}`, headers: [{ name: "X-Note", value: `a{{${t.id}.inputs.id}}` }] },
    }),
  });
  await activate(pageId);
  await manual(pageId, { id: 'he said "hi"\r\nX-Evil: 1', n: "7" });
  await drainWorkflows();
  const r = await lastRun(pageId);
  // 503: queued again with Retry-After; on the next attempt it works.
  assert.equal(r.status, "running");
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 120_000 });
  try {
    await drainWorkflows();
  } finally {
    mock.timers.reset();
  }
  assert.equal((await one<{ status: string }>("SELECT status FROM workflow_runs WHERE id=?", r.id))!.status, "succeeded");
  const [first, second] = api.seen.slice(-2);
  assert.equal(first.headers["idempotency-key"], second.headers["idempotency-key"]);
  assert.deepEqual(JSON.parse(second.body), { n: 7, s: 'he said "hi"\r\nX-Evil: 1' });
  assert.equal(second.headers["x-note"], 'ahe said "hi"X-Evil: 1');
  assert.equal(second.headers["x-evil"], undefined);
  // 404: external, no retry.
  await act({ action: "workflow.draft", pageId, graph: chain(t, { ...h, onError: { retry: 3, then: "fail" }, config: { method: "GET", url: `${api.base}/missing` } }) });
  await activate(pageId);
  await manual(pageId);
  await drainWorkflows();
  const missing = await lastRun(pageId);
  assert.equal(missing.status, "failed");
  assert.equal(missing.error_kind, "external");
  // Answer headers: an allow-list (no cookies).
  await act({ action: "workflow.draft", pageId, graph: chain(t, { ...h, config: { method: "GET", url: `${api.base}/cookie` } }) });
  await activate(pageId);
  await manual(pageId);
  await drainWorkflows();
  const kept = (await outputOf((await lastRun(pageId)).id, h.id)).headers;
  assert.equal(kept["x-request-id"], "r1");
  assert.equal(kept["set-cookie"], undefined);
  // Dry runs: a POST is not sent.
  const calls = api.seen.length;
  await act({ action: "workflow.draft", pageId, graph: chain(t, { ...h, config: { method: "POST", url: `${api.base}/x` } }) });
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "sample" } });
  await drainWorkflows();
  assert.equal(api.seen.length, calls);
  assert.equal((await outputOf(dry.runId, h.id)).wouldRequest.method, "POST");
});

test("http: the host is fixed text; the switches FLOWPLAN_WORKFLOW_HTTP and the host list", async () => {
  const { pageId, t, h } = await httpWorkflow("HTTP 3", { url: "https://{{Start.inputs.id}}/x" });
  const issues = (await act({ action: "workflow.validate", pageId, graph: chain(t, { ...h, config: { url: `https://{{${t.id}.inputs.id}}/x` } }) })).issues.map((i: { code: string }) => i.code);
  assert.ok(issues.includes("http_host"));
  for (const url of ["https://user:pw@api.example.org/", "ftp://example.org/", "https://ex{{x}}ample.org/"]) {
    const codes = (await act({ action: "workflow.validate", pageId, graph: chain(t, { ...h, config: { url } }) })).issues.map((i: { code: string }) => i.code);
    assert.ok(codes.includes("http_host"), url);
  }
  await act({ action: "admin.workflowLimits", limits: { http: false } }, admin);
  try {
    const codes = (await act({ action: "workflow.validate", pageId, graph: chain(t, { ...h, config: { url: `${api.base}/x` } }) })).issues.map((i: { code: string }) => i.code);
    assert.ok(codes.includes("http_off"));
  } finally {
    await act({ action: "admin.workflowLimits", limits: { http: null } }, admin);
  }
  await act({ action: "admin.workflowLimits", limits: { httpHosts: ["api.example.org"] } }, admin);
  try {
    const codes = (await act({ action: "workflow.validate", pageId, graph: chain(t, { ...h, config: { url: `${api.base}/x` } }) })).issues.map((i: { code: string }) => i.code);
    assert.ok(codes.includes("http_host_not_allowed"));
  } finally {
    await act({ action: "admin.workflowLimits", limits: { httpHosts: null } }, admin);
  }
});

test("SSRF: internal addresses are refused on every path (literal, mapped, decimal, DNS) and recorded", async () => {
  process.env.FLOWPLAN_WORKFLOW_HTTP_ALLOW_PRIVATE = "false";
  try {
    const t = node("trigger.manual", { inputs: [] }, "Start");
    const targets = [
      "https://127.0.0.1/",
      `https://127.0.0.1:${api.port}/`,
      "https://localhost/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:7f00:1]/",
      "https://[::ffff:a9fe:a9fe]/latest",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/",
      "https://172.16.5.4/",
      "https://192.168.1.1/",
      "https://100.64.0.1/",
      "https://0.0.0.0/",
      "https://2130706433/",
      "https://0x7f.0.0.1/",
      "https://[fd00::1]/",
      "https://[fe80::1]/",
      "https://[2002:7f00:1::]/",
      `http://127.0.0.1:${api.port}/`,
    ];
    const nodes = targets.map((url, i) => node("http.request", { method: "GET", url, timeoutSeconds: 3 }, `Ziel ${i}`, { onError: { retry: 0, then: "continue" } }));
    const graph = { nodes: [t, ...nodes], edges: nodes.map((n) => edge(t, n)) };
    const { pageId } = await workflow("SSRF", graph, owner, false);
    const before = api.seen.length;
    const r = await act({ action: "workflow.test", pageId, mode: "test", data: { kind: "sample" } });
    assert.equal(r.ok, false, "http:// needs the private switch");
    graph.nodes = graph.nodes.filter((n) => !String(n.config.url).startsWith("http:"));
    graph.edges = graph.edges.filter((e) => graph.nodes.some((n) => n.id === e.to.node));
    await act({ action: "workflow.draft", pageId, graph });
    const ok = await act({ action: "workflow.test", pageId, mode: "test", data: { kind: "sample" } });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
    await drainWorkflows();
    const steps = (await stepsOf(ok.runId)).filter((s) => s.node_id !== t.id);
    assert.equal(steps.length, targets.length - 1);
    for (const s of steps) {
      assert.equal(s.error_kind, "permission", `${s.node_id}: ${s.error}`);
      assert.match(s.error!, /Interne Adressen/);
    }
    assert.equal(api.seen.length, before, "nothing reached the local server");
    await securityWritesSettled();
    assert.ok(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM security_events WHERE kind='blocked.ssrf'"))!.n) >= targets.length - 2);
  } finally {
    process.env.FLOWPLAN_WORKFLOW_HTTP_ALLOW_PRIVATE = "true";
  }
});

/* ---------- Inbound webhooks ---------- */

async function hookWorkflow(mode: "signed" | "token") {
  const t = node("trigger.webhook", { mode, fields: [] }, "Webhook");
  const set = node("logic.set", { values: [{ name: "who", value: `{{${t.id}.body.name}}`, type: "text" }] }, "Lesen");
  const { pageId } = await workflow(`Hook ${mode}`, chain(t, set), owner, false);
  const hook = (await act({ action: "workflow.hook", pageId, nodeId: t.id })).hook as { url: string; secret: string };
  await activate(pageId);
  return { pageId, t, set, token: hook.url.split("/").pop()!, secret: hook.secret, url: hook.url };
}
const post = async (token: string, body: string, headers: Record<string, string> = {}, now = Date.now()) =>
  await receiveWorkflowHook({ token, headers: new Headers({ "content-type": "application/json", ...headers }), body: Buffer.from(body), query: new URLSearchParams("a=1"), now });
const signed = (secret: string, body: string, ts = Math.floor(Date.now() / 1000)) => ({ "x-flowplan-timestamp": String(ts), "x-flowplan-signature": `sha256=${hookSignature(secret, String(ts), body)}` });

test("webhook, signed: valid → 202 with the run; wrong, old, missing → 401 and a security event; a replay → the first run", async () => {
  const { pageId, set, token, secret, url } = await hookWorkflow("signed");
  assert.match(url, /\/api\/workflow-hooks\/[A-Za-z0-9_-]{43}$/);
  // The token is stored only as a hash, the secret sealed.
  const row = (await one<{ token_hash: string; sealed: string }>("SELECT token_hash,sealed FROM workflow_hooks WHERE page_id=?", pageId))!;
  assert.ok(!row.sealed.includes(secret) && !row.token_hash.includes(token));
  const body = JSON.stringify({ name: "Ada" });
  const first = signed(secret, body);
  const ok = await post(token, body, first);
  assert.equal(ok.status, 202);
  await drainWorkflows();
  assert.equal((await outputOf(ok.runId!, set.id)).who, "Ada");
  const trig = await one<{ output: string }>("SELECT output FROM workflow_steps WHERE run_id=? AND input IS NULL ORDER BY created_at LIMIT 1", ok.runId);
  assert.ok(trig && !trig.output.includes("x-flowplan-signature"), "the signature is not kept");
  // The same delivery again (the sender's retry): the first run, nothing new.
  const again = await post(token, body, first);
  assert.equal(again.status, 200);
  assert.equal(again.runId, ok.runId);
  await assert.rejects(post(token, body, { ...signed(secret, body), "x-flowplan-signature": `sha256=${"0".repeat(64)}` }), /Signatur ungültig/);
  await assert.rejects(post(token, body, signed(secret, body, Math.floor(Date.now() / 1000) - 600)), /Signatur ungültig/);
  await assert.rejects(post(token, body), /Signatur ungültig/);
  await assert.rejects(post(token, body, signed("whsec_other", body)), /Signatur ungültig/);
  // Another body under a valid signature of the first: refused.
  await assert.rejects(post(token, JSON.stringify({ name: "Eve" }), first), /Signatur ungültig/);
  await securityWritesSettled();
  assert.ok(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM security_events WHERE kind='workflow.hook.refused'"))!.n) >= 4);
  assert.equal((await runsOf(pageId)).length, 1);
  // An Idempotency-Key counts once.
  const keyed = await post(token, body, { ...signed(secret, body, Math.floor(Date.now() / 1000) + 1), "idempotency-key": "d-1" });
  const keyedAgain = await post(token, body, { ...signed(secret, body, Math.floor(Date.now() / 1000) + 2), "idempotency-key": "d-1" });
  assert.equal(keyed.status, 202);
  assert.equal(keyedAgain.status, 200);
  assert.equal(keyedAgain.runId, keyed.runId);
  // Paused: 409. Rotated: the old address is gone at once.
  await act({ action: "workflow.pause", pageId });
  await assert.rejects(post(token, body, signed(secret, body)), /pausiert/);
  await act({ action: "workflow.activate", pageId });
  const t = (await one<{ node_id: string }>("SELECT node_id FROM workflow_hooks WHERE page_id=?", pageId))!.node_id;
  const rotated = (await act({ action: "workflow.hook", pageId, nodeId: t, rotate: true })).hook;
  await assert.rejects(post(token, body, signed(secret, body)), /Signatur ungültig|nicht gefunden/);
  const fresh = await post(rotated.url.split("/").pop(), body, signed(rotated.secret, body));
  assert.equal(fresh.status, 202);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.hook.rotated' AND resource_id=?", pageId));
  // Editors see the address, readers not.
  await assert.rejects(get(`workflows/${pageId}/hooks`, viewer), /Keine Berechtigung/);
});

test("webhook, token only: chosen deliberately (warning), no signature, at most 10 a minute; unknown tokens 404", async () => {
  const { pageId, token } = await hookWorkflow("token");
  const state = await get(`workflows/${pageId}`);
  assert.ok(state.draft.issues.some((i: { code: string }) => i.code === "token_webhook"));
  await assert.rejects(post(token, "{not json"), /Ungültiges JSON/);
  const statuses = [];
  for (let i = 0; i < 10; i++)
    try {
      statuses.push((await post(token, JSON.stringify({ name: `n${i}` }))).status);
    } catch (e) {
      statuses.push((e as { status: number }).status);
    }
  assert.deepEqual(statuses, [...Array(9).fill(202), 429]);
  await assert.rejects(post("A".repeat(43), "{}"), /nicht gefunden/);
  void id;
});

/* ---------- Inbound e-mail ---------- */

test("mail-auth: aligned passes count, foreign passes do not, failures do; only the trusted header", () => {
  const from = "ceo@victim.example";
  const ar = (v: string) => verdictFromResults(parseAuthResults(v).results, from);
  assert.equal(ar("mx.local; dmarc=pass header.from=victim.example"), "pass");
  assert.equal(ar("mx.local; spf=pass smtp.mailfrom=attacker.example; dkim=pass header.d=attacker.example; dmarc=fail header.from=victim.example"), "fail");
  assert.equal(ar("mx.local; spf=pass smtp.mailfrom=attacker.example; dkim=pass header.d=attacker.example"), "unknown");
  assert.equal(ar("mx.local; dkim=pass header.d=victim.example"), "pass");
  assert.equal(ar("mx.local; spf=pass smtp.mailfrom=bounce@mail.victim.example"), "pass");
  assert.equal(ar("mx.local; spf=softfail smtp.mailfrom=victim.example"), "fail");
  // A forged header below the server's own: only the topmost counts…
  const headers: [string, string][] = [
    ["Authentication-Results", "mx.local; spf=fail smtp.mailfrom=victim.example"],
    ["Authentication-Results", "evil; dmarc=pass header.from=victim.example"],
  ];
  assert.equal(mailVerdict(headers, from, ""), "fail");
  // …or those of the configured server.
  assert.equal(mailVerdict([["Authentication-Results", "evil; dmarc=pass"]], from, "mx.local"), "unknown");
  assert.equal(sendgridVerdict("pass", "{@attacker.example : pass}", from), "unknown");
  assert.equal(sendgridVerdict("pass", "{@victim.example : pass}", from), "pass");
});

async function mailWorkflow(senders: "verified" | "not_failed" | "any", signing: boolean) {
  const t = node("trigger.mail.received", { address: "", senders }, "Mail");
  const set = node("logic.set", { values: [{ name: "s", value: `{{${t.id}.mail.subject}}`, type: "text" }, { name: "a", value: `{{${t.id}.authenticated}}`, type: "text" }] }, "Betreff");
  const { pageId } = await workflow(`Mail ${senders}`, chain(t, set), owner, false);
  const address = (await act({ action: "inbound.save", workspaceId: wid, pageId, senders: ["victim.example", "ok.example"], ...(signing ? { secret: "sign-key-123456" } : {}) })).id as string;
  t.config.address = address;
  await act({ action: "workflow.draft", pageId, graph: chain(t, set) });
  await activate(pageId);
  const token = (await one<{ token: string }>("SELECT token FROM inbound_addresses WHERE id=?", address))!.token;
  return { pageId, set, token, address };
}
let msg = 0;
const mail = (from: string, auth: "pass" | "fail" | "unknown", subject = "Hallo") => ({
  from,
  to: ["inbox@test.invalid"],
  subject,
  text: "Text",
  html: "<p>Text<script>x</script></p>",
  messageId: `m${++msg}@test`,
  date: new Date(),
  attachments: [{ filename: "a.txt", contentType: "text/plain", data: Buffer.from("anhang"), contentId: "", inline: false }],
  auth,
});

test("inbound e-mail to a workflow: allow-list, sender check, never mapped to an account; attachments as files of the workflow", async () => {
  const { pageId, set, token } = await mailWorkflow("not_failed", true);
  assert.equal((await receiveInboundMail(token, mail("eve@else.example", "pass"))).status, "rejected");
  await receiveInboundMail(token, mail("ceo@victim.example", "fail", "gefälscht"));
  await receiveInboundMail(token, mail("ada@ok.example", "pass", "echt"));
  // A duplicate Message-ID counts once.
  const m = mail("ada@ok.example", "pass", "doppelt");
  await receiveInboundMail(token, m);
  assert.equal((await receiveInboundMail(token, m)).status, "duplicate");
  await drainWorkflows();
  const outputs = await Promise.all((await runsOf(pageId)).map(async (r) => await outputOf(r.id, set.id)));
  assert.deepEqual(outputs.map((o) => o.s).sort(), ["doppelt", "echt"]);
  assert.ok(outputs.every((o) => o.a === "pass"));
  const trigger = JSON.parse((await one<{ output: string }>("SELECT output FROM workflow_steps WHERE run_id=? AND port='out' ORDER BY created_at LIMIT 1", (await runsOf(pageId))[0].id))!.output);
  assert.equal(trigger.mail.attachments[0].name, "a.txt");
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND page_id=?", trigger.mail.attachments[0].file, pageId));
  assert.ok(!trigger.mail.html.includes("<script"));
  // Runs run as the workflow's runner, never as the sender.
  assert.ok((await all<{ runner_id: string }>("SELECT runner_id FROM workflow_runs WHERE page_id=?", pageId)).every((r) => r.runner_id === owner.id));
});

test("inbound e-mail: an unsigned HTTP delivery's verdict is not trusted; “verified only” needs a pass; IMAP trusts its server", async () => {
  const unsigned = await mailWorkflow("verified", false);
  await receiveInboundMail(unsigned.token, mail("ceo@victim.example", "pass"));
  await drainWorkflows();
  assert.equal((await runsOf(unsigned.pageId)).length, 0, "a claimed pass without a signed delivery is unknown");
  await receiveInboundMail(unsigned.token, mail("ceo@victim.example", "pass"), Date.now(), "imap");
  await drainWorkflows();
  assert.equal((await runsOf(unsigned.pageId)).length, 1);
  // The verdict comes from the message's own headers when parsed.
  const raw = [
    "Authentication-Results: mx.local; spf=pass smtp.mailfrom=attacker.example; dmarc=fail header.from=victim.example",
    "From: ceo@victim.example",
    "To: inbox@test.invalid",
    "Subject: Zahlung",
    "Message-ID: <x1@test>",
    "",
    "Bitte überweisen.",
  ].join("\r\n");
  const parsed = await parseInboundPayload("message/rfc822", Buffer.from(raw));
  assert.equal(parsed.mail.auth, "fail");
});

/* ---------- E-mail, chat, journal ---------- */

test("notify.email: members and addresses, escaped HTML, at most N a day, outside addresses behind the switch", async () => {
  const t = node("trigger.manual", { inputs: [{ name: "to", type: "text", required: false }] }, "Start");
  const send = node("notify.email", { to: [editor.id, `{{${t.id}.inputs.to}}`], subject: "Hallo\r\nBcc: x@evil.example", message: "<b>fett</b>\n\nzweiter Absatz" }, "Mail");
  const { pageId } = await workflow("Mail out", chain(t, send));
  await act({ action: "admin.workflowLimits", limits: { mailsPerDay: 3 } }, admin);
  try {
    await manual(pageId, { to: "kunde@outside.example" });
    await drainWorkflows();
    const queued = await all<{ recipient: string; subject: string; html: string }>("SELECT recipient,subject,html FROM mail_queue WHERE subject LIKE 'Hallo%'");
    assert.deepEqual(queued.map((q) => q.recipient).sort(), ["editor@test.invalid", "kunde@outside.example"]);
    assert.equal(queued[0].subject, "HalloBcc: x@evil.example");
    assert.ok(queued[0].html.includes("&lt;b&gt;fett&lt;/b&gt;"));
    // 2 + 2 > 3: the second run fails with "limit".
    await manual(pageId, { to: "kunde@outside.example" });
    await drainWorkflows();
    const r = await lastRun(pageId);
    assert.equal(r.status, "failed");
    assert.equal(r.error_kind, "limit");
  } finally {
    await act({ action: "admin.workflowLimits", limits: { mailsPerDay: null } }, admin);
  }
  await act({ action: "admin.workflowLimits", limits: { externalMail: false } }, admin);
  try {
    await manual(pageId, { to: "kunde@outside.example" });
    await drainWorkflows();
    const r = await lastRun(pageId);
    assert.equal(r.error_kind, "permission");
    await manual(pageId, { to: "viewer@test.invalid" });
    await drainWorkflows();
    assert.equal((await lastRun(pageId)).status, "succeeded", "members' addresses are not outside");
  } finally {
    await act({ action: "admin.workflowLimits", limits: { externalMail: null } }, admin);
  }
});

test("notify.chat: only webhooks an owner released for workflows; delivered as workflow.message", async () => {
  const hookId = id();
  await run("INSERT INTO webhooks(id,workspace_id,url,events,secret,created_by,created_at,format,config) VALUES(?,?,?,?,?,?,?,?,?)", hookId, wid, "https://hooks.slack.test/T1", '["row.created"]', "s3cret-xyz", owner.id, Date.now(), "slack", "{}");
  const t = node("trigger.manual", { inputs: [] }, "Start");
  const chat = node("notify.chat", { webhook: hookId, title: "Bericht", message: "Fertig: *{{$workflow.title}}*" }, "Chat");
  const { pageId } = await workflow("Chat", chain(t, chat), owner, false);
  assert.ok((await act({ action: "workflow.activate", pageId })).issues.some((i: { code: string }) => i.code === "unknown_webhook"));
  await run("UPDATE webhooks SET config=? WHERE id=?", JSON.stringify({ workflows: true }), hookId);
  await activate(pageId);
  assert.ok((await get(`workflows/${pageId}/resources`)).chatHooks.some((h: { id: string }) => h.id === hookId));
  await manual(pageId);
  await drainWorkflows();
  assert.equal((await lastRun(pageId)).status, "succeeded");
  const d = JSON.parse((await one<{ body: string }>("SELECT body FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 1", hookId))!.body);
  assert.equal(d.event, "workflow.message");
  assert.equal(d.notice.text, "Fertig: *Chat*");
});

test("journal day: fires when the day's page is created – never for a journal with a PIN", async () => {
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "journal", title: "Tagebuch" })).id as string;
  const t = node("trigger.journal.day", { journal }, "Neuer Tag");
  const set = node("logic.set", { values: [{ name: "d", value: `{{${t.id}.date}}`, type: "auto" }] }, "Tag");
  const { pageId } = await workflow("Journal", chain(t, set));
  const today = new Date().toISOString().slice(0, 10);
  await act({ action: "journal.roll", pageId: journal, date: today, write: true });
  await act({ action: "journal.roll", pageId: journal, date: today, write: true });
  await drainWorkflows();
  const runs = await runsOf(pageId);
  assert.equal(runs.length, 1);
  assert.equal((await outputOf(runs[0].id, set.id)).d, today);
  // With a PIN: the check refuses it.
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET lock_hash=excluded.lock_hash", journal, "x");
  const codes = (await act({ action: "workflow.validate", pageId })).issues.map((i: { code: string }) => i.code);
  assert.ok(codes.includes("unknown_journal"));
});
