// Semantic search through pgvector (lib/ai/vector-store.ts): on PostgreSQL
// with the extension the database finds the nearest chunks – the same ones
// the JavaScript scan finds – and its table follows ai_embeddings whatever
// writes it; without the extension (or FLOWPLAN_PGVECTOR=off) the scan
// answers. SQLite: not applicable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-pgvector-"));
const { run, one, id, transaction } = await import("../lib/db");
const { onPostgres } = await import("./helpers/backend");
const { toVector, fromVector } = await import("../lib/ai/semantic");
const store = await import("../lib/ai/vector-store");

const withVector = onPostgres && !!(await one("SELECT 1 FROM pg_available_extensions WHERE name='vector'").catch(() => null));
const skip = !onPostgres ? "PostgreSQL only" : !withVector ? "pgvector is not installed on this server" : false;

const DIM = 64;
const vector = (seed: number) => toVector(Array.from({ length: DIM }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233)));
const workspaces = [id(), id()];
async function insert(n: number, from = 0) {
  await transaction(async () => {
    for (let i = from; i < from + n; i++)
      await run(
        "INSERT INTO ai_embeddings(page_id,row_id,chunk,workspace_id,hash,model,vector,created_at) VALUES(?,?,?,?,?,?,?,?)",
        `p${i % 50}`,
        i % 3 ? "" : `r${i}`,
        i,
        workspaces[i % 2],
        `h${i}`,
        "embed",
        vector(i),
        Date.now(),
      );
  });
}
// What the JavaScript scan computes: every stored vector of the workspace.
async function bruteForce(workspace: string, query: Float32Array, limit: number, pages?: Set<string>) {
  const { all } = await import("../lib/db");
  const rows = await all<{ page_id: string; row_id: string; chunk: number; vector: Uint8Array }>(
    "SELECT page_id,row_id,chunk,vector FROM ai_embeddings WHERE workspace_id=? AND model='embed'",
    workspace,
  );
  return rows
    .filter((r) => !pages || pages.has(r.page_id))
    .map((r) => {
      const v = fromVector(r.vector);
      let score = 0;
      for (let i = 0; i < v.length; i++) score += v[i] * query[i];
      return { pageId: r.page_id, rowId: r.row_id, chunk: Number(r.chunk), score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
const keys = (hits: { pageId: string; rowId: string; chunk: number }[] | null) => (hits ?? []).map((h) => `${h.pageId}/${h.rowId}/${h.chunk}`);

test("the trigger copies every vector; the database finds what the scan finds", { skip }, async () => {
  assert.equal(await store.ensureVectorStore(), true);
  await insert(600);
  await store.syncVectors();
  assert.deepEqual(await store.vectorStoreStatus(), { active: true, complete: true, indexed: [DIM] });
  // The bytes decode exactly (pgvector holds float4, as the bytes do).
  const stored = await one<{ embedding: string }>("SELECT embedding::text embedding FROM ai_embedding_vectors WHERE chunk=7");
  // (Its text is the shortest form of each float4.)
  assert.deepEqual((JSON.parse(stored!.embedding) as number[]).map(Math.fround), Array.from(fromVector(vector(7))));
  const query = fromVector(vector(4242));
  for (const limit of [1, 10, 40]) {
    const found = await store.nearestVectors(workspaces[0], "embed", query, limit);
    const expected = await bruteForce(workspaces[0], query, limit);
    assert.deepEqual(keys(found), keys(expected), `limit ${limit}`);
    for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(found![i].score - expected[i].score) < 1e-5);
  }
  // Filters: only some pages, never the source itself.
  const pages = new Set(["p2", "p4", "p6"]);
  assert.deepEqual(keys(await store.nearestVectors(workspaces[0], "embed", query, 5, { pages })), keys(await bruteForce(workspaces[0], query, 5, pages)));
  const top = (await store.nearestVectors(workspaces[0], "embed", query, 1))![0];
  const without = await store.nearestVectors(workspaces[0], "embed", query, 5, { exclude: { pageId: top.pageId, rowId: top.rowId } });
  assert.ok(!without!.some((h) => h.pageId === top.pageId && h.rowId === top.rowId));
  // Another model or size: nothing.
  assert.deepEqual(await store.nearestVectors(workspaces[0], "other", query, 5), []);
  assert.deepEqual(await store.nearestVectors(workspaces[0], "embed", query.slice(0, 32), 5), []);
});

test("deletes, re-embedded chunks and moved workspaces follow", { skip }, async () => {
  await run("DELETE FROM ai_embeddings WHERE page_id='p1'");
  assert.equal((await one<{ n: number }>("SELECT count(*) n FROM ai_embedding_vectors WHERE page_id='p1'"))!.n, 0);
  await run("UPDATE ai_embeddings SET vector=?,hash='changed' WHERE chunk=10", vector(99999));
  const changed = await one<{ hash: string; embedding: string }>("SELECT hash,embedding::text embedding FROM ai_embedding_vectors WHERE chunk=10");
  assert.equal(changed!.hash, "changed");
  assert.deepEqual((JSON.parse(changed!.embedding) as number[]).map(Math.fround), Array.from(fromVector(vector(99999))));
  // A page moved to another workspace (lib/page-transfer.ts) is found there.
  await run("UPDATE ai_embeddings SET workspace_id=? WHERE page_id='p0'", workspaces[1]);
  const query = fromVector(vector(0));
  assert.deepEqual(keys(await store.nearestVectors(workspaces[1], "embed", query, 20)), keys(await bruteForce(workspaces[1], query, 20)));
});

test("rows that bypassed the trigger (a restore, the migration tool) are filled in; until then the scan answers", { skip }, async () => {
  await run("ALTER TABLE ai_embeddings DISABLE TRIGGER ai_embeddings_vector_sync");
  await insert(300, 1000);
  await run("ALTER TABLE ai_embeddings ENABLE TRIGGER ai_embeddings_vector_sync");
  // The next start.
  assert.equal(await store.ensureVectorStore(), true);
  assert.equal(await store.nearestVectors(workspaces[0], "embed", fromVector(vector(1)), 5), null, "still filling in: the JavaScript scan");
  await store.syncVectors();
  assert.equal((await store.vectorStoreStatus()).complete, true);
  const query = fromVector(vector(1001));
  assert.deepEqual(keys(await store.nearestVectors(workspaces[1], "embed", query, 10)), keys(await bruteForce(workspaces[1], query, 10)));
});

test("FLOWPLAN_PGVECTOR=off: the scan, the trigger gone", { skip }, async () => {
  process.env.FLOWPLAN_PGVECTOR = "off";
  try {
    assert.equal(await store.ensureVectorStore(), false);
    assert.equal(await store.nearestVectors(workspaces[0], "embed", fromVector(vector(1)), 5), null);
    assert.equal(await one("SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='ai_embeddings_vector_sync' AND c.relnamespace=current_schema()::regnamespace"), undefined);
  } finally {
    delete process.env.FLOWPLAN_PGVECTOR;
  }
  assert.equal(await store.ensureVectorStore(), true);
  await store.syncVectors();
  assert.equal((await store.vectorStoreStatus()).complete, true);
});
