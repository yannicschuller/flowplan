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
function user(name: string): Identity {
  const uid = id();
  run(
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
const owner = user("owner"),
  wid = createWorkspace(owner.id, "Live"),
  boot = bootstrap(owner, wid);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fails = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: any) => e.status === status);

function setup(html: string) {
  const pid = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Live",
    }) as { id: string }
  ).id;
  run(
    "UPDATE documents SET state=?,html=? WHERE page_id=?",
    htmlState(html),
    html,
    pid,
  );
  const token = (
    command(owner, {
      action: "share.create",
      pageId: pid,
      role: "editor",
      name: "Gäste",
    }) as { token: string }
  ).token;
  return { pid, token };
}
// A guest client: its own Yjs document, synchronised like the browser does.
function guest(token: string, pid: string) {
  const doc = new Y.Doc();
  let pgen = "";
  const sync = (send = true) => {
    const result = mutateSharedContent(token, {
      action: "live",
      pageId: pid,
      pgen: pgen || undefined,
      vector: b64(Y.encodeStateVector(doc)),
      ...(send && pgen ? { update: b64(Y.encodeStateAsUpdate(doc)) } : {}),
    }) as { pgen: string; update: string; reset: boolean };
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
const memberHtml = (pid: string) =>
  String(one("SELECT html FROM documents WHERE page_id=?", pid)?.html);
// A member edit through the normal Yjs sync command.
function memberEdit(pid: string, html: string) {
  const d = one<{ state: Uint8Array; generation: string }>(
    "SELECT state,generation FROM documents WHERE page_id=?",
    pid,
  )!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, d.state);
  applyHtml(doc, html);
  command(owner, {
    action: "document.sync",
    pageId: pid,
    generation: d.generation,
    update: b64(Y.encodeStateAsUpdate(doc)),
  });
}

test("guests and members edit the same document live without reloads", () => {
  const { pid, token } = setup("<p>Anfang</p><p>Ende</p>");
  const generation = one(
    "SELECT generation FROM documents WHERE page_id=?",
    pid,
  )?.generation;
  const a = guest(token, pid),
    b = guest(token, pid);
  a.sync();
  b.sync();
  assert.equal(a.html(), "<p>Anfang</p><p>Ende</p>");
  // Guest A types; the member document changes without a new generation.
  applyHtml(a.doc, "<p>Anfang vom Gast</p><p>Ende</p>");
  a.sync();
  assert.equal(memberHtml(pid), "<p>Anfang vom Gast</p><p>Ende</p>");
  assert.equal(
    one("SELECT generation FROM documents WHERE page_id=?", pid)?.generation,
    generation,
  );
  // A member and guest B edit at the same time; everything merges.
  memberEdit(pid, "<p>Anfang vom Gast</p><p>Ende</p><p>Mitglied</p>");
  applyHtml(b.doc, "<p>Anfang</p><p>Ende von B</p>");
  b.sync();
  a.sync(false);
  const merged = memberHtml(pid);
  assert.match(merged, /Anfang vom Gast/);
  assert.match(merged, /Ende von B/);
  assert.match(merged, /Mitglied/);
  assert.equal(a.html(), merged);
  assert.equal(b.html(), merged);
});

test("live guest edits keep hidden links and mentions and refuse unshared references", () => {
  const secret = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Geheim",
    }) as { id: string }
  ).id;
  const { pid, token } = setup(
    `<p><a href="#page=${secret}">Intern</a> und <span data-type="mention" data-mention="${owner.id}" data-label="owner">@owner</span></p>`,
  );
  const g = guest(token, pid);
  g.sync();
  // The guest sees neither the page id nor where the link goes.
  assert.doesNotMatch(g.html(), new RegExp(secret));
  assert.match(g.html(), /\/share\/[^"]+\/hidden\//);
  applyHtml(g.doc, g.html().replace("</p>", "</p><p>Neu</p>"));
  g.sync();
  const html = memberHtml(pid);
  assert.match(html, new RegExp(`#page=${secret}`));
  assert.match(html, new RegExp(`data-mention="${owner.id}"`));
  assert.match(html, /Neu/);
  // Links to pages outside the share are refused and change nothing.
  applyHtml(
    g.doc,
    g.html() + `<p><a href="/share/${token}/${secret}">x</a></p>`,
  );
  fails(() => g.sync(), 403);
  assert.equal(memberHtml(pid), html);
});

test("readers cannot edit live and a restored version resets guest projections", () => {
  const { pid, token } = setup("<p>Text</p>");
  const reader = (
    command(owner, {
      action: "share.create",
      pageId: pid,
      role: "viewer",
      name: "Lesen",
    }) as { token: string }
  ).token;
  fails(
    () => mutateSharedContent(reader, { action: "live", pageId: pid }),
    403,
  );
  const g = guest(token, pid);
  g.sync();
  // A new document generation (e.g. a restored version) gives a new projection.
  run("UPDATE documents SET generation=? WHERE page_id=?", id(), pid);
  const result = g.sync(false);
  assert.equal(result.reset, true);
  assert.equal(g.html(), "<p>Text</p>");
  // Saving the title alone keeps the live content.
  mutateSharedContent(token, {
    action: "save",
    pageId: pid,
    version: sharedContent(token, pid).version,
    title: "Neuer Titel",
  });
  assert.equal(
    one("SELECT title FROM pages WHERE id=?", pid)?.title,
    "Neuer Titel",
  );
  assert.equal(memberHtml(pid), "<p>Text</p>");
});
