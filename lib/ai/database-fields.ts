// AI in databases – the parts without a provider call: AI properties
// (a prompt template over other properties and an output type), the
// constraints for what a model may write into a cell, and databases
// proposed from a description. lib/ai/database.ts runs the prompts.
//
// An AI property is a property of type text, select, multi-select or number
// with `ai: { prompt, auto?, autoBy? }`. Its values are ordinary cell
// values (filters, sorting, grouping, exports work as for any property);
// when and with which model a value was computed is kept in ai_cell_meta.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../auth";
import { all, id as uuid, one, run } from "../db";
import { isGuest } from "../permissions";
import { validDateValue } from "../date-values";
import type { Field, FieldType, Identity, Page, View } from "../types";
import { aiFilter } from "./access";
import { AI_REASON_TEXT } from "./features";
import { resolveAi } from "./resolve";
import { cellPlain, recordContent, recordTitle } from "./sources";

export type AiFieldConfig = { prompt: string; auto?: boolean; autoBy?: string };
export const AI_OUTPUT_TYPES = ["text", "select", "multiselect", "number"] as const satisfies readonly FieldType[];
// Properties "Mit KI ausfüllen" can fill.
export const AI_FILL_TYPES = ["text", "number", "select", "multiselect", "checkbox", "date", "url", "email", "phone"] as const satisfies readonly FieldType[];
// Properties a prompt may refer to as {Name}.
export const AI_REFERENCE_TYPES: FieldType[] = [
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "checkbox",
  "url",
  "email",
  "phone",
  "checklist",
  "person",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "id",
  "relation",
];
// Values that change with every write – also with the AI's own write of its
// value. They never count as input of an automatic property: the prompt
// would differ after each computation and queue the record again and again.
export const VOLATILE_REFERENCE_TYPES: FieldType[] = ["updated_at", "updated_by"];
// {Inhalt} / {Content} / {Contenu}: the record's page content (unless a property has that name).
export const CONTENT_REFERENCES = ["Inhalt", "Content", "Contenu"];
export const AI_PROMPT_MAX = 2000;
export const AI_TEXT_MAX = 4000;

export const aiFieldSchema = z.object({
  prompt: z.string().trim().min(1).max(AI_PROMPT_MAX),
  auto: z.boolean().optional(),
  autoBy: z.string().max(100).optional(),
});

// The {Name} references of a prompt, in order.
export const promptReferences = (prompt: string) => [...prompt.matchAll(/\{([^{}\n]{1,100})\}/g)].map((m) => m[1].trim());
export function referencedField(name: string, fields: Field[]): Field | undefined {
  const wanted = name.trim().toLowerCase();
  return fields.find((f) => f.id === name) || fields.find((f) => f.name.trim().toLowerCase() === wanted);
}
const isContentReference = (name: string, fields: Field[]) =>
  !referencedField(name, fields) && CONTENT_REFERENCES.some((c) => c.toLowerCase() === name.trim().toLowerCase());

const sameConfig = (a: Field, b: Field | undefined) =>
  !!b?.ai && a.type === b.type && a.ai?.prompt === b.ai.prompt && JSON.stringify(a.options || []) === JSON.stringify(b.options || []);

