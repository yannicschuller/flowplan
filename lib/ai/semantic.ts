// Semantic search for "ask": vectors of the workspace content made with the
// instance's embedding model, so questions find passages by meaning and not
// only by their words.
//
// OFF unless an administrator switches on "Suche nach Bedeutung" and the
// instance provider has an embedding model (Anthropic has none). Then a
// background job embeds changed pages and records chunk by chunk:
//   - only the instance provider is used (an administrator's decision, like
//     any other background work); a person's own provider never embeds,
//   - PIN journals, pages and spaces "Für KI gesperrt" and the trash are
//     never embedded (and their vectors are removed),
//   - everything else is stored once for everyone; personal AI rules,
//     permissions and private records apply at QUERY time (aiFilter) –
//     a vector never reaches a person, only the passages that pass,
//   - only a hash of each chunk is stored, never its text; unchanged chunks
//     keep their vector (incremental), a new model starts over.
// Storage: 4 bytes per dimension and chunk (768 dimensions, nomic-embed-text:
// about 3 KB per chunk of up to ~900 characters, i.e. roughly 3–4 × the
// text; 1536 dimensions: about 6 KB per chunk).
import { createHash } from "node:crypto";
import { limitAi } from "../action-limits";
import { all, one, run, transaction } from "../db";
import type { Identity } from "../types";
import { featureAllowed, instanceAiSettings, normalizeUrl } from "./settings";
import { instanceProviderConfig, resolveAi } from "./resolve";
import { embed, type AiConfig } from "./providers";
import { redactSecrets } from "./redact";
import { sourceText } from "./sources";
import { forEachAsync } from "../each-async";

// The instance's embedding configuration, or null when semantic search is off.
export async function semanticConfig(): Promise<(AiConfig & { embeddingModel: string }) | null> {
  const settings = await instanceAiSettings();
  if (!settings.enabled || !settings.semanticSearch || !featureAllowed(settings, "ask")) return null;
  const built = await instanceProviderConfig();
  if (!built.ok || built.config.kind === "anthropic" || !built.config.embeddingModel?.trim()) return null;
  return { ...built.config, embeddingModel: built.config.embeddingModel.trim() };
}
const configKey = (c: AiConfig & { embeddingModel: string }) => `${c.kind}|${normalizeUrl(c.kind, c.baseUrl)}|${c.embeddingModel}`;

// Semantic search for this person: "ask" usable with the instance provider
// (questions go to the same place as the indexed text, never elsewhere).
export async function semanticFor(user: Identity, workspaceId: string) {
  const resolved = await resolveAi(user, "ask", { workspaceId });
  if (!resolved.ok || resolved.source !== "instance") return null;
  return await semanticConfig();
}

const meta = async (key: string) => (await one<{ value: string }>("SELECT value FROM ai_meta WHERE key=?", key))?.value ?? null;
const setMeta = async (key: string, value: string) => await run("INSERT INTO ai_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);

export const chunkHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
// The text that is embedded for a chunk: its source's title gives context.
export const embedText = (title: string, chunk: string) => `${title}\n${chunk}`.slice(0, 4000);

export function toVector(values: number[]): Uint8Array {
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const vector = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) vector[i] = values[i] / norm;
  return new Uint8Array(vector.buffer);
}
export function fromVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

