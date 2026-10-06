// Settings of a database beyond its properties and views, all optional:
// when a record counts as done, workflow rules, automations, sprints, time
// tracking and the Git connection. Client-safe (schemas and helpers only).
import { z } from "zod";
import { filterSchema } from "./database-filters";
import type { Field } from "./types";

const fid = z.string().min(1).max(500);
const optionValue = z.string().max(100);

export const doneSchema = z.object({ field: fid, values: z.array(optionValue).max(50) });

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
]);
export const automationAction = z.discriminatedUnion("type", [
  // A fixed value; "@today" / "@now" for dates, "@actor" / "@creator" for people.
  z.object({ type: z.literal("set"), field: fid, value: z.unknown() }),
  z.object({ type: z.literal("notify"), to: z.string().max(600), message: z.string().trim().max(300).default("") }),
]);
export const automationSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().trim().max(120).default(""),
  enabled: z.boolean().default(true),
  trigger: automationTrigger,
  conditions: z.array(filterSchema).max(10).default([]),
  actions: z.array(automationAction).min(1).max(10),
});
export type Automation = z.infer<typeof automationSchema>;
export type AutomationAction = z.infer<typeof automationAction>;

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
  workflow: workflowSchema.optional(),
  automations: z.array(automationSchema).max(50).optional(),
  sprints: z.array(sprintSchema).max(200).optional(),
  // A number property with story points or hours; empty counts records.
  pointsField: fid.optional(),
  // A number property with the estimate in hours (time tracking).
  estimateField: fid.optional(),
  git: z.object({ token: z.string().max(80), secret: z.string().max(120), createdAt: z.string().max(40) }).optional(),
});
export type DatabaseSettings = z.infer<typeof settingsSchema>;

// Statuses that mean "finished", when nothing is configured.
const DONE_WORDS = /^(erledigt|fertig|abgeschlossen|done|closed|resolved|complete|completed|gelöst|geschlossen)$/i;

// The effective rule for "done": the configured one, otherwise a status
// property with an option like "Erledigt"/"Done", otherwise a checkbox
// called "Erledigt"/"Done".
export function doneRule(fields: Field[], settings: DatabaseSettings | undefined) {
  const configured = settings?.done && fields.find((f) => f.id === settings.done!.field);
  if (configured) return { field: configured, values: settings!.done!.values };
  const selects = fields.filter((f) => f.type === "select");
  const status = selects.find((f) => /status|stand|zustand|phase/i.test(f.name)) || selects.find((f) => f.options?.some((o) => DONE_WORDS.test(o)));
  const values = status?.options?.filter((o) => DONE_WORDS.test(o)) || [];
  if (status && values.length) return { field: status, values };
  const check = fields.find((f) => f.type === "checkbox" && /erledigt|done|fertig|abgeschlossen/i.test(f.name));
  return check ? { field: check, values: ["true"] } : null;
}
export function isDone(rule: ReturnType<typeof doneRule>, cells: Record<string, unknown>) {
  if (!rule) return false;
  const value = cells[rule.field.id];
  if (rule.field.type === "checkbox") return value === true;
  return typeof value === "string" && rule.values.includes(value);
}
