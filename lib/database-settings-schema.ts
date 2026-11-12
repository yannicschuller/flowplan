// Settings of a database beyond its properties and views, all optional:
// when a record counts as done, workflow rules, automations, sprints, time
// tracking and the Git connection. Client-safe (schemas and helpers only).
import { z } from "zod";
import { filterSchema } from "./database-filters";
import type { Field } from "./types";

const fid = z.string().min(1).max(500);
const optionValue = z.string().max(100);

export const doneSchema = z.object({ field: fid, values: z.array(optionValue).max(50) });
// The date a record is due (#248): a date property, or none at all ("the
// dates of this database are no deadlines"). Not set: guessed by name.
export const dueSchema = z.union([z.object({ field: fid }).strict(), z.object({ none: z.literal(true) }).strict()]);

// Allowed status changes and what a status needs.
export const workflowSchema = z.object({
  field: fid,
  // from → allowed targets; a status without an entry may change freely.
  transitions: z.record(optionValue, z.array(optionValue).max(50)).default({}),
  // status → properties that must be filled to set it.
  required: z.record(optionValue, z.array(fid).max(20)).default({}),
  // Statuses only owners of the database may set.
  ownersOnly: z.array(optionValue).max(50).default([]),
});

export const automationTrigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("created") }),
  z.object({ type: z.literal("form") }),
  // A property changed; with `to` only when it changed to that value.
  z.object({ type: z.literal("changed"), field: fid, to: z.string().max(500).optional() }),
  // A date property is in the past and the record is not done.
  z.object({ type: z.literal("overdue"), field: fid }),
  // On a schedule, in the given time zone: every `interval` days, every
  // `interval` weeks on `weekday` (ISO, 1 = Monday) or every `interval`
  // months on `day` (clamped to the month's last day), at `time`.
  z.object({
    type: z.literal("schedule"),
    freq: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365).default(1),
    weekday: z.number().int().min(1).max(7).default(1),
    day: z.number().int().min(1).max(31).default(1),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
    timeZone: z.string().min(1).max(100).default("UTC"),
  }),
]);
export const automationAction = z.discriminatedUnion("type", [
  // A fixed value; "@today" / "@now" for dates, "@actor" / "@creator" for people.
  z.object({ type: z.literal("set"), field: fid, value: z.unknown() }),
  z.object({ type: z.literal("notify"), to: z.string().max(600), message: z.string().trim().max(300).default("") }),
  // Scheduled rules only: a new record from a record template (empty: none)
  // plus fixed values; `dates` sets date properties to the run's day plus
  // the given number of days ("Fällig: +3 Tage").
  z.object({
    type: z.literal("create"),
    template: z.string().max(60).default(""),
    cells: z.record(fid, z.unknown()).default({}),
    dates: z.record(fid, z.number().int().min(-3650).max(3650)).default({}),
  }),
  // A record template on the triggering record, once per record and rule:
  // empty properties get its values, an empty document its text ("empty")
  // or the text goes below the existing one ("append"); placeholders are
  // filled (lib/record-template-apply.ts).
  z.object({
    type: z.literal("template"),
    template: z.string().min(1).max(60),
    mode: z.enum(["empty", "append"]).default("empty"),
  }),
]);
export const automationSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().trim().max(120).default(""),
  enabled: z.boolean().default(true),
  trigger: automationTrigger,
  conditions: z.array(filterSchema).max(10).default([]),
  actions: z.array(automationAction).min(1).max(10),
  // Set by the server: who last set the rule up (scheduled rules create
  // records as this person) and since when it applies (ISO time).
  createdBy: z.string().max(60).optional(),
  since: z.string().max(40).optional(),
  // Set by the server: the rule was extended into this workflow page and
  // replaced by it when it was activated (lib/workflows/store.ts); it stays
  // switched off and is shown as a link (docs/specs/workflows.md §2).
  workflow: z.string().max(60).optional(),
});
export type Automation = z.infer<typeof automationSchema>;
export type AutomationAction = z.infer<typeof automationAction>;
export type ScheduleTrigger = Extract<Automation["trigger"], { type: "schedule" }>;

export const sprintSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  goal: z.string().trim().max(500).default(""),
  state: z.enum(["planned", "active", "closed"]).default("planned"),
  // Filled when the sprint is closed (velocity).
  completed: z.number().min(0).optional(),
  committed: z.number().min(0).optional(),
  closedAt: z.string().max(40).optional(),
});
export type Sprint = z.infer<typeof sprintSchema>;

export const settingsSchema = z.object({
  done: doneSchema.optional(),
  due: dueSchema.optional(),
  workflow: workflowSchema.optional(),
  automations: z.array(automationSchema).max(50).optional(),
  sprints: z.array(sprintSchema).max(200).optional(),
  // A number property with story points or hours; empty counts records.
  pointsField: fid.optional(),
  // Sealed (lib/sealed-values.ts): token and secret empty, both in
  // `sealed`, the token's hash in `tokenHash`; older ones in plain text.
  git: z
    .object({
      token: z.string().max(80),
      secret: z.string().max(120),
      createdAt: z.string().max(40),
      sealed: z.string().max(600).optional(),
      tokenHash: z.string().max(64).optional(),
      // Optional access token for the back-link comments on pull/merge
      // requests (#184, lib/git-backlinks.ts): sealed, bound to the
      // provider's address it was entered for.
      access: z
        .object({
          provider: z.enum(["github", "gitlab", "forgejo"]),
          web: z.string().max(500),
          sealed: z.string().max(4000),
          setAt: z.string().max(40),
        })
        .optional(),
    })
    .optional(),
});
export type DatabaseSettings = z.infer<typeof settingsSchema>;

