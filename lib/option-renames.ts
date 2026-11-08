// Renamed options of select and multi-select properties: the property
// editor sees which names were renamed (or merged into another option),
// and the server carries everything that stores the old name over to the
// new one (lib/option-renames-server.ts). Client-safe (no server imports).
import { z } from "zod";
import { groupKey, pathCollapseKey } from "./database-groups";
import { MAX_ORDERED_ROWS } from "./row-order";
import type { DatabaseSettings } from "./database-settings-schema";
import type { FilterGroup, FilterNode, View } from "./types";

export const optionRenamesSchema = z
  .array(z.object({ field: z.string().min(1).max(500), from: z.string().max(100), to: z.string().min(1).max(100) }))
  .max(1000);
export type OptionRename = z.infer<typeof optionRenamesSchema>[number];
// Per property: old name → new name.
export type RenameMaps = Map<string, Map<string, string>>;

// The options as saved: trimmed, without empty entries and duplicates.
export const cleanOptions = (options: string[]) => [...new Set(options.map((o) => o.trim()).filter(Boolean))];

// The options list is edited as text ("A, B, C"). An option counts as
// renamed when a new name takes its place in the list ("A, B, C" →
// "A, X, C"). A name written a second time in place of an option merges
// that option into it ("A, B" → "A, A": B's records get A). Everything else
// is an added or removed option, as before: a name removed in one place
// and another added elsewhere is not guessed to be a rename.
export function optionRenames(before: string[], typed: string[]): { from: string; to: string }[] {
  const after = typed.map((o) => o.trim());
  const kept = new Set(after.filter(Boolean)),
    known = new Set(before);
  const count = (name: string) => after.filter((o) => o === name).length;
  const out: { from: string; to: string }[] = [],
    paired = new Set<string>(),
    created = new Set<string>();
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const from = before[i],
      to = after[i];
    if (!from || !to || kept.has(from) || paired.has(from)) continue;
    if (!known.has(to) && !created.has(to)) {
      out.push({ from, to });
      paired.add(from);
      created.add(to);
    } else if (count(to) > 1) {
      out.push({ from, to });
      paired.add(from);
    }
  }
  return out;
}

// A merge: the new name was an option already, or an earlier rename in
// the list leads to it (two options renamed to one new name).
export function mergesOf(renames: OptionRename[], optionsBefore: (field: string) => string[]) {
  return renames.filter(
    (r, i) => optionsBefore(r.field).includes(r.to) || renames.slice(0, i).some((o) => o.field === r.field && o.to === r.to),
  );
}

// Whether an option has settings of its own under "Workflow and done"
// (counts as done, transitions, required properties, owners only), which
// a merge into another option drops.
export function hasOwnSettings(settings: DatabaseSettings | undefined, field: string, option: string) {
  const flow = settings?.workflow?.field === field ? settings.workflow : undefined;
  return (
    (settings?.done?.field === field && settings.done.values.includes(option)) ||
    (!!flow && (Object.hasOwn(flow.transitions, option) || Object.hasOwn(flow.required, option) || flow.ownersOnly.includes(option)))
  );
}

export function renameMaps(renames: OptionRename[]): RenameMaps {
  const maps: RenameMaps = new Map();
  for (const r of renames) {
    const map = maps.get(r.field) || new Map<string, string>();
    map.set(r.from, r.to);
    maps.set(r.field, map);
  }
  return maps;
}

// A list of names with the renamed ones replaced; a merge leaves no
// duplicate. `null` when nothing changed.
function renamedList(values: unknown, map: Map<string, string>): string[] | null {
  if (!Array.isArray(values) || !values.some((v) => typeof v === "string" && map.has(v))) return null;
  return [...new Set(values.map((v) => (typeof v === "string" ? (map.get(v) ?? v) : v)))];
}

