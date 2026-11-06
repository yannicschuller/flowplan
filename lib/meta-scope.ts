// Scopes of tags, page property definitions and saved templates (#136), the
// part shared by the server and the browser: what a move or a template from
// another space brings along that its destination does not know, and what
// to do with each – map it to one there, copy it there, or remove it. Never
// lost without such a choice. lib/meta-scope-server.ts has the storage side.
//
// Decisions (documented in the docs, "Tags", "Eigenschaften", "Vorlagen"):
// - New tags, definitions and templates belong to the current space by
//   default; what existed before #136 belongs to the whole workspace.
// - Names are unique within a context (a space plus the workspace), ignoring
//   case; two spaces may use the same name, each its own item.
// - Never merged by name on their own: a move or template proposes the
//   same-named item as the target of "map", the person confirms.
import type { PagePropertyType, PageTagColor } from "./page-properties";

export type MetaKind = "tag" | "property";
export type MetaChoice = { action: "map"; to: string } | { action: "copy" } | { action: "remove" };
// Per item (by its id for moves, by `tag:<name>`/`property:<name>` for
// templates) a choice; `default` for the rest – "auto": map to the
// same-named one where there is one, else copy.
export type MetaPlan = {
  tags?: Record<string, MetaChoice>;
  properties?: Record<string, MetaChoice>;
  default?: "auto" | "copy" | "remove";
};
export type MetaCandidate = { id: string; name: string; spaceId: string | null; color?: PageTagColor; type?: PagePropertyType };
// One tag or definition a move or template brings that is not at home where
// it goes.
export type ForeignMeta = {
  kind: MetaKind;
  // Moves: the item's id; templates: `tag:<folded name>` / `property:<…>`.
  id: string;
  name: string;
  color?: PageTagColor;
  type?: PagePropertyType;
  // Where it comes from (null: the whole workspace) and its name.
  spaceId: string | null;
  spaceName?: string;
  // Pages (with the tag or a value) and database records (tag-backed
  // properties) that carry it.
  pages: number;
  records: number;
  // The same-named one where it goes (same type for properties): what "map"
  // proposes.
  sameName: string | null;
  // What "map" may choose: the destination's (definitions of the same type).
  candidates: MetaCandidate[];
};

export const metaKey = (kind: MetaKind, name: string) => `${kind}:${name.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;

// The choice a plan makes for an item (undefined: none – the server refuses).
export function choiceFor(item: Pick<ForeignMeta, "kind" | "id" | "sameName">, plan: MetaPlan | undefined): MetaChoice | undefined {
  const own = (item.kind === "tag" ? plan?.tags : plan?.properties)?.[item.id];
  if (own) return own;
  if (!plan?.default) return undefined;
  if (plan.default === "auto") return item.sameName ? { action: "map", to: item.sameName } : { action: "copy" };
  return { action: plan.default };
}
// What the dialog preselects: the same-named one, else a copy.
export const defaultChoice = (item: Pick<ForeignMeta, "kind" | "id" | "sameName">): MetaChoice => choiceFor(item, { default: "auto" })!;

export function planFrom(items: ForeignMeta[], choices: Record<string, MetaChoice>): MetaPlan {
  const plan: MetaPlan = { tags: {}, properties: {} };
  for (const item of items) (item.kind === "tag" ? plan.tags! : plan.properties!)[item.id] = choices[`${item.kind}:${item.id}`] ?? defaultChoice(item);
  return plan;
}