// Checks AI properties when a database's properties are saved (database.update)
// and decides who automatic updates run as: the person who switches them on
// – or who changes prompt, type or options while they are on. A value sent
// by the browser for autoBy is never trusted.
export function prepareAiFields(user: Identity, page: Pick<Page, "workspace_id">, fields: Field[], before: Field[]) {
  const aiFields = fields.filter((f) => f.ai);
  for (const f of aiFields) {
    const ai = f.ai!;
    if (!(AI_OUTPUT_TYPES as readonly string[]).includes(f.type))
      throw new HttpError(400, "KI-Eigenschaften geben Text, eine Auswahl, eine Mehrfachauswahl oder eine Zahl aus.");
    if ((f.type === "select" || f.type === "multiselect") && !f.options?.some((o) => o.trim()))
      throw new HttpError(400, "Eine KI-Auswahl braucht Optionen.");
    for (const name of promptReferences(ai.prompt)) {
      if (isContentReference(name, fields)) continue;
      const target = referencedField(name, fields);
      if (!target) throw new HttpError(400, `Unbekannte Eigenschaft im KI-Prompt: {${name}}`);
      if (target.id === f.id) throw new HttpError(400, "Ein KI-Prompt kann nicht auf die eigene Eigenschaft verweisen.");
      if (!AI_REFERENCE_TYPES.includes(target.type)) throw new HttpError(400, `Diese Eigenschaft kann im KI-Prompt nicht verwendet werden: {${name}}`);
      if (ai.auto && VOLATILE_REFERENCE_TYPES.includes(target.type))
        throw new HttpError(400, `Ein automatischer KI-Wert kann nicht auf {${name}} verweisen: Der Wert ändert sich mit jedem Schreiben der KI.`);
    }
  }
  // AI properties referring to each other in a circle would recompute forever.
  const edges = new Map(aiFields.map((f) => [f.id, promptReferences(f.ai!.prompt).map((n) => referencedField(n, fields)).filter((t): t is Field => !!t?.ai).map((t) => t.id)]));
  const state = new Map<string, 1 | 2>();
  const visit = (fid: string): boolean => {
    if (state.get(fid) === 1) return true;
    if (state.get(fid) === 2) return false;
    state.set(fid, 1);
    const cyclic = (edges.get(fid) || []).some(visit);
    state.set(fid, 2);
    return cyclic;
  };
  if (aiFields.some((f) => visit(f.id))) throw new HttpError(400, "KI-Eigenschaften dürfen nicht im Kreis aufeinander verweisen.");
  for (const f of aiFields) {
    const ai = f.ai!;
    const old = before.find((o) => o.id === f.id);
    if (!ai.auto) {
      delete ai.auto;
      delete ai.autoBy;
      continue;
    }
    if (old?.ai?.auto && old.ai.autoBy && sameConfig(f, old)) {
      ai.autoBy = old.ai.autoBy;
      continue;
    }
    if (isGuest(user, page.workspace_id)) throw new HttpError(403, "Gäste können keine automatischen KI-Werte einschalten.");
    const resolved = resolveAi(user, "database", { workspaceId: page.workspace_id });
    if (!resolved.ok) throw new HttpError(403, AI_REASON_TEXT[resolved.reason][0]);
    ai.autoBy = user.id;
  }
  // Removed AI properties take their bookkeeping along.
  return { removed: before.filter((o) => o.ai && !fields.some((f) => f.id === o.id && f.ai)).map((o) => o.id) };
}
export function forgetAiFields(pageId: string, fieldIds: string[]) {
  for (const fid of fieldIds) {
    run("DELETE FROM ai_cell_jobs WHERE page_id=? AND field_id=?", pageId, fid);
    run("DELETE FROM ai_cell_meta WHERE page_id=? AND field_id=?", pageId, fid);
  }
}

type RowLike = { id: string; number?: number | null; created_at?: string; updated_at?: string; created_by?: string | null; updated_by?: string | null };
export type PromptContext = {
  names: (id: string) => string;
  // Titles of related records – only those the AI may read for this person.
  relationTitles: (field: Field, ids: string[]) => string[];
  content: () => string;
};
// Related records' titles, filtered with aiFilter for the person.
export function relationTitlesFor(user: Identity) {
  const schemas = new Map<string, Field[]>();
  return (field: Field, ids: string[]) => {
    if (!field.relationPage || !ids.length) return [];
    const readable = aiFilter(
      user,
      ids.slice(0, 100).map((rowId) => ({ pageId: field.relationPage!, rowId })),
    );
    if (!schemas.has(field.relationPage)) {
      const stored = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", field.relationPage);
      schemas.set(field.relationPage, stored ? JSON.parse(stored.fields) : []);
    }
    const fields = schemas.get(field.relationPage)!;
    return readable.map((r) => {
      const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", r.rowId!);
      return row ? recordTitle(fields, JSON.parse(row.cells)) : "";
    });
  };
}
export const contentOf = (rowId: string) => () => recordContent(rowId);

