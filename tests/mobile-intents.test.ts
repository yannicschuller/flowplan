import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-intents-"));
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { withContentLocale } = await import("../lib/content-locale");
const { widgetUser } = await import("../lib/mobile-widgets");
const { intentPages, intentSearch, intentWorkspaces } = await import("../lib/mobile-intents");
const { focusSilences, setDeviceFocus } = await import("../lib/mobile-focus");
const { flushPushQueue } = await import("../lib/push");
const route = await import("../app/api/mobile/intents/[action]/route");

function account(name: string) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
let pushCounter = 0;
function phone(acc: { user: Identity; token: string }, push = false) {
  const pushToken = push ? `ExponentPushToken[intents-${String(++pushCounter).padStart(12, "0")}]` : undefined;
  const { deviceToken } = registerMobileDevice(acc.user, acc.token, { installationId: randomUUID(), platform: "ios", ...(pushToken ? { pushToken } : {}) });
  return { deviceToken, pushToken, device: widgetUser(`Bearer ${deviceToken}`)! };
}
const en = <T>(fn: () => T) => withContentLocale("en", fn);
const page = (user: Identity, wid: string, sid: string, title: string, kind = "document") =>
  (command(user, { action: "page.create", workspaceId: wid, spaceId: sid, kind, title }) as { id: string }).id;
function writeDocument(user: Identity, wid: string, pageId: string, html: string) {
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId)!.generation);
  command(user, { action: "document.sync", workspaceId: wid, pageId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
}

const owner = account("intent-owner"),
  reader = account("intent-reader"),
  stranger = account("intent-stranger");
const wid = createWorkspace(owner.user.id, "Agency");
const sid = bootstrap(owner.user, wid).spaces[0].id;
const other = createWorkspace(owner.user.id, "Home");
const otherSid = bootstrap(owner.user, other).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, reader.user.id, "viewer");
const strangerWid = createWorkspace(stranger.user.id, "Elsewhere");
const strangerSid = bootstrap(stranger.user, strangerWid).spaces[0].id;

const roadmap = page(owner.user, wid, sid, "Roadmap 2027");
const roadTrip = page(owner.user, other, otherSid, "Road trip packing list");
const clients = page(owner.user, wid, sid, "Clients", "database");
const secret = page(stranger.user, strangerWid, strangerSid, "Roadmap of the stranger");
writeDocument(owner.user, wid, roadmap, "<p>The launch of the zeppelin service is in spring.</p>");

const O = phone(owner).device,
  R = phone(reader).device;

test("pages by title, across workspaces, only readable ones; by id; suggested without a query", () => {
  const found = en(() => intentPages(O, { q: "road" })).pages;
  assert.deepEqual(found.map((p) => p.id).sort(), [roadmap, roadTrip].sort());
  const map = found.find((p) => p.id === roadmap)!;
  assert.equal(map.name, "Roadmap 2027");
  assert.equal(map.workspace, "Agency");
  assert.equal(map.workspaceId, wid);
  assert.equal(map.url, `/#page=${roadmap}`);
  // Titles that start with the text come first.
  assert.equal(en(() => intentPages(O, { q: "Road trip" })).pages[0].id, roadTrip);
  // Pages of other people's workspaces never show, not even by id.
  assert.ok(!en(() => intentPages(O, { q: "stranger" })).pages.length);
  assert.deepEqual(en(() => intentPages(O, { ids: [secret, clients] })).pages.map((p) => p.id), [clients]);
  // The reader sees the shared workspace only.
  assert.deepEqual(en(() => intentPages(R, { q: "road" })).pages.map((p) => p.id), [roadmap]);
  // LIKE wildcards are text.
  assert.equal(en(() => intentPages(O, { q: "%" })).pages.length, 0);
  // Without a query: favorites first.
  command(owner.user, { action: "favorite", pageId: clients, value: true });
  const suggested = en(() => intentPages(O, {})).pages;
  assert.equal(suggested[0].id, clients);
  assert.ok(suggested.length <= 20 && suggested.some((p) => p.id === roadTrip));
  assert.throws(() => intentPages(O, { ids: ["nope"] }));
});

test("pages of end-to-end encrypted spaces stay out", () => {
  const space = (command(owner.user, { action: "space.create", workspaceId: wid, name: "Vault" }) as { id: string }).id;
  const hidden = page(owner.user, wid, space, "Road to the vault");
  run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  assert.ok(!en(() => intentPages(O, { q: "vault" })).pages.length);
  assert.ok(!en(() => intentPages(O, { ids: [hidden] })).pages.length);
});

test("search finds text in documents across workspaces, with plain snippets", () => {
  const { results } = en(() => intentSearch(O, { q: "zeppelin" }));
  assert.equal(results.length, 1);
  assert.equal(results[0].id, roadmap);
  assert.equal(results[0].workspace, "Agency");
  assert.match(results[0].snippet, /zeppelin/);
  assert.doesNotMatch(results[0].snippet, /[\u0002\u0003]/);
  assert.equal(en(() => intentSearch(stranger.user, { q: "zeppelin" })).results.length, 0);
  assert.throws(() => intentSearch(O, { q: "  " }));
});

