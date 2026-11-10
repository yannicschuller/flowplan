"use client";
// The pages of the notebook's workspace for the pickers of the overview
// (lib/notebook-organize.ts notebookPeers): notebooks to copy or move
// sheets into, pages a link may point to. Loaded once when first needed.
import { useEffect, useState } from "react";
import { api } from "../ui";

export type NotebookPeer = { id: string; title: string; kind: string; icon: string | null; parentId: string | null; writable: boolean };

const cache = new Map<string, { at: number; promise: Promise<NotebookPeer[]> }>();
export function loadPeers(pageId: string) {
  const hit = cache.get(pageId);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = api<{ pages: NotebookPeer[] }>(`/api/pages/${pageId}/notebook?part=peers`).then((r) => r.pages);
  cache.set(pageId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(pageId));
  return promise;
}
export function usePeers(pageId: string, wanted: boolean) {
  const [peers, setPeers] = useState<NotebookPeer[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    loadPeers(pageId)
      .then((list) => alive && setPeers(list))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [pageId, wanted]);
  return { peers, error };
}
// "Parent / Child" for a page in a list.
export function peerPath(peers: NotebookPeer[], peer: NotebookPeer) {
  const byId = new Map(peers.map((p) => [p.id, p]));
  const names: string[] = [];
  let at: NotebookPeer | undefined = peer;
  const seen = new Set<string>();
  while (at && !seen.has(at.id) && names.length < 4) {
    seen.add(at.id);
    names.unshift(at.title || "…");
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return names.join(" / ");
}
