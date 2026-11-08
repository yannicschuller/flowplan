// The database rules ("Automationen", lib/database-settings-schema.ts) as
// workflow graphs (docs/specs/workflows.md §2): automationToGraph() makes a
// small linear graph of a rule, which the engine runs (lib/workflows/
// inline.ts, the same behaviour as before); graphToAutomation() goes back
// while the form can still express the graph (else null). Pure, client-safe.
import type { Automation, AutomationAction } from "../database-settings-schema";
import type { Field } from "../types";
import { GRAPH_FORMAT, GRAPH_VERSION, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from "./graph";
import type { WorkflowCondition } from "./catalog";

// Six stable characters from a rule id: node ids stay the same for a rule.
function shortHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36).padStart(6, "0").slice(-6);
}
const FIELD_LEFT = /^\{\{(n_[a-z0-9]+)\.record\.fields\.([^.|{}\s]+)\}\}$/;
export const fieldLeft = (triggerId: string, fieldId: string) => `{{${triggerId}.record.fields.${fieldId}}}`;
// The property a condition's left side names directly, if it does.
export function conditionField(left: string): { node: string; field: string } | null {
  const m = FIELD_LEFT.exec(left.trim());
  return m ? { node: m[1], field: m[2] } : null;
}

export function automationToGraph(a: Automation, databaseId: string, fields: Field[] = []): WorkflowGraph {
  const h = shortHash(`${databaseId}:${a.id}`);
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const triggerId = `n_${h}t0`;
  const t = a.trigger;
  const base = { typeVersion: 1, note: "", disabled: false };
  const trigger: WorkflowNode =
    t.type === "created"
      ? { ...base, id: triggerId, type: "trigger.record.created", label: "Trigger", position: { x: 0, y: 0 }, config: { database: databaseId, includeForm: true } }
      : t.type === "form"
        ? { ...base, id: triggerId, type: "trigger.form.submitted", label: "Trigger", position: { x: 0, y: 0 }, config: { database: databaseId } }
        : t.type === "changed"
          ? { ...base, id: triggerId, type: "trigger.record.changed", label: "Trigger", position: { x: 0, y: 0 }, config: { database: databaseId, fields: [t.field], ...(t.to ? { to: t.to } : {}) } }
          : t.type === "overdue"
            ? { ...base, id: triggerId, type: "trigger.record.date", label: "Trigger", position: { x: 0, y: 0 }, config: { database: databaseId, field: t.field, offsetDays: 0, mode: "overdue" } }
            : {
                ...base,
                id: triggerId,
                type: "trigger.schedule",
                label: "Trigger",
                position: { x: 0, y: 0 },
                config: { freq: t.freq, interval: t.interval, weekday: t.weekday, day: t.day, time: t.time, timeZone: t.timeZone },
              };
  nodes.push(trigger);
  let previous = { node: triggerId, port: "out" };
  let x = 320;
  const link = (node: WorkflowNode, port = "out") => {
    nodes.push(node);
    edges.push({ id: `e_${edges.length + 1}`, from: previous, to: { node: node.id, port: "in" } });
    previous = { node: node.id, port };
    x += 320;
  };
  if (a.conditions.length)
    link(
      {
        ...base,
        id: `n_${h}c0`,
        type: "logic.if",
        label: "Conditions",
        position: { x, y: 0 },
        config: {
          condition: {
            kind: "group",
            join: "and",
            rules: a.conditions.map((c): WorkflowCondition => ({
              kind: "condition",
              left: fieldLeft(triggerId, c.field),
              op: c.op,
              value: c.value,
              ...(c.values ? { values: c.values } : {}),
              ...(c.to !== undefined ? { to: c.to } : {}),
              ...(c.timeZone ? { timeZone: c.timeZone } : {}),
              ...(c.days !== undefined ? { days: c.days } : {}),
            })),
          },
        },
      },
      "true",
    );
  const name = (f: string) => fields.find((x) => x.id === f)?.name || f;
  a.actions.forEach((action, i) => {
    const nid = `n_${h}a${i}`;
    const at = { ...base, id: nid, position: { x, y: 0 } };
    if (action.type === "set")
      link({ ...at, type: "action.record.update", label: `Set ${i + 1}`, note: name(action.field), config: { record: "", database: databaseId, values: { [action.field]: action.value }, onlyEmpty: false } });
    else if (action.type === "notify")
      link({
        ...at,
        type: "notify.person",
        label: `Notify ${i + 1}`,
        config: { to: [action.to], title: "", message: action.message, link: "trigger", channels: ["inbox"], kind: "automation", ruleName: a.name },
      });
    else if (action.type === "template")
      link({ ...at, type: "action.record.template", label: `Template ${i + 1}`, config: { record: "", database: databaseId, template: action.template, mode: action.mode } });
    else {
      const values: Record<string, unknown> = { ...action.cells };
      for (const [fieldId, days] of Object.entries(action.dates)) values[fieldId] = `{{${triggerId}.slot.date | add_days: ${days}}}`;
      link({ ...at, type: "action.record.create", label: `Create ${i + 1}`, config: { database: databaseId, template: action.template, values } });
    }
  });
  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    settings: { timeZone: t.type === "schedule" ? t.timeZone : "UTC", triggerOnOwnChanges: false, limits: {} },
    nodes,
    edges,
  };
}

