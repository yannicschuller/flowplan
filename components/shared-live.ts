"use client";
import { serverMessage } from "@/lib/i18n-errors";
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
// with the server's projection (see lib/shared-live.ts) shortly after
// typing and whenever the push channel reports a change; the interval is
// the fallback when the channel is down.
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
  const clientId = useRef(crypto.randomUUID()).current;
  const live = useRef(false),
    lastRun = useRef(0),
    soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    runRef = useRef<() => unknown>(() => {});
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
        // Sent shortly after typing instead of on the next interval.
        if (!soon.current)
          soon.current = setTimeout(() => {
            soon.current = undefined;
            void runRef.current();
          }, 100);
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
      if (!response.ok) throw new Error(serverMessage(result.error));
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
    lastRun.current = Date.now();
    if (!inflight.current)
      inflight.current = sync().finally(() => {
        inflight.current = null;
      });
    return inflight.current;
  }, [sync]);
  runRef.current = run;
  useEffect(() => {
    if (!active) return;
    pgen.current = "";
    dirty.current = false;
    void run();
    // With the push channel open a full check every 10 s is enough.
    const timer = setInterval(() => {
      if (!live.current || dirty.current || Date.now() - lastRun.current > 10_000) void run();
    }, 1200);
    const params = new URLSearchParams({ pageId, client: clientId });
    if (rowId) params.set("rowId", rowId);
    const source = typeof EventSource === "undefined" ? null : new EventSource(`/api/share/${token}/live?${params}`);
    if (source) {
      source.onmessage = (event) => {
        let type = "";
        try {
          type = JSON.parse(event.data).type;
        } catch {
          return;
        }
        if (type === "ready") live.current = true;
        else if (type === "check") void run();
        else if (type === "presence")
          window.dispatchEvent(new CustomEvent("flowplan:presence", { detail: `guest:${pageId}:${rowId || ""}` }));
        else if (type === "revoked") {
          live.current = false;
          source.close();
        }
      };
      source.onerror = () => {
        live.current = false;
      };
    }
    return () => {
      source?.close();
      live.current = false;
      clearTimeout(soon.current);
      soon.current = undefined;
      clearInterval(timer);
      current.current?.destroy();
      current.current = null;
      setDoc(null);
    };
  }, [active, run, token, pageId, rowId, clientId]);
  // Sends pending changes before saving the title or properties.
  const flush = useCallback(async () => {
    if (inflight.current) await inflight.current;
    for (let i = 0; i < 5 && dirty.current; i++) await run();
    if (failure.current) throw new Error(failure.current);
  }, [run]);
  return { doc, docKey, state, error, flush, clientId };
}
