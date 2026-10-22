import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-e2ee-"));
const { id, run, one, all, db } = await import("../lib/db");
const { command, pageData, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportMarkdown } = await import("../lib/markdown-export");
const { collectExportContent } = await import("../lib/export-content");
const { aiMayRead } = await import("../lib/ai/access");
const { lockedPageIds } = await import("../lib/journal-extras");
const { processSearchIndex, searchWorkspace } = await import("../lib/search-index");
const { metadataOnly, documentLog, spaceKeys, encryptedArchive, ENCRYPTED_TITLE } = await import("../lib/e2ee-server");
const e2ee = await import("../lib/e2ee");

const MARKER = "Geheimnis-Marker-7f3a9c";

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = (who: Identity, input: Record<string, unknown>) => command(who, input) as Record<string, unknown>;
const refuses = (fn: () => unknown, pattern: RegExp = /verschlüsselte Seiten nicht verfügbar|plaintext refused/) =>
  assert.throws(fn, (e: Error) => pattern.test(e.message));

// Person with a key pair: the passphrase never reaches the server.
async function setUp(who: Identity, passphrase: string) {
  const created = await e2ee.createIdentity(passphrase);
  act(who, { action: "e2ee.identity.setup", ...created.identity });
  return created;
}
async function openSpace(who: Identity, privateKey: CryptoKey, spaceId: string) {
  const info = spaceKeys(who, spaceId);
  const keys = new Map<number, Awaited<ReturnType<typeof e2ee.spaceKeyFromRaw>>>();
  for (const k of info.myKeys)
    keys.set(k.version, await e2ee.spaceKeyFromRaw(k.version, await e2ee.openKey(k.sealed, privateKey, e2ee.spaceKeyContext(spaceId, k.version, who.id))));
  return { info, keys };
}
function textOf(doc: Y.Doc) {
  return doc.getText("t").toString();
}
async function readDocument(who: Identity, keys: Map<number, Awaited<ReturnType<typeof e2ee.spaceKeyFromRaw>>>, pageId: string) {
  const log = documentLog(who, pageId, 0);
  const doc = new Y.Doc();
  if (log.snapshot)
    Y.applyUpdate(doc, await e2ee.decryptContent(keys.get(log.snapshot.version)!, e2ee.fromBase64(log.snapshot.data), e2ee.contentContext("snapshot", pageId, log.snapshot.version)));
  for (const u of log.updates)
    Y.applyUpdate(doc, await e2ee.decryptContent(keys.get(u.version)!, e2ee.fromBase64(u.data), e2ee.contentContext("update", pageId, u.version)));
  return doc;
}

