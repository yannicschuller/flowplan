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

async function account(name: string) {
  const uid = id(),
    token = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
let pushCounter = 0;
async function phone(acc: { user: Identity; token: string }, push = false) {
  const pushToken = push ? `ExponentPushToken[intents-${String(++pushCounter).padStart(12, "0")}]` : undefined;
  const { deviceToken } = await registerMobileDevice(acc.user, acc.token, { installationId: randomUUID(), platform: "ios", ...(pushToken ? { pushToken } : {}) });
  return { deviceToken, pushToken, device: (await widgetUser(`Bearer ${deviceToken}`))! };
}
const en = <T>(fn: () => T) => withContentLocale("en", fn);
const page = async (user: Identity, wid: string, sid: string, title: string, kind = "document") =>
  ((await command(user, { action: "page.create", workspaceId: wid, spaceId: sid, kind, title })) as { id: string }).id;
async function writeDocument(user: Identity, wid: string, pageId: string, html: string) {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await command(user, { action: "document.sync", workspaceId: wid, pageId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
}

const owner = await account("intent-owner"),
  reader = await account("intent-reader"),
  stranger = await account("intent-stranger");
const wid = await createWorkspace(owner.user.id, "Agency");
const sid = (await bootstrap(owner.user, wid)).spaces[0].id;
const other = await createWorkspace(owner.user.id, "Home");
const otherSid = (await bootstrap(owner.user, other)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.user.id, "viewer");
const strangerWid = await createWorkspace(stranger.user.id, "Elsewhere");
const strangerSid = (await bootstrap(stranger.user, strangerWid)).spaces[0].id;

const roadmap = await page(owner.user, wid, sid, "Roadmap 2027");
const roadTrip = await page(owner.user, other, otherSid, "Road trip packing list");
const clients = await page(owner.user, wid, sid, "Clients", "database");
const secret = await page(stranger.user, strangerWid, strangerSid, "Roadmap of the stranger");
await writeDocument(owner.user, wid, roadmap, "<p>The launch of the zeppelin service is in spring.</p>");

const O = (await phone(owner)).device,
  R = (await phone(reader)).device;

test("pages by title, across workspaces, only readable ones; by id; suggested without a query", async () => {
  const found = (await en(async () => await intentPages(O, { q: "road" }))).pages;
  assert.deepEqual(found.map((p) => p.id).sort(), [roadmap, roadTrip].sort());
  const map = found.find((p) => p.id === roadmap)!;
  assert.equal(map.name, "Roadmap 2027");
  assert.equal(map.workspace, "Agency");
  assert.equal(map.workspaceId, wid);
  assert.equal(map.url, `/#page=${roadmap}`);
  // Titles that start with the text come first.
  assert.equal((await en(async () => await intentPages(O, { q: "Road trip" }))).pages[0].id, roadTrip);
  // Pages of other people's workspaces never show, not even by id.
  assert.ok(!(await en(async () => await intentPages(O, { q: "stranger" }))).pages.length);
  assert.deepEqual((await en(async () => await intentPages(O, { ids: [secret, clients] }))).pages.map((p) => p.id), [clients]);
  // The reader sees the shared workspace only.
  assert.deepEqual((await en(async () => await intentPages(R, { q: "road" }))).pages.map((p) => p.id), [roadmap]);
  // LIKE wildcards are text.
  assert.equal((await en(async () => await intentPages(O, { q: "%" }))).pages.length, 0);
  // Without a query: favorites first.
  await command(owner.user, { action: "favorite", pageId: clients, value: true });
  const suggested = (await en(async () => await intentPages(O, {}))).pages;
  assert.equal(suggested[0].id, clients);
  assert.ok(suggested.length <= 20 && suggested.some((p) => p.id === roadTrip));
  await assert.rejects(async () => await intentPages(O, { ids: ["nope"] }));
});

test("pages of end-to-end encrypted spaces stay out", async () => {
  const space = ((await command(owner.user, { action: "space.create", workspaceId: wid, name: "Vault" })) as { id: string }).id;
  const hidden = await page(owner.user, wid, space, "Road to the vault");
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  assert.ok(!(await en(async () => await intentPages(O, { q: "vault" }))).pages.length);
  assert.ok(!(await en(async () => await intentPages(O, { ids: [hidden] }))).pages.length);
});

test("search finds text in documents across workspaces, with plain snippets", async () => {
  const { results } = await en(async () => await intentSearch(O, { q: "zeppelin" }));
  assert.equal(results.length, 1);
  assert.equal(results[0].id, roadmap);
  assert.equal(results[0].workspace, "Agency");
  assert.match(results[0].snippet, /zeppelin/);
  assert.doesNotMatch(results[0].snippet, /[\u0002\u0003]/);
  assert.equal((await en(async () => await intentSearch(stranger.user, { q: "zeppelin" }))).results.length, 0);
  await assert.rejects(async () => await intentSearch(O, { q: "  " }));
});

test("workspaces for the Focus filter", async () => {
  assert.deepEqual((await en(async () => await intentWorkspaces(O))).workspaces.map((w) => w.name), ["Agency", "Home"]);
  assert.deepEqual((await en(async () => await intentWorkspaces(R))).workspaces.map((w) => w.id), [wid]);
});

test("a Focus holds back pushes of other workspaces on that device, then ends", async () => {
  const acc = await account("intent-focus");
  const fw = await createWorkspace(acc.user.id, "Focus work");
  const fs = (await bootstrap(acc.user, fw)).spaces[0].id;
  const fo = await createWorkspace(acc.user.id, "Focus private");
  const fos = (await bootstrap(acc.user, fo)).spaces[0].id;
  const work = await page(acc.user, fw, fs, "Work page");
  const priv = await page(acc.user, fo, fos, "Private page");
  await run("INSERT INTO members VALUES(?,?,?)", fw, owner.user.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", fo, owner.user.id, "editor");
  const { deviceToken, pushToken } = await phone(acc, true);
  const auth = `Bearer ${deviceToken}`;
  const now = Date.now();
  // Someone else's workspace is refused; another person's device too.
  await assert.rejects(async () => await setDeviceFocus(acc.user, auth, { workspaceId: wid, hide: true }), /not found|nicht gefunden/i);
  await assert.rejects(async () => await setDeviceFocus(owner.user, auth, { workspaceId: fw, hide: true }), /melde dich an/);
  const set = await en(async () => await setDeviceFocus(acc.user, auth, { workspaceId: fw, hide: true }, now));
  assert.equal(set.focus?.workspaceId, fw);
  const sent: { to: string; data: { url: string } }[] = [];
  const flush = () =>
    flushPushQueue(
      async () => {},
      async (message) => {
        sent.push(message);
      },
    );
  await command(owner.user, { action: "comment.create", pageId: work, body: "Work comment" });
  await command(owner.user, { action: "comment.create", pageId: priv, body: "Private comment" });
  await flush();
  assert.deepEqual(sent.filter((m) => m.to === pushToken).map((m) => m.data.url), [`/#page=${work}`]);
  // Another profile's Focus: everything waits; past its end it comes again.
  const subscription = (await one<{ push_subscription_id: string }>("SELECT push_subscription_id FROM mobile_devices WHERE user_id=?", acc.user.id))!.push_subscription_id;
  await setDeviceFocus(acc.user, auth, { workspaceId: null, hide: true, hours: 1 }, now);
  assert.ok(await focusSilences(subscription, fw, now));
  assert.ok(await focusSilences(subscription, null, now));
  assert.ok(!(await focusSilences(subscription, fw, now + 2 * 3_600_000)));
  // Switched off.
  assert.equal((await setDeviceFocus(acc.user, auth, { hide: false })).focus, null);
  assert.ok(!(await focusSilences(subscription, fo, now)));
  await command(owner.user, { action: "comment.create", pageId: priv, body: "After the focus" });
  await flush();
  assert.equal(sent.filter((m) => m.to === pushToken && m.data.url === `/#page=${priv}`).length, 1);
});

test("the route: device token only, rate-limited endpoints, focus by POST", async () => {
  const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
  const acc = await account("intent-route");
  const rw = await createWorkspace(acc.user.id, "Route");
  await page(acc.user, rw, (await bootstrap(acc.user, rw)).spaces[0].id, "Quarterly plan");
  const { deviceToken } = await phone(acc);
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
