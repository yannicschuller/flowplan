"use client";
// A workflow page (docs/specs/workflows.md §10): the head with the state,
// who it runs as and the switch; the tabs Editor and Runs. The editor is
// the live draft (use-draft.ts) on a canvas (canvas.tsx, xyflow) or as a
// list, with the palette, the side panel of the selected node, the check,
// test and dry runs, discarding and activating. Phones (< 768 px) show the
// state with an on/off switch, the flow as a list and the runs – editing
// is for tablets and computers. People who may only read see the active
// version.
import "@/app/workflow.css";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Flask,
  Graph,
  ListBullets,
  MagicWand,
  Play,
  Pause,
  SidebarSimple,
  TreeStructure,
  Users,
} from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { api } from "../ui";
import { StatusBadge } from "../settings-ui";
import { isTrigger, nodeSpec } from "@/lib/workflows/catalog";
import { checkGraph, graphFingerprint, issueMessage, newNodeId, workflowGraphSchema, type WorkflowGraph, type WorkflowNode } from "@/lib/workflows/graph";
import { layeredLayout } from "@/lib/whiteboard-autolayout";
import { freeLabel, typeName, type Issue, type PageRef, type Person, type Workspace, type WorkflowState, useStableT } from "./model";
import { useWorkflowDraft } from "./use-draft";
import { databasesOf, useDatabases } from "./use-databases";
import { Palette } from "./palette";
import { NodePanel } from "./node-panel";
import { ListView } from "./list-view";
import { ActivateDialog, AppendDialog, ConnectDialog, TestDialog } from "./dialogs";
import { initialConfig } from "./config-form";
import { RunList, RunView, stepStatuses, useRun } from "./runs";
import type { CanvasProps, NodeStatus } from "./canvas";

const NO_STATUS = new Map<string, NodeStatus>();
const NOOP = () => {};
const Canvas = dynamic(() => import("./canvas"), { ssr: false, loading: () => <div className="wf-canvas wf-canvas-loading" aria-busy="true" /> });

export type WorkflowViewProps = {
  pageId: string;
  workflow: WorkflowState;
  // The page may be edited here (not read mode, not locked).
  editable: boolean;
  pages: PageRef[];
  spaces: { id: string; name: string }[];
  members: Person[];
  me: Person;
  onReload: () => void;
  onError: (error: unknown) => void;
};

function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}
const inField = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]");

// How many nodes and connections differ from the active version.
function changes(draft: WorkflowGraph, active: WorkflowGraph | null) {
  if (!active) return null;
  const a = new Map(active.nodes.map((n) => [n.id, JSON.stringify({ ...n, position: undefined, note: undefined })]));
  const d = new Map(draft.nodes.map((n) => [n.id, JSON.stringify({ ...n, position: undefined, note: undefined })]));
  let n = 0;
  for (const [id, v] of d) if (a.get(id) !== v) n++;
  for (const id of a.keys()) if (!d.has(id)) n++;
  const ae = new Set(active.edges.map((e) => `${e.from.node}:${e.from.port}>${e.to.node}`));
  const de = new Set(draft.edges.map((e) => `${e.from.node}:${e.from.port}>${e.to.node}`));
  for (const e of de) if (!ae.has(e)) n++;
  for (const e of ae) if (!de.has(e)) n++;
  return n;
}
const parsed = (g: WorkflowGraph) => {
  const r = workflowGraphSchema.safeParse(g);
  return r.success ? r.data : g;
};

