import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { isGuest, requireMember } from "./permissions";
import { safeFetch } from "./safe-fetch";
import {
  CITATION_LIMITS,
  normalizeDoi,
  parseReferences,
  sanitizeItem,
  suggestKey,
  uniqueKey,
  type CslItem,
} from "./citations";
import type { Identity } from "./types";

// The workspace's bibliography: CSL-JSON items by citation key, filled by
// BibTeX/CSL-JSON imports (Zotero) and resolved DOIs. Citations in
// documents carry a copy of their item, so documents, exports and shared
// pages work without this table.
const MAX_LIBRARY = 5000;
const DOI_CACHE_DAYS = 30;

export function bibliography(user: Identity, workspaceId: string) {
  requireMember(user, workspaceId);
  // Guests see only the pages shared with them, not the whole library.
  if (isGuest(user, workspaceId)) return [];
  return all<{ item: string }>(
    "SELECT item FROM bibliography WHERE workspace_id=? ORDER BY key",
    workspaceId,
  ).map((row) => JSON.parse(row.item) as CslItem);
}
// Adds or updates items (same key: replaced). Inside a transaction.
export function addToBibliography(user: Identity, workspaceId: string, items: CslItem[]) {
  requireMember(user, workspaceId, "editor");
  if (items.length > CITATION_LIMITS.items) throw new HttpError(413, "Zu viele Einträge auf einmal (höchstens 5000).");
  const count = Number(one<{ n: number }>("SELECT COUNT(*) n FROM bibliography WHERE workspace_id=?", workspaceId)?.n || 0);
  let added = 0,
    updated = 0;
  const stored: CslItem[] = [];
  for (const raw of items) {
    const item = sanitizeItem(raw);
    if (!item) continue;
    const json = JSON.stringify(item);
    if (json.length > 50000) continue;
    const existing = one<{ id: string }>("SELECT id FROM bibliography WHERE workspace_id=? AND key=?", workspaceId, item.id);
    if (existing) {
      run("UPDATE bibliography SET item=? WHERE id=?", json, existing.id);
      updated++;
    } else {
      if (count + added >= MAX_LIBRARY)
        throw new HttpError(413, "Die Literaturliste ist voll (höchstens 5000 Einträge).");
      run(
        "INSERT INTO bibliography(id,workspace_id,key,item,created_by,created_at) VALUES(?,?,?,?,?,?)",
        id(),
        workspaceId,
        item.id,
        json,
        user.id,
        Date.now(),
      );
      added++;
    }
    stored.push(item);
  }
  return { added, updated, items: stored };
}
export function importBibliography(user: Identity, input: Record<string, unknown>) {
  const { workspaceId, text } = z
    .object({ workspaceId: z.uuid(), text: z.string().min(1).max(CITATION_LIMITS.text) })
    .parse(input);
  requireMember(user, workspaceId, "editor");
  let items: CslItem[];
  try {
    items = parseReferences(text);
  } catch (error) {
    throw new HttpError(400, (error as Error).message || "Die Literaturdatei ist ungültig.");
  }
  if (!items.length) throw new HttpError(400, "Keine Literaturangaben gefunden (BibTeX oder CSL-JSON).");
  return addToBibliography(user, workspaceId, items);
}
export function removeFromBibliography(user: Identity, input: Record<string, unknown>) {
  const { workspaceId, key } = z.object({ workspaceId: z.uuid(), key: z.string().min(1).max(200) }).parse(input);
  requireMember(user, workspaceId, "editor");
  run("DELETE FROM bibliography WHERE workspace_id=? AND key=?", workspaceId, key);
  return { ok: true };
}

// Metadata of a DOI as CSL-JSON (DOI content negotiation: Crossref,
// DataCite, mEDRA …), cached; only through the SSRF-safe fetch.
export async function resolveDoi(raw: unknown, fetcher = safeFetch): Promise<Omit<CslItem, "id">> {
  const doi = normalizeDoi(raw);
  if (!doi) throw new HttpError(400, "Keine gültige DOI (z. B. 10.1000/xyz123).");
  const key = doi.toLowerCase();
  const cached = one<{ item: string; fetched_at: number }>("SELECT item,fetched_at FROM doi_cache WHERE doi=?", key);
  if (cached && cached.fetched_at > Date.now() - DOI_CACHE_DAYS * 86400000) return JSON.parse(cached.item);
  const response = await fetcher(`https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`, {
    accept: "application/vnd.citationstyles.csl+json",
    maxBytes: 500_000,
    timeout: 10000,
  });
  if (response.status === 404) throw new HttpError(404, "Diese DOI ist nicht bekannt.");
  if (response.status !== 200 || !/json/i.test(response.type))
    throw new HttpError(502, "Die DOI konnte gerade nicht aufgelöst werden.");
  let item: CslItem | null = null;
  try {
    item = sanitizeItem(JSON.parse(response.body), "doi");
  } catch {
    item = null;
  }
  if (!item) throw new HttpError(502, "Die DOI-Daten sind unvollständig.");
  const { id: _, ...data } = { ...item, DOI: item.DOI || doi };
  run(
    "INSERT INTO doi_cache(doi,item,fetched_at) VALUES(?,?,?) ON CONFLICT(doi) DO UPDATE SET item=excluded.item,fetched_at=excluded.fetched_at",
    key,
    JSON.stringify(data),
    Date.now(),
  );
  return data;
}
// A resolved DOI in the bibliography: an existing entry with that DOI is
// reused, otherwise it gets a key like "mueller2021deep".
export function bibliographyForDoi(user: Identity, workspaceId: string, data: Omit<CslItem, "id">) {
  requireMember(user, workspaceId, "editor");
  const known = all<{ item: string }>("SELECT item FROM bibliography WHERE workspace_id=?", workspaceId)
    .map((r) => JSON.parse(r.item) as CslItem)
    .find((item) => item.DOI && data.DOI && item.DOI.toLowerCase() === data.DOI.toLowerCase());
  if (known) return known;
  const key = uniqueKey(suggestKey(data), (k) => !!one("SELECT 1 FROM bibliography WHERE workspace_id=? AND key=?", workspaceId, k));
  return addToBibliography(user, workspaceId, [{ ...data, id: key }]).items[0];
}
