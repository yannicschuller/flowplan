"use client";
// Runs of a workflow (docs/specs/workflows.md §10.4): the list with
// filters, and one run – its graph (the pinned version, or the draft of a
// test) with the state of every node, the steps in order with attempts,
// durations and errors, and their input and output where the person may
// see them (§9.3). Open runs can be cancelled; "retry from" comes later.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Clock, MinusCircle, X } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { api } from "../ui";
import { StatusBadge, type Tone } from "../settings-ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { WorkflowGraph } from "@/lib/workflows/graph";
import { duration, OPEN_RUN, type RunDetail, type RunSummary, type TimelineStep, useStableT } from "./model";
import { stepStatus } from "./node-panel";
import type { NodeStatus } from "./canvas";

export const runTone = (status: string): Tone => (status === "succeeded" ? "ok" : status === "failed" ? "error" : status === "cancelled" ? "off" : "info");
const ICON: Record<string, typeof Check> = { succeeded: Check, failed: X, cancelled: MinusCircle };

// The state of each node in a run: its last step.
export function stepStatuses(steps: TimelineStep[], locale: string): Map<string, NodeStatus> {
  const out = new Map<string, NodeStatus>();
  for (const s of steps) out.set(s.nodeId, { status: s.status, duration: s.startedAt && s.finishedAt ? duration(s.finishedAt - s.startedAt, locale as never) : "" });
  return out;
}