// Pages that are never embedded: in the trash (themselves, a page above or
// their space), below a journal with a PIN, or closed to the AI by a manager.
export async function embeddableChecker() {
  const blocks = new Set((await all<{ target_id: string }>("SELECT target_id FROM ai_blocks")).map((r) => r.target_id));
  const pinned = new Set((await all<{ page_id: string }>("SELECT page_id FROM journal_settings WHERE lock_hash IS NOT NULL")).map((r) => r.page_id));
  const deletedSpaces = new Set((await all<{ id: string }>("SELECT id FROM spaces WHERE deleted_at IS NOT NULL")).map((r) => r.id));
  const known = new Map<string, boolean>();
  return async (pageId: string): Promise<boolean> => {
    if (known.has(pageId)) return known.get(pageId)!;
    let ok = true;
    const seen = new Set<string>();
    let current = await one<{ id: string; parent_id: string | null; space_id: string; deleted_at: string | null }>("SELECT id,parent_id,space_id,deleted_at FROM pages WHERE id=?", pageId);
    if (!current || deletedSpaces.has(current.space_id) || blocks.has(current.space_id)) ok = false;
    while (ok && current) {
      if (seen.has(current.id) || seen.size > 256 || current.deleted_at || pinned.has(current.id) || blocks.has(current.id)) ok = false;
      seen.add(current.id);
      current = current.parent_id ? (await one("SELECT id,parent_id,space_id,deleted_at FROM pages WHERE id=?", current.parent_id)) : undefined;
    }
    known.set(pageId, ok);
    return ok;
  };
}

// What decides which pages may be embedded; a change re-checks everything.
async function blockSignature() {
  const blocks = (await all<{ target_id: string }>("SELECT target_id FROM ai_blocks ORDER BY target_id")).map((r) => r.target_id);
  const pins = (await all<{ page_id: string }>("SELECT page_id FROM journal_settings WHERE lock_hash IS NOT NULL ORDER BY page_id")).map((r) => r.page_id);
  const spaces = (await all<{ id: string }>("SELECT id FROM spaces WHERE deleted_at IS NOT NULL ORDER BY id")).map((r) => r.id);
  return chunkHash([blocks.join(","), pins.join(","), spaces.join(",")].join("|"));
}
async function markEverything() {
  await run("INSERT INTO ai_embed_dirty SELECT id,'' FROM pages WHERE deleted_at IS NULL AND COALESCE(synced,0)=0 ON CONFLICT DO NOTHING");
  await run("INSERT INTO ai_embed_dirty SELECT page_id,id FROM rows WHERE true ON CONFLICT DO NOTHING");
}

// Texts per hour for the background job (FLOWPLAN_AI_EMBED_PER_HOUR).
const perHour = () => Math.max(1, Number(process.env.FLOWPLAN_AI_EMBED_PER_HOUR) || 5000);
const runtime = globalThis as typeof globalThis & { flowplanEmbedLog?: { at: number; n: number }[]; flowplanEmbedRetry?: number };
function budgetLeft(now = Date.now()) {
  const log = (runtime.flowplanEmbedLog = (runtime.flowplanEmbedLog || []).filter((e) => e.at > now - 3_600_000));
  return perHour() - log.reduce((sum, e) => sum + e.n, 0);
}

export type EmbedRun = { embedded: number; reused: number; removed: number; pending: number };

