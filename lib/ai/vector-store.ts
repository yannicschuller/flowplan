// Semantic search with pgvector (docs/architecture/database.md, §5b): on
// PostgreSQL with the `vector` extension the nearest chunks are found by the
// database – an HNSW index per vector size, exact in SQL where the index
// cannot serve – instead of reading every vector of the workspace into
// JavaScript (lib/ai/semantic.ts, nearestChunks: the way on SQLite and on
// PostgreSQL without the extension).
//
// `ai_embeddings.vector` (bytes, 4 per dimension) stays what is stored,
// backed up, moved and restored on both databases. `ai_embedding_vectors`
// is derived from it and PostgreSQL's alone: not in the translated schema,
// snapshots or instance moves, and left out of pg_dump backups
// (lib/pg-backup.ts), so a backup restores on a server without pgvector.
// A trigger on ai_embeddings keeps it current for every write, whichever
// code makes it (the bytes are decoded in SQL, flowplan_floats()); what
// bypassed the trigger – a restore, the migration tool, a database made
// before pgvector was installed – is filled in from ai_embeddings at the
// next start, in the background (syncVectors). Until that is done the
// JavaScript scan answers. A row is used only together with the row of
// ai_embeddings with the same key, hash and model.
//
// FLOWPLAN_PGVECTOR=off keeps the JavaScript scan even with the extension.
import { all, inTransaction, one, sql, transaction } from "../db";
import { db } from "../db-driver";
import { quoteIdent } from "../db-driver/pg-ddl.mjs";
import { extensionSchema } from "../pg-extensions";

// HNSW indexes take vectors of up to 2,000 dimensions; larger ones are
// searched exactly (in SQL).
const MAX_INDEXED = 2000;
const runtime = globalThis as typeof globalThis & {
  flowplanVectorStore?: { ext: string | null; complete: boolean; indexed: Set<number>; filling: Promise<void> | null };
};
const state = (runtime.flowplanVectorStore ??= { ext: null, complete: false, indexed: new Set(), filling: null });
const disabled = () => sql.name === "sqlite" || /^(off|0|false|no)$/i.test(process.env.FLOWPLAN_PGVECTOR || "");
export const vectorStoreActive = () => !!state.ext && !disabled();

// The objects of pgvector's side, by name: a pg_dump backup leaves them
// out (lib/pg-backup.ts) and ensureVectorStore makes them anew.
export const VECTOR_TABLE = "ai_embedding_vectors";
export const VECTOR_TRIGGER = "ai_embeddings_vector_sync";

// IEEE 754 single precision, little endian (lib/ai/semantic.ts toVector)
// → real[]; infinities and NaN (never in a normalised vector) as 0.
const FLOATS_SQL = `CREATE OR REPLACE FUNCTION flowplan_floats(b bytea) RETURNS real[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $f$
SELECT COALESCE(array_agg((CASE WHEN e=255 THEN 0 WHEN e=0 THEN m::float8*2^(-149) ELSE (1+m::float8/8388608)*2^(e-127) END*(1-2*s))::real ORDER BY i),'{}')
FROM (SELECT i,get_byte(b,4*i+3)>>7 s,((get_byte(b,4*i+3)&127)<<1)|(get_byte(b,4*i+2)>>7) e,((get_byte(b,4*i+2)&127)<<16)|(get_byte(b,4*i+1)<<8)|get_byte(b,4*i) m FROM generate_series(0,length(b)/4-1) i) x $f$`;
const UPSERT = "ON CONFLICT(page_id,row_id,chunk) DO UPDATE SET hash=excluded.hash,model=excluded.model,dims=excluded.dims,embedding=excluded.embedding";