export function useRun(runId: string | null, onError: (e: unknown) => void) {
  const [run, setRun] = useState<RunDetail | null>(null);
  useEffect(() => {
    setRun(null);
    if (!runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await api<RunDetail>(`/api/workflow-runs/${runId}`);
        if (!live) return;
        setRun(r);
        if (OPEN_RUN.has(r.status)) timer = setTimeout(load, 700);
      } catch (e) {
        if (live) onError(e);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runId, onError]);
  return run;
}

// i18n-table: 2 – [value, German, English]
const FILTERS = [
  ["", "Alle", "All"],
  ["failed", "Fehlgeschlagen", "Failed"],
  ["open", "Offen", "Open"],
  ["test", "Tests", "Tests"],
] as const;

export function RunList({ pageId, graph, onOpen, onError }: { pageId: string; graph: WorkflowGraph | null; onOpen: (id: string) => void; onError: (e: unknown) => void }) {
  const t = useStableT();
  const locale = useLocale();
  const [filter, setFilter] = useState("");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const load = useCallback(async () => {
    const q = filter === "test" ? "mode=test" : filter ? `status=${filter}` : "";
    try {
      setRuns((await api<{ runs: RunSummary[] }>(`/api/workflows/${pageId}/runs?limit=100${q ? `&${q}` : ""}`)).runs);
    } catch (e) {
      onError(e);
    }
  }, [filter, pageId, onError]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const labels = new Map((graph?.nodes || []).map((n) => [n.id, n.label]));
  const time = new Intl.DateTimeFormat(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" });
  return (
    <section className="wf-runs" aria-label={t("Läufe", "Runs")}>
      <div className="wf-filter" role="group" aria-label={t("Filter", "Filter")}>
        {FILTERS.map(([v, de, en]) => (
          <button key={v} type="button" className={`button compact${filter === v ? " chosen" : ""}`} aria-pressed={filter === v} onClick={() => setFilter(v)}>
            {t(de, en)}
          </button>
        ))}
      </div>
      {runs === null ? (
        <p className="muted">{t("Läufe werden geladen …", "Loading runs …")}</p>
      ) : !runs.length ? (
        <p className="muted wf-empty">{filter ? t("Keine Läufe mit diesem Filter.", "No runs with this filter.") : t("Noch keine Läufe. Ein Testlauf oder das erste Ereignis erscheint hier.", "No runs yet. A test run or the first event shows up here.")}</p>
      ) : (
        <ul className="wf-run-list">
          {runs.map((r) => {
            const I = ICON[r.status] || Clock;
            return (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id)}>
                  <span className={`wf-run-icon status-${r.status}`}>
                    <I weight="bold" aria-hidden />
                  </span>
                  <span className="wf-run-main">
                    <strong>{time.format(new Date(r.createdAt))}</strong>
                    <span className="muted">
                      {labels.get(r.triggerNodeId) || t("Auslöser", "Trigger")}
                      {r.error ? ` · ${r.error}` : ""}
                    </span>
                  </span>
                  <span className="wf-run-meta">
                    <StatusBadge tone={runTone(r.status)}>{stepStatus(r.status, t)}</StatusBadge>
                    <span className="muted">
                      {r.mode === "test" ? t("Testlauf", "Test run") : r.mode === "dry" ? t("Probelauf", "Dry run") : r.version ? `v${r.version}` : ""}
                      {r.startedAt && r.finishedAt ? ` · ${duration(r.finishedAt - r.startedAt, locale)}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function RunView({
  runId,
  canEdit,
  onBack,
  onError,
  renderGraph,
}: {
  runId: string;
  canEdit: boolean;
  onBack: () => void;
  onError: (e: unknown) => void;
  renderGraph: (graph: WorkflowGraph, statuses: Map<string, NodeStatus>, selected: string | null, onSelect: (id: string | null) => void) => ReactNode;
}) {
  const t = useStableT();
  const locale = useLocale();
  const run = useRun(runId, onError);
  const [selected, setSelected] = useState<string | null>(null);
  const statuses = useMemo(() => stepStatuses(run?.timeline || [], locale), [run, locale]);
  const time = new Intl.DateTimeFormat(LOCALE_TAG, { dateStyle: "medium", timeStyle: "medium" });
  if (!run) return <p className="muted">{t("Lauf wird geladen …", "Loading the run …")}</p>;
  const labels = new Map(run.graph.nodes.map((n) => [n.id, n.label]));
  const steps = selected ? run.timeline.filter((s) => s.nodeId === selected) : run.timeline;
  return (
    <section className="wf-run" aria-label={t("Lauf", "Run")}>
      <div className="wf-run-head">
        <button type="button" className="button compact" onClick={onBack}>
          <ArrowLeft /> {t("Alle Läufe", "All runs")}
        </button>
        <StatusBadge tone={runTone(run.status)}>{stepStatus(run.status, t)}</StatusBadge>
        <span className="muted">
          {run.mode === "test" ? t("Testlauf", "Test run") : run.mode === "dry" ? t("Probelauf", "Dry run") : t("Echter Lauf", "Live run")}
          {" · "}
          {time.format(new Date(run.createdAt))}
          {run.startedAt && run.finishedAt ? ` · ${duration(run.finishedAt - run.startedAt, locale)}` : ""}
          {run.runner ? t(` · als ${run.runner.name}`, ` · as ${run.runner.name}`) : ""}
        </span>
        {canEdit && OPEN_RUN.has(run.status) && (
          <button
            type="button"
            className="button compact"
            onClick={async () => {
              try {
                await api("/api/command", { action: "workflow.run.cancel", runId: run.id });
              } catch (e) {
                onError(e);
              }
            }}
          >
            {t("Abbrechen", "Cancel")}
          </button>
        )}
      </div>
      {run.error && <p className="wf-step-error">{run.error}</p>}
      {run.origin && <p className="muted">{t(`Ausgelöst von einem Lauf in „${run.origin.title || "…"}“`, `Triggered by a run in “${run.origin.title || "…"}”`)}</p>}
      {!run.contentsVisible && <p className="muted">{t("Ein- und Ausgaben sieht nur, wer den Workflow bearbeiten darf.", "Only people who may edit the workflow see inputs and outputs.")}</p>}
      <div className="wf-run-body">
        <div className="wf-run-graph">{renderGraph(run.graph, statuses, selected, setSelected)}</div>
        <ol className="wf-timeline" aria-label={t("Schritte", "Steps")}>
          {selected && (
            <li>
              <button type="button" className="text-button" onClick={() => setSelected(null)}>
                {t("Alle Schritte zeigen", "Show all steps")}
              </button>
            </li>
          )}
          {steps.map((s) => (
            <li key={s.id} className={`status-${s.status}`}>
              <details>
                <summary>
                  <strong>{labels.get(s.nodeId) || s.nodeId}</strong>
                  <span className="muted">
                    {" "}
                    · {stepStatus(s.status, t)}
                    {s.attempt > 0 ? t(` · Versuch ${s.attempt + 1}`, ` · attempt ${s.attempt + 1}`) : ""}
                    {s.startedAt && s.finishedAt ? ` · ${duration(s.finishedAt - s.startedAt, locale)}` : ""}
                  </span>
                </summary>
                {s.error && <p className="wf-step-error">{s.error}</p>}
                {s.input?.config !== undefined && (
                  <>
                    <h3>{t("Eingabe", "Input")}</h3>
                    <pre>{JSON.stringify(s.input.config, null, 2)}</pre>
                  </>
                )}
                {s.output !== null && s.output !== undefined && (
                  <>
                    <h3>{t("Ausgabe", "Output")}</h3>
                    <pre>{JSON.stringify(s.output, null, 2)}</pre>
                  </>
                )}
              </details>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
