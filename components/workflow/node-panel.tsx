"use client";
// The side panel of the selected node (docs/specs/workflows.md §10.2): name,
// the check's findings for it, its settings (config-form.tsx), "on error",
// a note, and the input and output of the last test run.
import { useEffect, useId, useState } from "react";
import { Lightning, Trash, X, Warning, WarningCircle } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { Select } from "../select";
import { isTrigger, nodeSpec } from "@/lib/workflows/catalog";
import { labelSchema, type WorkflowGraph, type WorkflowNode } from "@/lib/workflows/graph";
import { ConfigForm } from "./config-form";
import { duration, issuesOf, specName, type Issue, type TimelineStep, type Workspace, useStableT } from "./model";
import { NodeIcon } from "./node-icon";
import { runsInlineHere } from "./node-card";
import type { DatabaseInfo } from "./use-databases";

export function NodePanel({
  pageId,
  graph,
  node,
  ws,
  databases,
  issues,
  step,
  values,
  editable,
  onChange,
  onDelete,
  onClose,
}: {
  pageId?: string;
  graph: WorkflowGraph;
  node: WorkflowNode;
  ws: Workspace;
  databases: Map<string, DatabaseInfo>;
  issues: Issue[];
  // The node's step in the shown test run or run, if any.
  step: TimelineStep | null;
  values: Map<string, unknown>;
  editable: boolean;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useStableT();
  const locale = useLocale();
  const spec = nodeSpec(node.type);
  const labelId = useId(),
    noteId = useId(),
    retryId = useId(),
    thenId = useId();
  const [label, setLabel] = useState(node.label);
  useEffect(() => setLabel(node.label), [node.label]);
  const labelOk = labelSchema.safeParse(label).success;
  const own = issuesOf(issues, node.id);
  const trigger = graph.nodes.find((n) => isTrigger(n.type) && typeof n.config.database === "string");
  const branch = !!spec && spec.ports(node.config).some((p) => p !== "out");
  return (
    <aside className="wf-panel" aria-labelledby={`${labelId}-title`}>
      <header className="wf-panel-head">
        <NodeIcon type={node.type} />
        <div>
          <h2 id={`${labelId}-title`}>{node.label}</h2>
          <p className="muted">
            {specName(spec, t)}
            {runsInlineHere(graph, node) && (
              <span className="wf-inline-badge" title={t("Läuft sofort beim Speichern des Eintrags mit", "Runs right away when the record is saved")}>
                <Lightning weight="fill" aria-hidden /> {t("Sofortteil", "Immediate")}
              </span>
            )}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label={t("Panel schließen", "Close the panel")} onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="wf-panel-body">
        {spec && <p className="muted small">{t(spec.description[0], spec.description[1])}</p>}
        {own.length > 0 && (
          <ul className="wf-issues" aria-label={t("Prüfung", "Check")}>
            {own.map((i, n) => (
              <li key={n} className={i.level}>
                {i.level === "error" ? <WarningCircle weight="fill" aria-hidden /> : <Warning aria-hidden />}
                <span>
                  <span className="sr-only">{i.level === "error" ? t("Fehler: ", "Error: ") : t("Warnung: ", "Warning: ")}</span>
                  {i.message}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={labelId}>
            {t("Bezeichnung", "Label")}
          </label>
          <input
            id={labelId}
            value={label}
            disabled={!editable}
            maxLength={60}
            aria-invalid={!labelOk || undefined}
            aria-describedby={!labelOk ? `${labelId}-error` : undefined}
            onChange={(e) => {
              setLabel(e.target.value);
              if (labelSchema.safeParse(e.target.value).success) onChange({ ...node, label: e.target.value.trim() });
            }}
          />
          {!labelOk && (
            <small className="wf-field-error" id={`${labelId}-error`}>
              {t("1–60 Zeichen, ohne . | { } [ ]", "1–60 characters, without . | { } [ ]")}
            </small>
          )}
        </div>
        <ConfigForm
          ctx={{ pageId, node, ws, databases, picker: { graph, nodeId: node.id, ws, values }, triggerDatabase: (trigger?.config.database as string) || null, disabled: !editable }}
          onChange={(config) => onChange({ ...node, config })}
        />
        {!isTrigger(node.type) && (
          <fieldset className="wf-group">
            <legend>{t("Bei Fehler", "On error")}</legend>
            <div className="wf-inline">
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={retryId}>
                  {t("Wiederholen", "Retries")}
                </label>
                <input
                  id={retryId}
                  type="number"
                  className="wf-number"
                  min={0}
                  max={5}
                  value={node.onError?.retry ?? 0}
                  disabled={!editable}
                  onChange={(e) => onChange({ ...node, onError: { then: node.onError?.then || "fail", retry: Math.max(0, Math.min(5, Number(e.target.value) || 0)) } })}
                />
              </div>
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={thenId}>
                  {t("Danach", "Then")}
                </label>
                <Select
                  id={thenId}
                  value={node.onError?.then || "fail"}
                  disabled={!editable}
                  onChange={(e) => onChange({ ...node, onError: { retry: node.onError?.retry ?? 0, then: e.target.value as "fail" | "port" | "continue" } })}
                >
                  <option value="fail">{t("Lauf abbrechen", "Fail the run")}</option>
                  <option value="port">{t("Über den Ausgang „Fehler“ weiter", "Continue through the “Error” output")}</option>
                  <option value="continue">{t("Fehler übergehen", "Ignore the error")}</option>
                </Select>
              </div>
            </div>
            {!branch && (
              <label className="wf-check">
                <input type="checkbox" checked={!!node.disabled} disabled={!editable} onChange={(e) => onChange({ ...node, disabled: e.target.checked })} />
                <span>{t("Abgeschaltet (wird übersprungen)", "Switched off (skipped)")}</span>
              </label>
            )}
          </fieldset>
        )}
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={noteId}>
            {t("Notiz", "Note")}
          </label>
          <textarea id={noteId} rows={2} value={node.note || ""} maxLength={2000} disabled={!editable} onChange={(e) => onChange({ ...node, note: e.target.value })} />
        </div>
        {step && (
          <details className="wf-io" open>
            <summary>
              {t("Ein- und Ausgabe des Laufs", "Input and output of the run")} · {stepStatus(step.status, t)}
              {step.startedAt && step.finishedAt ? ` · ${duration(step.finishedAt - step.startedAt, locale)}` : ""}
            </summary>
            {step.error && <p className="wf-step-error">{step.error}</p>}
            {step.input?.config !== undefined && (
              <>
                <h3>{t("Eingabe", "Input")}</h3>
                <pre>{JSON.stringify(step.input.config, null, 2)}</pre>
              </>
            )}
            {step.input?.warnings?.length ? <p className="muted">{step.input.warnings.join(" · ")}</p> : null}
            {step.output !== null && step.output !== undefined && (
              <>
                <h3>{t("Ausgabe", "Output")}</h3>
                <pre>{JSON.stringify(step.output, null, 2)}</pre>
              </>
            )}
          </details>
        )}
        {editable && (
          <button type="button" className="button compact danger" onClick={onDelete}>
            <Trash /> {t("Knoten löschen", "Delete the node")}
          </button>
        )}
      </div>
    </aside>
  );
}

// i18n-table: 1 – [German, English] pairs (step and run states)
export const STATUS_TEXT: Record<string, [string, string]> = {
  queued: ["Wartet", "Queued"],
  running: ["Läuft", "Running"],
  waiting: ["Wartet", "Waiting"],
  held: ["Angehalten", "Held"],
  succeeded: ["Erfolgreich", "Succeeded"],
  failed: ["Fehlgeschlagen", "Failed"],
  cancelled: ["Abgebrochen", "Cancelled"],
  skipped: ["Übersprungen", "Skipped"],
};
export const stepStatus = (s: string, t: (de: string, en: string) => string) => (STATUS_TEXT[s] ? t(STATUS_TEXT[s][0], STATUS_TEXT[s][1]) : s);