// One step of the background job: up to `maxTexts` new vectors. Returns
// what happened (tests call it directly).
export async function processEmbeddings(maxTexts = 64, signal?: AbortSignal): Promise<EmbedRun> {
  const result: EmbedRun = { embedded: 0, reused: 0, removed: 0, pending: 0 };
  const config = await semanticConfig();
  if (!config) {
    // Switched off: nothing is kept.
    if (await one("SELECT 1 FROM ai_embeddings LIMIT 1") || await one("SELECT 1 FROM ai_embed_dirty LIMIT 1") || await meta("embed-config"))
      await transaction(async () => {
        result.removed = Number((await run("DELETE FROM ai_embeddings")).changes);
        await run("DELETE FROM ai_embed_dirty");
        await run("DELETE FROM ai_meta WHERE key IN ('embed-config','embed-blocks')");
      });
    return result;
  }
  const key = configKey(config);
  if ((await meta("embed-config")) !== key)
    await transaction(async () => {
      result.removed += Number((await run("DELETE FROM ai_embeddings")).changes);
      await markEverything();
      await setMeta("embed-config", key);
    });
  const signature = await blockSignature();
  if ((await meta("embed-blocks")) !== signature)
    await transaction(async () => {
      await markEverything();
      await setMeta("embed-blocks", signature);
    });
  if ((runtime.flowplanEmbedRetry || 0) > Date.now()) return result;
  const allowance = Math.min(maxTexts, budgetLeft());
  const embeddable = await embeddableChecker();
  const entries = await all<{ page_id: string; row_id: string }>("SELECT page_id,row_id FROM ai_embed_dirty LIMIT 100");
  for (const entry of entries) {
    if (signal?.aborted) break;
    const clear = async () => await run("DELETE FROM ai_embeddings WHERE page_id=? AND row_id=?", entry.page_id, entry.row_id);
    // Taken off the list first: a change while embedding marks it again.
    await run("DELETE FROM ai_embed_dirty WHERE page_id=? AND row_id=?", entry.page_id, entry.row_id);
    const page = await one<{ workspace_id: string; synced: number | null }>("SELECT workspace_id,synced FROM pages WHERE id=?", entry.page_id);
    if (!page || page.synced || !embeddable(entry.page_id)) {
      // Not embeddable: neither the page nor any of its records.
      result.removed += Number((entry.row_id ? (await clear()) : (await run("DELETE FROM ai_embeddings WHERE page_id=?", entry.page_id))).changes);
      continue;
    }
    const source = await sourceText(entry.page_id, entry.row_id || null);
    if (!source || !source.chunks.length) {
      result.removed += Number((await clear()).changes);
      continue;
    }
    const texts = source.chunks.slice(0, 200).map((c) => embedText(source.title, c));
    const hashes = texts.map(chunkHash);
    const existing = new Map(
      (await all<{ hash: string; vector: Uint8Array }>("SELECT hash,vector FROM ai_embeddings WHERE page_id=? AND row_id=? AND model=?", entry.page_id, entry.row_id, config.embeddingModel)).map(
        (r) => [r.hash, r.vector],
      ),
    );
    const missing = texts.map((t, i) => ({ text: t, hash: hashes[i] })).filter((t) => !existing.has(t.hash));
    const unique = [...new Map(missing.map((m) => [m.hash, m])).values()];
    if (unique.length && result.embedded + unique.length > allowance && result.embedded > 0) {
      await run("INSERT INTO ai_embed_dirty VALUES(?,?) ON CONFLICT DO NOTHING", entry.page_id, entry.row_id);
      break;
    }
    // Larger than what is left: wait for a step with the full allowance (a
    // source larger than a whole step is embedded at once then).
    if (unique.length > allowance && allowance < maxTexts) {
      await run("INSERT INTO ai_embed_dirty VALUES(?,?) ON CONFLICT DO NOTHING", entry.page_id, entry.row_id);
      break;
    }
    let vectors: number[][] = [];
    try {
      for (let i = 0; i < unique.length; i += 64) {
        const part = await embed(config, unique.slice(i, i + 64).map((u) => u.text), signal);
        if (!part) throw new Error("Keine Embeddings");
        vectors.push(...part);
      }
    } catch (error) {
      await run("INSERT INTO ai_embed_dirty VALUES(?,?) ON CONFLICT DO NOTHING", entry.page_id, entry.row_id);
      runtime.flowplanEmbedRetry = Date.now() + 5 * 60_000;
      console.error("Embeddings fehlgeschlagen:", redactSecrets(String((error as Error)?.message || error), [config.apiKey]));
      break;
    }
    if (vectors.length) (runtime.flowplanEmbedLog ||= []).push({ at: Date.now(), n: vectors.length });
    const fresh = new Map(unique.map((u, i) => [u.hash, toVector(vectors[i])]));
    await transaction(async () => {
      // Deleted while embedding: nothing to store.
      if (!(await one("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", entry.page_id))) return;
      if (entry.row_id && !(await one("SELECT 1 FROM rows WHERE id=? AND page_id=?", entry.row_id, entry.page_id))) return;
      await clear();
      await forEachAsync(hashes, async (hash, chunk) => {
        const vector = fresh.get(hash) || existing.get(hash);
        if (!vector) return;
        await run(
          "INSERT INTO ai_embeddings(page_id,row_id,chunk,workspace_id,hash,model,vector,created_at) VALUES(?,?,?,?,?,?,?,?)",
          entry.page_id,
          entry.row_id,
          chunk,
          page.workspace_id,
          hash,
          config.embeddingModel,
          vector,
          Date.now(),
        );
      });
    });
    result.embedded += unique.length;
    result.reused += hashes.length - missing.length;
  }
  result.pending = Number((await one<{ n: number }>("SELECT count(*) n FROM ai_embed_dirty"))?.n || 0);
  return result;
}

