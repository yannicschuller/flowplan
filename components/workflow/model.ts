// Shared pieces of the workflow editor (docs/specs/workflows.md §10): the
// state the server sends, references to pages and people, the order of the
// nodes (triggers first, then along the edges), labels, one-line summaries
// and the output tree of the placeholder picker. Client-only helpers; the
// graph model itself is lib/workflows/graph.ts.
import { aiFieldOutputs, isTrigger, nodeSpec, NODE_TYPES, RECORD_OUTPUT, type AiField, type NodeSpec, type OutputField } from "@/lib/workflows/catalog";
import { nodePorts, outgoing, type GraphIssue, type WorkflowGraph, type WorkflowNode } from "@/lib/workflows/graph";
import { toDisplay, type DisplayContext } from "@/lib/workflows/placeholders";
import type { Field } from "@/lib/types";
import { localeTag, translate, type Locale } from "@/lib/i18n";
import { translateLabel } from "@/lib/i18n-labels";
import { useMemo } from "react";
import { useLocale } from "../i18n";

export type T = (de: string, en?: string) => string;
export type Person = { id: string; name: string; email?: string };
export type PageRef = { id: string; title: string; kind: string; icon?: string | null; space_id: string; parent_id: string | null };
export type Issue = GraphIssue & { message: string };
export type RunSummary = {
  id: string;
  status: string;
  mode: string;
  version: number | null;
  triggerNodeId: string;
  steps: number;
  depth: number;
  originRunId: string | null;
  failedNodeId: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};
export type TimelineStep = {
  id: string;
  nodeId: string;
  iteration: string;
  via: string;
  status: string;
  attempt: number;
  port: string | null;
  dueAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  errorKind: string | null;
  error: string | null;
  input: { config?: unknown; warnings?: string[] } | null;
  output: unknown;
};
export type RunDetail = RunSummary & {
  pageId: string;
  versionId: string | null;
  graph: WorkflowGraph;
  runner: Person | null;
  contentsVisible: boolean;
  origin: { runId: string; pageId: string; title: string | null } | null;
  aiTokens: number;
  errorKind: string | null;
  approvals: { id: string; stepId: string; decision: string | null; expiresAt: number | null; canDecide: boolean }[];
  timeline: TimelineStep[];
};
// An approval (GET /api/workflow-approvals…, lib/workflows/actions.ts).
export type Approval = {
  id: string;
  pageId: string;
  title: string;
  runId: string;
  message: string;
  decision: string | null;
  decidedBy: Person | null;
  comment: string;
  approvers: Person[];
  canDecide: boolean;
  expiresAt: number | null;
  createdAt: number;
  decidedAt: number | null;
};
// What the editor may pick (GET /api/workflows/{id}/resources).
export type Resources = {
  chatHooks: { id: string; format: string; host: string }[];
  addresses: { id: string; label: string; signed: boolean; senders: string[] }[];
  journals: { id: string; title: string; locked: boolean }[];
};
export type Credential = { id: string; name: string; kind: string; host: string; updatedAt: number; createdBy: Person | null };
// GET /api/pages/{id} → workflow (lib/workflows/store.ts workflowState).
export type WorkflowState = {
  pageId: string;
  title: string;
  status: "draft" | "active" | "paused" | "auto_paused";
  pauseReason: string | null;
  runner: Person | null;
  activatedAt: number | null;
  pausedAt: number | null;
  throttled: number;
  canEdit: boolean;
  active: { id: string; number: number; graph: WorkflowGraph; activatedBy: Person | null; activatedAt: number; note: string } | null;
  draft: { graph: WorkflowGraph; generation: string; state: string; changed: boolean; issues: Issue[] } | null;
  lastRun: { id: string; status: string; mode: string; created_at: number; finished_at: number | null } | null;
};
// What the editor knows about the workspace (for pickers and names).
export type Workspace = {
  workspaceId?: string;
  pages: PageRef[];
  spaces: { id: string; name: string }[];
  members: Person[];
  // Properties of databases, loaded on demand (useDatabaseFields).
  fields: Map<string, Field[]>;
};

export const OPEN_RUN = new Set(["queued", "running", "waiting", "held"]);
export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

