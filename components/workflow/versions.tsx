"use client";
// The versions of a workflow (docs/specs/workflows.md §3, §10.5): the
// activated versions and the draft states in one timeline; one opened shows
// its graph and what differs from the current draft (nodes added, removed,
// changed with their settings before and after) and can become the draft –
// never the active version directly.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { api } from "../ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { workflowGraphSchema, type WorkflowGraph } from "@/lib/workflows/graph";
import { graphDiff, diffSize, typeName, type Person, useStableT, type T } from "./model";

type Versions = {
  versions: { id: string; number: number; activatedBy: Person | null; activated_at: number; note: string }[];
  drafts: { id: string; createdAt: string; createdBy: Person | null }[];
};
type Entry = { id: string; kind: "version" | "draft"; at: number; who: string; title: string; note?: string };

const parse = (g: unknown): WorkflowGraph => {
  const r = workflowGraphSchema.safeParse(g);
  return r.success ? r.data : (g as WorkflowGraph);
};
const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

export function VersionsView({
  pageId,
  current,
  activeId,
  canRestore,
  onRestored,
  onError,
  renderGraph,
}: {
  pageId: string;
  // The draft (editors) or the active version (readers) to compare with.
  current: WorkflowGraph | null;
  activeId: string | null;
  canRestore: boolean;
  onRestored: () => void;
  onError: (e: unknown) => void;
  renderGraph: (graph: WorkflowGraph, marks: Map<string, "added" | "changed">) => ReactNode;
}) {
  const t = useStableT();
  const [data, setData] = useState<Versions | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api<Versions>(`/api/workflows/${pageId}/versions`)
      .then((d) => live && setData(d))
      .catch((e) => live && onError(e));
    return () => {
      live = false;
    };
  }, [pageId, onError]);
  useEffect(() => {
    setGraph(null);
    if (!open) return;
    let live = true;
    void api<{ graph: unknown }>(`/api/workflows/${pageId}/versions/${open}`)
      .then((v) => live && setGraph(parse(v.graph)))
      .catch((e) => live && onError(e));
    return () => {
      live = false;
    };
  }, [open, pageId, onError]);
  const time = new Intl.DateTimeFormat(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" });
  const entries = useMemo<Entry[]>(() => {
    if (!data) return [];
    const v: Entry[] = data.versions.map((x) => ({
      id: x.id,
      kind: "version",
      at: x.activated_at,
      who: x.activatedBy?.name || "",
      title: t(`Version ${x.number}${x.id === activeId ? " · aktiv" : ""}`, `Version ${x.number}${x.id === activeId ? " · active" : ""}`),
      note: x.note,
    }));
    const d: Entry[] = data.drafts.map((x) => ({ id: x.id, kind: "draft", at: Date.parse(x.createdAt.includes("T") ? x.createdAt : `${x.createdAt.replace(" ", "T")}Z`), who: x.createdBy?.name || "", title: t("Entwurfsstand", "Draft state") }));
    return [...v, ...d].sort((a, b) => b.at - a.at);
  }, [data, activeId, t]);
  const diff = useMemo(() => (graph && current ? graphDiff(graph, current) : null), [graph, current]);
  const marks = useMemo(() => new Map<string, "added" | "changed">(), []);
  if (!data) return <p className="muted">{t("Versionen werden geladen …", "Loading versions …")}</p>;
  return (
    <section className="wf-versions" aria-label={t("Versionen", "Versions")}>
      <ol className="wf-version-list">
        {entries.map((e) => (
          <li key={e.id}>
            <button type="button" className={open === e.id ? "chosen" : ""} aria-pressed={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <strong>{e.title}</strong>
              <span className="muted">
                {Number.isFinite(e.at) ? time.format(new Date(e.at)) : ""}
                {e.who ? ` · ${e.who}` : ""}
              </span>
              {e.note && <span className="wf-version-note">{e.note}</span>}
            </button>
          </li>
        ))}
        {!entries.length && <li className="muted">{t("Noch keine Versionen.", "No versions yet.")}</li>}
      </ol>
      {open && (
        <div className="wf-version-detail">
          {!graph ? (
            <p className="muted">{t("Wird geladen …", "Loading …")}</p>
          ) : (
            <>
              {diff && <DiffList diff={diff} t={t} />}
              {canRestore && (
                <button
                  type="button"
                  className="button compact"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api("/api/command", { action: "workflow.restore", pageId, versionId: open });
                      onRestored();
                    } catch (e) {
                      onError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <ArrowCounterClockwise /> {t("Als Entwurf wiederherstellen", "Restore as the draft")}
                </button>
              )}
              <div className="wf-version-graph">{renderGraph(graph, marks)}</div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// What changed from a state to the current draft.
export function DiffList({ diff, t }: { diff: ReturnType<typeof graphDiff>; t: T }) {
  if (!diffSize(diff)) return <p className="muted">{t("Gleich wie der aktuelle Stand.", "Same as the current state.")}</p>;
  return (
    <div className="wf-diff">
      <p className="muted small">{t("Bis zum aktuellen Stand:", "Up to the current state:")}</p>
      <ul>
        {diff.added.map((n) => (
          <li key={n.id} className="wf-diff-added">
            <span className="wf-diff-mark" aria-hidden>
              +
            </span>
            <span className="sr-only">{t("Hinzugefügt: ", "Added: ")}</span>
            <strong>{n.label}</strong> · {typeName(n.type, t)}
          </li>
        ))}
        {diff.removed.map((n) => (
          <li key={n.id} className="wf-diff-removed">
            <span className="wf-diff-mark" aria-hidden>
              −
            </span>
            <span className="sr-only">{t("Entfernt: ", "Removed: ")}</span>
            <strong>{n.label}</strong> · {typeName(n.type, t)}
          </li>
        ))}
        {diff.changed.map((c) => (
          <li key={c.node.id} className="wf-diff-changed">
            <span className="wf-diff-mark" aria-hidden>
              ~
            </span>
            <span className="sr-only">{t("Geändert: ", "Changed: ")}</span>
            <strong>{c.node.label}</strong>
            <dl>
              {c.keys.slice(0, 8).map((k) => (
                <div key={k.key}>
                  <dt>{k.key}</dt>
                  <dd>
                    <del>{short(k.before)}</del> → <ins>{short(k.after)}</ins>
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
        {(diff.edgesAdded > 0 || diff.edgesRemoved > 0) && (
          <li className="muted">
            {t(`Verbindungen: ${diff.edgesAdded} neu, ${diff.edgesRemoved} entfernt`, `Connections: ${diff.edgesAdded} new, ${diff.edgesRemoved} removed`)}
          </li>
        )}
      </ul>
    </div>
  );
}
