// Notifications to chat apps (#63, lib/messengers.ts): the channel in the
// matrix and its defaults, the request each service gets (with a mocked
// transport), text or only a hint, end-to-end encrypted spaces, retries,
// throttling and turning a refused target off, the Telegram bot's one-time
// codes, operations alerts for administrators and that no token ever leaves
// the server.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-messengers-"));
process.env.APP_URL = "https://flow.example.test";
delete process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE;
delete process.env.FLOWPLAN_MESSENGER_ALLOW_PRIVATE;
delete process.env.FLOWPLAN_TELEGRAM_BOT_TOKEN;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const M = await import("../lib/messengers");
const S = await import("../lib/messenger-send");
const ops = await import("../lib/admin-ops");
type Request = import("../lib/messenger-send").HttpRequest;
type Response = import("../lib/messenger-send").HttpResponse;

function person(name: string, admin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email,locale) VALUES(?,?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`, "de");
  if (admin)
    run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)", uid, `${name.toLowerCase()}@example.test`, "x", 1, Date.now());
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: admin, disabled: 0, created_at: "" } as Identity;
}
const ada = person("Ada"),
  ben = person("Ben"),
  root = person("Root", true);
const wid = createWorkspace(ada.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = bootstrap(ada, wid).spaces[0].id;
const page = String((command(ada, { workspaceId: wid, action: "page.create", spaceId: space, title: "Plan", kind: "document" }) as Record<string, unknown>).id);

// The network: every request is recorded; `answer` decides the reply.
let sent: Request[] = [];
let answer: (r: Request) => Response | Promise<Response> = () => ({ status: 200, body: '{"ok":true}' });
M.setMessengerHttp(async (request) => {
  sent.push(request);
  return answer(request);
});
// Public hosts resolve to a public address; "intern.example.test" to a private one.
M.setMessengerResolver(async (host) => (host.startsWith("intern.") ? ["10.0.0.7"] : ["203.0.113.10"]));
beforeEach(() => {
  sent = [];
  answer = () => ({ status: 200, body: '{"ok":true}' });
});

const notify = (user: Identity, kind: string, body: string, pageId: string | null = page) => {
  const nid = id();
  run("INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,?)", nid, user.id, body, pageId, kind);
  return nid;
};
const pending = (user: Identity) =>
  all<{ id: number }>("SELECT d.id FROM messenger_deliveries d JOIN messenger_targets t ON t.id=d.target_id WHERE t.user_id=? AND d.delivered_at IS NULL", user.id);
const clearQueue = () => run("DELETE FROM messenger_deliveries");
const flush = (at = Date.now()) => M.flushMessengerQueue(at);
const body = (r: Request) => JSON.parse(r.body) as Record<string, unknown>;

test("the chat-app column: defaults per kind, nothing queued without a connection", async () => {
  const prefs = bootstrap(ada, wid).notificationPrefs!;
  for (const kind of ["mention", "comment", "reminder", "security", "share"] as const) assert.equal(prefs[kind].messenger, true, kind);
  for (const kind of ["change", "automation", "guest"] as const) assert.equal(prefs[kind].messenger, false, kind);
  notify(ada, "mention", "Ben hat dich in „Plan“ erwähnt");
  assert.equal(pending(ada).length, 0, "no connection, no queue");
});

test("connecting: tokens are sealed, never shown, the event is recorded", async () => {
  const overview = await M.connectMessenger(ada, { service: "gotify", server: "https://gotify.example.test/", token: "AppTokenSecret12345" });
  assert.equal(overview.targets.length, 1);
  const target = overview.targets[0];
  assert.equal(target.detail, "gotify.example.test");
  assert.equal(target.secretHint, "…2345");
  const json = JSON.stringify(overview);
  assert.ok(!json.includes("AppTokenSecret12345"), "no token in the answer");
  const stored = one<{ secret: string; config: string }>("SELECT secret,config FROM messenger_targets WHERE id=?", target.id)!;
  assert.ok(stored.secret.startsWith("fps1:"), "sealed at rest");
  assert.ok(!stored.secret.includes("AppToken") && !stored.config.includes("AppToken"));
  // Changing the server keeps nothing secret behind: a new token is needed …
  await assert.rejects(M.connectMessenger(ada, { service: "gotify", server: "https://other.example.test" }), /fehlt/);
  // … while the same server keeps the stored one.
  await M.connectMessenger(ada, { service: "gotify", server: "https://gotify.example.test" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(one("SELECT 1 FROM security_events WHERE kind='account.messenger_added' AND actor_id=?", ada.id));
  assert.ok(!JSON.stringify(all("SELECT detail FROM security_events")).includes("AppTokenSecret"));
  // API tokens never manage connections.
  await assert.rejects(M.connectMessenger({ ...ada, apiScope: "write" } as Identity, { service: "ntfy", topic: "x" }), /API-Token/);
});

test("Gotify: title, message with link, priority, click URL in the extras", async () => {
  clearQueue();
  const nid = notify(ada, "mention", "Ben hat dich in „Plan“ erwähnt");
  notify(ada, "change", "Ben hat „Plan“ geändert");
  assert.equal(pending(ada).length, 1, "only the kinds switched on for chat apps");
  await flush();
  assert.equal(sent.length, 1);
  const r = sent[0];
  assert.equal(r.url, "https://gotify.example.test/message");
  assert.equal(r.method, "POST");
  assert.equal(r.headers["X-Gotify-Key"], "AppTokenSecret12345");
  const b = body(r) as { title: string; message: string; priority: number; extras: Record<string, { click?: { url: string } }> };
  assert.equal(b.title, "Flowplan · Erwähnung");
  assert.match(b.message, /^Ben hat dich in „Plan“ erwähnt\n\nhttps:\/\/flow\.example\.test\/#page=/);
  assert.equal(b.priority, 5);
  assert.match(b.extras["client::notification"].click!.url, new RegExp(`^https://flow\\.example\\.test/#page=${page}`));
  assert.equal(pending(ada).length, 0);
  assert.ok(one("SELECT 1 FROM messenger_deliveries WHERE notification_id=? AND delivered_at IS NOT NULL", nid));
  assert.ok(!r.url.includes("AppToken"), "the token travels in a header, not in the address");
});