export default function WorkflowView(props: WorkflowViewProps) {
  const t = useStableT();
  const { workflow: state, pageId } = props;
  const phone = useMedia("(max-width: 767px)");
  const [tab, setTab] = useState<"editor" | "runs">("editor");
  const [runId, setRunId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [busy, setBusy] = useState(false);
  // The editor reports its live graph and how to save at once.
  const live = useRef<{ graph: WorkflowGraph; flush: () => Promise<void>; select: (id: string) => void } | null>(null);
  const manage = state.canEdit;
  const canEditDraft = manage && props.editable && !!state.draft && !phone;
  const onError = props.onError;
  // The shell sends new arrays on every render: kept while their content is the same.
  const wsKey = JSON.stringify([props.pages, props.spaces, props.members]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ws = useMemo(() => ({ pages: props.pages, spaces: props.spaces, members: props.members }), [wsKey]);
  const shownGraph = state.draft?.graph || state.active?.graph || null;
  const status =
    state.status === "active"
      ? { tone: "ok" as const, text: t("Aktiv", "Active") }
      : state.status === "paused"
        ? { tone: "warn" as const, text: t("Pausiert", "Paused") }
        : state.status === "auto_paused"
          ? { tone: "error" as const, text: t("Automatisch pausiert", "Paused automatically") }
          : { tone: "off" as const, text: t("Entwurf", "Draft") };
  const pause = async () => {
    setBusy(true);
    try {
      await api("/api/command", { action: "workflow.pause", pageId });
      props.onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const openRun = (id: string) => {
    setRunId(id);
    setTab("runs");
  };
  const renderGraph = (graph: WorkflowGraph, statuses: Map<string, NodeStatus>, selected: string | null, onSelect: (id: string | null) => void) => (
    <ReadOnlyGraph graph={graph} ws={ws} statuses={statuses} selected={selected} onSelect={onSelect} list={phone} />
  );
  return (
    <div className={`workflow-page${phone ? " phone" : ""}`}>
      <header className="wf-head">
        <div className="wf-state">
          <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
          {state.status === "auto_paused" && state.pauseReason && <span className="muted">{state.pauseReason}</span>}
          {state.status === "paused" && state.pauseReason && <span className="muted">{state.pauseReason}</span>}
          {state.runner && state.status !== "draft" && <span className="muted">{t(`läuft als ${state.runner.name}`, `runs as ${state.runner.name}`)}</span>}
          {state.active && <span className="muted">{t(`Version ${state.active.number}`, `Version ${state.active.number}`)}</span>}
        </div>
        {manage && (
          <div className="wf-switch">
            {phone ? (
              <label className="wf-onoff">
                <span>{t("Aktiv", "Active")}</span>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={state.status === "active"}
                  aria-label={t("Workflow aktiv", "Workflow active")}
                  disabled={busy || (!state.draft && state.status !== "active")}
                  onClick={() => (state.status === "active" ? void pause() : setActivating(true))}
                >
                  <span aria-hidden />
                </button>
              </label>
            ) : state.status === "active" ? (
              <button type="button" className="button compact" disabled={busy} onClick={pause}>
                <Pause /> {t("Pausieren", "Pause")}
              </button>
            ) : null}
          </div>
        )}
      </header>
      <div className="wf-tabs" role="tablist" aria-label={t("Ansicht", "View")}>
        <button type="button" role="tab" id={`wf-tab-editor-${pageId}`} aria-selected={tab === "editor"} aria-controls={`wf-panel-${pageId}`} onClick={() => setTab("editor")}>
          {canEditDraft ? t("Editor", "Editor") : t("Ablauf", "Flow")}
        </button>
        <button
          type="button"
          role="tab"
          id={`wf-tab-runs-${pageId}`}
          aria-selected={tab === "runs"}
          aria-controls={`wf-panel-${pageId}`}
          onClick={() => {
            setTab("runs");
            setRunId(null);
          }}
        >
          {t("Läufe", "Runs")}
        </button>
      </div>
      <div className="wf-tab-panel" role="tabpanel" id={`wf-panel-${pageId}`} aria-labelledby={`wf-tab-${tab}-${pageId}`}>
        {tab === "runs" ? (
          runId ? (
            <RunView runId={runId} canEdit={manage} onBack={() => setRunId(null)} onError={onError} renderGraph={renderGraph} />
          ) : (
            <RunList pageId={pageId} graph={shownGraph} onOpen={setRunId} onError={onError} />
          )
        ) : canEditDraft ? (
          <Editor {...props} ws={ws} live={live} onActivate={() => setActivating(true)} onOpenRun={openRun} />
        ) : (
          <>
            {phone && manage && <p className="wf-note muted">{t("Bearbeiten auf Tablet oder Computer.", "Edit on a tablet or computer.")}</p>}
            {!manage && state.status === "draft" && <p className="muted">{t("Dieser Workflow wurde noch nicht aktiviert.", "This workflow has not been activated yet.")}</p>}
            {(manage ? shownGraph : state.active?.graph) && (
              <ReadOnlyGraph graph={(manage ? shownGraph : state.active?.graph)!} ws={ws} statuses={NO_STATUS} selected={null} onSelect={NOOP} list={phone} />
            )}
          </>
        )}
      </div>
      {manage && state.draft && (
        <ActivateDialog
          open={activating}
          pageId={pageId}
          graph={live.current?.graph || state.draft.graph}
          ws={{ ...ws, fields: new Map() }}
          me={props.me}
          runner={state.runner}
          flush={live.current?.flush || (async () => {})}
          onClose={() => setActivating(false)}
          onDone={() => {
            setActivating(false);
            props.onReload();
          }}
          onPick={(id) => live.current?.select(id)}
          onError={onError}
        />
      )}
    </div>
  );
}

// A graph to look at: the canvas (computers, tablets) or the list (phones).
function ReadOnlyGraph({ graph, ws, statuses, selected, onSelect, list }: { graph: WorkflowGraph; ws: Omit<Workspace, "fields">; statuses: Map<string, NodeStatus>; selected: string | null; onSelect: (id: string | null) => void; list: boolean }) {
  const { fields } = useDatabases(databasesOf(graph));
  const full = useMemo(() => ({ ...ws, fields }), [ws, fields]);
  const noop = NOOP;
  if (list) return <ListView graph={graph} ws={full} issues={[]} statuses={statuses} selected={selected} editable={false} onSelect={onSelect} />;
  const canvas: CanvasProps = {
    graph,
    ws: full,
    issues: [],
    editable: false,
    selected,
    statuses,
    onSelect,
    onMove: noop,
    onConnect: noop,
    onDeleteNode: noop,
    onDeleteEdge: noop,
    onAdd: noop,
    onAppend: noop,
    onInsert: noop,
    onConnectDialog: noop,
    onDuplicate: noop,
    onUndo: noop,
    onRedo: noop,
    onList: noop,
  };
  return (
    <div className="wf-readonly">
      <Canvas {...canvas} />
    </div>
  );
}

type EditorProps = WorkflowViewProps & {
  ws: Omit<Workspace, "fields">;
  live: React.MutableRefObject<{ graph: WorkflowGraph; flush: () => Promise<void>; select: (id: string) => void } | null>;
  onActivate: () => void;
  onOpenRun: (id: string) => void;
};

function Editor(props: EditorProps) {
  const t = useStableT();
  const locale = useLocale();
  const { workflow: state, pageId, onError } = props;
  const draftState = state.draft!;
  const showError = useCallback((m: string) => onError(new Error(m)), [onError]);
  const draft = useWorkflowDraft({ pageId, state: draftState.state, generation: draftState.generation, editable: props.editable, onReload: props.onReload, onError: showError });
  const { graph, change } = draft;
  const { info: databases, fields } = useDatabases(databasesOf(graph));
  const ws: Workspace = useMemo(() => ({ ...props.ws, fields }), [props.ws, fields]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [palette, setPalette] = useState(true);
  const [append, setAppend] = useState<{ after: string | null; edge?: string } | null>(null);
  const [connect, setConnect] = useState<string | null>(null);
  const [testing, setTesting] = useState<"test" | "dry" | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const testRun = useRun(testRunId, onError);
  const narrow = useMedia("(max-width: 1100px)");
  useEffect(() => setPalette(!narrow), [narrow]);
  props.live.current = { graph, flush: draft.flush, select: (id) => setSelected(id) };

  // The check: the structure at once, the references from the server.
  const local = useMemo(() => checkGraph(parsed(graph) as WorkflowGraph).map((i) => ({ ...i, message: issueMessage(i, locale) })), [graph, locale]);
  const [server, setServer] = useState<Issue[]>(draftState.issues);
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setServer((await api<{ issues: Issue[] }>("/api/command", { action: "workflow.validate", pageId, graph })).issues);
      } catch {
        setServer([]);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [graph, pageId]);
  const issues = useMemo(() => {
    const seen = new Set(local.map((i) => `${i.code}:${i.nodeId || ""}:${i.edgeId || ""}`));
    return [...local, ...server.filter((i) => !seen.has(`${i.code}:${i.nodeId || ""}:${i.edgeId || ""}`) && (!i.nodeId || graph.nodes.some((n) => n.id === i.nodeId)))];
  }, [local, server, graph]);
  const errors = issues.filter((i) => i.level === "error").length,
    warnings = issues.length - errors;

  const statuses = useMemo(() => (testRun ? stepStatuses(testRun.timeline, locale) : NO_STATUS), [testRun, locale]);
  const values = useMemo(() => new Map((testRun?.timeline || []).map((s) => [s.nodeId, s.output])), [testRun]);
  const selectedNode = graph.nodes.find((n) => n.id === selected) || null;
  const step = selectedNode && testRun ? [...testRun.timeline].reverse().find((s) => s.nodeId === selectedNode.id) || null : null;
  const changed = useMemo(() => {
    if (!state.active) return null;
    return graphFingerprint(parsed(graph)) === graphFingerprint(parsed(state.active.graph)) ? 0 : changes(graph, state.active.graph);
  }, [graph, state.active]);
  const triggerDb = graph.nodes.find((n) => isTrigger(n.type) && typeof n.config.database === "string")?.config.database as string | undefined;

  /* ---------- Edits ---------- */
  const edgeId = () => `e_${Math.random().toString(36).slice(2, 12)}`;
  const addNode = (type: string, at?: { x: number; y: number }, after?: { node: string; port: string } | null, insert?: string) => {
    const id = newNodeId();
    change((g) => {
      const prev = after ? g.nodes.find((n) => n.id === after.node) : null;
      const lowest = g.nodes.reduce((m, n) => Math.max(m, n.position.y), -140);
      const position = at || (prev ? { x: prev.position.x + 280, y: prev.position.y } : { x: 0, y: lowest + 140 });
      const node: WorkflowNode = { id, type, typeVersion: 1, label: freeLabel(g, typeName(type, t)), note: "", position, disabled: false, config: initialConfig(type, { database: triggerDb }) };
      let edges = g.edges;
      const old = insert ? g.edges.find((e) => e.id === insert) : null;
      if (old) {
        node.position = { x: Math.round(((g.nodes.find((n) => n.id === old.from.node)?.position.x ?? 0) + (g.nodes.find((n) => n.id === old.to.node)?.position.x ?? 0)) / 2), y: (g.nodes.find((n) => n.id === old.to.node)?.position.y ?? 0) + 120 };
        edges = [...g.edges.filter((e) => e.id !== old.id), { id: edgeId(), from: old.from, to: { node: id, port: "in" } }];
        if (!isTrigger(type) && nodeSpec(type)?.ports({}).includes("out")) edges.push({ id: edgeId(), from: { node: id, port: "out" }, to: old.to });
      } else if (prev && !isTrigger(type)) edges = [...g.edges, { id: edgeId(), from: { node: prev.id, port: after!.port }, to: { node: id, port: "in" } }];
      return { ...g, nodes: [...g.nodes, node], edges };
    });
    setSelected(id);
  };
  const appendAfter = (afterId: string | null) => {
    const node = graph.nodes.find((n) => n.id === afterId);
    const port = node ? nodeSpec(node.type)?.ports(node.config)[0] : undefined;
    return node && port ? { node: node.id, port } : null;
  };
  const deleteNode = (id: string) => {
    change((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from.node !== id && e.to.node !== id) }));
    if (selected === id) setSelected(null);
  };
  const connectNodes = (from: { node: string; port: string }, to: string) =>
    change((g) => {
      const target = g.nodes.find((n) => n.id === to);
      if (!target || isTrigger(target.type) || from.node === to || g.edges.some((e) => e.from.node === from.node && e.from.port === from.port && e.to.node === to)) return g;
      return { ...g, edges: [...g.edges, { id: edgeId(), from, to: { node: to, port: "in" } }] };
    });
  const duplicate = (id: string) => {
    const copy = newNodeId();
    change((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (!n) return g;
      return { ...g, nodes: [...g.nodes, { ...structuredClone(n), id: copy, label: freeLabel(g, n.label), position: { x: n.position.x + 40, y: n.position.y + 100 } }] };
    });
    setSelected(copy);
  };
  const tidy = () =>
    change((g) => {
      const layout = layeredLayout(
        g.nodes.map((n) => ({ id: n.id, w: 240, h: 100 })),
        g.edges.map((e) => ({ from: e.from.node, to: e.to.node })),
        { direction: "LR", rankGap: 80, nodeGap: 40 },
      );
      return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: layout.get(n.id) ? { x: Math.round(layout.get(n.id)!.x / 20) * 20, y: Math.round(layout.get(n.id)!.y / 20) * 20 } : n.position })) };
    });
  const discard = async () => {
    if (!state.active) return;
    try {
      await draft.flush();
      await api("/api/command", { action: "workflow.restore", pageId, versionId: state.active.id });
    } catch (e) {
      onError(e);
    }
  };

  const key = (e: KeyboardEvent) => {
    if (inField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === "l") {
      setView((v) => (v === "canvas" ? "list" : "canvas"));
      e.preventDefault();
    }
  };
  const canvasProps: CanvasProps = {
    graph,
    ws,
    issues,
    editable: props.editable,
    selected,
    statuses,
    onSelect: setSelected,
    onMove: (moves) => change((g) => ({ ...g, nodes: g.nodes.map((n) => { const m = moves.find((x) => x.id === n.id); return m ? { ...n, position: { x: m.x, y: m.y } } : n; }) })),
    onConnect: connectNodes,
    onDeleteNode: deleteNode,
    onDeleteEdge: (id) => change((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) })),
    onAdd: (type, at) => addNode(type, at),
    onAppend: (id) => setAppend({ after: id }),
    onInsert: (edge) => setAppend({ after: null, edge }),
    onConnectDialog: setConnect,
    onDuplicate: duplicate,
    onUndo: draft.undo,
    onRedo: draft.redo,
    onList: () => setView("list"),
  };
  const saveText =
    draft.save === "saved" ? t("Gespeichert", "Saved") : draft.save === "failed" ? t("Speichern fehlgeschlagen", "Saving failed") : draft.save === "offline" ? t("Offline", "Offline") : t("Speichern …", "Saving …");
  return (
    <div className="wf-editor" onKeyDown={key}>
      <div className="wf-draftbar">
        <div className="wf-draft-state">
          <span>
            {changed === null
              ? t("Entwurf · noch nie aktiviert", "Draft · never activated")
              : changed === 0
                ? t(`Entwurf = Version ${state.active!.number}`, `Draft = version ${state.active!.number}`)
                : changed === 1
                  ? t(`Entwurf · 1 Änderung seit Version ${state.active!.number}`, `Draft · 1 change since version ${state.active!.number}`)
                  : t(`Entwurf · ${changed} Änderungen seit Version ${state.active!.number}`, `Draft · ${changed} changes since version ${state.active!.number}`)}
          </span>
          <span className="muted" role="status">
            {saveText}
          </span>
          {draft.presence.length > 0 && (
            <span className="wf-presence">
              <Users aria-hidden /> {t(`${draft.presence.map((p) => p.name).join(", ")} bearbeitet mit`, `${draft.presence.map((p) => p.name).join(", ")} editing too`)}
            </span>
          )}
          <span className={`wf-check-state${errors ? " error" : warnings ? " warning" : ""}`}>
            {errors ? (errors === 1 ? t("1 Fehler", "1 error") : t(`${errors} Fehler`, `${errors} errors`)) : warnings ? (warnings === 1 ? t("1 Warnung", "1 warning") : t(`${warnings} Warnungen`, `${warnings} warnings`)) : t("Keine Probleme", "No problems")}
          </span>
        </div>
        <div className="wf-actions">
          <button type="button" className="icon-button" aria-label={t("Rückgängig", "Undo")} title={t("Rückgängig", "Undo")} disabled={!draft.canUndo} onClick={draft.undo}>
            <ArrowCounterClockwise />
          </button>
          <button type="button" className="icon-button" aria-label={t("Wiederholen", "Redo")} title={t("Wiederholen", "Redo")} disabled={!draft.canRedo} onClick={draft.redo}>
            <ArrowClockwise />
          </button>
          <button type="button" className="button compact" aria-pressed={view === "list"} onClick={() => setView(view === "canvas" ? "list" : "canvas")}>
            {view === "canvas" ? <ListBullets /> : <Graph />} {view === "canvas" ? t("Liste", "List") : t("Fläche", "Canvas")}
          </button>
          {view === "canvas" && (
            <button type="button" className="button compact" onClick={tidy} disabled={graph.nodes.length < 2}>
              <TreeStructure /> {t("Aufräumen", "Tidy up")}
            </button>
          )}
          <button type="button" className="button compact" onClick={() => setTesting("dry")}>
            <Flask /> {t("Probelauf", "Dry run")}
          </button>
          <button type="button" className="button compact" onClick={() => setTesting("test")}>
            <Play /> {t("Testlauf", "Test run")}
          </button>
          {state.active && changed !== 0 && (
            <button type="button" className="button compact" onClick={discard}>
              {t("Verwerfen", "Discard")}
            </button>
          )}
          {(state.status !== "active" || changed !== 0) && (
            <button type="button" className="button compact primary" onClick={props.onActivate}>
              <MagicWand /> {state.status === "active" ? t("Änderungen aktivieren", "Activate changes") : t("Aktivieren", "Activate")}
            </button>
          )}
        </div>
      </div>
      {testRun && (
        <div className={`wf-testbar status-${testRun.status}`} role="status">
          <span>
            {testRun.mode === "dry" ? t("Probelauf", "Dry run") : t("Testlauf", "Test run")}: {statusWord(testRun.status, t)}
            {testRun.error ? ` – ${testRun.error}` : ""}
          </span>
          <button type="button" className="text-button" onClick={() => props.onOpenRun(testRun.id)}>
            {t("Lauf ansehen", "View the run")}
          </button>
          <button type="button" className="text-button" onClick={() => setTestRunId(null)}>
            {t("Ausblenden", "Hide")}
          </button>
        </div>
      )}
      <div className={`wf-workspace${palette ? " with-palette" : ""}${selectedNode ? " with-panel" : ""}`}>
        {props.editable && (
          <div className={`wf-side${palette ? " open" : ""}`}>
            <button type="button" className="icon-button wf-palette-toggle" aria-expanded={palette} aria-label={palette ? t("Knotenliste ausblenden", "Hide the node list") : t("Knotenliste zeigen", "Show the node list")} onClick={() => setPalette(!palette)}>
              <SidebarSimple />
            </button>
            {palette && <Palette onPick={(type) => addNode(type, undefined, appendAfter(selected))} compact={narrow} />}
          </div>
        )}
        <div className="wf-main">
          {view === "canvas" ? (
            <Canvas {...canvasProps} />
          ) : (
            <ListView
              graph={graph}
              ws={ws}
              issues={issues}
              statuses={statuses}
              selected={selected}
              editable={props.editable}
              onSelect={setSelected}
              onDelete={deleteNode}
              onAppend={(id) => setAppend({ after: id })}
              onConnect={setConnect}
            />
          )}
          {!graph.nodes.length && (
            <div className="wf-empty-canvas">
              <p>{t("Leg los mit einem Auslöser: wann soll der Workflow starten?", "Start with a trigger: when should the workflow start?")}</p>
              <button type="button" className="button primary" onClick={() => setAppend({ after: null })}>
                {t("Auslöser wählen", "Choose a trigger")}
              </button>
            </div>
          )}
        </div>
        {selectedNode && (
          <NodePanel
            graph={graph}
            node={selectedNode}
            ws={ws}
            databases={databases}
            issues={issues}
            step={step}
            values={values}
            editable={props.editable}
            onChange={(node) => change((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === node.id ? node : n)) }))}
            onDelete={() => deleteNode(selectedNode.id)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      <AppendDialog
        open={!!append}
        title={append?.edge ? t("Knoten dazwischen einfügen", "Insert a node in between") : append?.after ? t("Knoten anfügen", "Append a node") : t("Knoten hinzufügen", "Add a node")}
        triggers={!append?.after && !append?.edge}
        onClose={() => setAppend(null)}
        onPick={(type) => {
          const a = append;
          setAppend(null);
          addNode(type, undefined, a?.after ? appendAfter(a.after) : null, a?.edge);
        }}
      />
      <ConnectDialog graph={graph} nodeId={connect} onClose={() => setConnect(null)} onConnect={(port, to) => connectNodes({ node: connect!, port }, to)} onRemove={(id) => change((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }))} />
      <TestDialog
        open={!!testing}
        mode={testing || "dry"}
        pageId={pageId}
        graph={graph}
        ws={ws}
        databases={databases}
        flush={draft.flush}
        onClose={() => setTesting(null)}
        onStarted={(id) => {
          setTesting(null);
          setTestRunId(id);
        }}
        onError={onError}
      />
    </div>
  );
}

function statusWord(s: string, t: (de: string, en: string) => string) {
  if (s === "succeeded") return t("erfolgreich", "succeeded");
  if (s === "failed") return t("fehlgeschlagen", "failed");
  if (s === "cancelled") return t("abgebrochen", "cancelled");
  return t("läuft …", "running …");
}