test("encodings and the recovery key", () => {
  const bytes = e2ee.randomBytes(32);
  assert.deepEqual(e2ee.fromBase32(e2ee.toBase32(bytes)), bytes);
  assert.deepEqual(e2ee.fromBase64(e2ee.toBase64(bytes)), bytes);
  const key = e2ee.formatRecoveryKey(bytes);
  assert.match(key, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  // Case, spaces and look-alike digits do not matter.
  assert.deepEqual(e2ee.parseRecoveryKey(key.toLowerCase().replaceAll("-", " ")), bytes);
  assert.deepEqual(e2ee.parseRecoveryKey(key.replaceAll("O", "0")), bytes);
  assert.equal(e2ee.parseRecoveryKey("ABCD-EFGH"), null);
});

test("the private key opens with the passphrase or the recovery key only", async () => {
  assert.equal(await e2ee.x25519Supported(), true);
  const { identity, recoveryKey } = await e2ee.createIdentity("korrekt pferd batterie heftklammer");
  assert.equal(identity.wrappedPrivate.iterations, 600_000);
  assert.equal(e2ee.fromBase64(identity.publicKey).length, 32);
  const pkcs8 = await e2ee.unwrapWithPassphrase(identity.wrappedPrivate, "korrekt pferd batterie heftklammer");
  await assert.rejects(e2ee.unwrapWithPassphrase(identity.wrappedPrivate, "falsch"), e2ee.DecryptError);
  const recovered = await e2ee.unwrapWithRecovery(identity.recoveryWrapped, e2ee.parseRecoveryKey(recoveryKey)!);
  assert.deepEqual(recovered, pkcs8);
  await assert.rejects(e2ee.unwrapWithRecovery(identity.recoveryWrapped, e2ee.randomBytes(32)), e2ee.DecryptError);
  // A new passphrase wraps the same key pair.
  const rewrapped = await e2ee.wrapWithPassphrase(recovered, "ein ganz neuer satz", 600_000);
  assert.deepEqual(await e2ee.unwrapWithPassphrase(rewrapped, "ein ganz neuer satz"), pkcs8);
  // Too few iterations are not accepted when reading either.
  await assert.rejects(e2ee.unwrapWithPassphrase({ ...rewrapped, iterations: 1000 }, "ein ganz neuer satz"), e2ee.DecryptError);
});

test("space keys are sealed for one member and one context", async () => {
  const alice = await e2ee.createIdentity("alice passphrase 1", 600_000);
  const bob = await e2ee.createIdentity("bob passphrase 22", 600_000);
  const key = await e2ee.newSpaceKey(1);
  const context = e2ee.spaceKeyContext("space", 1, "bob");
  const sealed = await e2ee.sealKey(key.raw, bob.identity.publicKey, context);
  assert.deepEqual(await e2ee.openKey(sealed, bob.privateKey, context), key.raw);
  await assert.rejects(e2ee.openKey(sealed, alice.privateKey, context), e2ee.DecryptError);
  await assert.rejects(e2ee.openKey(sealed, bob.privateKey, e2ee.spaceKeyContext("space", 2, "bob")), e2ee.DecryptError);
  // Content is bound to its page and purpose.
  const data = await e2ee.encryptContent(key, new TextEncoder().encode(MARKER), e2ee.contentContext("update", "p1", 1));
  assert.equal(Buffer.from(data).includes(MARKER), false);
  assert.equal(new TextDecoder().decode(await e2ee.decryptContent(key, data, e2ee.contentContext("update", "p1", 1))), MARKER);
  await assert.rejects(e2ee.decryptContent(key, data, e2ee.contentContext("update", "p2", 1)), e2ee.DecryptError);
  await assert.rejects(e2ee.decryptContent(key, data, e2ee.contentContext("snapshot", "p1", 1)), e2ee.DecryptError);
  // Titles and files.
  const title = await e2ee.encryptTitle(key, "p1", "Tagebuch");
  assert.equal(await e2ee.decryptTitle((v) => (v === 1 ? key : undefined), "p1", title), "Tagebuch");
  await assert.rejects(e2ee.decryptTitle((v) => (v === 1 ? key : undefined), "p2", title));
  const file = await e2ee.encryptFile(key, "p1", { name: "geheim.txt", mime: "text/plain", bytes: new TextEncoder().encode(MARKER) });
  assert.ok(e2ee.isEncryptedFile(file));
  assert.equal(Buffer.from(file).includes(MARKER), false);
  assert.equal(Buffer.from(file).includes("geheim.txt"), false);
  const opened = await e2ee.decryptFile((v) => (v === 1 ? key : undefined), "p1", file);
  assert.deepEqual(opened.name, "geheim.txt");
  assert.equal(new TextDecoder().decode(opened.bytes), MARKER);
  await assert.rejects(e2ee.decryptFile((v) => (v === 1 ? key : undefined), "p9", file));
});

test("an encrypted space: ciphertext only, members, rotation and refused plaintext paths", async () => {
  const alice = user("alice"),
    bob = user("bob"),
    carol = user("carol");
  const wid = createWorkspace(alice.id, "E2EE");
  run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", wid, carol.id, "editor");
  const plainSpace = bootstrap(alice, wid).spaces[0].id;
  const a = await setUp(alice, "alice passphrase 1");
  const b = await setUp(bob, "bob passphrase 22");
  // Setting up twice is refused; the identity holds only opaque blobs.
  assert.throws(() => act(alice, { action: "e2ee.identity.setup", ...a.identity }), /bereits eingerichtet/);
  // A wrap with too few iterations is not accepted.
  const weak = await e2ee.createIdentity("carol weak", 1000);
  assert.throws(() => act(carol, { action: "e2ee.identity.setup", ...weak.identity }));

  // The creator seals the first space key for herself; the browser picks
  // the space id, since the sealed key names its space.
  const spaceId = id();
  const v1 = await e2ee.newSpaceKey(1);
  const created = act(alice, {
    action: "space.create",
    workspaceId: wid,
    id: spaceId,
    name: "Tagebuch",
    private: true,
    encrypted: { key: await e2ee.sealKey(v1.raw, a.identity.publicKey, e2ee.spaceKeyContext(spaceId, 1, alice.id)), encryptTitles: true },
  });
  const sid = String(created.id);
  assert.equal(sid, spaceId);
  assert.equal(one<{ visibility: string }>("SELECT visibility FROM spaces WHERE id=?", sid)!.visibility, "private");
  let opened = await openSpace(alice, a.privateKey, sid);
  assert.deepEqual(opened.keys.get(1)!.raw, v1.raw);

  // Titles: the plain title never reaches the server.
  assert.throws(() => act(alice, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Mein Tagebuch" }), /Titel verschlüsselt/);
  const pageId = String(act(alice, { action: "page.create", workspaceId: wid, spaceId: sid, title: ENCRYPTED_TITLE }).id);
  const titleCipher = await e2ee.encryptTitle(v1, pageId, `Titel ${MARKER}`);
  act(alice, { action: "e2ee.title", pageId, cipher: titleCipher });
  assert.throws(() => act(alice, { action: "page.update", pageId, patch: { title: "Klartext" } }), /Titel verschlüsselt/);
  // Documents only.
  assert.throws(() => act(alice, { action: "page.create", workspaceId: wid, spaceId: sid, title: ENCRYPTED_TITLE, kind: "database" }), /nur Dokumente/);

  // Alice writes: the update is encrypted before it leaves the browser.
  const docA = new Y.Doc();
  const updates: Uint8Array[] = [];
  docA.on("update", (u: Uint8Array) => updates.push(u));
  docA.getText("t").insert(0, `Liebes Tagebuch, ${MARKER}`);
  const append = async (who: Identity, key: Awaited<ReturnType<typeof e2ee.spaceKeyFromRaw>>, update: Uint8Array) =>
    act(who, {
      action: "e2ee.append",
      pageId,
      version: key.version,
      data: e2ee.toBase64(await e2ee.encryptContent(key, update, e2ee.contentContext("update", pageId, key.version))),
    });
  const first = await append(alice, v1, updates.shift()!);
  assert.equal(typeof first.seq, "number");
  // Garbage that is not our ciphertext format is refused.
  assert.throws(() => act(alice, { action: "e2ee.append", pageId, version: 1, data: Buffer.from(MARKER).toString("base64") }));

  // Page data: no HTML, no state, its own generation.
  const data = pageData(alice, pageId) as Record<string, unknown>;
  assert.equal(data.html, "");
  assert.equal(data.state, null);
  assert.equal(data.generation, "e2ee");
  assert.equal((data.page as { title: string }).title, ENCRYPTED_TITLE);

  // Plaintext paths are refused.
  refuses(() => act(alice, { action: "document.sync", pageId, generation: "1", update: Buffer.from(Y.encodeStateAsUpdate(docA)).toString("base64") }));
  refuses(() => act(alice, { action: "document.markdown", pageId, html: `<p>${MARKER}</p>` }));
  refuses(() => act(alice, { action: "document.markdown.apply", pageId, markdown: MARKER }));
  refuses(() => act(alice, { action: "page.snapshot", pageId }));
  refuses(() => act(alice, { action: "page.duplicate", pageId }));
  refuses(() => act(alice, { action: "share.create", pageId, role: "viewer", name: "x" }));
  refuses(() => act(alice, { action: "page.publish", pageId, enabled: true }));
  refuses(() => act(alice, { action: "comment.create", pageId, body: MARKER }));
  refuses(() => act(alice, { action: "thread.create", pageId, body: MARKER, anchor: {} }));
  refuses(() => act(alice, { action: "page.aliases", pageId, aliases: [MARKER] }));
  refuses(() => act(alice, { action: "template.save", pageId, name: MARKER }));
  refuses(() => act(alice, { action: "page.import", workspaceId: wid, spaceId: sid, title: "Import", content: MARKER, format: "markdown" }));
  refuses(() => act(alice, { action: "grant.set", resourceId: sid, userId: carol.id, role: "editor" }));
  refuses(() => act(alice, { action: "space.duplicate", spaceId: sid }));
  assert.throws(() => act(alice, { action: "space.update", spaceId: sid, name: "Offen", private: false }), /bleibt privat/);
  // In or out of the space: refused both ways.
  const plainPage = String(act(alice, { action: "page.create", workspaceId: wid, spaceId: plainSpace, title: "Offen" }).id);
  assert.throws(() => act(alice, { action: "page.move", pageId, spaceId: plainSpace, parentId: null }), /hinein oder aus ihm heraus/);
  assert.throws(() => act(alice, { action: "page.move", pageId: plainPage, spaceId: sid, parentId: null }), /hinein oder aus ihm heraus/);
  // Exports, AI, search and webhooks.
  await assert.rejects(exportMarkdown(alice, { pageId, format: "markdown", includeSubpages: false }), /nicht verfügbar/);
  await assert.rejects(exportMarkdown(alice, { spaceId: sid, format: "zip", includeSubpages: false }), /nicht verfügbar/);
  assert.throws(() => collectExportContent(alice, { pageId, maxPages: 10, format: "PDF" }), /nicht verfügbar/);
  assert.equal(aiMayRead(alice, pageId), false);
  assert.ok(lockedPageIds(alice, wid).has(pageId));
  while (processSearchIndex()) {}
  assert.equal(searchWorkspace(alice, wid, "Tagebuch").some((r) => r.id === pageId), false);
  assert.equal(one("SELECT 1 FROM search_index WHERE page_id=?", pageId), undefined);
  assert.deepEqual(metadataOnly({ pageId, text: MARKER }), { pageId, encrypted: true });
  // The database refuses plaintext even from a code path that forgot to ask.
  assert.throws(() => run("UPDATE documents SET html=? WHERE page_id=?", `<p>${MARKER}</p>`, pageId), /plaintext refused/);
  assert.throws(() => run("INSERT INTO comments(id,page_id,author_id,body) VALUES(?,?,?,?)", id(), pageId, alice.id, MARKER), /plaintext refused/);
  assert.throws(() => run("UPDATE pages SET public_token=? WHERE id=?", id(), pageId), /plaintext refused/);

  // Bob is not a member yet: no access, no key.
  assert.throws(() => spaceKeys(bob, sid), /Kein Zugriff/);
  // Carol has no key pair: she cannot be added.
  assert.deepEqual(spaceKeys(alice, sid).withoutKeys.map((u) => u.userId).includes(carol.id), true);
  const sealFor = async (key: typeof v1, who: Identity, publicKey: string) => e2ee.sealKey(key.raw, publicKey, e2ee.spaceKeyContext(sid, key.version, who.id));
  assert.throws(
    () => act(alice, { action: "e2ee.member.add", spaceId: sid, userId: carol.id, keys: [] }),
  );
  act(alice, { action: "e2ee.member.add", spaceId: sid, userId: bob.id, keys: [{ version: 1, sealed: await sealFor(v1, bob, b.identity.publicKey) }] });
  const bobView = await openSpace(bob, b.privateKey, sid);
  assert.deepEqual(bobView.keys.get(1)!.raw, v1.raw);
  // Bob reads and writes; edits sync through the log.
  const docB = await readDocument(bob, bobView.keys, pageId);
  assert.equal(textOf(docB), `Liebes Tagebuch, ${MARKER}`);
  assert.equal(await e2ee.decryptTitle((v) => bobView.keys.get(v), pageId, one<{ title_cipher: string }>("SELECT title_cipher FROM pages WHERE id=?", pageId)!.title_cipher), `Titel ${MARKER}`);
  const bobUpdates: Uint8Array[] = [];
  docB.on("update", (u: Uint8Array) => bobUpdates.push(u));
  docB.getText("t").insert(docB.getText("t").length, " – Bob war hier");
  await append(bob, bobView.keys.get(1)!, bobUpdates.shift()!);
  assert.equal(textOf(await readDocument(alice, opened.keys, pageId)), `Liebes Tagebuch, ${MARKER} – Bob war hier`);

  // Compaction: the encrypted full state replaces the updates it covers.
  const full = await readDocument(alice, opened.keys, pageId);
  const last = documentLog(alice, pageId, 0).updates.at(-1)!.seq;
  act(alice, {
    action: "e2ee.compact",
    pageId,
    upto: last,
    version: 1,
    data: e2ee.toBase64(await e2ee.encryptContent(v1, Y.encodeStateAsUpdate(full), e2ee.contentContext("snapshot", pageId, 1))),
  });
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM e2ee_updates WHERE page_id=?", pageId)!.n, 0);
  assert.equal(documentLog(alice, pageId, 0).snapshot?.upto, last);
  assert.equal(documentLog(alice, pageId, last).snapshot, null);
  assert.equal(textOf(await readDocument(bob, bobView.keys, pageId)), `Liebes Tagebuch, ${MARKER} – Bob war hier`);
  // An older snapshot cannot replace a newer one.
  assert.throws(() => act(alice, { action: "e2ee.compact", pageId, upto: last, version: 1, data: e2ee.toBase64(e2ee.randomBytes(40).fill(1, 0, 1)) }), /neuere/);

  // Removing Bob: his keys go, writing waits for a new key.
  const removed = act(alice, { action: "e2ee.member.remove", spaceId: sid, userId: bob.id });
  assert.equal(removed.rotate, true);
  assert.throws(() => spaceKeys(bob, sid), /Kein Zugriff/);
  assert.equal(all("SELECT 1 FROM e2ee_space_keys WHERE space_id=? AND user_id=?", sid, bob.id).length, 0);
  docA.getText("t").insert(0, "Neu: ");
  await assert.rejects(append(alice, v1, Y.encodeStateAsUpdate(docA)), /erneuert/);
  const v2 = await e2ee.newSpaceKey(2);
  // The new key must go to exactly the remaining holders – not to Bob.
  assert.throws(
    () =>
      act(alice, { action: "e2ee.rotate", spaceId: sid, version: 2, keys: [{ userId: alice.id, sealed: {} }, { userId: bob.id, sealed: {} }] }),
  );
  act(alice, { action: "e2ee.rotate", spaceId: sid, version: 2, keys: [{ userId: alice.id, sealed: await sealFor(v2, alice, a.identity.publicKey) }] });
  opened = await openSpace(alice, a.privateKey, sid);
  assert.equal(opened.info.keyVersion, 2);
  assert.deepEqual([...opened.keys.keys()], [1, 2]);
  // Old key version is refused for new content; the new one works.
  await assert.rejects(append(alice, v1, Y.encodeStateAsUpdate(docA)), /erneuert/);
  await append(alice, opened.keys.get(2)!, Y.encodeStateAsUpdate(docA));
  // Bob's old copy of key 1 does not open what was written with key 2.
  const newest = documentLog(alice, pageId, last).updates.at(-1)!;
  assert.equal(newest.version, 2);
  await assert.rejects(e2ee.decryptContent(bobView.keys.get(1)!, e2ee.fromBase64(newest.data), e2ee.contentContext("update", pageId, 2)));
  assert.equal(textOf(await readDocument(alice, opened.keys, pageId)).startsWith("Neu: Liebes Tagebuch"), true);
  // Adding someone back needs every key version the adder holds.
  assert.throws(
    () => act(alice, { action: "e2ee.member.add", spaceId: sid, userId: bob.id, keys: [{ version: 2, sealed: {} }] }),
  );

  // Leaving the workspace also takes the keys and asks for a new one.
  act(alice, { action: "e2ee.member.add", spaceId: sid, userId: bob.id, keys: [
    { version: 1, sealed: await sealFor(v1, bob, b.identity.publicKey) },
    { version: 2, sealed: await sealFor(opened.keys.get(2)!, bob, b.identity.publicKey) },
  ] });
  run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, bob.id);
  assert.equal(one<{ rotate_pending: number }>("SELECT rotate_pending FROM spaces WHERE id=?", sid)!.rotate_pending, 1);
  assert.equal(all("SELECT 1 FROM e2ee_space_keys WHERE space_id=? AND user_id=?", sid, bob.id).length, 0);

  // The encrypted archive: ciphertext, sealed keys, my wrapped key pair.
  const archive = encryptedArchive(alice, sid);
  assert.equal(archive.format, "flowplan-e2ee-1");
  assert.equal(archive.pages.length, 1);
  assert.equal(JSON.stringify(archive).includes(MARKER), false);
  assert.ok(archive.identity?.wrappedPrivate);

  // Nothing readable anywhere in the database file.
  db().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const name of readdirSync(process.env.FLOWPLAN_DATA_DIR!)) {
    if (!name.startsWith("flowplan.sqlite")) continue;
    const bytes = readFileSync(join(process.env.FLOWPLAN_DATA_DIR!, name));
    assert.equal(bytes.includes(MARKER), false, `${name} contains plaintext`);
    assert.equal(bytes.includes("alice passphrase 1"), false, `${name} contains the passphrase`);
  }
  const stored = one<{ html: string; state: Uint8Array | null }>("SELECT html,state FROM documents WHERE page_id=?", pageId)!;
  assert.equal(stored.html, "");
  assert.equal(stored.state, null);
});

test("a reset key pair loses the space keys", async () => {
  const dave = user("dave");
  const wid = createWorkspace(dave.id, "Reset");
  const d = await setUp(dave, "dave passphrase 333");
  const sid = String(
    act(dave, {
      action: "space.create",
      workspaceId: wid,
      name: "Notizen",
      private: true,
      encrypted: { key: await e2ee.sealKey((await e2ee.newSpaceKey(1)).raw, d.identity.publicKey, "x") },
    }).id,
  );
  // A new passphrase replaces the wrap; the version guards against races.
  const pkcs8 = await e2ee.unwrapWithPassphrase(d.identity.wrappedPrivate, "dave passphrase 333");
  act(dave, { action: "e2ee.identity.update", version: 1, wrappedPrivate: await e2ee.wrapWithPassphrase(pkcs8, "dave new passphrase") });
  assert.throws(() => act(dave, { action: "e2ee.identity.update", version: 1, wrappedPrivate: d.identity.wrappedPrivate }), /inzwischen geändert/);
  act(dave, { action: "e2ee.identity.reset" });
  assert.equal(spaceKeys(dave, sid).myKeys.length, 0);
});

test("the decrypted Markdown export runs in the browser on the editor's JSON", async () => {
  const { documentMarkdown } = await import("../lib/e2ee-markdown");
  const markdown = documentMarkdown(
    {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heute" }] },
        { type: "paragraph", content: [{ type: "text", text: "fett", marks: [{ type: "bold" }] }, { type: "text", text: " und *roh*" }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "erledigt" }] }] }] },
        { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "a = `b`" }] },
        { type: "encryptedFile", attrs: { name: "foto.png", mime: "image/png" } },
      ],
    },
    "Tagebuch",
  );
  assert.equal(markdown, "# Tagebuch\n\n## Heute\n\n**fett** und \\*roh\\*\n\n- [x] erledigt\n\n```js\na = `b`\n```\n\n![foto.png](foto.png)\n");
});