// Record values (records, record templates, form drafts, automations):
// changes `cells` in place, true when something changed.
export function renameCells(cells: Record<string, unknown>, maps: RenameMaps) {
  let changed = false;
  for (const [fid, map] of maps) {
    const value = cells[fid];
    if (typeof value === "string" && map.has(value)) {
      cells[fid] = map.get(value);
      changed = true;
    } else {
      const list = renamedList(value, map);
      if (list) {
        cells[fid] = list;
        changed = true;
      }
    }
  }
  return changed;
}

type Condition = { field: string; value: string; values?: string[] };
function renameCondition<C extends Condition>(c: C, maps: RenameMaps): C {
  const map = maps.get(c.field);
  if (!map) return c;
  const values = renamedList(c.values, map);
  return {
    ...c,
    ...(map.has(c.value) ? { value: map.get(c.value)! } : {}),
    ...(values ? { values } : {}),
  };
}
function renameGroup(group: FilterGroup, maps: RenameMaps): FilterGroup {
  return {
    ...group,
    rules: group.rules.map((r: FilterNode) => (r.kind === "group" ? renameGroup(r, maps) : renameCondition(r, maps))),
  };
}

// Group keys (board columns, collapsed and ordered groups, WIP limits,
// card order) are the JSON of the value; a merged one keeps the target's
// entry where both exist.
function renameKey(key: string, map: Map<string, string>) {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return key;
  }
  return typeof value === "string" && map.has(value) ? groupKey(map.get(value)) : key;
}
function renameKeys(keys: string[], map: Map<string, string>) {
  return [...new Set(keys.map((k) => renameKey(k, map)))];
}
function renameRecord<V>(entries: Record<string, V>, map: Map<string, string>, merge?: (target: V, source: V) => V) {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(entries)) if (renameKey(k, map) === k) out[k] = v;
  for (const [k, v] of Object.entries(entries)) {
    const next = renameKey(k, map);
    if (next === k) continue;
    out[next] = !(next in out) ? v : merge ? merge(out[next], v) : out[next];
  }
  return out;
}

// Collapsed nested groups are addressed by the keys of all their levels
// (["sub", level 1, level 2, …]; swimlanes ["sub", "lane", subgroup]),
// each renamed with the property of its level.
function renamePathKey(key: string, levels: (Map<string, string> | undefined)[]) {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return key;
  }
  if (!Array.isArray(value) || value[0] !== "sub") return key;
  const lane = value[1] === "lane",
    path = value.slice(lane ? 2 : 1);
  if (!path.every((part) => typeof part === "string")) return key;
  const next = (path as string[]).map((part, i) => {
    const map = levels[i + (lane ? 1 : 0)];
    return map ? renameKey(part, map) : part;
  });
  return next.some((part, i) => part !== path[i]) ? pathCollapseKey([...(lane ? ["lane"] : []), ...next]) : key;
}

// Filters, filter groups and the grouping state of the views (on every
// grouping level); changes the views in place.
export function renameInViews(views: View[], maps: RenameMaps) {
  for (const v of views) {
    v.filters = v.filters.map((f) => renameCondition(f, maps));
    if (v.filterGroup) v.filterGroup = renameGroup(v.filterGroup, maps);
    const levels = [v.groupBy, v.subGroupBy, ...(v.groupLevels || [])].map((fid) => (fid ? maps.get(fid) : undefined));
    if (!levels.some(Boolean)) continue;
    // Columns, their order, limits and card order belong to the first level.
    const map = levels[0];
    if (v.groupSettings)
      v.groupSettings = {
        ...v.groupSettings,
        collapsed: [...new Set(v.groupSettings.collapsed.map((k) => renamePathKey(map ? renameKey(k, map) : k, levels)))],
        ...(map && v.groupSettings.order ? { order: renameKeys(v.groupSettings.order, map) } : {}),
      };
    if (!map) continue;
    if (v.wip) v.wip = renameRecord(v.wip, map);
    if (v.groupRowOrder)
      v.groupRowOrder = renameRecord(v.groupRowOrder, map, (a, b) => [...new Set([...a, ...b])].slice(0, MAX_ORDERED_ROWS));
  }
}