// i18n-table: 1 – [German, English] pairs (palette categories)
export const CATEGORY_TEXT: Record<string, [string, string]> = {
  trigger: ["Auslöser", "Triggers"],
  logic: ["Logik", "Logic"],
  records: ["Einträge", "Records"],
  pages: ["Seiten", "Pages"],
  notify: ["Benachrichtigen", "Notify"],
  ai: ["KI", "AI"],
  http: ["HTTP", "HTTP"],
};
// i18n-table: 1 – [German, English] pairs (output ports)
const PORT_TEXT: Record<string, [string, string]> = {
  out: ["weiter", "next"],
  true: ["ja", "yes"],
  false: ["nein", "no"],
  error: ["Fehler", "Error"],
  item: ["Element", "Item"],
  done: ["fertig", "done"],
  default: ["sonst", "otherwise"],
  approved: ["genehmigt", "approved"],
  rejected: ["abgelehnt", "rejected"],
  timeout: ["Frist abgelaufen", "timed out"],
  unclear: ["unklar", "unclear"],
};
// A port's name; a switch's cases by their label (or value).
export const portLabel = (port: string, t: T, node?: WorkflowNode) => {
  if (PORT_TEXT[port]) return t(PORT_TEXT[port][0], PORT_TEXT[port][1]);
  if (port.startsWith("case:")) {
    const kase = ((node?.config.cases as { id: string; label?: string; value?: string }[]) || []).find((c) => `case:${c.id}` === port);
    return kase ? kase.label || kase.value || t("Fall", "Case") : t("Fall", "Case");
  }
  return port;
};

export const specName = (s: NodeSpec | undefined, t: T) => (s ? t(s.name[0], s.name[1]) : "?");
export const typeName = (type: string, t: T) => specName(nodeSpec(type), t);
export const PALETTE = NODE_TYPES;