test("only a hint when the person wants it, and always in end-to-end encrypted spaces", async () => {
  clearQueue();
  M.setMessengerSettings(ada, { preview: false });
  notify(ada, "mention", "Ben hat dich in „Geheimplan“ erwähnt");
  await flush();
  let b = body(sent[0]) as { title: string; message: string };
  assert.equal(b.title, "Flowplan");
  assert.match(b.message, /^Neue Benachrichtigung in Flowplan\n\nhttps:/);
  assert.ok(!sent[0].body.includes("Geheimplan"));
  M.setMessengerSettings(ada, { preview: true });
  // An encrypted space: no content even with the text switched on.
  const secretSpace = id();
  run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", secretSpace, wid, "Tresor", "team", ada.id);
  run("UPDATE spaces SET encrypted=1 WHERE id=?", secretSpace);
  const secretPage = id();
  run("INSERT INTO pages(id,workspace_id,space_id,title,kind,created_by) VALUES(?,?,?,?,?,?)", secretPage, wid, secretSpace, "", "document", ada.id);
  sent = [];
  notify(ada, "comment", "Ben kommentiert „Tresorinhalt“", secretPage);
  await flush();
  b = body(sent[0]) as { title: string; message: string };
  assert.equal(b.title, "Flowplan");
  assert.ok(!sent[0].body.includes("Tresorinhalt"), "no content from an encrypted space");
  assert.match(b.message, new RegExp(`#page=${secretPage}`), "the link is still there");
});

