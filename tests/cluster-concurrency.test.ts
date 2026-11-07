// Check-then-write under real concurrency (docs/architecture/database.md
// §14): on PostgreSQL transactions run in parallel under READ COMMITTED –
// within one instance as across several – so each of these runs two or more
// clients at the same moment and checks that the result is the one a
// serial order would give. On SQLite they pass as well (one writer at a
// time), which keeps the expectations honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-concurrency-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SMTP_HOST;
const { all, id, one, run, transaction } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { register, AccountExists } = await import("../lib/local-auth");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { enforceQuota, setWorkspaceQuota } = await import("../lib/instance-ops");
const { claimStorageJobs } = await import("../lib/storage");
const { stateHtml } = await import("../lib/document-server");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const owner = await person("Owner");
const editor = await person("Editor");
const wid = await createWorkspace(owner.id, "W");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;

// A client of a document: its own Y.Doc from the stored state; push()
// appends a paragraph and returns the update.
function client(state: Uint8Array | null) {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return (text: string) => {
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(text)]);
      doc.getXmlFragment("default").push([p]);
    });
    return Buffer.from(Y.encodeStateAsUpdate(doc, sv)).toString("base64");
  };
}

test("two saves of one document at the same moment both end up in it (merge under FOR UPDATE)", async () => {
  const page = await createPage(wid, space, owner.id, "Doc");
  const base = (await one<{ state: Uint8Array | null; generation: string }>("SELECT state,generation FROM documents WHERE page_id=?", page))!;
  // Four people edit from the same base and save at once.
  const texts = ["alpha", "bravo", "charlie", "delta"];
  await Promise.all(
    texts.map(async (text, i) => {
      const push = client(base.state);
      await command(i % 2 ? editor : owner, { action: "document.sync", pageId: page, generation: base.generation, update: push(text) });
    }),
  );
  const stored = (await one<{ state: Uint8Array; html: string }>("SELECT state,html FROM documents WHERE page_id=?", page))!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stored.state);
  const html = stateHtml(doc);
  for (const text of texts) {
    assert.ok(html.includes(text), `${text} is in the merged document`);
    assert.ok(stored.html.includes(text), `${text} is in the stored HTML`);
  }
});

test("records created at the same moment get distinct numbers 1…n", async () => {
  const db = await createPage(wid, space, owner.id, "Tasks", "database");
  const n = 12;
  await Promise.all(Array.from({ length: n }, () => command(editor, { action: "row.create", pageId: db })));
  const numbers = (await all<{ number: number }>("SELECT number FROM rows WHERE page_id=? ORDER BY number", db)).map((r) => Number(r.number));
  assert.deepEqual(numbers, Array.from({ length: n }, (_, i) => i + 1));
});

test("two sign-ups with one address at the same moment: one account, the other is told it exists", async () => {
  await saveInstanceSettings({ ...(await instanceSettings()), allowSignup: true });
  const results = await Promise.allSettled(
    [1, 2, 3].map(() => register({ name: "Twin", email: "twin@example.test", password: "a-long-password" }, "en")),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof AccountExists, String(r.reason));
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE lower(email)='twin@example.test'"))!.n), 1);
});

test("sharing a page with the same person twice at once: one membership, one grant", async () => {
  const page = await createPage(wid, space, owner.id, "Shared");
  const guest = await person("Guest");
  const results = await Promise.allSettled(
    ["viewer", "editor", "viewer"].map((role) => command(owner, { action: "page.share", pageId: page, email: "guest@example.test", role })),
  );
  for (const r of results) assert.equal(r.status, "fulfilled", r.status === "rejected" ? String(r.reason) : "");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id=? AND user_id=?", wid, guest.id))!.n), 1);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM grants WHERE resource_id=? AND user_id=?", page, guest.id))!.n), 1);
});

test("two uploads that each fit the quota but not together: one is refused", async () => {
  const w2 = await createWorkspace(owner.id, "Quota");
  const s2 = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", w2))!.id;
  const page = await createPage(w2, s2, owner.id, "Files");
  await setWorkspaceQuota(w2, 1);
  const size = 600 * 1024;
  const upload = () =>
    transaction(async () => {
      await enforceQuota(w2, size);
      // Something slow between the check and the write (as a real upload).
      await one("SELECT COUNT(*) FROM pages");
      await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), page, "a.bin", "application/octet-stream", size, owner.id);
    });
  const results = await Promise.allSettled([upload(), upload(), upload()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /Speicherkontingent/);
});

test("workers claiming the storage queue at once never take the same job", async () => {
  await run("DELETE FROM storage_queue");
  const keys = Array.from({ length: 40 }, (_, i) => `claim-${String(i).padStart(2, "0")}`);
  for (const key of keys) await run("INSERT INTO storage_queue(key,op,attempts,next_at) VALUES(?,'put',0,0)", key);
  const now = Date.now();
  const claims = await Promise.all(Array.from({ length: 5 }, () => claimStorageJobs(now, 10)));
  const taken = claims.flat().map((job) => job.key);
  assert.equal(new Set(taken).size, taken.length, "no job twice");
  assert.equal(taken.length, 40, "all jobs taken");
  // Claimed jobs are leased: nothing is due right now.
  assert.deepEqual(await claimStorageJobs(now, 10), []);
  // After the lease (the worker died) they come back.
  assert.equal((await claimStorageJobs(now + 11 * 60_000, 100)).length, 40);
  await run("DELETE FROM storage_queue");
});

test("comments written to one page at the same moment all land (the offline change log's trigger upserts)", async () => {
  const page = await createPage(wid, space, owner.id, "Discussed");
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => command(i % 2 ? editor : owner, { action: "comment.create", pageId: page, body: `remark ${i}` })),
  );
  for (const r of results) assert.equal(r.status, "fulfilled", r.status === "rejected" ? String(r.reason) : "");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM comments WHERE page_id=?", page))!.n), 8);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM offline_changes WHERE page_id=? AND row_id=''", page))!.n), 1);
});