// Made when the database opens (lib/db.ts): the extension (installed when
// the server has it and the role may), the table, the trigger, which sizes
// have an index; then what is missing is filled in, in the background.
// Returns whether pgvector is in use.
export async function ensureVectorStore(): Promise<boolean> {
  state.ext = null;
  state.complete = false;
  state.indexed = new Set();
  if (sql.name === "sqlite") return false;
  if (disabled()) {
    // Switched off: the trigger would only cost time.
    await db.exec(`DROP TRIGGER IF EXISTS ${VECTOR_TRIGGER} ON ai_embeddings`).catch(() => {});
    return false;
  }
  await db.tx(
    async () => {
      const ext = await extensionSchema("vector");
      if (!ext) {
        // E.g. a backup from a server with pgvector restored on one without.
        await db.exec(`DROP TRIGGER IF EXISTS ${VECTOR_TRIGGER} ON ai_embeddings; DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
        return;
      }
      const x = quoteIdent(ext);
      await db.exec(
        `CREATE TABLE IF NOT EXISTS ${VECTOR_TABLE}(page_id text NOT NULL,row_id text NOT NULL,chunk bigint NOT NULL,hash text NOT NULL,model text NOT NULL,dims integer NOT NULL,embedding ${x}.vector NOT NULL,PRIMARY KEY(page_id,row_id,chunk))`,
      );
      // No statistics on the vectors: ANALYZE (and autovacuum) would sort
      // them, and pgvector refuses to compare vectors of different sizes
      // (another model) – the table's other columns are analysed as usual.
      await db.exec(`ALTER TABLE ${VECTOR_TABLE} ALTER COLUMN embedding SET STATISTICS 0`);
      await db.exec(FLOATS_SQL);
      await db.exec(`CREATE OR REPLACE FUNCTION flowplan_vector_sync() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM ${VECTOR_TABLE} WHERE page_id=OLD.page_id AND row_id=OLD.row_id AND chunk=OLD.chunk;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.page_id,OLD.row_id,OLD.chunk) IS DISTINCT FROM (NEW.page_id,NEW.row_id,NEW.chunk) THEN
    DELETE FROM ${VECTOR_TABLE} WHERE page_id=OLD.page_id AND row_id=OLD.row_id AND chunk=OLD.chunk;
  END IF;
  IF length(NEW.vector)>=4 THEN
    INSERT INTO ${VECTOR_TABLE}(page_id,row_id,chunk,hash,model,dims,embedding)
    VALUES(NEW.page_id,NEW.row_id,NEW.chunk,NEW.hash,NEW.model,length(NEW.vector)/4,flowplan_floats(NEW.vector)::${x}.vector) ${UPSERT};
  END IF;
  RETURN NEW;
END $f$`);
      await db.exec(
        `CREATE OR REPLACE TRIGGER ${VECTOR_TRIGGER} AFTER INSERT OR DELETE OR UPDATE OF page_id,row_id,chunk,hash,model,vector ON ai_embeddings FOR EACH ROW EXECUTE FUNCTION flowplan_vector_sync()`,
      );
      state.ext = ext;
    },
    { lock: "flowplan:vector-store" },
  );
  if (!state.ext) return false;
  for (const r of await all<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='${VECTOR_TABLE}'`)) {
    const m = /^ai_embedding_vectors_hnsw_(\d+)$/.exec(r.indexname);
    if (m) state.indexed.add(Number(m[1]));
  }
  // Filled in after the opening, not during it (a large instance takes a
  // while: about 0.4 ms per vector of 768 dimensions).
  setImmediate(() => void syncVectors());
  return true;
}

const sameRow = "v.page_id=e.page_id AND v.row_id=e.row_id AND v.chunk=e.chunk AND v.hash=e.hash AND v.model=e.model";

// The HNSW index for vectors of one size (inner product: the vectors are
// normalised, so it orders like cosine similarity).
export async function ensureVectorIndex(dims: number) {
  if (!vectorStoreActive() || inTransaction() || state.indexed.has(dims) || dims > MAX_INDEXED || !Number.isInteger(dims) || dims < 1) return;
  const x = quoteIdent(state.ext!);
  await db.tx(
    async () =>
      await db.exec(
        `CREATE INDEX IF NOT EXISTS ai_embedding_vectors_hnsw_${dims} ON ${VECTOR_TABLE} USING hnsw ((embedding::${x}.vector(${dims})) ${x}.vector_ip_ops) WHERE dims=${dims}`,
      ),
    { lock: "flowplan:vector-store" },
  );
  state.indexed.add(dims);
}

// Fills in what bypassed the trigger, 500 vectors per transaction, and
// makes the indexes for the sizes it met. One run at a time; when nothing
// is missing, the database answers the searches.
export function syncVectors(): Promise<void> {
  if (!vectorStoreActive() || inTransaction()) return Promise.resolve();
  if (state.filling) return state.filling;
  const x = quoteIdent(state.ext!);
  const filling = (async () => {
    try {
      for (;;) {
        const added = await transaction(
          async () =>
            await all<{ dims: number }>(
              `INSERT INTO ${VECTOR_TABLE}(page_id,row_id,chunk,hash,model,dims,embedding)
               SELECT e.page_id,e.row_id,e.chunk,e.hash,e.model,length(e.vector)/4,flowplan_floats(e.vector)::${x}.vector FROM ai_embeddings e
               WHERE length(e.vector)>=4 AND NOT EXISTS(SELECT 1 FROM ${VECTOR_TABLE} v WHERE ${sameRow}) LIMIT 500
               ${UPSERT} RETURNING dims`,
            ),
        );
        if (added.length < 500) break;
        await new Promise((done) => setImmediate(done));
      }
      for (const r of await all<{ dims: number }>(`SELECT DISTINCT dims FROM ${VECTOR_TABLE}`)) await ensureVectorIndex(Number(r.dims));
      state.complete = true;
    } catch (error) {
      console.error("pgvector: filling in the vectors failed", (error as Error)?.message);
    }
  })().finally(() => {
    state.filling = null;
  });
  state.filling = filling;
  return filling;
}
// New sizes get their index (lib/ai/semantic.ts after storing vectors).
export async function vectorsStored(dims: number) {
  if (vectorStoreActive() && !state.indexed.has(dims)) await ensureVectorIndex(dims).catch((error) => console.error("pgvector: index not made", (error as Error)?.message));
}
// Whether every stored vector is in pgvector's table (tests, status).
export async function vectorStoreStatus() {
  if (!vectorStoreActive()) return { active: false as const, complete: false, indexed: [] as number[] };
  await state.filling;
  const missing = !!(await one(`SELECT 1 FROM ai_embeddings e WHERE length(e.vector)>=4 AND NOT EXISTS(SELECT 1 FROM ${VECTOR_TABLE} v WHERE ${sameRow}) LIMIT 1`));
  return { active: true as const, complete: state.complete && !missing, indexed: [...state.indexed].sort((a, b) => a - b) };
}

export type VectorHit = { pageId: string; rowId: string; chunk: number; score: number };
// The `limit` chunks of a workspace closest to `query` (normalised), best
// first; only those of `pages` when given, never those of `exclude`.
// null when pgvector cannot answer (not installed, vectors still being
// filled in): the caller scans in JavaScript.
export async function nearestVectors(
  workspaceId: string,
  model: string,
  query: Float32Array,
  limit: number,
  filter: { pages?: Set<string> | null; exclude?: { pageId: string; rowId: string } } = {},
): Promise<VectorHit[] | null> {
  if (!vectorStoreActive() || !state.complete || !query.length) return null;
  const dims = query.length;
  const x = quoteIdent(state.ext!);
  const q = `[${Array.from(query, (v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
  const pages = filter.pages ? [...filter.pages] : null;
  if (pages && !pages.length) return [];
  const where = `e.workspace_id=? AND e.model=? AND v.dims=?${pages ? ` AND e.page_id IN ${db.dialect.jsonValues()}` : ""}${filter.exclude ? " AND NOT (e.page_id=? AND e.row_id=?)" : ""}`;
  const whereArgs = [workspaceId, model, dims, ...(pages ? [JSON.stringify(pages)] : []), ...(filter.exclude ? [filter.exclude.pageId, filter.exclude.rowId] : [])];
  // Inner product of normalised vectors = cosine similarity; <#> is its
  // negative (smaller is closer).
  const select = (distance: string) =>
    `SELECT e.page_id,e.row_id,e.chunk,-(${distance}) score FROM ${VECTOR_TABLE} v JOIN ai_embeddings e ON ${sameRow} WHERE ${where} ORDER BY ${distance} LIMIT ?`;
  type Row = { page_id: string; row_id: string; chunk: number; score: number };
  const hits = (rows: Row[]) => rows.map((r) => ({ pageId: r.page_id, rowId: r.row_id, chunk: Number(r.chunk), score: Number(r.score) }));
  if (state.indexed.has(dims)) {
    // Through the HNSW index of this size (the cast matches the index
    // expression). The index finds candidates before the workspace and the
    // filters are checked; it looks further than `limit` (ef_search), and
    // should that still leave fewer hits than wanted, the exact query below
    // answers.
    const indexed = `v.embedding::${x}.vector(${dims}) OPERATOR(${x}.<#>) ?::${x}.vector(${dims})`;
    const rows = await transaction(async () => {
      await db.exec(`SET LOCAL hnsw.ef_search = ${Math.min(1000, Math.max(100, limit * 4))}`);
      return await all<Row>(select(indexed), q, ...whereArgs, q, limit);
    });
    if (rows.length >= limit) return hits(rows);
  }
  // Exact: every vector of the workspace and model, in SQL.
  const exact = `v.embedding OPERATOR(${x}.<#>) ?::${x}.vector`;
  return hits(await all<Row>(select(exact), q, ...whereArgs, q, limit));
}
