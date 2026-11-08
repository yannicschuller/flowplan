"use client";
// The draft of a workflow as a live Yjs document (lib/workflows/draft.ts),
// exchanged with the server like a whiteboard (components/whiteboard):
// `workflow.sync` every second with the own changes since the last answer
// and the state vector, so the answer holds only what others changed.
// The people editing along come back with every answer (presence).
// Edits go through `change(graph => graph)`: the new graph is written into
// the document as changes (writeGraph), undo and redo cover only the own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { api } from "../ui";
import { draftGraph, writeGraph } from "@/lib/workflows/draft";
import type { WorkflowGraph } from "@/lib/workflows/graph";

const to64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const from64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const LOCAL = "local";

export type SaveState = "saved" | "pending" | "saving" | "failed" | "offline";
export type Presence = { user_id: string; name: string };

export function useWorkflowDraft(input: { pageId: string; state: string; generation: string; editable: boolean; onReload: () => void; onError: (message: string) => void }) {
  const { pageId, generation, editable, onReload, onError } = input;
  const doc = useMemo(() => {
    const d = new Y.Doc();
    try {
      Y.applyUpdate(d, from64(input.state), "remote");
    } catch {}
    return d;
    // The document belongs to this page and generation (the key of the view).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, generation]);
  const [graph, setGraph] = useState<WorkflowGraph>(() => draftGraph(doc));
  const [save, setSave] = useState<SaveState>("saved");
  const [presence, setPresence] = useState<Presence[]>([]);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const dirty = useRef(false),
    inflight = useRef(false),
    lastVector = useRef<Uint8Array>(Y.encodeStateVector(doc));
  // Made in an effect (not during render): React may run effects twice and
  // a destroyed manager would track nothing.
  const undoRef = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setGraph(draftGraph(doc)));
    };
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      update();
      if (origin !== "remote") {
        dirty.current = true;
        setSave("pending");
      }
    };
    const undo = new Y.UndoManager([doc.getMap("nodes"), doc.getMap("edges"), doc.getMap("settings")], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
    undoRef.current = undo;
    const stack = () => setHistory({ undo: undo.undoStack.length > 0, redo: undo.redoStack.length > 0 });
    doc.on("update", onUpdate);
    undo.on("stack-item-added", stack);
    undo.on("stack-item-popped", stack);
    return () => {
      cancelAnimationFrame(frame);
      doc.off("update", onUpdate);
      undo.destroy();
      if (undoRef.current === undo) undoRef.current = null;
    };
  }, [doc]);

  const sync = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const send = editable && dirty.current;
    const vector = Y.encodeStateVector(doc);
    const update = send ? Y.encodeStateAsUpdate(doc, lastVector.current) : null;
    if (send) {
      dirty.current = false;
      setSave("saving");
    }
    try {
      const result = await api<{ state: string; presence: (Presence & { x: number; y: number })[] }>("/api/command", {
        action: "workflow.sync",
        pageId,
        generation,
        vector: to64(vector),
        ...(update ? { update: to64(update) } : {}),
        // Present while the page is open (the position is not used here).
        ...(editable ? { cursor: document.visibilityState === "visible" ? { x: 0, y: 0 } : null } : {}),
      });
      Y.applyUpdate(doc, from64(result.state), "remote");
      if (send) lastVector.current = vector;
      setPresence(result.presence.map((p) => ({ user_id: p.user_id, name: p.name })));
      setSave(dirty.current ? "pending" : "saved");
    } catch (e) {
      if (send) dirty.current = true;
      const status = (e as { status?: number }).status;
      // A new generation of the draft (restored, replaced): load it again.
      if (status === 409) onReload();
      else {
        setSave(navigator.onLine ? "failed" : "offline");
        if (navigator.onLine && send) onError((e as Error).message);
      }
    } finally {
      inflight.current = false;
    }
  }, [doc, editable, generation, onError, onReload, pageId]);
  useEffect(() => {
    void sync();
    const timer = setInterval(() => void sync(), 1000);
    const leave = () => {
      if (!editable || !dirty.current) return;
      const body = JSON.stringify({ action: "workflow.sync", pageId, generation, update: to64(Y.encodeStateAsUpdate(doc, lastVector.current)), cursor: null });
      void fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 }).catch(() => {});
    };
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [sync, doc, editable, generation, pageId]);

  // An edit: the next graph from the current one, written as changes.
  const change = useCallback(
    (fn: (graph: WorkflowGraph) => WorkflowGraph) => {
      if (!editable) return;
      const next = fn(draftGraph(doc));
      doc.transact(() => writeGraph(doc, next), LOCAL);
      // At once (not on the next frame): controlled fields keep their caret.
      setGraph(draftGraph(doc));
    },
    [doc, editable],
  );
  // Writes now (before a test run or activation reads the stored draft).
  const flush = useCallback(async () => {
    for (let i = 0; i < 20 && inflight.current; i++) await new Promise((r) => setTimeout(r, 100));
    if (dirty.current) await sync();
  }, [sync]);
  return {
    doc,
    graph,
    save,
    presence,
    change,
    flush,
    canUndo: history.undo,
    canRedo: history.redo,
    undo: () => void undoRef.current?.undo(),
    redo: () => void undoRef.current?.redo(),
    // Starts a new undo step for the next edit.
    stopCapturing: () => undoRef.current?.stopCapturing(),
  };
}
export type Draft = ReturnType<typeof useWorkflowDraft>;