// The prompt with every {Name} replaced by the record's value. `empty`:
// the prompt refers to properties and all of them are empty. `input`: the
// same text with the volatile values ({Zuletzt geändert} …) left as their
// references – what the input hash is made of, so that a value's own write
// does not count as a changed input.
export function renderAiPrompt(prompt: string, fields: Field[], cells: Record<string, unknown>, row: RowLike, context: PromptContext) {
  let references = 0,
    filled = 0;
  const render = (volatile: boolean) =>
    prompt.replace(/\{([^{}\n]{1,100})\}/g, (whole, raw: string) => {
      const name = raw.trim();
      const field = referencedField(name, fields);
      let value: string;
      if (field) {
        if (!AI_REFERENCE_TYPES.includes(field.type)) return whole;
        if (!volatile && VOLATILE_REFERENCE_TYPES.includes(field.type)) return whole;
        value =
          field.type === "relation"
            ? context.relationTitles(field, (Array.isArray(cells[field.id]) ? (cells[field.id] as unknown[]) : []).map(String)).filter(Boolean).join(", ")
            : cellPlain(field, cells[field.id], row, context.names);
      } else if (isContentReference(name, fields)) value = context.content();
      else return whole;
      if (volatile) {
        references++;
        if (value.trim()) filled++;
      }
      return value.slice(0, 8000);
    });
  const text = render(true);
  return { text, input: render(false), empty: references > 0 && filled === 0 };
}
export const aiInputHash = (field: Field, rendered: string) =>
  createHash("sha256")
    .update(JSON.stringify([field.type, field.options || [], field.ai?.prompt || "", rendered]))
    .digest("hex")
    .slice(0, 32);

// ---- What a model may write ----

export const INVALID = Symbol("invalid");
const unquote = (s: string) =>
  s
    .trim()
    .replace(/^["'„“”‚‘’«»]+|["'„“”‚‘’«»]+$/g, "")
    .trim();
function matchOption(value: string, options: string[]) {
  const wanted = unquote(unquote(value).replace(/[.!?]+$/, ""));
  return options.find((o) => o === wanted) ?? options.find((o) => o.trim().toLowerCase() === wanted.toLowerCase());
}
function parseNumber(value: unknown): number | null | typeof INVALID {
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID;
  if (typeof value !== "string") return INVALID;
  let s = value.trim().replace(/[\s ']/g, "");
  if (!s) return null;
  // 1.234,5 → 1234.5; 1,5 → 1.5
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const match = s.match(/^-?\d+(\.\d+)?(e-?\d+)?/i);
  if (!match) return INVALID;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : INVALID;
}

// A model's value for a property, constrained to what the property allows.
// null: no value ("nothing applies"); INVALID: not usable.
export function constrainAiValue(field: Field, raw: unknown): unknown | null | typeof INVALID {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case "number": {
      const n = parseNumber(Array.isArray(raw) && raw.length === 1 ? raw[0] : raw);
      if (n === INVALID || n === null) return n;
      if (field.rollupDisplay === "rating") return Math.max(0, Math.min(field.rollupMax && field.rollupMax <= 10 ? field.rollupMax : 5, Math.round(n)));
      const decimals = field.decimals;
      return decimals === undefined ? n : Number(n.toFixed(decimals));
    }
    case "select": {
      const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : INVALID) : raw;
      if (value === INVALID || typeof value !== "string") return INVALID;
      if (!unquote(value)) return null;
      return matchOption(value, field.options || []) ?? INVALID;
    }
    case "multiselect": {
      const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\n]/) : null;
      if (!list || list.some((v) => typeof v !== "string")) return INVALID;
      const named = (list as string[]).map(unquote).filter(Boolean);
      const matched = [...new Set(named.map((v) => matchOption(v, field.options || [])).filter((v): v is string => !!v))];
      // Only invented options: not usable; some invented ones are dropped.
      if (named.length && !matched.length) return INVALID;
      return matched.slice(0, 100);
    }
    case "checkbox":
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string" && /^(true|ja|yes|wahr|1)$/i.test(raw.trim())) return true;
      if (typeof raw === "string" && /^(false|nein|no|falsch|0)$/i.test(raw.trim())) return false;
      return INVALID;
    case "date": {
      if (typeof raw !== "string") return INVALID;
      const value = raw.trim().slice(0, 10);
      if (!value) return null;
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && validDateValue(value) ? value : INVALID;
    }
    case "text":
    case "url":
    case "email":
    case "phone": {
      if (typeof raw !== "string" && typeof raw !== "number") return INVALID;
      const text = unquote(String(raw)).slice(0, AI_TEXT_MAX);
      if (!text) return null;
      if (field.type === "url" && !/^https?:\/\/[^\s]+$/i.test(text)) return INVALID;
      if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return INVALID;
      if (field.type === "phone" && !/^[+\d][\d\s()/.-]{2,40}$/.test(text)) return INVALID;
      return text;
    }
  }
  return INVALID;
}
// The stored form of "no value".
export function emptyAiCell(field: Field): unknown {
  if (field.type === "multiselect") return [];
  if (field.type === "number") return null;
  if (field.type === "checkbox") return false;
  return "";
}
export const isEmptyCell = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

