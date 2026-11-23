// Plans in "KI fragen" (#462): what the browser and the server share – the
// limits, the shapes of a checked plan and its results, which steps depend
// on which, and the quick guess whether an input is plainly a question.
// No server imports: components/ai-plan.tsx and lib/ai/client.ts use it.

export const PLAN_LIMITS = {
  steps: 30,
  // Reading rounds before the plan (search, read a page, list pages, read a database).
  rounds: 8,
  // Read calls the model may make in one round.
  callsPerRound: 4,
  // What one read call hands to the model, and all of them together.
  resultChars: { local: 6_000, remote: 14_000 },
  readChars: { local: 30_000, remote: 120_000 },
  instruction: 4000,
  // Text edits of one step (suggested changes).
  edits: 30,
  tags: 20,
  values: 20,
  targets: 50,
} as const;

export const PLAN_TOOLS = [
  "create_page",
  "create_database",
  "create_tasks",
  "append_text",
  "create_record",
  "update_record",
  "insert_link",
  "set_relation",
  "rename_page",
  "move_page",
  "set_properties",
  "edit_text",
] as const;
export type PlanTool = (typeof PLAN_TOOLS)[number];

// A local reference: "$page1" names a page (database, record) a step
// creates; later steps use it in place of an id.
export const REF_PATTERN = /^\$[A-Za-z][A-Za-z0-9_]{0,30}$/;
export const isRef = (value: unknown): value is string => typeof value === "string" && REF_PATTERN.test(value);

// What the browser shows for one step. `step` is the checked, normalised
// step (ids resolved) that comes back with "Ausführen" – and is checked
// again there. `problem` (German, localised by the browser) when it cannot
// run; `needs`: the steps whose result it uses ($refs); `unmentioned`: it
// changes a page the instruction did not name.
export type PlanPreview = {
  index: number;
  tool: string;
  step: Record<string, unknown> | null;
  ok: boolean;
  problem?: string;
  needs: number[];
  unmentioned?: boolean;
  view: PlanView;
};
export type PlanView = {
  // Where it happens: the page, database, record or space.
  target: string;
  title?: string;
  markdown?: string;
  tasks?: { text: string; assignee?: string; due?: string }[];
  cells?: { name: string; value: string }[];
  // Move and rename: from → to.
  from?: string;
  to?: string;
  // Links: where the link goes ("under ‹heading›" or the end) and to what.
  link?: { to: string; heading?: string };
  tags?: { add: string[]; remove: string[] };
  // Suggested changes: per block the text now and the text proposed.
  diff?: { op: string; before: string; after: string }[];
  // A new database: its properties.
  fields?: { name: string; type: string }[];
  records?: number;
};

// How to take one result back ("Alles rückgängig").
export type PlanUndo =
  | { kind: "trash_page"; pageId: string }
  | { kind: "trash_row"; pageId: string; rowId: string }
  | { kind: "rename"; pageId: string; title: string }
  | { kind: "move"; pageId: string; spaceId: string; parentId: string | null; afterId: string | null }
  | { kind: "properties"; pageId: string; tags: string[]; values: Record<string, unknown> }
  | { kind: "remove_blocks"; pageId: string; blockIds: string[] }
  | { kind: "withdraw"; pageId: string; suggestionIds: string[] }
  | { kind: "cells"; pageId: string; rowId: string; cells: Record<string, unknown> };

export type PlanStepResult = {
  index: number;
  tool: string;
  ok: boolean;
  error?: string;
  // Not run because a step it depends on did not run.
  skipped?: boolean;
  pageId?: string;
  rowId?: string;
  title?: string;
  undo?: PlanUndo;
};
export type PlanUndoResult = { index: number; ok: boolean; error?: string };

// What a planning request ends with.
export type PlanOutcome =
  | { kind: "question"; tokens: PlanTokens }
  | { kind: "plan"; summary: string; steps: PlanPreview[]; read: PlanReadItem[]; tokens: PlanTokens; rounds: number; stopped?: "rounds" | "quota" | "size" };