// Back to a rule, while the form can show the graph: one trigger the
// rules know, at most one condition group (all "and", on the trigger's
// record), then a line of actions the rules know. Otherwise null.
export function graphToAutomation(graph: WorkflowGraph, base: Pick<Automation, "id" | "name" | "enabled">): Automation | null {
  const triggers = graph.nodes.filter((n) => n.type.startsWith("trigger."));
  if (triggers.length !== 1) return null;
  const tr = triggers[0];
  const c = tr.config as Record<string, unknown>;
  let trigger: Automation["trigger"];
  if (tr.type === "trigger.record.created" && c.includeForm !== false) trigger = { type: "created" };
  else if (tr.type === "trigger.form.submitted") trigger = { type: "form" };
  else if (tr.type === "trigger.record.changed" && Array.isArray(c.fields) && c.fields.length === 1 && c.from === undefined)
    trigger = { type: "changed", field: String(c.fields[0]), ...(c.to ? { to: String(c.to) } : {}) };
  else if (tr.type === "trigger.record.date" && c.mode === "overdue" && !c.offsetDays && !c.time) trigger = { type: "overdue", field: String(c.field) };
  else if (tr.type === "trigger.schedule")
    trigger = {
      type: "schedule",
      freq: c.freq as "daily",
      interval: Number(c.interval ?? 1),
      weekday: Number(c.weekday ?? 1),
      day: Number(c.day ?? 1),
      time: String(c.time ?? "09:00"),
      timeZone: String(c.timeZone || graph.settings.timeZone || "UTC"),
    };
  else return null;
  const conditions: Automation["conditions"] = [];
  const actions: AutomationAction[] = [];
  let current = tr.id,
    port = "out";
  const seen = new Set<string>();
  for (;;) {
    const next = graph.edges.filter((e) => e.from.node === current);
    if (!next.length) break;
    if (next.length !== 1 || next[0].from.port !== port) return null;
    const node = graph.nodes.find((n) => n.id === next[0].to.node);
    if (!node || seen.has(node.id) || node.disabled || node.onError) return null;
    if (graph.edges.filter((e) => e.to.node === node.id).length !== 1) return null;
    seen.add(node.id);
    const nc = node.config as Record<string, unknown>;
    if (node.type === "logic.if") {
      if (actions.length || conditions.length) return null;
      const group = nc.condition as { join?: string; rules?: Record<string, unknown>[] } | undefined;
      if (!group || (group.join && group.join !== "and")) return null;
      for (const rule of group.rules || []) {
        if (rule.kind !== "condition") return null;
        const target = conditionField(String(rule.left));
        if (!target || target.node !== tr.id) return null;
        if ([rule.value, rule.to, ...((rule.values as unknown[]) || [])].some((v) => typeof v === "string" && v.includes("{{"))) return null;
        conditions.push({
          field: target.field,
          op: rule.op as Automation["conditions"][number]["op"],
          value: String(rule.value ?? ""),
          ...(rule.values ? { values: rule.values as string[] } : {}),
          ...(rule.to !== undefined ? { to: String(rule.to) } : {}),
          ...(rule.timeZone ? { timeZone: String(rule.timeZone) } : {}),
          ...(rule.days !== undefined ? { days: Number(rule.days) } : {}),
        });
      }
      current = node.id;
      port = "true";
      if (graph.edges.some((e) => e.from.node === node.id && e.from.port === "false")) return null;
      continue;
    }
    if (node.type === "action.record.update") {
      const entries = Object.entries((nc.values as Record<string, unknown>) || {});
      if (nc.record || nc.onlyEmpty || !entries.length) return null;
      for (const [field, value] of entries) {
        if (typeof value === "string" && value.includes("{{")) return null;
        actions.push({ type: "set", field, value });
      }
    } else if (node.type === "notify.person") {
      const to = nc.to as string[];
      const message = String(nc.message || "");
      if (to?.length !== 1 || nc.title || message.includes("{{") || JSON.stringify(nc.channels) !== '["inbox"]' || nc.kind !== "automation") return null;
      actions.push({ type: "notify", to: to[0], message });
    } else if (node.type === "action.record.template") {
      if (nc.record) return null;
      actions.push({ type: "template", template: String(nc.template), mode: nc.mode === "append" ? "append" : "empty" });
    } else if (node.type === "action.record.create" && trigger.type === "schedule") {
      const cells: Record<string, unknown> = {};
      const dates: Record<string, number> = {};
      for (const [field, value] of Object.entries((nc.values as Record<string, unknown>) || {})) {
        const m = typeof value === "string" ? /^\{\{(n_[a-z0-9]+)\.slot\.date \| add_days: (-?\d+)\}\}$/.exec(value) : null;
        if (m && m[1] === tr.id) dates[field] = Number(m[2]);
        else if (typeof value === "string" && value.includes("{{")) return null;
        else cells[field] = value;
      }
      actions.push({ type: "create", template: String(nc.template || ""), cells, dates });
    } else return null;
    current = node.id;
    port = "out";
  }
  if (seen.size !== graph.nodes.length - 1 || !actions.length || actions.length > 10) return null;
  // Scheduled rules only create; other rules never do.
  if ((trigger.type === "schedule") !== actions.every((a) => a.type === "create")) return null;
  return { ...base, trigger, conditions, actions };
}