export type SemanticHit = { pageId: string; rowId: string; chunk: number; score: number };
const MAX_SCANNED = 200_000;

// The chunks closest in meaning to the question (unfiltered – the caller
// MUST pass them through aiFilter before using them). The embedding call
// counts against the AI rate limit unless `limited` says the request it
// belongs to (an Ask whose answer takes the slot) is counted already. A
// `vector` made earlier (lib/ai/ask.ts across workspaces) skips the call.
export async function semanticCandidates(
  user: Identity,
  workspaceId: string,
  question: string,
  options: { pages?: Set<string> | null; limit?: number; signal?: AbortSignal; limited?: boolean; vector?: Float32Array | null } = {},
): Promise<SemanticHit[]> {
  const config = await semanticFor(user, workspaceId);
  if (!config) return [];
  if (!(await one("SELECT 1 FROM ai_embeddings WHERE workspace_id=? AND model=? LIMIT 1", workspaceId, config.embeddingModel))) return [];
  let query = options.vector || null;
  if (!query) {
    if (!options.limited) limitAi(user.id);
    const [values] = await embed(config, [question.slice(0, 2000)], options.signal) || [];
    if (!values?.length) return [];
    query = fromVector(toVector(values));
  }
  return nearestChunks(workspaceId, config.embeddingModel, query, options.limit ?? 40, (row) => !options.pages || options.pages.has(row.page_id), options.signal);
}

// The question as a normalized vector (one embedding call, rate-limited
// unless `limited`), or null without semantic search for this person.
export async function semanticQueryVector(
  user: Identity,
  workspaceId: string,
  question: string,
  options: { signal?: AbortSignal; limited?: boolean } = {},
): Promise<Float32Array | null> {
  const config = await semanticFor(user, workspaceId);
  if (!config) return null;
  if (!options.limited) limitAi(user.id);
  const [values] = await embed(config, [question.slice(0, 2000)], options.signal) || [];
  return values?.length ? fromVector(toVector(values)) : null;
}

// The best chunks of a workspace for a vector, scanning at most
// MAX_SCANNED rows. The scan reads SCAN_SLICE rows at a time and gives the
// event loop a turn between slices (setImmediate), so a large workspace
// (100,000 vectors take ~100 ms) does not hold up every other request. A
// slice is read in full before the turn: an open statement iterator would
// keep the database connection busy for everyone else.
const SCAN_SLICE = 2_000;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function nearestChunks(
  workspaceId: string,
  model: string,
  query: Float32Array,
  limit: number,
  keep: (row: { page_id: string; row_id: string }) => boolean,
  signal?: AbortSignal,
): Promise<SemanticHit[]> {
  const best: SemanticHit[] = [];
  let worst = -Infinity;
  // In key order, slice after slice (keyset: the last key of a slice).
  let after: [string, string, number] = ["", "", -1],
    scanned = 0;
  while (scanned < MAX_SCANNED) {
    const rows = await all<{
      page_id: string;
      row_id: string;
      chunk: number;
      vector: Uint8Array;
    }>(
      "SELECT page_id,row_id,chunk,vector FROM ai_embeddings WHERE workspace_id=? AND model=? AND (page_id,row_id,chunk)>(?,?,?) ORDER BY page_id,row_id,chunk LIMIT ?",
      workspaceId,
      model,
      ...after,
      Math.min(SCAN_SLICE, MAX_SCANNED - scanned),
    );
    for (const row of rows) {
      if (!keep(row)) continue;
      const vector = fromVector(row.vector);
      if (vector.length !== query.length) continue;
      let score = 0;
      for (let i = 0; i < vector.length; i++) score += vector[i] * query[i];
      if (best.length >= limit && score <= worst) continue;
      best.push({ pageId: row.page_id, rowId: row.row_id, chunk: Number(row.chunk), score });
      best.sort((a, b) => b.score - a.score);
      if (best.length > limit) best.pop();
      worst = best[best.length - 1].score;
    }
    scanned += rows.length;
    if (rows.length < SCAN_SLICE) break;
    const last = rows[rows.length - 1];
    after = [last.page_id, last.row_id, Number(last.chunk)];
    await nextTurn();
    if (signal?.aborted) break;
  }
  return best;
}