// The done rule, workflow and automations of the database. A renamed
// option keeps its rules under the new name; an option merged into another
// one (`merges`, a subset of `maps`) gives up its own: the target keeps
// whether it counts as done, its transitions, required properties and
// whether only owners set it, and transitions to the merged option lead to
// the target. Returns the changed settings, or null.
export function renameInSettings(settings: DatabaseSettings, maps: RenameMaps, merges: RenameMaps = new Map()): DatabaseSettings | null {
  const next = structuredClone(settings);
  const name = (map: Map<string, string>, value: string) => map.get(value) ?? value;
  // Lists and keys that describe the option itself: a merged one goes.
  const own = (fid: string, values: string[]) => {
    const map = maps.get(fid)!,
      merged = merges.get(fid);
    return [...new Set(values.filter((v) => !merged?.has(v)).map((v) => name(map, v)))];
  };
  if (next.done && maps.has(next.done.field)) next.done.values = own(next.done.field, next.done.values);
  const flowMap = next.workflow && maps.get(next.workflow.field);
  if (next.workflow && flowMap) {
    const fid = next.workflow.field,
      merged = merges.get(fid);
    const transitions: Record<string, string[]> = {},
      required: Record<string, string[]> = {};
    for (const [from, to] of Object.entries(next.workflow.transitions))
      if (!merged?.has(from)) transitions[name(flowMap, from)] = [...new Set(to.map((v) => name(flowMap, v)))];
    for (const [status, fields] of Object.entries(next.workflow.required))
      if (!merged?.has(status)) required[name(flowMap, status)] = fields;
    next.workflow = { ...next.workflow, transitions, required, ownersOnly: own(fid, next.workflow.ownersOnly) };
  }
  for (const rule of next.automations || []) {
    const map = rule.trigger.type === "changed" ? maps.get(rule.trigger.field) : undefined;
    // "Changed to": a multi-select compares its values joined by ", ".
    if (rule.trigger.type === "changed" && map && rule.trigger.to)
      rule.trigger.to = map.has(rule.trigger.to)
        ? map.get(rule.trigger.to)!
        : [...new Set(rule.trigger.to.split(", ").map((v) => name(map, v)))].join(", ");
    rule.conditions = rule.conditions.map((c) => renameCondition(c, maps));
    for (const action of rule.actions) {
      if (action.type === "set") {
        const cells = { [action.field]: action.value };
        if (renameCells(cells, maps)) action.value = cells[action.field];
      } else if (action.type === "create") renameCells(action.cells, maps);
    }
  }
  return JSON.stringify(next) === JSON.stringify(settings) ? null : next;
}

// "Only show if …" conditions of a form (and of a survey) compare answers
// with option names. Works on the stored JSON; null when nothing changed.
export function renameInFormConfig(config: Record<string, unknown>, maps: RenameMaps): Record<string, unknown> | null {
  const next = structuredClone(config) as {
    logic?: Record<string, Condition>;
    blocks?: { showIf?: Condition }[];
    survey?: { items?: { showIf?: Condition }[] };
  };
  const condition = (c: Condition | undefined) => (c && typeof c.field === "string" && typeof c.value === "string" ? renameCondition(c, maps) : c);
  if (next.logic && typeof next.logic === "object")
    for (const [k, c] of Object.entries(next.logic)) next.logic[k] = condition(c)!;
  for (const block of Array.isArray(next.blocks) ? next.blocks : []) if (block?.showIf) block.showIf = condition(block.showIf);
  for (const item of Array.isArray(next.survey?.items) ? next.survey.items : []) if (item?.showIf) item.showIf = condition(item.showIf);
  return JSON.stringify(next) === JSON.stringify(config) ? null : (next as Record<string, unknown>);
}
