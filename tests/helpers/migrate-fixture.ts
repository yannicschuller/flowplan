// An instance for tests/db-migrate.test.ts, run as a process of its own on
// the database the environment names (SQLite: FLOWPLAN_DATA_DIR,
// PostgreSQL: DATABASE_URL + FLOWPLAN_PG_SCHEMA):
//   node --import tsx tests/helpers/migrate-fixture.ts seed    – fills it
//   node --import tsx tests/helpers/migrate-fixture.ts query   – prints what
//     searches, semantic search and a few counts find, as JSON
// Realistic: the example pages of a new workspace, documents in German,
// English, French and Chinese, a database with records, comments, files,
// tags and embeddings (two vector sizes, two workspaces).
import type { Identity } from "../../lib/types";

const mode = process.argv[2];
const { one, all, run, id, transaction } = await import("../../lib/db");
const { closeDatabase } = await import("../../lib/db-driver");
const { searchWorkspace, refreshSearchIndex, termMatches } = await import("../../lib/search-index");
const { nearestChunks, toVector, fromVector } = await import("../../lib/ai/semantic");
const vectors = await import("../../lib/ai/vector-store");

const vector = (seed: number, dims: number) => toVector(Array.from({ length: dims }, (_, i) => Math.sin(seed * 7.13 + i * 0.37) + Math.cos(seed * i * 0.011)));
const QUERIES = ["planung", "Projekt", "kuhlschrank", "réunion", "eleve", "项目计划", "测试", "budget", "Angebot", "kommentar", "anhang", "ab", "zz-nichts"];

if (mode === "seed") {
  const { createWorkspace } = await import("../../lib/seed");
  const { command, bootstrap, database } = await import("../../lib/api");
  const owner = async (name: string) => {
    const uid = id();
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, name, `${name.toLowerCase()}@example.test`);
    return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: true, disabled: 0, created_at: "" } as Identity;
  };
  const ada = await owner("Ada");
  const ben = await owner("Ben");
  const texts = [
    ["Projektplanung 2027", "<h1>Ziele</h1><p>Die Projektplanung für das neue Büro in Zürich: Budget, Zeitplan, Übergabe.</p>"],
    ["Inventar Küche", "<p>Kühlschrank, Herd, zwei Kühlschrank-Regale. Kühlschrank prüfen.</p>"],
    ["Réunion d'équipe", "<p>L'élève présente le résumé. Ordre du jour : budget et café.</p>"],
    ["项目计划", "<p>我们的项目计划包括三个阶段，第二阶段是测试。</p>"],
    ["Quarterly report", "<p>Project budget and planning for Q3; the fridge budget is separate.</p>"],
  ];
  for (const [who, name] of [
    [ada, "Nordwind"],
    [ben, "Südwind"],
  ] as const) {
    const wid = await createWorkspace(who.id, name, true);
    const space = (await bootstrap(who, wid)).spaces[0].id;
    const pages: string[] = [];
    for (let k = 0; k < 4; k++)
      for (const [title, html] of texts) {
        const pid = ((await command(who, { action: "page.create", workspaceId: wid, spaceId: space, title: `${title} ${k || ""}`.trim() })) as { id: string }).id;
        await run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pid, html.repeat(k + 1));
        pages.push(pid);
      }
    const db = ((await command(who, { action: "page.create", workspaceId: wid, spaceId: space, title: "Aufgaben", kind: "database" })) as { id: string }).id;
    await command(who, {
      action: "database.update",
      pageId: db,
      version: (await database(db)).version,
      fields: [
        { id: "title", name: "Name", type: "text" },
        { id: "note", name: "Notiz", type: "text" },
      ],
      views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
    });
    for (let r = 0; r < 30; r++) await command(who, { action: "row.create", pageId: db, cells: { title: `Angebot ${r}`, note: r % 3 ? "Lieferant anrufen" : "Projekt Budget prüfen" } });
    for (const pid of pages.slice(0, 6)) await run("INSERT INTO comments(id,page_id,author_id,body) VALUES(?,?,?,?)", id(), pid, who.id, "Ein Kommentar zur Planung");
    for (const pid of pages.slice(0, 3)) await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), pid, "anhang-budget.pdf", "application/pdf", 10, who.id);
    await transaction(async () => {
      let n = 0;
      for (const pid of pages)
        for (let chunk = 0; chunk < 4; chunk++, n++)
          await run(
            "INSERT INTO ai_embeddings(page_id,row_id,chunk,workspace_id,hash,model,vector,created_at) VALUES(?,?,?,?,?,?,?,?)",
            pid,
            "",
            chunk,
            wid,
            `h${n}`,
            // Two models and sizes, as after a change of the embedding model.
            chunk === 3 ? "small" : "embed",
            vector(n + (name === "Südwind" ? 1000 : 0), chunk === 3 ? 48 : 96),
            Date.now(),
          );
    });
  }
  await refreshSearchIndex();
} else if (mode === "query") {
  // Built anew on both, as after the migration: equal ranks then come in
  // the same order.
  await run("DELETE FROM search_state");
  await refreshSearchIndex();
  await vectors.syncVectors();
  const out: Record<string, unknown> = {};
  for (const w of await all<{ id: string; name: string; created_by: string }>("SELECT id,name,created_by FROM workspaces ORDER BY name")) {
    const user = { ...(await one<Identity>("SELECT * FROM users WHERE id=?", w.created_by))!, groups: [], isAdmin: true } as Identity;
    const searches: Record<string, unknown> = {};
    for (const q of QUERIES) searches[q] = (await searchWorkspace(user, w.id, q)).map((h) => [h.title, h.kind, h.rowId ? "row" : "", h.snippet]);
    const terms = (await termMatches(w.id, ["budget", "planung", "kühlschrank"], { limit: 20 })).length;
    const semantic: Record<string, unknown> = {};
    for (const [model, dims] of [
      ["embed", 96],
      ["small", 48],
    ] as const) {
      const query = fromVector(vector(7, dims));
      semantic[model] = (await nearestChunks(w.id, model, query, 12, {})).map((h) => [h.pageId, h.chunk, Math.round(h.score * 1e5) / 1e5]);
    }
    out[w.name] = { searches, terms, semantic };
  }
  out.counts = Object.fromEntries(
    await Promise.all(["users", "pages", "rows", "comments", "files", "ai_embeddings", "page_tags"].map(async (t) => [t, Number((await one<{ n: number }>(`SELECT count(*) n FROM ${t}`))!.n)])),
  );
  out.pgvector = vectors.vectorStoreActive() ? (await vectors.vectorStoreStatus()).complete : null;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
await closeDatabase();
