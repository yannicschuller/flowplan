import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-shared-live-"),
);
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { mutateSharedContent, sharedContent } =
  await import("../lib/shared-content");
const { applyHtml } = await import("../lib/shared-live");
const { htmlState, stateHtml } = await import("../lib/document-server");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.com`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.com`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Live"),
  boot = await bootstrap(owner, wid);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fails = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: any) => e.status === status);

async function setup(html: string) {
  const pid = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Live",
    })) as { id: string }
  ).id;
  await run(
    "UPDATE documents SET state=?,html=? WHERE page_id=?",
    htmlState(html),
    html,
    pid,
  );
  const token = (
    (await command(owner, {
      action: "share.create",
      pageId: pid,
      role: "editor",
      name: "Gäste",
    })) as { token: string }
  ).token;
  return { pid, token };
}
// A guest client: its own Yjs document, synchronised like the browser does.
function guest(token: string, pid: string) {
  const doc = new Y.Doc();
  let pgen = "";
  const sync = async (send = true) => {
    const result = (await mutateSharedContent(token, {
      action: "live",
      pageId: pid,
      pgen: pgen || undefined,
      vector: b64(Y.encodeStateVector(doc)),
      ...(send && pgen ? { update: b64(Y.encodeStateAsUpdate(doc)) } : {}),
    })) as { pgen: string; update: string; reset: boolean };
    if (result.reset || !pgen) {
      doc
        .getXmlFragment("default")
        .delete(0, doc.getXmlFragment("default").length);
    }
    pgen = result.pgen;
    Y.applyUpdate(doc, Buffer.from(result.update, "base64"));
    return result;
  };
  return { doc, sync, html: () => stateHtml(doc) };
}
const memberHtml = async (pid: string) =>
  String((await one("SELECT html FROM documents WHERE page_id=?", pid))?.html);
// A member edit through the normal Yjs sync command.
async function memberEdit(pid: string, html: string) {
  const d = (await one<{ state: Uint8Array; generation: string }>(
    "SELECT state,generation FROM documents WHERE page_id=?",
    pid,
  ))!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, d.state);
  applyHtml(doc, html);
  await command(owner, {
    action: "document.sync",
    pageId: pid,
    generation: d.generation,
    update: b64(Y.encodeStateAsUpdate(doc)),
  });
}

test("guests and members edit the same document live without reloads", async () => {
  const { pid, token } = await setup("<p>Anfang</p><p>Ende</p>");
  const generation = (await one(
    "SELECT generation FROM documents WHERE page_id=?",
    pid,
  ))?.generation;
  const a = guest(token, pid),
    b = guest(token, pid);
  await a.sync();
  await b.sync();
  assert.equal(a.html(), "<p>Anfang</p><p>Ende</p>");
  // Guest A types; the member document changes without a new generation.
  applyHtml(a.doc, "<p>Anfang vom Gast</p><p>Ende</p>");
  await a.sync();
  assert.equal(await memberHtml(pid), "<p>Anfang vom Gast</p><p>Ende</p>");
  assert.equal(
    (await one("SELECT generation FROM documents WHERE page_id=?", pid))?.generation,
    generation,
  );
  // A member and guest B edit at the same time; everything merges.
  await memberEdit(pid, "<p>Anfang vom Gast</p><p>Ende</p><p>Mitglied</p>");
  applyHtml(b.doc, "<p>Anfang</p><p>Ende von B</p>");
  await b.sync();
  await a.sync(false);
  const merged = await memberHtml(pid);
  assert.match(merged, /Anfang vom Gast/);
  assert.match(merged, /Ende von B/);
  assert.match(merged, /Mitglied/);
  assert.equal(a.html(), merged);
  assert.equal(b.html(), merged);
});