test("workspaces for the Focus filter", () => {
  assert.deepEqual(en(() => intentWorkspaces(O)).workspaces.map((w) => w.name), ["Agency", "Home"]);
  assert.deepEqual(en(() => intentWorkspaces(R)).workspaces.map((w) => w.id), [wid]);
});

test("a Focus holds back pushes of other workspaces on that device, then ends", async () => {
  const acc = account("intent-focus");
  const fw = createWorkspace(acc.user.id, "Focus work");
  const fs = bootstrap(acc.user, fw).spaces[0].id;
  const fo = createWorkspace(acc.user.id, "Focus private");
  const fos = bootstrap(acc.user, fo).spaces[0].id;
  const work = page(acc.user, fw, fs, "Work page");
  const priv = page(acc.user, fo, fos, "Private page");
  run("INSERT INTO members VALUES(?,?,?)", fw, owner.user.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", fo, owner.user.id, "editor");
  const { deviceToken, pushToken } = phone(acc, true);
  const auth = `Bearer ${deviceToken}`;
  const now = Date.now();
  // Someone else's workspace is refused; another person's device too.
  assert.throws(() => setDeviceFocus(acc.user, auth, { workspaceId: wid, hide: true }), /not found|nicht gefunden/i);
  assert.throws(() => setDeviceFocus(owner.user, auth, { workspaceId: fw, hide: true }), /melde dich an/);
  const set = en(() => setDeviceFocus(acc.user, auth, { workspaceId: fw, hide: true }, now));
  assert.equal(set.focus?.workspaceId, fw);
  const sent: { to: string; data: { url: string } }[] = [];
  const flush = () =>
    flushPushQueue(
      async () => {},
      async (message) => {
        sent.push(message);
      },
    );
  command(owner.user, { action: "comment.create", pageId: work, body: "Work comment" });
  command(owner.user, { action: "comment.create", pageId: priv, body: "Private comment" });
  await flush();
  assert.deepEqual(sent.filter((m) => m.to === pushToken).map((m) => m.data.url), [`/#page=${work}`]);
  // Another profile's Focus: everything waits; past its end it comes again.
  const subscription = one<{ push_subscription_id: string }>("SELECT push_subscription_id FROM mobile_devices WHERE user_id=?", acc.user.id)!.push_subscription_id;
  setDeviceFocus(acc.user, auth, { workspaceId: null, hide: true, hours: 1 }, now);
  assert.ok(focusSilences(subscription, fw, now));
  assert.ok(focusSilences(subscription, null, now));
  assert.ok(!focusSilences(subscription, fw, now + 2 * 3_600_000));
  // Switched off.
  assert.equal(setDeviceFocus(acc.user, auth, { hide: false }).focus, null);
  assert.ok(!focusSilences(subscription, fo, now));
  command(owner.user, { action: "comment.create", pageId: priv, body: "After the focus" });
  await flush();
  assert.equal(sent.filter((m) => m.to === pushToken && m.data.url === `/#page=${priv}`).length, 1);
});

test("the route: device token only, rate-limited endpoints, focus by POST", async () => {
  const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
  const acc = account("intent-route");
  const rw = createWorkspace(acc.user.id, "Route");
  page(acc.user, rw, bootstrap(acc.user, rw).spaces[0].id, "Quarterly plan");
  const { deviceToken } = phone(acc);
  const get = (path: string, authorization = `Bearer ${deviceToken}`) =>
    route.GET(new Request(`http://localhost/api/mobile/intents/${path}`, { headers: { authorization } }), ctx(path.split("?")[0]));
  const pages = await get("pages?q=quarter");
  assert.equal(pages.status, 200);
  assert.equal(pages.headers.get("Cache-Control"), "no-store");
  assert.equal(((await pages.json()) as { pages: { name: string }[] }).pages[0].name, "Quarterly plan");
  assert.equal((await get("pages?ids=nope")).status, 400);
  assert.equal((await get("workspaces")).status, 200);
  assert.equal((await get("search?q=")).status, 400);
  assert.equal((await get("nothing")).status, 404);
  assert.equal((await get("pages", `Bearer ${acc.token}`)).status, 401);
  const post = (body: unknown, action = "focus") =>
    route.POST(
      new Request(`http://localhost/api/mobile/intents/${action}`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}` }, body: JSON.stringify(body) }),
      ctx(action),
    );
  const focus = await post({ workspaceId: rw, hide: true });
  assert.equal(focus.status, 200);
  assert.equal(((await focus.json()) as { focus: { workspaceId: string } }).focus.workspaceId, rw);
  assert.equal((await post({ hide: false })).status, 200);
  assert.equal((await post({ workspaceId: "x" })).status, 400);
  assert.equal((await post({}, "pages")).status, 404);
});