// What the model read before planning (shown while reading and with the plan).
export type PlanReadItem = { kind: "search" | "page" | "list" | "database"; title: string };
export type PlanTokens = { input: number; output: number };
// The lines of the planning stream (NDJSON): progress, then the outcome or an error.
export type PlanEvent =
  | { type: "thinking"; round: number }
  | { type: "reading"; round: number; items: PlanReadItem[] }
  | { type: "outcome"; outcome: PlanOutcome }
  | { type: "error"; error: string };

// Every step that needs `index`, directly or through others.
export function dependents(steps: Pick<PlanPreview, "index" | "needs">[], index: number): number[] {
  const out = new Set<number>();
  const visit = (i: number) => {
    for (const s of steps) if (s.needs.includes(i) && !out.has(s.index)) {
      out.add(s.index);
      visit(s.index);
    }
  };
  visit(index);
  return [...out].sort((a, b) => a - b);
}

// The steps that can run from a choice: impossible ones never, a step
// whose prerequisite is impossible or not chosen neither – with the step
// it waits for as the reason.
export function effectiveSelection(steps: Pick<PlanPreview, "index" | "needs" | "ok">[], chosen: Iterable<number>) {
  const picked = new Set(chosen);
  const selected = new Set<number>();
  const blockedBy = new Map<number, number>();
  for (const s of [...steps].sort((a, b) => a.index - b.index)) {
    if (!s.ok || !picked.has(s.index)) continue;
    const missing = s.needs.find((n) => !selected.has(n));
    if (missing !== undefined) blockedBy.set(s.index, missing);
    else selected.add(s.index);
  }
  return { selected, blockedBy };
}

// Plainly a question: ends with "?", starts with a question word or asks
// for an answer ("Fasse … zusammen", "Erkläre …"), and names nothing to
// change. Everything else goes to the planner, where the model decides (it
// may answer that the input is a question after all).
const QUESTION_START =
  /^(wer|wen|wem|wessen|was|wie|wo|wann|warum|weshalb|wieso|welche[rsmn]?|gibt es|who|whom|whose|what|how|where|when|why|which|is there|are there|qui|que|quoi|comment|où|quand|pourquoi|quel(le)?s?|кто|что|как|где|когда|почему|какой|谁|什么|怎么|哪里|为什么)(?=[\s,?？]|$)/iu;
const ACTION_WORDS = [
  // German and French stems (any ending), English and French words as a whole.
  /(^|[^\p{L}])(erstell|leg\p{L}*\s.*\san\b|stell\p{L}*\s.*\sum\b|umstell|anleg|verschieb|umbenenn|benenn\p{L}*\s.*\sum\b|verlink|verknüpf|tagg|änder|überarbeit|schreib\p{L}*\s.*\sum\b|umschreib|kürz|hinzu|sortier|ordne|organisier|erzeug|crée|ajout|déplac|renomm|modifi|réécri)/iu,
  /\b(create|add|make|move|rename|link|tag|set|change|rewrite|shorten|edit|organi[sz]e|sort|put|insert|update|lie|relie)\b/i,
  /(создай|добавь|перемести|переименуй|измени|свяжи|创建|添加|移动|重命名|链接|修改|整理)/u,
];
// Asking for an answer, not for a change.
const ANSWER_START =
  /^(bitte\s+)?(fass\p{L}*|zusammenfass\p{L}*|erklär\p{L}*|erläuter\p{L}*|übersetz\p{L}*|nenn\p{L}*|zeig\p{L}*|find\p{L}*|such\p{L}*|vergleich\p{L}*|beschreib\p{L}*|list\p{L}*|gib mir|sag mir|please\s+\p{L}+|summari[sz]e|explain|translate|tell|show|find|search|compare|describe|give me|résume|explique|traduis|montre|cherche|compare|décris|объясни|покажи|найди|опиши|总结|解释|翻译|显示|查找)(?=[\s,:]|$)/iu;
export function plainQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (ACTION_WORDS.some((words) => words.test(t))) return false;
  return /[?？]$/.test(t) || QUESTION_START.test(t) || ANSWER_START.test(t);
}