test("live guest edits keep hidden links and mentions and refuse unshared references", async () => {
  const secret = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Geheim",
    })) as { id: string }
  ).id;
  const { pid, token } = await setup(
    `<p><a href="#page=${secret}">Intern</a> und <span data-type="mention" data-mention="${owner.id}" data-label="owner">@owner</span></p>`,
  );
  const g = guest(token, pid);
  await g.sync();
  // The guest sees neither the page id nor where the link goes.
  assert.doesNotMatch(g.html(), new RegExp(secret));
  assert.match(g.html(), /\/share\/[^"]+\/hidden\//);
  applyHtml(g.doc, g.html().replace("</p>", "</p><p>Neu</p>"));
  await g.sync();
  const html = await memberHtml(pid);
  assert.match(html, new RegExp(`#page=${secret}`));
  assert.match(html, new RegExp(`data-mention="${owner.id}"`));
  assert.match(html, /Neu/);
  // Links to pages outside the share are refused and change nothing.
  applyHtml(
    g.doc,
    g.html() + `<p><a href="/share/${token}/${secret}">x</a></p>`,
  );
  fails(async () => await g.sync(), 403);
  assert.equal(await memberHtml(pid), html);
});

test("a link may not grow a document without bound: size cap, daily byte budget, fat projections start afresh", async () => {
  const { MAX_GUEST_DOCUMENT } = await import("../lib/shared-content");
  const { pid, token } = await setup("<p>Start</p>");
  const g = guest(token, pid);
  await g.sync();
  const type = (text: string) => {
    const frag = g.doc.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText(text)]);
    frag.insert(frag.length, [para]);
  };
  // A paste that would push the canonical HTML past the cap is refused …
  type("x".repeat(MAX_GUEST_DOCUMENT + 10));
  fails(async () => await g.sync(), 413);
  // … while members' larger documents stay editable (the check is on growth).
  const reset = guest(token, pid);
  await reset.sync();
  assert.equal(reset.html(), "<p>Start</p>");
  // The bytes of every accepted change count against the link's daily budget.
  const { anonymousBytesToday } = await import("../lib/anonymous-budget");
  const before = await anonymousBytesToday(`live:${token}`);
  const g2 = guest(token, pid);
  await g2.sync();
  const frag = g2.doc.getXmlFragment("default");
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("Mehr")]);
  frag.insert(frag.length, [para]);
  await g2.sync();
  assert.ok((await anonymousBytesToday(`live:${token}`)) > before);
  await run("INSERT INTO anonymous_uploads(scope,bytes,at) VALUES(?,?,?)", `live:${token}`, 100 * 1024 * 1024, Date.now());
  const p2 = new Y.XmlElement("paragraph");
  p2.insert(0, [new Y.XmlText("Noch mehr")]);
  frag.insert(frag.length, [p2]);
  fails(async () => await g2.sync(), 413);
  await run("DELETE FROM anonymous_uploads WHERE scope=?", `live:${token}`);
  // A stored projection past 8 MB is rebuilt: guests get a reset.
  const key = (await import("../lib/shared-live")).liveKey(token, pid);
  await run("UPDATE share_live SET state=? WHERE key=?", Buffer.alloc(8_000_001), key);
  const g3 = guest(token, pid);
  await g3.sync();
  assert.match(g3.html(), /Mehr/);
  assert.ok(((await one<{ n: number }>("SELECT length(state) n FROM share_live WHERE key=?", key))?.n || 0) < 1_000_000);
});

test("readers cannot edit live and a restored version resets guest projections", async () => {
  const { pid, token } = await setup("<p>Text</p>");
  const reader = (
    (await command(owner, {
      action: "share.create",
      pageId: pid,
      role: "viewer",
      name: "Lesen",
    })) as { token: string }
  ).token;
  fails(
    async () => await mutateSharedContent(reader, { action: "live", pageId: pid }),
    403,
  );
  const g = guest(token, pid);
  await g.sync();
  // A new document generation (e.g. a restored version) gives a new projection.
  await run("UPDATE documents SET generation=? WHERE page_id=?", id(), pid);
  const result = await g.sync(false);
  assert.equal(result.reset, true);
  assert.equal(g.html(), "<p>Text</p>");
  // Saving the title alone keeps the live content.
  await mutateSharedContent(token, {
    action: "save",
    pageId: pid,
    version: (await sharedContent(token, pid)).version,
    title: "Neuer Titel",
  });
  assert.equal(
    (await one("SELECT title FROM pages WHERE id=?", pid))?.title,
    "Neuer Titel",
  );
  assert.equal(await memberHtml(pid), "<p>Text</p>");
});