test("ntfy: JSON publishing with topic, click, priority, tags and the access token", async () => {
  await M.connectMessenger(ben, { service: "ntfy", topic: "flowplan-ben", auth: "token", token: "tk_abcdefghijklmnop" });
  notify(ben, "security", "Jemand hat mehrmals eine falsche PIN eingegeben");
  await flush();
  const r = sent.find((x) => x.url.startsWith("https://ntfy.sh"))!;
  assert.equal(r.url, "https://ntfy.sh/");
  assert.equal(r.headers.Authorization, "Bearer tk_abcdefghijklmnop");
  const b = body(r) as { topic: string; title: string; message: string; click: string; priority: number; tags: string[] };
  assert.equal(b.topic, "flowplan-ben");
  assert.equal(b.title, "Flowplan · Sicherheit");
  assert.equal(b.priority, 4, "security rings louder");
  assert.deepEqual(b.tags, ["warning"]);
  assert.match(b.click, /^https:\/\/flow\.example\.test\//);
  // Basic auth instead of a token.
  const basic = S.buildRequest("ntfy", { server: "https://ntfy.example.test", topic: "t", user: "ben" }, { password: "pw" }, { title: "T", text: "x", url: "https://u", open: "o" }, "1");
  assert.equal(basic.headers.Authorization, `Basic ${Buffer.from("ben:pw").toString("base64")}`);
  assert.equal(basic.url, "https://ntfy.example.test/");
  await M.removeMessenger(ben, { id: M.messengerOverview(ben).targets[0].id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(one("SELECT 1 FROM security_events WHERE kind='account.messenger_removed' AND actor_id=?", ben.id));
});

test("Matrix: PUT with a transaction id, plain body and HTML with the link", async () => {
  await M.connectMessenger(ben, { service: "matrix", homeserver: "https://matrix.example.test", room: "!room:example.test", token: "syt_matrix_token_value" });
  notify(ben, "comment", "Ada kommentiert „Plan“");
  await flush();
  const r = sent.find((x) => x.url.includes("/_matrix/"))!;
  assert.equal(r.method, "PUT");
  assert.match(r.url, /^https:\/\/matrix\.example\.test\/_matrix\/client\/v3\/rooms\/!room%3Aexample\.test\/send\/m\.room\.message\/fp-\d+$/);
  assert.equal(r.headers.Authorization, "Bearer syt_matrix_token_value");
  const b = body(r) as Record<string, string>;
  assert.equal(b.msgtype, "m.text");
  assert.equal(b.format, "org.matrix.custom.html");
  assert.match(b.body, /Ada kommentiert „Plan“\nhttps:\/\/flow\.example\.test\//);
  assert.match(b.formatted_body, /<a href="https:\/\/flow\.example\.test\/#page=[^"]+">In Flowplan öffnen<\/a>/);
  await M.removeMessenger(ben, { id: M.messengerOverview(ben).targets[0].id });
});

test("Telegram with an own bot: sendMessage with HTML, a custom API address", async () => {
  await assert.rejects(M.connectMessenger(ben, { service: "telegram", token: "kein-token", chatId: "42" }), /Bot-Token/);
  await M.connectMessenger(ben, { service: "telegram", token: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345", chatId: "42", apiUrl: "https://tg-relay.example.test/" });
  const view = M.messengerOverview(ben).targets[0];
  assert.equal(view.mode, "own");
  assert.match(view.detail, /Chat 42 · tg-relay\.example\.test/);
  assert.ok(!JSON.stringify(view).includes("ABCdef"));
  notify(ben, "reminder", "Erinnerung: „Plan“ – Fällig: <morgen> & mehr");
  await flush();
  const r = sent.find((x) => x.url.includes("/bot"))!;
  assert.equal(r.url, "https://tg-relay.example.test/bot123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345/sendMessage");
  const b = body(r) as { chat_id: string; text: string; parse_mode: string };
  assert.equal(b.chat_id, "42");
  assert.equal(b.parse_mode, "HTML");
  assert.match(b.text, /^<b>Flowplan · Erinnerung<\/b>\n/);
  assert.ok(b.text.includes("&lt;morgen&gt; &amp; mehr"), "HTML is escaped");
  assert.match(b.text, /<a href="https:\/\/flow\.example\.test\/#page=[^"]+">In Flowplan öffnen<\/a>$/);
});

test("refused addresses: internal, not allowed by the administrators, not https", async () => {
  await assert.rejects(M.connectMessenger(ben, { service: "gotify", server: "https://127.0.0.1:8080", token: "abcdefghijkl" }), /Interne Adressen/);
  await assert.rejects(M.connectMessenger(ben, { service: "gotify", server: "https://intern.example.test", token: "abcdefghijkl" }), /Interne Adressen/);
  await assert.rejects(M.connectMessenger(ben, { service: "gotify", server: "http://gotify.example.test", token: "abcdefghijkl" }), /https/);
  await assert.rejects(M.connectMessenger(ben, { service: "gotify", server: "https://user:pw@gotify.example.test", token: "abcdefghijkl" }), /Zugangsdaten/);
  M.saveMessengerAdmin(root, { allowedHosts: ["*.corp.example.test", "push.example.test"] });
  await assert.rejects(M.connectMessenger(ben, { service: "gotify", server: "https://gotify.example.test", token: "abcdefghijkl" }), /nicht freigegeben/);
  await M.connectMessenger(ben, { service: "ntfy", server: "https://ntfy.corp.example.test", topic: "ok" });
  // The default servers always work.
  await M.connectMessenger(ben, { service: "ntfy", topic: "ok" });
  M.saveMessengerAdmin(root, { allowedHosts: [] });
  assert.equal(M.hostAllowed("a.corp.example.test", ["*.corp.example.test"]), true);
  assert.equal(M.hostAllowed("corp.example.test.evil.test", ["*.corp.example.test"]), false);
  // With FLOWPLAN_MESSENGER_ALLOW_PRIVATE the own network is fine.
  process.env.FLOWPLAN_MESSENGER_ALLOW_PRIVATE = "true";
  assert.equal(await M.checkServerUrl("http://intern.example.test:8080/"), "http://intern.example.test:8080");
  delete process.env.FLOWPLAN_MESSENGER_ALLOW_PRIVATE;
  // A refused address at sending time (DNS changed): a failure like 401.
  assert.deepEqual(S.classifyError(new Error("Interne Adressen sind nicht erlaubt.")), { ok: false, reason: "private" });
  assert.deepEqual(S.classifyError(new Error("getaddrinfo ENOTFOUND x")), { ok: false, reason: "unreachable" });
  await M.removeMessenger(ben, { id: M.messengerOverview(ben).targets.find((t) => t.service === "ntfy")!.id });
});

test("answers: 429 waits without losing an attempt, 5xx retries, 400 gives up", async () => {
  clearQueue();
  assert.deepEqual(S.classify("telegram", { status: 429, body: '{"ok":false,"parameters":{"retry_after":7}}' }), { ok: false, reason: "rate_limited", status: 429, retryAfter: 7 });
  assert.deepEqual(S.classify("matrix", { status: 429, body: '{"retry_after_ms":2500}' }), { ok: false, reason: "rate_limited", status: 429, retryAfter: 3 });
  assert.deepEqual(S.classify("ntfy", { status: 429, body: "", headers: { "retry-after": "30" } }), { ok: false, reason: "rate_limited", status: 429, retryAfter: 30 });
  assert.deepEqual(S.classify("telegram", { status: 400, body: '{"ok":false,"description":"Bad Request: chat not found"}' }), { ok: false, reason: "notfound", status: 400 });
  assert.deepEqual(S.classify("telegram", { status: 403, body: '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' }), { ok: false, reason: "auth", status: 403 });
  assert.deepEqual(S.classify("telegram", { status: 200, body: '{"ok":false}' }).ok, false);
  const now = Date.now();
  answer = () => ({ status: 429, body: '{"ok":false,"parameters":{"retry_after":7}}' });
  notify(ben, "mention", "Ada hat dich in „Plan“ erwähnt");
  await flush(now);
  let d = one<{ attempts: number; available_at: number; last_error: string }>("SELECT attempts,available_at,last_error FROM messenger_deliveries ORDER BY id DESC LIMIT 1")!;
  assert.equal(d.attempts, 0);
  assert.ok(d.available_at >= now + 6000);
  assert.equal(d.last_error, "rate_limited:429");
  answer = () => ({ status: 502, body: "" });
  await flush(d.available_at);
  d = one("SELECT attempts,available_at,last_error FROM messenger_deliveries ORDER BY id DESC LIMIT 1")!;
  assert.equal(d.attempts, 1);
  assert.equal(d.last_error, "server:502");
  assert.equal(one<{ enabled: number }>("SELECT enabled FROM messenger_targets WHERE user_id=?", ben.id)!.enabled, 1, "a server error does not turn it off");
  answer = () => ({ status: 400, body: '{"ok":false,"description":"Bad Request: can\'t parse entities"}' });
  await flush(d.available_at);
  d = one("SELECT attempts,available_at,last_error FROM messenger_deliveries ORDER BY id DESC LIMIT 1")!;
  assert.equal(d.attempts, M.MAX_ATTEMPTS, "given up");
  assert.equal(d.last_error, "rejected:400");
});

test("repeated 401/404: the target is turned off and the person told in the inbox", async () => {
  clearQueue();
  answer = () => ({ status: 401, body: '{"ok":false,"error_code":401,"description":"Unauthorized"}' });
  let at = Date.now();
  notify(ben, "mention", "Ada hat dich in „Plan“ erwähnt");
  for (let i = 0; i < M.DISABLE_AFTER; i++) {
    await flush(at);
    at += 3_600_000;
  }
  const target = one<{ enabled: number; disabled_reason: string; failures: number }>("SELECT enabled,disabled_reason,failures FROM messenger_targets WHERE user_id=?", ben.id)!;
  assert.equal(target.enabled, 0);
  assert.equal(target.disabled_reason, "auth:401");
  const told = one<{ body: string; kind: string }>("SELECT body,kind FROM notifications WHERE user_id=? AND body LIKE 'Chat-App%' ORDER BY created_at DESC", ben.id)!;
  assert.match(told.body, /^Chat-App Telegram ausgeschaltet: wiederholt abgewiesen \(HTTP 401\)/);
  assert.equal(told.kind, "security");
  assert.equal(pending(ben).length, 0, "nothing waits for a target that is off");
  const view = M.messengerOverview(ben).targets[0];
  assert.equal(view.enabled, false);
  // English for people who read English.
  const { englishMessage } = await import("../lib/i18n-errors");
  assert.match(englishMessage(told.body), /^Chat app Telegram switched off: refused repeatedly \(HTTP 401\)/);
  // Nothing is queued for it any more; on again by the person.
  notify(ben, "mention", "Noch eine Erwähnung");
  assert.equal(pending(ben).length, 0);
  M.enableMessenger(ben, { id: view.id });
  assert.equal(M.messengerOverview(ben).targets[0].enabled, true);
  assert.equal(one<{ failures: number }>("SELECT failures FROM messenger_targets WHERE id=?", view.id)!.failures, 0);
});

test("at most RATE_PER_MINUTE messages a minute per target", async () => {
  clearQueue();
  const target = one<{ id: string }>("SELECT id FROM messenger_targets WHERE user_id=?", ben.id)!;
  const now = Date.now();
  for (let i = 0; i < M.RATE_PER_MINUTE; i++)
    run("INSERT INTO messenger_deliveries(target_id,title,body,url,available_at,created_at,delivered_at) VALUES(?,?,?,?,?,?,?)", target.id, "t", "b", "u", now, now, now - 1000);
  notify(ben, "mention", "Zu viel auf einmal");
  await flush(now);
  assert.equal(sent.length, 0);
  const d = one<{ attempts: number; available_at: number }>("SELECT attempts,available_at FROM messenger_deliveries WHERE delivered_at IS NULL")!;
  assert.equal(d.attempts, 0, "throttled, not failed");
  assert.ok(d.available_at > now);
  clearQueue();
});

test("test message: the outcome right away, with a clear reason", async () => {
  const target = M.messengerOverview(ben).targets[0];
  answer = () => ({ status: 200, body: '{"ok":true}' });
  const ok = await M.testMessenger(ben, { id: target.id });
  assert.equal(ok.ok, true);
  assert.match(String(body(sent[0]).text), /Testnachricht/);
  answer = () => ({ status: 404, body: '{"ok":false}' });
  const missing = await M.testMessenger(ben, { id: target.id });
  assert.deepEqual([missing.ok, (missing as { error: string }).error], [false, "notfound:404"]);
  answer = () => {
    throw new Error("connect ECONNREFUSED");
  };
  assert.equal(((await M.testMessenger(ben, { id: target.id })) as { error: string }).error, "unreachable");
  const { messengerErrorText } = await import("../lib/messenger-services");
  const en = (de: string, enText: string) => enText;
  assert.match(messengerErrorText("auth:401", en), /Credentials refused \(HTTP 401\)/);
  assert.match(messengerErrorText("notfound:404", en), /Not found \(HTTP 404\)/);
  assert.match(messengerErrorText("private", en), /Internal addresses/);
  assert.match(messengerErrorText("unreachable", en), /not reachable/);
  // At most a few a minute.
  await M.testMessenger(ben, { id: target.id });
  await M.testMessenger(ben, { id: target.id });
  await assert.rejects(M.testMessenger(ben, { id: target.id }), /Zu viele Testnachrichten/);
  // Someone else's connection does not exist for this person.
  await assert.rejects(M.testMessenger(ada, { id: target.id }), /nicht gefunden/);
});

test("the instance's Telegram bot: getMe on saving, sealed, never in the answer", async () => {
  answer = (r) =>
    r.url.endsWith("/getMe") ? { status: 200, body: '{"ok":true,"result":{"id":1,"username":"FlowplanTestBot"}}' } : { status: 200, body: '{"ok":true}' };
  const status = await M.saveMessengerBot(root, { token: "987654:BotTokenSecretValue_abcdefghij", apiUrl: "https://tg-proxy.example.test/" });
  assert.equal(status.bot.username, "FlowplanTestBot");
  assert.equal(status.bot.apiUrl, "https://tg-proxy.example.test");
  assert.equal(status.bot.tokenHint, "…ghij");
  assert.ok(!JSON.stringify(status).includes("BotTokenSecretValue"));
  assert.ok(!JSON.stringify(M.messengerAdminStatus()).includes("BotTokenSecretValue"));
  assert.ok(!one<{ value: string }>("SELECT value FROM instance_settings WHERE key='messengers'")!.value.includes("BotTokenSecretValue"));
  assert.equal(sent[0].url, "https://tg-proxy.example.test/bot987654:BotTokenSecretValue_abcdefghij/getMe");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(one("SELECT 1 FROM security_events WHERE kind='admin.messenger_bot' AND actor_id=?", root.id));
  // A refused token is not stored.
  answer = () => ({ status: 401, body: '{"ok":false}' });
  await assert.rejects(M.saveMessengerBot(root, { token: "111:WrongTokenWrongTokenWrong123" }), /lehnt den Bot-Token ab/);
  assert.equal(M.messengerAdminStatus().bot.username, "FlowplanTestBot");
  assert.equal(M.messengerOverview(ada).bot?.username, "FlowplanTestBot");
});

test("Telegram /start <code>: binds the chat once, codes expire, wrong codes bind nothing", async () => {
  const link = await M.createTelegramLink(ada);
  assert.match(link.url, /^https:\/\/t\.me\/FlowplanTestBot\?start=[A-Za-z0-9_-]{24}$/);
  assert.equal(link.url.split("start=")[1], link.code);
  assert.ok(!one("SELECT 1 FROM telegram_links WHERE code_hash=?", link.code), "only a hash is stored");
  // A wrong code binds nothing.
  assert.deepEqual(M.consumeTelegramCode("WrongCodeWrongCode123456", "555"), { status: "invalid" });
  assert.deepEqual(M.consumeTelegramCode("x y", "555"), { status: "invalid" });
  // getUpdates delivers "/start <code>" from a private chat; the bot answers.
  answer = (r) =>
    r.url.endsWith("/getUpdates")
      ? {
          status: 200,
          body: JSON.stringify({
            ok: true,
            result: [
              { update_id: 100, message: { text: "/start", chat: { id: 777, type: "private" }, from: { language_code: "en" } } },
              { update_id: 101, message: { text: `/start ${link.code}`, chat: { id: 777, type: "private" }, from: { language_code: "de" } } },
              { update_id: 102, message: { text: `/start ${link.code}`, chat: { id: 888, type: "group" } } },
            ],
          }),
        }
      : { status: 200, body: '{"ok":true}' };
  const results = await M.pollTelegram(0);
  assert.deepEqual(results.map((r) => r?.status ?? null), ["invalid", "linked", null]);
  assert.equal(one<{ value: string }>("SELECT value FROM instance_state WHERE key='telegramOffset'")!.value, "103");
  const poll = sent.find((r) => r.url.endsWith("/getUpdates"))!;
  assert.deepEqual(body(poll).allowed_updates, ["message"]);
  const replies = sent.filter((r) => r.url.endsWith("/sendMessage")).map((r) => body(r) as { chat_id: number; text: string });
  assert.match(replies[0].text, /^Open the link from Flowplan/);
  assert.match(replies[1].text, /^Verbunden/);
  const target = M.messengerOverview(ada).targets.find((t) => t.service === "telegram")!;
  assert.equal(target.mode, "bot");
  assert.match(target.detail, /@FlowplanTestBot · Chat 777/);
  assert.equal(target.hasSecret, false, "the bot's token is not stored with the person");
  // Single use.
  assert.deepEqual(M.consumeTelegramCode(link.code, "999"), { status: "used" });
  // Expired codes.
  const late = await M.createTelegramLink(ben);
  assert.deepEqual(M.consumeTelegramCode(late.code, "999", late.expires + 1), { status: "expired" });
  assert.equal(M.messengerOverview(ben).targets.some((t) => t.mode === "bot"), false);
  // A new link replaces the person's earlier unused code.
  const again = await M.createTelegramLink(ben);
  assert.deepEqual(M.consumeTelegramCode(late.code, "999"), { status: "invalid" });
  assert.equal(M.consumeTelegramCode(again.code, "999").status, "linked");
  // Messages to the bound chat go through the instance's bot and API address.
  sent = [];
  answer = () => ({ status: 200, body: '{"ok":true}' });
  clearQueue();
  notify(ada, "share", "Ben hat „Plan“ mit dir geteilt");
  await flush();
  const toBot = sent.find((r) => r.url.includes("/sendMessage") && body(r).chat_id === "777")!;
  assert.equal(toBot.url, "https://tg-proxy.example.test/bot987654:BotTokenSecretValue_abcdefghij/sendMessage");
  // A conflict (webhook set elsewhere) is reported to the administrators.
  await M.createTelegramLink(ben);
  answer = () => ({ status: 409, body: '{"ok":false,"description":"Conflict"}' });
  await assert.rejects(M.pollTelegram(0), /conflict/);
  assert.equal(M.messengerAdminStatus().bot.lastError, "conflict");
});

test("services switched off by the administrators: no connecting, nothing sent", async () => {
  clearQueue();
  M.saveMessengerAdmin(root, { services: { gotify: false } });
  assert.equal(M.messengerOverview(ada).services.includes("gotify"), false);
  assert.equal(M.messengerOverview(ada).targets.find((t) => t.service === "gotify")!.blocked, true);
  await assert.rejects(M.connectMessenger(ada, { service: "gotify", server: "https://gotify.example.test", token: "abcdefghijkl" }), /ausgeschaltet/);
  notify(ada, "mention", "Ben hat dich in „Plan“ erwähnt");
  await flush();
  assert.equal(sent.filter((r) => r.url.includes("gotify")).length, 0);
  M.saveMessengerAdmin(root, { services: { gotify: true } });
  assert.ok(one("SELECT 1 FROM audit WHERE action='admin.messengers'"));
});

test("operations alerts reach administrators' chat apps; security incidents are not sent twice", async () => {
  clearQueue();
  answer = (r) => (r.url.endsWith("/getMe") ? { status: 200, body: '{"ok":true,"result":{"username":"FlowplanTestBot"}}' } : { status: 200, body: '{"ok":true}' });
  await M.connectMessenger(root, { service: "ntfy", topic: "ops-root" });
  // Many failed sign-ins: a health alert, without any webhook configured.
  for (let i = 0; i < ops.LOGIN_ALERT_THRESHOLD; i++) run("INSERT INTO ops_events(kind,at) VALUES('login_failure',?)", Date.now());
  const sentByWebhook = await ops.checkHealthAlerts();
  assert.equal(sentByWebhook.length, 0, "no webhook");
  const queued = all<{ title: string; body: string; url: string }>(
    "SELECT d.title,d.body,d.url FROM messenger_deliveries d JOIN messenger_targets t ON t.id=d.target_id WHERE t.user_id=?",
    root.id,
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].title, "Flowplan · Viele fehlgeschlagene Anmeldungen");
  assert.equal(queued[0].url, "https://flow.example.test/#admin/monitoring");
  // Once a day.
  await ops.checkHealthAlerts();
  assert.equal(all("SELECT 1 FROM messenger_deliveries").length, 1);
  await flush();
  const r = sent.find((x) => body(x).topic === "ops-root")!;
  assert.equal(body(r).priority, 4);
  // Not for administrators who turned operations alerts off.
  M.setMessengerSettings(root, { ops: false });
  assert.deepEqual(M.opsMessengerAdmins(), []);
  // Security incidents: sendSecurityAlert leaves chat apps alone (the
  // "security" notification already goes there by its kind).
  clearQueue();
  await ops.sendSecurityAlert("brute_force_account", "x");
  assert.equal(all("SELECT 1 FROM messenger_deliveries").length, 0);
  notify(root, "security", "Sicherheit: Passwort-Raten bei einem Konto. Details unter Administration → Sicherheit.", null);
  assert.equal(all("SELECT 1 FROM messenger_deliveries").length, 1, "exactly one message for the incident");
});

test("deleting the account removes its connections", async () => {
  const { deleteAccount } = await import("../lib/account-deletion");
  const gone = person("Gone");
  await M.connectMessenger(gone, { service: "ntfy", topic: "gone-topic" });
  run("UPDATE users SET disabled=1 WHERE id=?", gone.id);
  deleteAccount(root, gone.id);
  assert.equal(one("SELECT 1 FROM messenger_targets WHERE user_id=?", gone.id), undefined);
});