// Sources close in meaning to a page or record ("Verwandte Seiten"): the
// mean of its stored vectors against the workspace – no provider call, so
// nothing leaves the server. Unfiltered like semanticCandidates: callers
// pass the hits through aiFilter. Empty without semantic search for this
// person or before the source is embedded. The hits (before aiFilter, so
// the same for everyone) are kept for a minute: opening the same page again
// does not scan the workspace again.
const NEIGHBOUR_TTL = 60_000;
const neighbourCache = new Map<string, { at: number; hits: SemanticHit[] }>();
export async function semanticNeighbours(user: Identity, workspaceId: string, pageId: string, rowId: string, limit = 60): Promise<SemanticHit[]> {
  const config = await semanticFor(user, workspaceId);
  if (!config) return [];
  const cacheKey = `${workspaceId}|${config.embeddingModel}|${pageId}|${rowId}|${limit}`;
  const cached = neighbourCache.get(cacheKey);
  if (cached && cached.at > Date.now() - NEIGHBOUR_TTL) return cached.hits;
  const own = (await all<{ vector: Uint8Array }>(
    "SELECT vector FROM ai_embeddings WHERE page_id=? AND row_id=? AND model=? ORDER BY chunk LIMIT 50",
    pageId,
    rowId,
    config.embeddingModel,
  )).map((r) => fromVector(r.vector));
  if (!own.length) return [];
  const mean = new Array<number>(own[0].length).fill(0);
  for (const v of own) if (v.length === mean.length) for (let i = 0; i < v.length; i++) mean[i] += v[i];
  const query = fromVector(toVector(mean));
  // Best chunk per source.
  const hits = await nearestChunks(workspaceId, config.embeddingModel, query, limit * 4, (row) => !(row.page_id === pageId && row.row_id === rowId));
  const bySource = new Map<string, SemanticHit>();
  for (const hit of hits) {
    const k = `${hit.pageId}/${hit.rowId}`;
    if (!bySource.has(k)) bySource.set(k, hit);
  }
  const result = [...bySource.values()].slice(0, limit);
  const now = Date.now();
  if (neighbourCache.size >= 500) for (const [k, v] of neighbourCache) if (v.at <= now - NEIGHBOUR_TTL || neighbourCache.size >= 500) neighbourCache.delete(k);
  neighbourCache.set(cacheKey, { at: now, hits: result });
  return result;
}

// For the administration: how much is stored.
export async function semanticStats() {
  const stats = await one<{ chunks: number; bytes: number; sources: number }>(
    "SELECT count(*) chunks,COALESCE(sum(length(vector)),0) bytes,count(DISTINCT page_id||'/'||row_id) sources FROM ai_embeddings",
  );
  const pending = Number((await one<{ n: number }>("SELECT count(*) n FROM ai_embed_dirty"))?.n || 0);
  const config = await semanticConfig();
  return {
    active: !!config,
    model: config?.embeddingModel || "",
    chunks: Number(stats?.chunks || 0),
    bytes: Number(stats?.bytes || 0),
    sources: Number(stats?.sources || 0),
    pending: config ? pending : 0,
  };
}
