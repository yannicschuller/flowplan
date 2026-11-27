// The second half of a large import (#594): writing reports where it is
// ("page 812 of 2000") instead of sitting at 50 %, each page is cleaned
// once (cleanHtml gives what it is given back unchanged), and files are
// published a few at a time without leaving work running after a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-import-progress-"));
const { one, run, id, transaction } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { importFromSource } = await import("../lib/importers");
const { launchJob, jobOutcome, jobProgress } = await import("../lib/background-jobs");
const { cleanHtml, cleanHtmlState, htmlState } = await import("../lib/document-server");
const { forEachLimited } = await import("../lib/each-async");
const { vaultZip } = await import("./helpers/obsidian-vault");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "progress", "progress@example.test");
const owner = { id: uid, name: "progress", email: "progress@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const json = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const value = JSON.stringify(yDocToProsemirrorJSON(doc, "default"));
  doc.destroy();
  return value;
};

test("a job's step travels with its progress; a new phase is reported at once, nothing from inside a SQLite transaction", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let reported!: () => void;
  const done = new Promise<void>((resolve) => (reported = resolve));
  const job = await launchJob(owner, "import", "vault.zip", async () => {
    await jobProgress(0.6, { phase: "prepare", done: 812, total: 2000 });
    // Within half a second: the same phase waits, a new one does not.
    await jobProgress(0.61, { phase: "prepare", done: 820, total: 2000 });
    await jobProgress(0.8, { phase: "create", done: 0, total: 2046 });
    // In the transaction the one connection is taken: nothing is written.
    await transaction(async () => {
      await jobProgress(0.9, { phase: "write", done: 100, total: 2046 });
    });
    reported();
    await waiting;
    return { pages: 1 };
  });
  await done;
  assert.deepEqual(await jobOutcome(owner, job), { status: "running", progress: 0.8, step: { phase: "create", done: 0, total: 2046 } });
  release();
  for (let i = 0; i < 50 && (await jobOutcome(owner, job))?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await jobOutcome(owner, job), { status: "done", value: { pages: 1 } });
});

// (Saving runs in the transaction: on SQLite the poll is answered once it
// has ended, with the result.)
test("an import in the background says which page it prepares (#594)", async () => {
  const wid = await createWorkspace(owner.id, "Fortschritt");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const bytes = await vaultZip({ notes: 120, images: 10 });
  const job = await launchJob(owner, "import", "vault.zip", () => importFromSource(owner, wid, space, { name: "vault.zip", bytes }, { source: "obsidian" }));
  const seen: { progress: number | null; step?: { phase: string; done: number; total: number } }[] = [];
  for (;;) {
    const outcome = await jobOutcome(owner, job);
    if (outcome?.status !== "running") {
      assert.equal(outcome?.status, "done");
      assert.equal((outcome as { value: { pages: number } }).value.pages, 120);
      break;
    }
    const now = { progress: outcome.progress, step: outcome.step };
    if (outcome.step && JSON.stringify(seen.at(-1)) !== JSON.stringify(now)) seen.push(now);
    await turn();
  }
  const prepare = seen.filter((s) => s.step?.phase === "prepare");
  assert.ok(prepare.length, JSON.stringify(seen));
  // Every note and folder page: 120 notes and their folders.
  const total = prepare[0].step!.total;
  assert.ok(total > 120 && prepare.every((s) => s.step!.done > 0 && s.step!.done <= total && s.progress! > 0.5 && s.progress! < 0.8), JSON.stringify(prepare));
  // Reported in order.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].progress! >= seen[i - 1].progress!, JSON.stringify(seen));
});

test("cleaned HTML cleans to itself: a page is cleaned once and its state made from it", () => {
  const samples = [
    "<p>a &amp; b &lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &#39;s&#39; &nbsp;x</p>",
    '<p>stray</p></p><a href="javascript:alert(1)">x</a><a href="https://example.com/?a=1&b=2">y</a>',
    '<iframe src="https://evil.example/x"></iframe><iframe src="https://www.youtube.com/embed/abc"></iframe><iframe></iframe>',
    '<aside data-callout="note" data-callout-icon="💡" data-callout-color="nope"><p>x</p></aside>',
    '<details data-block-id="t1"><summary>Titel</summary><div><p>Inhalt</p></div></details><details><summary>zweiter</summary><div><p>auch</p></div></details>',
    '<div style="page-break-after: always"></div><p style="color: red; text-align: center; width: 50%">x</p>',
    '<img src="/api/files/x" alt="a" data-occlusion="garbage"><img src="/api/files/y" data-block-id="b1">',
    "<table><tr><td>a</td><th>b</th></tr></table><ul><li><p>a<ul><li>b</li></ul></p></li></ul>",
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>erledigt</p></li></ul><p><strong>offen <em>und',
    '<div data-pdf="/api/files/p" data-title="&quot;Bericht&quot; &amp; mehr"><a href="/api/files/p">Bericht</a></div><audio src="/api/files/a" controls></audio>',
    '<pre><code class="language-js">if (a &lt; b &amp;&amp; c) {}\n</code></pre><h2 data-block-id="h1">Ü <code>x</code></h2>',
  ];
  const source = '<p><a href="https://example.com/q">https://example.com/q</a></p>';
  for (const html of samples) {
    const clean = cleanHtml(html);
    assert.equal(cleanHtml(clean), clean, html);
    assert.equal(cleanHtml(source + html), cleanHtml(source + clean), html);
    assert.equal(json(cleanHtmlState(clean)), json(htmlState(clean)), html);
  }
  assert.equal(json(cleanHtmlState("")), json(htmlState("")));
});

test("files are published a few at a time; after a failure nothing new starts and the running ones finish first", async () => {
  let running = 0,
    most = 0;
  const started: number[] = [];
  await forEachLimited(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
    started.push(i);
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
  });
  assert.equal(most, 4);
  assert.equal(started.length, 20);
  const finished: number[] = [];
  await assert.rejects(
    forEachLimited(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      await new Promise((resolve) => setTimeout(resolve, i === 1 ? 1 : 5));
      if (i === 1) throw new Error("bucket down");
      finished.push(i);
    }),
    /bucket down/,
  );
  // 0 and 2 were running when 1 failed; they finished before the error came back.
  assert.deepEqual(finished.sort(), [0, 2]);
});
