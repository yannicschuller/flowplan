// The vector scan of semantic search gives the event loop turns, and the
// meaning part of "Verwandte Seiten" is limited per person.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-semantic-scan-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id, transaction } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { semanticNeighbours, toVector } = await import("../lib/ai/semantic");
const { relatedPages } = await import("../lib/related-pages");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben");
const wid = await createWorkspace(admin.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const mock = await startOllamaMock();
after(() => mock.close());
await command(admin, {
  action: "admin.ai",
  settings: { enabled: true, semanticSearch: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "embed" } },
});
await run("INSERT INTO ai_meta(key,value) VALUES('embed-config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", `ollama|${mock.base.toLowerCase()}|embed`);

const DIM = 256,
  VECTORS = 12_000;
const pages: string[] = [];
for (let i = 0; i < 40; i++) pages.push(await createPage(wid, space, admin.id, `Seite ${i}`));
const vector = (seed: number) => toVector(Array.from({ length: DIM }, (_, i) => Math.sin(seed * 31 + i)));
await transaction(async () => {
  for (let i = 0; i < VECTORS; i++)
    await run(
      "INSERT INTO ai_embeddings(page_id,row_id,chunk,workspace_id,hash,model,vector,created_at) VALUES(?,?,?,?,?,?,?,?)",
      pages[i % pages.length],
      "",
      Math.floor(i / pages.length),
      wid,
      "h" + i,
      "embed",
      vector(i % 97),
      Date.now(),
    );
});

test("the vector scan yields to the event loop between slices and still finds the best chunks", async () => {
  let turns = 0;
  let ticking = true;
  const tick = () => {
    turns++;
    if (ticking) setImmediate(tick);
  };
  setImmediate(tick);
  const hits = await semanticNeighbours(ben, wid, pages[0], "", 10);
  ticking = false;
  assert.ok(turns >= Math.floor(VECTORS / 2_000) - 1, `other work ran ${turns} times during the scan`);
  assert.equal(hits.length, 10);
  assert.ok(!hits.some((h) => h.pageId === pages[0]), "not the page itself");
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  // The same request again within a minute comes from the cache.
  turns = 0;
  ticking = true;
  setImmediate(tick);
  assert.deepEqual(await semanticNeighbours(ben, wid, pages[0], "", 10), hits);
  ticking = false;
  assert.ok(turns <= 1);
});

test("the meaning part of related pages is limited per person", async () => {
  let semantic = 0;
  for (let i = 0; i < 70; i++) if ((await relatedPages(ben, pages[i % pages.length])).semantic) semantic++;
  assert.equal(semantic, 60, "60 scans a minute, then links and tags only");
  assert.equal((await relatedPages(admin, pages[1])).semantic, true, "others are not affected");
});