// The JSON schema the model is asked for, per property type.
export function valueInstruction(field: Field): string {
  const options = JSON.stringify((field.options || []).filter((o) => o.trim()));
  switch (field.type) {
    case "number":
      return '"value" ist eine Zahl (JSON-Zahl, ohne Einheit) oder null, wenn sich keine bestimmen lässt.';
    case "select":
      return `"value" ist genau eine dieser Optionen, exakt so geschrieben: ${options} – oder null, wenn keine passt.`;
    case "multiselect":
      return `"value" ist eine Liste mit passenden Optionen aus ${options}, exakt so geschrieben (auch eine leere Liste).`;
    case "checkbox":
      return '"value" ist true oder false.';
    case "date":
      return '"value" ist ein Datum im Format JJJJ-MM-TT oder null.';
    case "url":
      return '"value" ist eine vollständige URL (https://…) oder null.';
    case "email":
      return '"value" ist eine E-Mail-Adresse oder null.';
    case "phone":
      return '"value" ist eine Telefonnummer oder null.';
    default:
      return `"value" ist ein Text (höchstens ${AI_TEXT_MAX} Zeichen, ohne Anführungszeichen drumherum) oder null.`;
  }
}
// A schema that only accepts usable values: an unusable one gets the
// model's one retry (lib/ai/json.ts).
export function valueSchema(field: Field) {
  return z
    .object({ value: z.unknown() })
    .transform((answer, ctx) => {
      const value = constrainAiValue(field, answer.value);
      if (value === INVALID) {
        ctx.addIssue({ code: "custom", path: ["value"], message: valueInstruction(field) });
        return z.NEVER;
      }
      return value;
    });
}

// The properties of a record as context for "Mit KI ausfüllen".
export function recordContext(fields: Field[], target: Field, cells: Record<string, unknown>, row: RowLike, context: PromptContext) {
  const lines = fields
    .filter((f) => f.id !== target.id && AI_REFERENCE_TYPES.includes(f.type))
    .map((f) => {
      const value =
        f.type === "relation"
          ? context.relationTitles(f, (Array.isArray(cells[f.id]) ? (cells[f.id] as unknown[]) : []).map(String)).join(", ")
          : cellPlain(f, cells[f.id], row, context.names);
      return value ? `${f.name}: ${value.slice(0, 2000)}` : "";
    })
    .filter(Boolean);
  const content = context.content();
  return `${lines.join("\n")}${content ? `\n\nInhalt des Eintrags:\n${content}` : ""}`;
}

// ---- A database from a description ----

export const PROPOSAL_TYPES = ["text", "number", "date", "select", "multiselect", "checkbox", "url", "email", "phone"] as const;
export const PROPOSAL_LIMITS = { fields: 25, options: 30, rows: 10, name: 60 } as const;
const proposalValue = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(100)).max(PROPOSAL_LIMITS.options), z.null()]);
// What the model must answer (and what the browser sends back after review).
// Unknown keys are dropped; types, names, options and sizes are checked.
export const proposalSchema = z.object({
  title: z.string().trim().max(100).optional(),
  fields: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(PROPOSAL_LIMITS.name),
        type: z.enum(PROPOSAL_TYPES),
        options: z.array(z.string().trim().min(1).max(PROPOSAL_LIMITS.name)).max(PROPOSAL_LIMITS.options).optional(),
      }),
    )
    .min(1)
    .max(PROPOSAL_LIMITS.fields),
  rows: z.array(z.record(z.string().max(100), proposalValue)).max(PROPOSAL_LIMITS.rows).optional(),
});
export type DatabaseProposal = {
  title: string;
  fields: { name: string; type: (typeof PROPOSAL_TYPES)[number]; options?: string[] }[];
  rows: Record<string, unknown>[];
};