// Names are compared lower-case and without accents ("Échéance" →
// "echeance", "gelöst" → "gelost"), so either spelling matches.
export const plainName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

// Statuses that mean "finished", when nothing is configured: German,
// English, French, Italian, Spanish and Chinese. Only words that clearly
// mean done – "Expiré"/"Abgelaufen" does not (an expired voucher is not a
// finished task); such databases set it under "Status rules and done".
const DONE_WORDS = new RegExp(
  "^(?:" +
    [
      "erledigt|fertig|abgeschlossen|gelost|geloest|geschlossen",
      "done|closed|resolved|complete|completed",
      "termine|terminee|fait|faite|fini|finie|clos|close|cloture|cloturee|ferme|fermee|resolu|resolue",
      "completato|completata|fatto|fatta|chiuso|chiusa|risolto|risolta",
      "hecho|hecha|terminado|terminada|cerrado|cerrada|completado|completada|resuelto|resuelta",
      "已完成|完成|已关闭|已解决|已结束",
    ].join("|") +
    ")$",
);
const isDoneWord = (option: string) => DONE_WORDS.test(plainName(option));
const DONE_CHECKBOX = /erledigt|done|fertig|abgeschlossen|termine|fait|fini|hecho|fatto|completato|完成/;

// The effective rule for "done": the configured one, otherwise a status
// property with an option like "Erledigt"/"Done", otherwise a checkbox
// called "Erledigt"/"Done".
export function doneRule(fields: Field[], settings: DatabaseSettings | undefined) {
  const configured = settings?.done && fields.find((f) => f.id === settings.done!.field);
  if (configured) return { field: configured, values: settings!.done!.values };
  const selects = fields.filter((f) => f.type === "select");
  const status = selects.find((f) => /status|stand|zustand|phase/i.test(f.name)) || selects.find((f) => f.options?.some(isDoneWord));
  const values = status?.options?.filter(isDoneWord) || [];
  if (status && values.length) return { field: status, values };
  const check = fields.find((f) => f.type === "checkbox" && DONE_CHECKBOX.test(plainName(f.name)));
  return check ? { field: check, values: ["true"] } : null;
}

// Date properties named like a due date, in two tiers: clear words first
// ("Fällig", "Due", "Échéance", "截止"), then weaker ones ("Termin", "bis",
// "Fin de validité", "Expiration"), so "Terminé le" never beats "Échéance".
const DUE_NAMES = [
  new RegExp(
    [
      "fallig|faellig|due|deadline|frist",
      "echeance|delai|date limite|a rendre",
      "scadenza|scadenze|data limite",
      "vencimiento|fecha limite|plazo",
      "截止|到期|期限",
    ].join("|"),
  ),
  /termin|bis|until|jusqu|fin de validit|expir|ablauf|valable|entro il|valido fino|hasta|有效期/,
];
// The due date by name only (undefined when no property is named so).
export function guessDueField<F extends { type: string; name: string }>(fields: F[]): F | undefined {
  const dates = fields.filter((f) => f.type === "date");
  for (const pattern of DUE_NAMES) {
    const found = dates.find((f) => pattern.test(plainName(f.name)));
    if (found) return found;
  }
  return undefined;
}
// The setting "Due date": a date property ("field"), none ("none"), or
// automatic ("auto": also when the chosen property was deleted or is no
// longer a date).
export function dueSetting(fields: Field[], settings: DatabaseSettings | undefined): { mode: "auto" } | { mode: "none" } | { mode: "field"; field: Field } {
  const due = settings?.due;
  if (due && "none" in due) return { mode: "none" };
  const field = due && "field" in due ? fields.find((f) => f.id === due.field && f.type === "date") : undefined;
  return field ? { mode: "field", field } : { mode: "auto" };
}
// The date a record is due, used by "My tasks", due notifications, the
// app's widgets and quick capture: the configured property, nothing when
// set to "no due date", otherwise a date property named like one, else the
// first date property.
export function dueField(fields: Field[], settings?: DatabaseSettings) {
  const setting = dueSetting(fields, settings);
  if (setting.mode === "none") return undefined;
  if (setting.mode === "field") return setting.field;
  return guessDueField(fields) || fields.find((f) => f.type === "date");
}
// Where a new due date goes (quick capture, the app's capture), among the
// date properties `writable` the person may write: the configured property
// if writable, nothing for "no due date", otherwise the name guess or the
// first of them.
export function writableDueField<F extends { id: string; type: string; name: string }>(fields: Field[], settings: DatabaseSettings | undefined, writable: F[]) {
  const dates = writable.filter((f) => f.type === "date");
  const setting = dueSetting(fields, settings);
  if (setting.mode === "none") return undefined;
  if (setting.mode === "field") return dates.find((f) => f.id === setting.field.id);
  return guessDueField(dates) || dates[0];
}
export function isDone(rule: Awaited<ReturnType<typeof doneRule>>, cells: Record<string, unknown>) {
  if (!rule) return false;
  const value = cells[rule.field.id];
  if (rule.field.type === "checkbox") return value === true;
  return typeof value === "string" && rule.values.includes(value);
}
