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
        <li key={n} className={`is-${i.level}`}>
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
            {(() => {
              // What leaves Flowplan (§9.1): hosts, e-mail, chat, AI.
              const hosts = [...new Set(graph.nodes.filter((n) => n.type === "http.request" && !n.disabled).map((n) => /^https?:\/\/([^/?#{}]+)/i.exec(String(n.config.url || ""))?.[1] || "?"))];
              const mails = graph.nodes.some((n) => n.type === "notify.email" && !n.disabled);
              const chat = graph.nodes.some((n) => n.type === "notify.chat" && !n.disabled);
              const ai = graph.nodes.some((n) => n.type.startsWith("ai.") && !n.disabled);
              if (!hosts.length && !mails && !chat && !ai) return null;
              return (
                <>
                  <h3>{t("Nach außen", "Outside")}</h3>
                  <ul className="wf-summary">
                    {hosts.length > 0 && <li>{t(`HTTP-Anfragen an ${hosts.join(", ")}`, `HTTP requests to ${hosts.join(", ")}`)}</li>}
                    {mails && <li>{t("E-Mails (höchstens 100 je Tag)", "E-mails (at most 100 a day)")}</li>}
                    {chat && <li>{t("Nachrichten in Chat-Webhooks", "Messages to chat webhooks")}</li>}
                    {ai && <li>{t("KI: Texte gehen an den KI-Anbieter der Instanz (kostet Tokens des Workflows)", "AI: texts go to the instance’s AI provider (uses the workflow’s tokens)")}</li>}
                  </ul>
                </>
              );
            })()}
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
  // Own values in the trigger's own form (§10.3): its inputs, a mail, a webhook body.
  const [form, setForm] = useState<Record<string, string>>({});
  const [assume, setAssume] = useState<"approved" | "rejected">("approved");
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
      const type = trigger?.type;
      try {
        if (type === "trigger.manual") {
          const inputs: Record<string, unknown> = {};
          for (const f of (trigger!.config.inputs as { name: string; type: string }[]) || []) {
            const v = form[`input:${f.name}`] ?? "";
            if (v === "") continue;
            inputs[f.name] = f.type === "number" ? Number(v) : f.type === "boolean" ? v === "true" : v;
          }
          data = { kind: "custom", output: { inputs, startedBy: null, source: "workflow" } };
        } else if (type === "trigger.mail.received")
          data = {
            kind: "custom",
            output: {
              mail: { from: form.from || "", to: [], subject: form.subject || "", text: form.text || "", html: "", date: new Date().toISOString(), messageId: "test", attachments: [] },
              authenticated: form.authenticated || "pass",
            },
          };
        else if (type === "trigger.webhook") data = { kind: "custom", output: { body: JSON.parse(json || "null"), query: {}, headers: {}, receivedAt: new Date().toISOString() } };
        else if (type === "trigger.schedule") data = { kind: "custom", output: { slot: { date: form.date || new Date().toISOString().slice(0, 10), time: String(trigger!.config.time || "09:00") } } };
        else data = { kind: "custom", output: JSON.parse(json) };
      } catch {
        setIssues([{ level: "error", code: "json", message: t("Kein gültiges JSON.", "Not valid JSON.") }]);
        return;
      }
    }
    setBusy(true);
    try {
      await flush();
      const r = await api<{ ok: boolean; runId: string | null; issues: Issue[] }>("/api/command", { action: "workflow.test", pageId, mode, nodeId: trigger?.id, data, assume });
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
                <option value="custom">{["trigger.manual", "trigger.mail.received", "trigger.schedule"].includes(trigger?.type || "") ? t("Eigene Werte", "Own values") : t("Eigene Werte (JSON)", "Own values (JSON)")}</option>
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
            {source === "custom" && <CustomValues trigger={trigger!} form={form} setForm={setForm} json={json} setJson={setJson} jsonId={ids.json} t={t} />}
            {mode === "dry" && graph.nodes.some((n) => n.type === "logic.approval") && (
              <div className="wf-field">
                <label className="wf-field-label" htmlFor={`${ids.source}-assume`}>
                  {t("Freigaben im Probelauf", "Approvals in the dry run")}
                </label>
                <Select id={`${ids.source}-assume`} value={assume} onChange={(e) => setAssume(e.target.value as "approved" | "rejected")}>
                  <option value="approved">{t("Als genehmigt annehmen", "Assume approved")}</option>
                  <option value="rejected">{t("Als abgelehnt annehmen", "Assume rejected")}</option>
                </Select>
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
              {ports.map((p) => <option key={p} value={p}>{portLabel(p, t, node)}</option>)}
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

// The trigger's own form for "own values" of a test run.
function CustomValues({ trigger, form, setForm, json, setJson, jsonId, t }: { trigger: WorkflowGraph["nodes"][number]; form: Record<string, string>; setForm: (f: Record<string, string>) => void; json: string; setJson: (v: string) => void; jsonId: string; t: (de: string, en: string) => string }) {
  const id = useId();
  const field = (key: string, label: string, type = "text") => (
    <div className="wf-field" key={key}>
      <label className="wf-field-label" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      {type === "textarea" ? (
        <textarea id={`${id}-${key}`} rows={4} value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      ) : (
        <input id={`${id}-${key}`} type={type} value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      )}
    </div>
  );
  if (trigger.type === "trigger.manual") {
    const inputs = (trigger.config.inputs as { name: string; type: string; required?: boolean }[]) || [];
    if (!inputs.length) return <p className="muted">{t("Dieser Auslöser hat keine Eingabefelder.", "This trigger has no input fields.")}</p>;
    return <>{inputs.map((f) => field(`input:${f.name}`, `${f.name}${f.required ? " *" : ""}`, f.type === "number" ? "number" : f.type === "date" ? "date" : "text"))}</>;
  }
  if (trigger.type === "trigger.mail.received")
    return (
      <>
        {field("from", t("Absender", "From"), "email")}
        {field("subject", t("Betreff", "Subject"))}
        {field("text", t("Text", "Text"), "textarea")}
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={`${id}-auth`}>
            {t("Absender geprüft", "Sender verified")}
          </label>
          <Select id={`${id}-auth`} value={form.authenticated || "pass"} onChange={(e) => setForm({ ...form, authenticated: e.target.value })}>
            <option value="pass">{t("Bestanden", "Passed")}</option>
            <option value="unknown">{t("Unbekannt", "Unknown")}</option>
            <option value="fail">{t("Durchgefallen", "Failed")}</option>
          </Select>
        </div>
      </>
    );
  if (trigger.type === "trigger.schedule") return field("date", t("Termin (Datum)", "Slot (date)"), "date");
  return (
    <div className="wf-field">
      <label className="wf-field-label" htmlFor={jsonId}>
        {trigger.type === "trigger.webhook" ? t("Inhalt des Aufrufs (JSON)", "Body of the call (JSON)") : t("Ausgabe des Auslösers", "Output of the trigger")}
      </label>
      <textarea id={jsonId} className="wf-json" rows={6} value={json} onChange={(e) => setJson(e.target.value)} />
    </div>
  );
}

// Pausing (§8.11, open question 8): open runs are held – or cancelled.
export function PauseDialog({ open, pageId, onClose, onDone, onError }: { open: boolean; pageId: string; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const t = useStableT();
  const [cancel, setCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openRuns, setOpenRuns] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setCancel(false);
    setOpenRuns(null);
    void api<{ runs: unknown[] }>(`/api/workflows/${pageId}/runs?status=open&mode=live&limit=200`)
      .then((r) => setOpenRuns(r.runs.length))
      .catch(() => setOpenRuns(0));
  }, [open, pageId]);
  return (
    <Modal open={open} onClose={onClose} title={t("Workflow pausieren", "Pause the workflow")}>
      <div className="wf-dialog">
        <p>{t("Pausiert startet der Workflow keine neuen Läufe; Ereignisse in der Zwischenzeit werden nicht nachgeholt.", "While paused the workflow starts no new runs; events in the meantime are not made up for.")}</p>
        {openRuns !== null && openRuns > 0 && (
          <>
            <p>{openRuns === 1 ? t("1 Lauf ist noch offen. Er wird angehalten und läuft nach dem Aktivieren weiter.", "1 run is still open. It is held and goes on after activating.") : t(`${openRuns} Läufe sind noch offen. Sie werden angehalten und laufen nach dem Aktivieren weiter.`, `${openRuns} runs are still open. They are held and go on after activating.`)}</p>
            <label className="wf-check">
              <input type="checkbox" checked={cancel} onChange={(e) => setCancel(e.target.checked)} />
              <span>{t("Offene Läufe stattdessen abbrechen (auch wartende Freigaben)", "Cancel the open runs instead (waiting approvals too)")}</span>
            </label>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/command", { action: "workflow.pause", pageId, cancelRuns: cancel });
                onDone();
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {cancel ? t("Pausieren und abbrechen", "Pause and cancel") : t("Pausieren", "Pause")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
