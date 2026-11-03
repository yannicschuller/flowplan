"use client";
// What is folded and unfolded in the sidebar (#97): the keys of
// lib/sidebar-folds.ts, from the bootstrap (stored in the account), changed
// here at once and saved a moment later (command sidebar.state, only the
// changes). A copy stays on the device, so a cached bootstrap (switching
// workspaces) does not show an older state first.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./ui";
import { readCollapsedSpaces } from "@/lib/space-moves";
import { LEGACY_COLLECTIONS_FOLD_KEY } from "./collections-nav";
import {
  applySidebarChanges,
  legacyFoldChanges,
  newerSidebar,
  type StoredSidebar,
} from "@/lib/sidebar-folds";

const SAVE_DELAY = 800;
const cacheKey = (workspaceId: string) => `flowplan-sidebar:${workspaceId}`;
function readCache(workspaceId: string): StoredSidebar {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey(workspaceId)) || "null");
    return value && Array.isArray(value.keys) && typeof value.updatedAt === "number" ? value : null;
  } catch {
    return null;
  }
}
function writeCache(workspaceId: string, keys: readonly string[], updatedAt: number) {
  try {
    localStorage.setItem(cacheKey(workspaceId), JSON.stringify({ keys, updatedAt }));
  } catch {
    /* kept for this tab only */
  }
}
function legacyCollectionsFolded() {
  try {
    return localStorage.getItem(LEGACY_COLLECTIONS_FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

export function useSidebarFolds(workspaceId: string, server: StoredSidebar) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set(server?.keys || []));
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const pending = useRef<{ workspaceId: string; changes: Record<string, boolean> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When this tab last changed or received the state.
  const known = useRef(server?.updatedAt || 0);
  const workspaceRef = useRef(workspaceId);

  const flush = useCallback((keepalive = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const batch = pending.current;
    pending.current = null;
    if (!batch || !Object.keys(batch.changes).length) return;
    const body = { action: "sidebar.state", workspaceId: batch.workspaceId, changes: batch.changes };
    if (keepalive) {
      // Leaving the page: the request outlives it.
      void fetch("/api/command", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
      return;
    }
    void api<{ keys: string[]; updatedAt: number }>("/api/command", body)
      .then((saved) => {
        // The server's list (pruned); unless more changes came meanwhile.
        if (pending.current || batch.workspaceId !== workspaceRef.current) return;
        known.current = saved.updatedAt;
        writeCache(batch.workspaceId, saved.keys, saved.updatedAt);
      })
      .catch(() => {
        // Offline or refused: the device keeps its copy; tried again with the next change.
        const again = pending.current?.workspaceId === batch.workspaceId ? pending.current.changes : {};
        pending.current = { workspaceId: batch.workspaceId, changes: { ...batch.changes, ...again } };
      });
  }, []);

  const change = useCallback(
    (all: Record<string, boolean>) => {
      // Only what differs from now.
      const changes = Object.fromEntries(Object.entries(all).filter(([key, on]) => keysRef.current.has(key) !== on));
      if (!Object.keys(changes).length) return;
      const wid = workspaceRef.current;
      const next = new Set(applySidebarChanges([...keysRef.current], changes));
      keysRef.current = next;
      setKeys(next);
      const now = Date.now();
      known.current = now;
      writeCache(wid, [...next], now);
      if (pending.current && pending.current.workspaceId !== wid) flush();
      pending.current = { workspaceId: wid, changes: { ...(pending.current?.changes || {}), ...changes } };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(), SAVE_DELAY);
    },
    [flush],
  );

  // Another workspace (or the first render): the newer of the account's
  // state and this device's copy; with neither, what this device folded
  // before the state moved into the account.
  useEffect(() => {
    if (workspaceRef.current !== workspaceId) flush();
    workspaceRef.current = workspaceId;
    const chosen = newerSidebar(server, readCache(workspaceId));
    if (chosen) {
      known.current = chosen.updatedAt;
      const next = new Set(chosen.keys);
      keysRef.current = next;
      setKeys(next);
      return;
    }
    keysRef.current = new Set();
    setKeys(keysRef.current);
    const legacy = legacyFoldChanges(readCollapsedSpaces(), legacyCollectionsFolded());
    // (Spaces of other workspaces in that list drop out on the server.)
    change(legacy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // A fresh bootstrap with a newer state (another device folded something):
  // taken over unless this tab has unsaved changes.
  useEffect(() => {
    if (!server || pending.current || server.updatedAt <= known.current) return;
    known.current = server.updatedAt;
    writeCache(workspaceId, server.keys, server.updatedAt);
    const next = new Set(server.keys);
    keysRef.current = next;
    setKeys(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.updatedAt]);

  useEffect(() => {
    const leave = () => flush(true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      flush();
    };
  }, [flush]);

  return { keys, has: (key: string) => keys.has(key), change };
}
