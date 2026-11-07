// Large AFFiNE imports (#163): bounded memory, the import as a background
// job the page asks for, a re-import after the pages were deleted, and a
// clear refusal instead of running out of memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-affine-large-test-"));
const { id, run } = await import("../lib/db");
const { htmlState, htmlJson, jsonHtml } = await import("../lib/document-server");
const { launchJob, jobOutcome, runningJob } = await import("../lib/background-jobs");
const { requireAffineMemory, AFFINE_MEMORY_FACTOR } = await import("../lib/importers/affine-read");
const { HttpError } = await import("../lib/auth");
const { englishMessage } = await import("../lib/i18n-errors");
const { largeAffine } = await import("./helpers/affine-large-run");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const MB = 1024 * 1024;

test("HTML to the editor's state keeps nothing per page while one task runs (#163)", () => {
  // A page as imports write it: figures (their parse rule asks the DOM with
  // querySelectorAll), a table and much text.
  const text = "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. </p>".repeat(80);
  const html = `${text}<figure><img src="/api/files/x" alt="Bild"><figcaption>Bild</figcaption></figure><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>`;
  htmlState(html);
  gc();
  const base = process.memoryUsage().heapUsed;
  // Synchronous, as an import's transaction: before #163 every call left a
  // happy-dom window behind (torn down only after the task) and the parsed
  // DOM (held by happy-dom's WeakRef query caches), about 1 MB a page.
  for (let i = 0; i < 300; i++) htmlState(html);
  gc();
  const grown = (process.memoryUsage().heapUsed - base) / MB;
  assert.ok(grown < 30, `heap grew by ${grown.toFixed(1)} MB for 300 pages`);
  // The same document as @tiptap/html/server gives.
  const json = htmlJson(html) as { content: { type: string }[] };
  assert.deepEqual([...new Set(json.content.map((n) => n.type))].sort(), ["image", "paragraph", "table"]);
  assert.match(jsonHtml(json), /<figure[^>]*><img[^>]*src="\/api\/files\/x"/);
});

test("a large workspace file: imported in the background within a small heap, and again after its pages were deleted (#163)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-affine-large-file-"));
  try {
    const file = join(dir, "large.affine");
    largeAffine(file, 300, 60, 20_000);
    // Before #163 this import needed well over 300 MB of heap (every page's
    // DOM stayed until the end of the transaction) and the process died.
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=192", "--import", "tsx", "--import", "./tests/helpers/cleanup.mjs", "tests/helpers/affine-large-run.ts", file],
      { encoding: "utf8", timeout: 300_000 },
    );
    assert.equal(child.status, 0, `the import ran out of memory or failed:\n${child.stderr.slice(-3000)}`);
    const out = JSON.parse(child.stdout.trim().split("\n").pop()!);
    assert.deepEqual(out.preview, { pages: 300, files: 300, whiteboards: 30 });
    // 300 pages, 30 whiteboards and the workspace page above them; 300
    // pictures and the 30 on whiteboards (stored with the board).
    assert.deepEqual(out.first, { pages: 331, files: 330, roots: 1 });
    assert.equal(out.trashed, 0, "everything went into the trash");
    // The same once more: the trash holding the first import changes nothing.
    assert.deepEqual({ ...out.second, files: out.second.files - out.first.files }, out.first);
    assert.equal(out.titles, 330, "300 pages and 30 whiteboards, once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a background job answers with its progress, result or error – only to the person who started it (#163)", async () => {
  const account = async (name: string) => {
    const uid = id();
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
    return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  };
  const owner = await account("job-owner");
  const other = await account("job-other");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const job = await launchJob(owner, "import", "gross.affine", async () => {
    await waiting;
    return { pages: 3 };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await jobOutcome(owner, job), { status: "running", progress: null });
  assert.equal(runningJob(owner, "import"), true, "a second import is refused meanwhile");
  assert.equal(await jobOutcome(other, job), null, "not theirs");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await jobOutcome(owner, job), { status: "done", value: { pages: 3 } });
  assert.equal(runningJob(owner, "import"), false);

  const failing = await launchJob(owner, "import", "kaputt.affine", () => {
    throw new HttpError(400, "Die AFFiNE-Datei kann nicht gelesen werden.");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failed = await jobOutcome(owner, failing);
  assert.equal(failed?.status, "failed");
  assert.equal(((failed as { error: Error }).error as Error).message, "Die AFFiNE-Datei kann nicht gelesen werden.");
  assert.equal(await jobOutcome(owner, id()), null, "unknown (e.g. after a restart)");
});

test("a workspace too large for the free heap is refused with what helps (#163)", () => {
  // 1 GB heap; 600 MB in use, of which 200 MB are garbage.
  let used = 600 * MB,
    collected = 0;
  const heap = () => ({ heap_size_limit: 1024 * MB, used_heap_size: used });
  const collect = () => {
    collected++;
    used = 400 * MB;
  };
  // Fits as it is: nothing is collected.
  assert.doesNotThrow(() => requireAffineMemory(100 * MB, heap, collect));
  assert.equal(collected, 0);
  // Fits once the garbage is gone (624 MB free, up to 90 % of it).
  assert.doesNotThrow(() => requireAffineMemory(180 * MB, heap, collect));
  assert.equal(collected, 1);
  assert.throws(
    () => requireAffineMemory(200 * MB, heap, collect),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 413);
      assert.match(error.message, new RegExp(`etwa ${200 * AFFINE_MEMORY_FACTOR} MB, frei sind 624 MB`));
      assert.match(englishMessage(error.message), /^The server does not have enough memory for this AFFiNE workspace: the import needs about 600 MB, 624 MB are free\./);
      return true;
    },
  );
  // The real heap: a small workspace always fits.
  assert.doesNotThrow(() => requireAffineMemory(MB));
});