// Names made unique, options only where they belong (deduplicated; a
// selection without options becomes text), a text property first (the
// title), example values checked against their property.
export function normalizeProposal(raw: unknown): DatabaseProposal {
  const parsed = proposalSchema.parse(raw);
  const names = new Set<string>();
  type ProposedField = DatabaseProposal["fields"][number];
  let fields: ProposedField[] = parsed.fields.map((f): ProposedField => {
    let name = f.name.replace(/\s+/g, " ");
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${f.name.slice(0, PROPOSAL_LIMITS.name - 4)} ${i}`;
    names.add(name.toLowerCase());
    const options = [...new Set((f.options || []).map((o) => o.replace(/,/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean))];
    if (f.type === "select" || f.type === "multiselect")
      return options.length ? { name, type: f.type, options } : { name, type: "text" as const };
    return { name, type: f.type };
  });
  const titleIndex = fields.findIndex((f) => f.type === "text");
  if (titleIndex > 0) fields = [fields[titleIndex], ...fields.slice(0, titleIndex), ...fields.slice(titleIndex + 1)];
  if (titleIndex < 0) {
    let name = "Name";
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `Name ${i}`;
    fields = [{ name, type: "text" as const }, ...fields].slice(0, PROPOSAL_LIMITS.fields);
  }
  const rows = (parsed.rows || [])
    .map((row) => {
      const cells: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const field = fields.find((f) => f.name.toLowerCase() === key.trim().toLowerCase());
        if (!field || cells[field.name] !== undefined) continue;
        const constrained = constrainAiValue({ id: field.name, ...field } as Field, value);
        if (constrained === INVALID || constrained === null || (Array.isArray(constrained) && !constrained.length)) continue;
        cells[field.name] = constrained;
      }
      return cells;
    })
    .filter((cells) => Object.keys(cells).length > 0);
  return { title: (parsed.title || "").slice(0, 100), fields, rows };
}

const fieldId = () => `ai_${randomBytes(5).toString("hex")}`;
// Sets up an (empty) database page from a reviewed proposal: properties,
// a table, a board when there is a selection, and the example records.
export function applyDatabaseProposal(pageId: string, userId: string, raw: unknown, labels: { all: string; board: string }) {
  const proposal = normalizeProposal(raw);
  const fields: Field[] = proposal.fields.map((f, i) => ({
    id: i === 0 ? "title" : fieldId(),
    name: f.name,
    type: f.type,
    ...(f.options ? { options: f.options } : {}),
  }));
  const select = fields.find((f) => f.type === "select");
  const views: View[] = [
    { id: "table", name: labels.all, type: "table", filters: [], sorts: [] },
    ...(select ? [{ id: "board", name: labels.board, type: "board" as const, filters: [], sorts: [], groupBy: select.id }] : []),
  ];
  run("UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?", JSON.stringify(fields), JSON.stringify(views), pageId);
  const now = Date.now();
  proposal.rows.forEach((row, i) => {
    const cells = Object.fromEntries(Object.entries(row).map(([name, value]) => [fields.find((f) => f.name === name)!.id, value]));
    run("INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)", uuid(), pageId, JSON.stringify(cells), now + i, userId, userId);
  });
  return { fields: fields.length, rows: proposal.rows.length };
}

// For the browser: metadata of AI values and the queue of a database.
export function aiCellMeta(pageId: string, visible: (rowId: string) => boolean) {
  const meta: Record<string, Record<string, { at: number; model: string; status: string }>> = {};
  for (const m of all<{ row_id: string; field_id: string; model: string; computed_at: number; status: string }>(
    "SELECT row_id,field_id,model,computed_at,status FROM ai_cell_meta WHERE page_id=?",
    pageId,
  )) {
    if (!visible(m.row_id)) continue;
    (meta[m.row_id] ||= {})[m.field_id] = { at: Number(m.computed_at), model: m.model, status: m.status };
  }
  return meta;
}