// A label that is not taken yet: the type's name, else "… 2", "… 3".
export function freeLabel(graph: WorkflowGraph, base: string) {
  const clean = base.replace(/[.|{}[\]]/g, "").slice(0, 55).trim() || "Knoten";
  const taken = new Set(graph.nodes.map((n) => n.label.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`.toLowerCase())) return `${clean} ${i}`;
}

// Nodes in graph order: triggers first (by position), then depth first
// along their edges in port order; unconnected nodes last. The order of Tab
// on the canvas and of the list view.
export function orderedNodes(graph: WorkflowGraph): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: WorkflowNode[] = [];
  const visit = (n: WorkflowNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
    for (const port of nodePorts(n)) for (const e of outgoing(graph, n.id, port)) {
      const next = byId.get(e.to.node);
      if (next) visit(next);
    }
  };
  const byPos = (a: WorkflowNode, b: WorkflowNode) => a.position.y - b.position.y || a.position.x - b.position.x;
  for (const n of graph.nodes.filter((n) => isTrigger(n.type)).sort(byPos)) visit(n);
  for (const n of [...graph.nodes].sort(byPos)) visit(n);
  return out;
}

// The tree shown in the list view: each node once, below the node and port
// it is first reached from.
export type Outline = { node: WorkflowNode; depth: number; port: string | null; via: string | null }[];
export function outline(graph: WorkflowGraph): Outline {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: Outline = [];
  const visit = (n: WorkflowNode, depth: number, port: string | null, via: string | null) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push({ node: n, depth, port, via });
    const ports = nodePorts(n);
    const branching = ports.filter((p) => outgoing(graph, n.id, p).length).length > 1 || ports.some((p) => p !== "out" && outgoing(graph, n.id, p).length);
    for (const p of ports)
      for (const e of outgoing(graph, n.id, p)) {
        const next = byId.get(e.to.node);
        if (next) visit(next, branching ? depth + 1 : depth, branching ? p : null, n.id);
      }
  };
  const byPos = (a: WorkflowNode, b: WorkflowNode) => a.position.y - b.position.y || a.position.x - b.position.x;
  for (const n of graph.nodes.filter((n) => isTrigger(n.type)).sort(byPos)) visit(n, 0, null, null);
  for (const n of [...graph.nodes].sort(byPos)) visit(n, 0, null, null);
  return out;
}

// The display form of a stored text (names instead of ids); the stored
// text itself when it does not parse.
export function displayContext(graph: WorkflowGraph, locale: Locale, ws: Workspace): DisplayContext {
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const fieldsOf = (root: string) => {
    const n = graph.nodes.find((x) => x.id === root);
    const db = n && typeof n.config.database === "string" ? n.config.database : null;
    return db ? ws.fields.get(db) || [] : [];
  };
  return {
    locale,
    labels,
    keyName: (root, keys, key) => {
      if (keys[keys.length - 1] === "fields") return fieldsOf(root).find((f) => f.id === key)?.name.replace(/[.|{}[\]]/g, "") || key;
      return key;
    },
    keyId: (root, keys, name) => {
      if (keys[keys.length - 1] === "fields") return fieldsOf(root).find((f) => f.name.replace(/[.|{}[\]]/g, "").toLowerCase() === name.toLowerCase() || f.id === name)?.id || name;
      return name;
    },
  };
}
export function showText(text: string, ctx: DisplayContext) {
  try {
    return toDisplay(text, ctx);
  } catch {
    return text;
  }
}

// The name of a page reference (an id, or a placeholder in display form).
export function refText(value: unknown, ws: Workspace, ctx: DisplayContext, t: T) {
  if (typeof value !== "string" || !value.trim()) return "";
  if (isUuid(value)) return ws.pages.find((p) => p.id === value.trim())?.title || t("Seite ohne Zugriff", "Page without access");
  return showText(value, ctx);
}

// One line about a node's settings, on its card and in the list.
export function nodeSummary(node: WorkflowNode, ws: Workspace, ctx: DisplayContext, t: T): string {
  const c = node.config as Record<string, unknown>;
  const page = (id: unknown) => (isUuid(id) ? ws.pages.find((p) => p.id === id)?.title || t("Seite ohne Zugriff", "Page without access") : "");
  const fields = (db: unknown) => (typeof db === "string" ? ws.fields.get(db) || [] : []);
  const scope = (s: unknown) => {
    const v = (s || { kind: "workspace" }) as { kind: string; pageId?: string; spaceId?: string; depth?: string };
    if (v.kind === "below") return v.depth === "all" ? t(`irgendwo unter „${page(v.pageId)}“`, `anywhere below “${page(v.pageId)}”`) : t(`direkt unter „${page(v.pageId)}“`, `directly below “${page(v.pageId)}”`);
    if (v.kind === "space") return t(`im Bereich „${ws.spaces.find((x) => x.id === v.spaceId)?.name || "?"}“`, `in the space “${ws.spaces.find((x) => x.id === v.spaceId)?.name || "?"}”`);
    return t("im ganzen Arbeitsbereich", "in the whole workspace");
  };
  switch (node.type) {
    case "trigger.record.created":
    case "trigger.record.changed":
    case "trigger.record.done":
    case "trigger.form.submitted":
    case "trigger.record.date":
    case "action.record.create":
    case "action.record.find":
      return c.database ? `„${page(c.database)}“` : t("Datenbank wählen", "Choose a database");
    case "trigger.page.created":
    case "trigger.page.changed":
    case "trigger.page.moved":
    case "trigger.page.tagged":
    case "trigger.comment.created":
    case "trigger.mention":
      return scope(c.scope);
    case "trigger.schedule":
      return `${c.freq === "weekly" ? t("wöchentlich", "weekly") : c.freq === "monthly" ? t("monatlich", "monthly") : t("täglich", "daily")} · ${String(c.time || "09:00")}`;
    case "trigger.manual":
      return t("über „Ausführen“", "with “Run”");
    case "action.record.update": {
      const all = [...fields(c.database), ...[...ws.fields.values()].flat()];
      const names = Object.keys((c.values as object) || {}).map((k) => all.find((f) => f.id === k)?.name || k);
      return names.length ? names.join(", ") : t("Werte wählen", "Choose values");
    }
    case "action.page.append":
      return c.page ? t(`an „${refText(c.page, ws, ctx, t)}“`, `to “${refText(c.page, ws, ctx, t)}”`) : t("Seite wählen", "Choose a page");
    case "action.page.create":
      return c.parent ? t(`unter „${refText(c.parent, ws, ctx, t)}“`, `below “${refText(c.parent, ws, ctx, t)}”`) : t("Elternseite wählen", "Choose a parent page");
    case "action.page.move":
    case "action.page.tag":
      return refText(c.page, ws, ctx, t);
    case "notify.person": {
      const to = (c.to as string[]) || [];
      return to.length ? to.map((r) => recipientName(r, ws, ctx, t)).join(", ") : t("Empfänger wählen", "Choose recipients");
    }
    case "logic.if": {
      const n = ((c.condition as { rules?: unknown[] })?.rules || []).length;
      return n === 1 ? t("1 Bedingung", "1 condition") : t(`${n} Bedingungen`, `${n} conditions`);
    }
    case "logic.set":
      return (((c.values as { name: string }[]) || []).map((v) => v.name).join(", ") || t("Werte festlegen", "Define values")).slice(0, 80);
    case "logic.stop":
      return c.result === "failed" ? t("als Fehler", "as failed") : t("erfolgreich", "succeeded");
    case "logic.switch": {
      const n = ((c.cases as unknown[]) || []).length;
      return `${showText(String(c.value || ""), ctx).slice(0, 40) || "…"} · ${n === 1 ? t("1 Fall", "1 case") : t(`${n} Fälle`, `${n} cases`)}`;
    }
    case "logic.foreach":
      return `${showText(String(c.list || ""), ctx).slice(0, 50) || t("Liste wählen", "Choose a list")}${c.mode === "parallel" ? t(" · parallel", " · in parallel") : ""}`;
    case "logic.wait": {
      const units: Record<string, [string, string]> = { minutes: ["Min.", "min"], hours: ["Std.", "h"], days: ["Tage", "days"] };
      const u = units[String(c.unit || "hours")] || units.hours;
      if (c.mode === "until") return t(`bis ${showText(String(c.until || ""), ctx) || "…"}`, `until ${showText(String(c.until || ""), ctx) || "…"}`) + (c.time ? ` ${c.time}` : "");
      if (c.mode === "next") return t(`bis zum nächsten ${c.weekdays ? "Werktag" : "Tag"} ${c.time || "09:00"}`, `until the next ${c.weekdays ? "working day" : "day"} ${c.time || "09:00"}`);
      return `${Number(c.amount || 1)} ${t(u[0], u[1])}`;
    }
    case "logic.approval": {
      const to = (c.approvers as string[]) || [];
      return to.length ? to.map((r) => recipientName(r, ws, ctx, t)).join(", ") : t("Freigebende wählen", "Choose approvers");
    }
    case "ai.summarize":
    case "ai.extract":
    case "ai.classify":
      return showText(String(c.text || ""), ctx).slice(0, 60) || t("Text wählen", "Choose a text");
    case "ai.prompt":
      return showText(String(c.prompt || ""), ctx).slice(0, 60) || t("Anweisung schreiben", "Write a prompt");
    case "http.request": {
      const url = String(c.url || "");
      const host = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1] || "";
      return host ? `${c.method || "GET"} ${host}` : t("Adresse eingeben", "Enter an address");
    }
    case "notify.email": {
      const to = (c.to as string[]) || [];
      return to.length ? to.map((r) => (r.includes("@") && !r.includes("{{") ? r : recipientName(r, ws, ctx, t))).join(", ").slice(0, 80) : t("Empfänger wählen", "Choose recipients");
    }
    case "notify.chat":
      return c.webhook ? t("an einen Chat-Webhook", "to a chat webhook") : t("Webhook wählen", "Choose a webhook");
    case "trigger.webhook":
      return c.mode === "token" ? t("nur Token", "token only") : t("signiert", "signed");
    case "trigger.mail.received":
      return c.address ? t("an eine Workflow-Adresse", "to a workflow address") : t("Adresse wählen", "Choose an address");
    case "trigger.journal.day":
      return c.journal ? `„${page(c.journal)}“` : t("jedes Journal", "any journal");
  }
  return "";
}
export function recipientName(r: string, ws: Workspace, ctx: DisplayContext, t: T) {
  if (r === "@actor") return t("Auslösende Person", "Person who triggered it");
  if (r === "@creator") return t("Ersteller des Eintrags", "Creator of the record");
  if (r === "@runner") return t("Ausführende Person", "Person running it");
  if (r.startsWith("field:")) return t(`Personen aus „${r.slice(6)}“`, `People from “${r.slice(6)}”`);
  return ws.members.find((m) => m.id === r)?.name || showText(r, ctx);
}

// The output tree of a node for the picker: its catalogue outputs, with
// the properties of its database below record.fields, and the named
// values of logic.set.
export function outputTree(node: WorkflowNode, ws: Workspace): OutputField[] {
  const s = nodeSpec(node.type);
  if (!s) return [];
  const db = typeof node.config.database === "string" ? node.config.database : null;
  const props: OutputField[] = (db ? ws.fields.get(db) || [] : []).map((f) => ({
    key: f.id,
    label: [f.name, f.name],
    type: f.type === "number" ? "number" : f.type === "checkbox" ? "boolean" : f.type === "date" ? "date" : f.type === "person" ? "person" : "text",
  }));
  const fill = (fields: OutputField[]): OutputField[] =>
    fields.map((f) =>
      f.type === "record" ? { ...f, children: RECORD_OUTPUT.map((r) => (r.key === "fields" ? { ...r, children: props } : r)) } : f.children ? { ...f, children: fill(f.children) } : f,
    );
  if (node.type === "logic.set")
    return ((node.config.values as { name: string; type?: string }[]) || []).map((v) => ({ key: v.name, label: [v.name, v.name], type: v.type === "number" ? "number" : v.type === "boolean" ? "boolean" : "text" }));
  // Typed AI fields, the expected fields of a webhook body.
  if (node.type === "ai.extract")
    return s.outputs.map((o) => (o.key === "fields" ? { ...o, children: aiFieldOutputs(node.config.fields as AiField[]) } : o));
  if (node.type === "ai.prompt")
    return s.outputs.map((o) => (o.key === "json" ? { ...o, children: aiFieldOutputs(node.config.fields as AiField[]) } : o));
  if (node.type === "trigger.webhook")
    return s.outputs.map((o) =>
      o.key === "body"
        ? { ...o, children: ((node.config.fields as { name: string; type: string }[]) || []).map((f) => ({ key: f.name, label: [f.name, f.name] as [string, string], type: (["text", "number", "boolean", "date", "object", "list"].includes(f.type) ? f.type : "text") as OutputField["type"] })) }
        : o,
    );
  return fill(s.outputs);
}

export const issuesOf = (issues: Issue[], nodeId: string) => issues.filter((i) => i.nodeId === nodeId);
export const worstLevel = (issues: Issue[]) => (issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : null);

export function duration(ms: number | null | undefined, locale: Locale) {
  if (ms === null || ms === undefined || ms < 0) return "";
  const tag = localeTag(locale);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(tag, { maximumFractionDigits: 1 })} s`;
  return `${Math.round(ms / 60_000)} min`;
}

// useT() with a stable identity per language (useT() makes a new function on
// every render; the canvas derives its nodes from it).
export function useStableT(): T {
  const locale = useLocale();
  return useMemo(() => {
    const pick = translate(locale);
    return (de: string, en?: string) => (en === undefined ? translateLabel(de, locale) : pick(de, en));
  }, [locale]);
}

// The difference of two graphs (§10.2 draft changes, §10.5 versions):
// nodes added, removed and changed (with the settings before and after),
// connections added and removed. Positions and notes do not count.
export type GraphDiff = {
  added: WorkflowNode[];
  removed: WorkflowNode[];
  changed: { node: WorkflowNode; before: WorkflowNode; keys: { key: string; before: unknown; after: unknown }[] }[];
  edgesAdded: number;
  edgesRemoved: number;
};
export function graphDiff(before: WorkflowGraph, after: WorkflowGraph): GraphDiff {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const out: GraphDiff = { added: [], removed: [], changed: [], edgesAdded: 0, edgesRemoved: 0 };
  for (const n of after.nodes) {
    const old = a.get(n.id);
    if (!old) {
      out.added.push(n);
      continue;
    }
    const keys: GraphDiff["changed"][number]["keys"] = [];
    const cmp = (key: string, x: unknown, y: unknown) => JSON.stringify(x ?? null) !== JSON.stringify(y ?? null) && keys.push({ key, before: x, after: y });
    cmp("label", old.label, n.label);
    cmp("disabled", old.disabled, n.disabled);
    cmp("onError", old.onError, n.onError);
    for (const k of new Set([...Object.keys(old.config || {}), ...Object.keys(n.config || {})])) cmp(k, old.config?.[k], n.config?.[k]);
    if (keys.length) out.changed.push({ node: n, before: old, keys });
  }
  for (const n of before.nodes) if (!b.has(n.id)) out.removed.push(n);
  const ea = new Set(before.edges.map((e) => `${e.from.node}:${e.from.port}>${e.to.node}`));
  const eb = new Set(after.edges.map((e) => `${e.from.node}:${e.from.port}>${e.to.node}`));
  for (const e of eb) if (!ea.has(e)) out.edgesAdded++;
  for (const e of ea) if (!eb.has(e)) out.edgesRemoved++;
  return out;
}
export const diffSize = (d: GraphDiff) => d.added.length + d.removed.length + d.changed.length + d.edgesAdded + d.edgesRemoved;
