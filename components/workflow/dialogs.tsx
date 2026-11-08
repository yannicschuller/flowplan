"use client";
// The dialogs of the editor: activating (check and summary, §9.1/§10.2),
// starting a test or dry run with its data (§10.3), connecting a node by
// keyboard ("C") and appending one ("A", "+" on a connection).
import { useEffect, useId, useMemo, useState } from "react";
import { Lightning, Warning, WarningCircle } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { Modal, api } from "../ui";
import { Select } from "../select";
import { isTrigger, nodeSpec } from "@/lib/workflows/catalog";
import { nodePorts, outgoing, type WorkflowGraph } from "@/lib/workflows/graph";
import { displayContext, nodeSummary, portLabel, typeName, type Issue, type Person, type Workspace, useStableT } from "./model";
import { Palette } from "./palette";
import { PageSelect } from "./config-form";
import { inlineNodes } from "./node-card";
import type { DatabaseInfo } from "./use-databases";

function IssueList({ issues, labels, onPick }: { issues: Issue[]; labels: Map<string, string>; onPick?: (nodeId: string) => void }) {
  const t = useStableT();
  if (!issues.length) return null;
  return (
    <ul className="wf-issues">
      {issues.map((i, n) => (
        <li key={n} className={i.level}>
          {i.level === "error" ? <WarningCircle weight="fill" aria-hidden /> : <Warning aria-hidden />}
          <span>
            <span className="sr-only">{i.level === "error" ? t("Fehler: ", "Error: ") : t("Warnung: ", "Warning: ")}</span>
            {i.nodeId && labels.get(i.nodeId) ? (
              onPick ? (
                <button type="button" className="link-button" onClick={() => onPick(i.nodeId!)}>
                  {labels.get(i.nodeId)}
                </button>
              ) : (
                <strong>{labels.get(i.nodeId)}</strong>
              )
            ) : null}
            {i.nodeId && labels.get(i.nodeId) ? ": " : ""}
            {i.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ActivateDialog({
  open,
  pageId,
  graph,
  ws,
  me,
  runner,
  flush,
  onClose,
  onDone,
  onPick,
  onError,
}: {
  open: boolean;
  pageId: string;
  graph: WorkflowGraph;
  ws: Workspace;
  me: Person;
  runner: Person | null;
  flush: () => Promise<void>;
  onClose: () => void;
  onDone: () => void;
  onPick: (nodeId: string) => void;
  onError: (e: unknown) => void;
}) {
  const t = useStableT();
  const locale = useLocale();
  const noteId = useId();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setIssues(null);
    setNote("");
    let live = true;
    void (async () => {
      try {
        await flush();
        const r = await api<{ issues: Issue[] }>("/api/command", { action: "workflow.validate", pageId });
        if (live) setIssues(r.issues);
      } catch (e) {
        if (live) onError(e);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageId]);
  const ctx = useMemo(() => displayContext(graph, locale, ws), [graph, locale, ws]);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const triggers = graph.nodes.filter((n) => isTrigger(n.type) && !n.disabled);
  const writes = graph.nodes.filter((n) => !n.disabled && (n.type.startsWith("action.") || n.type.startsWith("notify.")));
  const inline = inlineNodes(graph);
  const errors = (issues || []).filter((i) => i.level === "error");
  return (
    <Modal open={open} onClose={onClose} title={t("Workflow aktivieren", "Activate the workflow")} wide>
      <div className="wf-dialog">
        {issues === null ? (
          <p className="muted" role="status">
            {t("Wird geprüft …", "Checking …")}
          </p>
        ) : errors.length ? (
          <>
            <p>{t("Vor dem Aktivieren ist noch etwas zu tun:", "Something needs fixing before activating:")}</p>
            <IssueList issues={issues} labels={labels} onPick={(id) => (onPick(id), onClose())} />
          </>
        ) : (
          <>
            <h3>{t("Reagiert auf", "Reacts to")}</h3>
            <ul className="wf-summary">
              {triggers.map((n) => (
                <li key={n.id}>
                  <strong>{typeName(n.type, t)}</strong> {nodeSummary(n, ws, ctx, t)}
                </li>
              ))}
            </ul>
            <h3>{t("Tut dann", "Then does")}</h3>
            <ul className="wf-summary">
              {writes.length ? (
                writes.map((n) => (
                  <li key={n.id}>
                    <strong>{n.label}</strong> · {typeName(n.type, t)} {nodeSummary(n, ws, ctx, t)}
                    {inline.has(n.id) && (
                      <span className="wf-inline-badge">
                        <Lightning weight="fill" aria-hidden /> {t("sofort beim Speichern", "right when saved")}
                      </span>
                    )}
                  </li>
                ))
              ) : (
                <li className="muted">{t("Nichts, was Daten ändert.", "Nothing that changes data.")}</li>
              )}
            </ul>
            <p className="wf-runs-as">
              {t(
                `Läuft als du (${me.name}) – mit deinen Rechten. Er reagiert nur auf das, was du sehen darfst, und ändert nur, was du ändern darfst.`,
                `Runs as you (${me.name}) – with your rights. It reacts only to what you may see and changes only what you may change.`,
              )}
              {runner && runner.id !== me.id ? t(` Bisher lief er als ${runner.name}.`, ` It ran as ${runner.name} so far.`) : ""}
            </p>
            {issues.length > 0 && (
              <>
                <h3>{t("Hinweise", "Notes")}</h3>
                <IssueList issues={issues} labels={labels} onPick={(id) => (onPick(id), onClose())} />
              </>
            )}
            <div className="wf-field">
              <label className="wf-field-label" htmlFor={noteId}>
                {t("Notiz zur Version (optional)", "Note for this version (optional)")}
              </label>
              <input id={noteId} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || issues === null || errors.length > 0}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ ok: boolean; issues: Issue[] }>("/api/command", { action: "workflow.activate", pageId, note });
                if (r.ok) onDone();
                else setIssues(r.issues);
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Aktivieren", "Activate")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

type Source = "sample" | "last" | "page" | "record" | "custom";
export function TestDialog({
  open,
  mode,
  pageId,
  graph,
  ws,
  databases,
  flush,
  onClose,
  onStarted,
  onError,
}: {
  open: boolean;
  mode: "test" | "dry";
  pageId: string;
  graph: WorkflowGraph;
  ws: Workspace;
  databases: Map<string, DatabaseInfo>;
  flush: () => Promise<void>;
  onClose: () => void;
  onStarted: (runId: string) => void;
  onError: (e: unknown) => void;
}) {
  const t = useStableT();
  const ids = { trigger: useId(), source: useId(), target: useId(), json: useId() };
  const triggers = graph.nodes.filter((n) => isTrigger(n.type));
  const [nodeId, setNodeId] = useState("");
  const [source, setSource] = useState<Source>("sample");
  const [target, setTarget] = useState("");
  const [json, setJson] = useState("{}");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const trigger = triggers.find((n) => n.id === nodeId) || triggers[0];
  const db = trigger && typeof trigger.config.database === "string" ? trigger.config.database : "";
  const recordTrigger = !!db;
  const pageTrigger = !!trigger && /^trigger\.(page|comment|mention)/.test(trigger.type);
  useEffect(() => {
    if (!open) return;
    setIssues([]);
    setTarget("");
  }, [open, source]);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const start = async () => {
    let data: Record<string, unknown> = { kind: source };
    if (source === "page") data = { kind: "page", pageId: target };
    if (source === "record") data = { kind: "record", rowId: target };
    if (source === "custom") {
      try {
        data = { kind: "custom", output: JSON.parse(json) };
      } catch {
        setIssues([{ level: "error", code: "json", message: t("Kein gültiges JSON.", "Not valid JSON.") }]);
        return;
      }
    }
    setBusy(true);
    try {
      await flush();
      const r = await api<{ ok: boolean; runId: string | null; issues: Issue[] }>("/api/command", { action: "workflow.test", pageId, mode, nodeId: trigger?.id, data });
      if (r.ok && r.runId) onStarted(r.runId);
      else setIssues(r.issues);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={mode === "test" ? t("Testlauf", "Test run") : t("Probelauf", "Dry run")}>
      <div className="wf-dialog">
        <p className={mode === "test" ? "wf-warning" : "muted"}>
          {mode === "test"
            ? t("Ein Testlauf ändert echte Daten – als du, mit dem Entwurf.", "A test run changes real data – as you, with the draft.")
            : t("Ein Probelauf zeigt nur, was die Knoten täten: nichts wird geschrieben oder gesendet.", "A dry run only shows what the nodes would do: nothing is written or sent.")}
        </p>
        {!triggers.length ? (
          <p>{t("Der Workflow braucht zuerst einen Auslöser.", "The workflow needs a trigger first.")}</p>
        ) : (
          <>
            {triggers.length > 1 && (
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={ids.trigger}>
                  {t("Auslöser", "Trigger")}
                </label>
                <Select id={ids.trigger} value={trigger?.id} onChange={(e) => setNodeId(e.target.value)}>
                  {triggers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                </Select>
              </div>
            )}
            <div className="wf-field">
              <label className="wf-field-label" htmlFor={ids.source}>
                {t("Daten des Auslösers", "Data of the trigger")}
              </label>
              <Select id={ids.source} value={source} onChange={(e) => setSource(e.target.value as Source)}>
                <option value="sample">{t("Beispiel", "Example")}</option>
                <option value="last">{t("Letztes echtes Ereignis", "Last real event")}</option>
                {pageTrigger && <option value="page">{t("Seite wählen …", "Choose a page …")}</option>}
                {recordTrigger && <option value="record">{t("Eintrag wählen …", "Choose a record …")}</option>}
                <option value="custom">{t("Eigene Werte (JSON)", "Own values (JSON)")}</option>
              </Select>
            </div>
            {source === "page" && (
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={ids.target}>
                  {t("Seite", "Page")}
                </label>
                <PageSelect id={ids.target} value={target} ws={ws} disabled={false} onChange={setTarget} t={t} />
              </div>
            )}
            {source === "record" && (
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={ids.target}>
                  {t("Eintrag", "Record")}
                </label>
                <Select id={ids.target} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">{t("Eintrag wählen …", "Choose a record …")}</option>
                  {(databases.get(db)?.rows || []).map((r) => <option key={r.id} value={r.id}>{r.title || t("Ohne Titel", "Untitled")}</option>)}
                </Select>
              </div>
            )}
            {source === "custom" && (
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={ids.json}>
                  {t("Ausgabe des Auslösers", "Output of the trigger")}
                </label>
                <textarea id={ids.json} className="wf-json" rows={6} value={json} onChange={(e) => setJson(e.target.value)} />
              </div>
            )}
          </>
        )}
        <IssueList issues={issues} labels={labels} />
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button primary" disabled={busy || !triggers.length || ((source === "page" || source === "record") && !target)} onClick={start}>
            {mode === "test" ? t("Testlauf starten", "Start the test run") : t("Probelauf starten", "Start the dry run")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ConnectDialog({ graph, nodeId, onConnect, onRemove, onClose }: { graph: WorkflowGraph; nodeId: string | null; onConnect: (port: string, to: string) => void; onRemove: (edgeId: string) => void; onClose: () => void }) {
  const t = useStableT();
  const ids = { port: useId(), to: useId() };
  const node = graph.nodes.find((n) => n.id === nodeId);
  const ports = node ? nodePorts(node) : [];
  const [port, setPort] = useState(ports[0] || "out");
  const [to, setTo] = useState("");
  useEffect(() => {
    setPort(ports[0] || "out");
    setTo("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const targets = graph.nodes.filter((n) => n.id !== nodeId && !isTrigger(n.type) && !outgoing(graph, nodeId || "", port).some((e) => e.to.node === n.id));
  return (
    <Modal open={!!node} onClose={onClose} title={t(`„${node?.label || ""}“ verbinden`, `Connect “${node?.label || ""}”`)}>
      <div className="wf-dialog">
        {node && outgoing(graph, node.id).length > 0 && (
          <ul className="wf-summary">
            {outgoing(graph, node.id).map((e) => (
              <li key={e.id}>
                {portLabel(e.from.port, t)} → <strong>{labels.get(e.to.node)}</strong>{" "}
                <button type="button" className="text-button" onClick={() => onRemove(e.id)}>
                  {t("Trennen", "Disconnect")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {ports.length > 1 && (
          <div className="wf-field">
            <label className="wf-field-label" htmlFor={ids.port}>
              {t("Ausgang", "Output")}
            </label>
            <Select id={ids.port} value={port} onChange={(e) => setPort(e.target.value)}>
              {ports.map((p) => <option key={p} value={p}>{portLabel(p, t)}</option>)}
            </Select>
          </div>
        )}
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={ids.to}>
            {t("Verbinden mit", "Connect to")}
          </label>
          <Select id={ids.to} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t("Knoten wählen …", "Choose a node …")}</option>
            {targets.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </Select>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Fertig", "Done")}
          </button>
          <button type="button" className="button primary" disabled={!to} onClick={() => (onConnect(port, to), setTo(""))}>
            {t("Verbinden", "Connect")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function AppendDialog({ open, title, triggers, onPick, onClose }: { open: boolean; title: string; triggers: boolean; onPick: (type: string) => void; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <Palette autoFocus triggers={triggers} onPick={onPick} />
    </Modal>
  );
}

export const writesData = (type: string) => !!nodeSpec(type) && (type.startsWith("action.") || type.startsWith("notify."));
