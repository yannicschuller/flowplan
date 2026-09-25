"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";

const to64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const from64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// Live editing through a share link: the guest's Yjs document is exchanged
// with the server's projection every 1.2 seconds (see lib/shared-live.ts).
export function useSharedLive({
  token,
  pageId,
  rowId,
  active,
  onVersion,
}: {
  token: string;
  pageId: string;
  rowId?: string;
  active: boolean;
  onVersion: (version: string) => void;
}) {
  const [doc, setDoc] = useState<Y.Doc | null>(null),
    [docKey, setDocKey] = useState(0),
    [state, setState] = useState<"connecting" | "saving" | "saved" | "error">(
      "connecting",
    ),
    [error, setError] = useState("");
  const current = useRef<Y.Doc | null>(null),
    pgen = useRef(""),
    dirty = useRef(false),
    inflight = useRef<Promise<void> | null>(null),
    failure = useRef(""),
    versionRef = useRef(onVersion);
  versionRef.current = onVersion;
  const attach = useCallback((next: Y.Doc) => {
    next.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") {
        dirty.current = true;
        setState("saving");
      }
    });
    current.current?.destroy();
    current.current = next;
    setDoc(next);
    setDocKey((k) => k + 1);
  }, []);
  const sync = useCallback(async () => {
    const d = current.current;
    const send = !!d && dirty.current && !!pgen.current;
    dirty.current = false;
    try {
      const response = await fetch(`/api/share/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "live",
          pageId,
          rowId,
          pgen: pgen.current || undefined,
          ...(d ? { vector: to64(Y.encodeStateVector(d)) } : {}),
          ...(send ? { update: to64(Y.encodeStateAsUpdate(d!)) } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.reset || !pgen.current || !d) {
        // A new projection (first load or restored version) replaces the doc.
        const next = new Y.Doc();
        Y.applyUpdate(next, from64(result.update), "remote");
        pgen.current = result.pgen;
        attach(next);
      } else Y.applyUpdate(d, from64(result.update), "remote");
      versionRef.current(result.version);
      failure.current = "";
      setError("");
      setState(dirty.current ? "saving" : "saved");
    } catch (e) {
      failure.current = (e as Error).message;
      setError(failure.current);
      setState("error");
    }
  }, [token, pageId, rowId, attach]);
  const run = useCallback(() => {
    if (!inflight.current)
      inflight.current = sync().finally(() => {
        inflight.current = null;
      });
    return inflight.current;
  }, [sync]);
  useEffect(() => {
    if (!active) return;
    pgen.current = "";
    dirty.current = false;
    void run();
    const timer = setInterval(() => void run(), 1200);
    return () => {
      clearInterval(timer);
      current.current?.destroy();
      current.current = null;
      setDoc(null);
    };
  }, [active, run]);
  // Sends pending changes before saving the title or properties.
  const flush = useCallback(async () => {
    if (inflight.current) await inflight.current;
    for (let i = 0; i < 5 && dirty.current; i++) await run();
    if (failure.current) throw new Error(failure.current);
  }, [run]);
  return { doc, docKey, state, error, flush };
}
