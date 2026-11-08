// The node catalogue of workflows (docs/specs/workflows.md §6): every node
// type with its names, symbol, category, whether it can run in the
// immediate part (§2), its configuration schema, its output ports and the
// shape of its output (for the placeholder picker). Client-safe: schemas
// and data only; the execution lives in lib/workflows/nodes/*.ts.
//
// Wave 1 has the record and page triggers, form, schedule, date, comment,
// mention and manual triggers, the record and page actions, notify.person
// and logic.if/set/stop. Further types (§6.3–6.6) come with later waves;
// a graph naming a type that is not here is refused by the check.
import { z } from "zod";
import { filterOperators } from "../database-filters";

export const NODE_CATEGORIES = ["trigger", "logic", "records", "pages", "notify", "ai", "http"] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

const id = z.string().min(1).max(100);
// A text that may hold placeholders (lib/workflows/placeholders.ts).
const tmpl = z.string().max(20_000);
const shortTmpl = z.string().max(2_000);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

// Where page events are watched: the whole workspace, one space, or below a
// page (only its direct children or everything below).
export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }),
  z.object({ kind: z.literal("space"), spaceId: id }),
  z.object({ kind: z.literal("below"), pageId: id, depth: z.enum(["children", "all"]).default("children") }),
]);
export type WorkflowScope = z.infer<typeof scopeSchema>;
const scope = scopeSchema.default({ kind: "workspace" });

// Conditions of logic.if: left a placeholder, the operators of the
// database filters, right values with placeholders; groups nest twice.
const condition = z.object({
  kind: z.literal("condition"),
  left: shortTmpl,
  op: z.enum(filterOperators),
  value: shortTmpl.default(""),
  values: z.array(shortTmpl).max(100).optional(),
  to: shortTmpl.optional(),
  timeZone: z.string().max(100).optional(),
  days: z.number().int().min(1).max(36600).optional(),
});
export type WorkflowCondition = z.infer<typeof condition>;
export type WorkflowConditionGroup = { kind: "group"; join: "and" | "or"; rules: (WorkflowCondition | WorkflowConditionGroup)[] };
const innerGroup = z.object({ kind: z.literal("group"), join: z.enum(["and", "or"]), rules: z.array(condition).max(50) });
const middleGroup = z.object({ kind: z.literal("group"), join: z.enum(["and", "or"]), rules: z.array(z.union([condition, innerGroup])).max(50) });
export const conditionGroupSchema = z.object({
  kind: z.literal("group").default("group"),
  join: z.enum(["and", "or"]).default("and"),
  rules: z.array(z.union([condition, middleGroup])).max(50).default([]),
}) as unknown as z.ZodType<WorkflowConditionGroup>;

// Blocks a page action writes (§6.2): text with placeholders, inserted as
// text, never as markup (§7.4).
export const blockSchema = z.object({
  type: z.enum(["paragraph", "heading", "bullet", "task", "link", "divider"]),
  text: tmpl.default(""),
  level: z.number().int().min(1).max(3).optional(),
  // link: the page (id or placeholder) a link card points to.
  page: shortTmpl.optional(),
  checked: z.boolean().optional(),
});
export type WorkflowBlock = z.infer<typeof blockSchema>;

// Property id → value: a text with placeholders, or a fixed value (a
// database rule's true/false, list, "@today" …).
const values = z.record(id, z.unknown()).refine((v) => JSON.stringify(v).length <= 200_000).default({});
const recipients = z.array(shortTmpl).max(50);
const channel = z.enum(["inbox", "push", "email", "messenger"]);

// Output shapes for the picker: a small typed tree.
export type OutputType = "text" | "number" | "boolean" | "date" | "datetime" | "person" | "page" | "record" | "list" | "object" | "file";
export type OutputField = { key: string; label: [string, string]; type: OutputType; children?: OutputField[]; item?: OutputType };

// i18n-table: 1 – [German, English] pairs
const person: OutputField[] = [
  { key: "id", label: ["ID", "ID"], type: "text" },
  { key: "name", label: ["Name", "Name"], type: "text" },
  { key: "email", label: ["E-Mail", "Email"], type: "text" },
];
// i18n-table: 1 – [German, English] pairs
const pageRef: OutputField[] = [
  { key: "id", label: ["ID", "ID"], type: "text" },
  { key: "title", label: ["Titel", "Title"], type: "text" },
  { key: "url", label: ["Adresse", "URL"], type: "text" },
];
// i18n-table: 1 – [German, English] pairs
export const PAGE_OUTPUT: OutputField[] = [
  ...pageRef,
  { key: "link", label: ["Link", "Link"], type: "page" },
  { key: "kind", label: ["Typ", "Type"], type: "text" },
  { key: "parent", label: ["Elternseite", "Parent page"], type: "page", children: pageRef },
  { key: "space", label: ["Bereich", "Space"], type: "object", children: [{ key: "id", label: ["ID", "ID"], type: "text" }, { key: "name", label: ["Name", "Name"], type: "text" }] },
  { key: "tags", label: ["Tags", "Tags"], type: "list", item: "text" },
  { key: "text", label: ["Text", "Text"], type: "text" },
  { key: "createdAt", label: ["Angelegt am", "Created at"], type: "datetime" },
  { key: "createdBy", label: ["Angelegt von", "Created by"], type: "person", children: person },
  { key: "updatedAt", label: ["Geändert am", "Updated at"], type: "datetime" },
];
// i18n-table: 1 – [German, English] pairs
export const RECORD_OUTPUT: OutputField[] = [
  { key: "id", label: ["ID", "ID"], type: "text" },
  { key: "url", label: ["Adresse", "URL"], type: "text" },
  { key: "title", label: ["Titel", "Title"], type: "text" },
  { key: "number", label: ["Nummer", "Number"], type: "number" },
  { key: "database", label: ["Datenbank", "Database"], type: "page", children: pageRef },
  // The children are the database's properties (filled in by the editor).
  { key: "fields", label: ["Felder", "Fields"], type: "object" },
  { key: "createdAt", label: ["Angelegt am", "Created at"], type: "datetime" },
  { key: "createdBy", label: ["Angelegt von", "Created by"], type: "person", children: person },
  { key: "updatedAt", label: ["Geändert am", "Updated at"], type: "datetime" },
];
const recordOut = (key = "record"): OutputField => ({ key, label: key === "record" ? ["Eintrag", "Record"] : ["Erster", "First"], type: "record", children: RECORD_OUTPUT });
const pageOut = (key = "page", label: [string, string] = ["Seite", "Page"]): OutputField => ({ key, label, type: "page", children: PAGE_OUTPUT });
const actorOut: OutputField = { key: "actor", label: ["Ausgelöst von", "Triggered by"], type: "person", children: person };

export type NodeSpec = {
  type: string;
  category: NodeCategory;
  name: [string, string];
  description: [string, string];
  // Phosphor icon name.
  icon: string;
  // Can run in the immediate part, inside the writing transaction (§2).
  inline: boolean;
  config: z.ZodType;
  ports: (config: Record<string, unknown>) => string[];
  outputs: OutputField[];
  // Triggers: the event kind (workflow_events.kind, workflow_triggers.kind).
  event?: string;
};

const out = () => ["out"];
const spec = (s: NodeSpec) => s;

// i18n-table: 1 – [German, English] pairs
export const NODE_TYPES: NodeSpec[] = [
  /* ---------- Triggers ---------- */
  spec({
    type: "trigger.record.created",
    category: "trigger",
    name: ["Neuer Eintrag", "New record"],
    description: ["Ein Eintrag wird in einer Datenbank angelegt.", "A record is created in a database."],
    icon: "PlusCircle",
    inline: true,
    event: "record.created",
    config: z.object({ database: id, includeForm: z.boolean().default(true) }),
    ports: out,
    outputs: [recordOut(), actorOut, { key: "via", label: ["Über", "Via"], type: "text" }],
  }),
  spec({
    type: "trigger.record.changed",
    category: "trigger",
    name: ["Eintrag geändert", "Record changed"],
    description: ["Eigenschaften eines Eintrags ändern sich.", "Properties of a record change."],
    icon: "PencilSimple",
    inline: true,
    event: "record.changed",
    config: z.object({ database: id, fields: z.array(id).max(50).default([]), from: z.string().max(500).optional(), to: z.string().max(500).optional() }),
    ports: out,
    outputs: [
      recordOut(),
      { key: "before", label: ["Vorher", "Before"], type: "object" },
      { key: "changed", label: ["Geänderte Felder", "Changed fields"], type: "list", item: "text" },
      actorOut,
    ],
  }),
  spec({
    type: "trigger.record.done",
    category: "trigger",
    name: ["Eintrag erledigt", "Record done"],
    description: ["Ein Eintrag wird erledigt.", "A record becomes done."],
    icon: "CheckCircle",
    inline: true,
    event: "record.done",
    config: z.object({ database: id }),
    ports: out,
    outputs: [recordOut(), actorOut],
  }),
  spec({
    type: "trigger.record.date",
    category: "trigger",
    name: ["Datum erreicht", "Date reached"],
    description: ["Ein Datum eines Eintrags ist erreicht oder überfällig.", "A date of a record is reached or overdue."],
    icon: "CalendarCheck",
    inline: false,
    event: "record.date",
    config: z.object({
      database: id,
      field: id,
      offsetDays: z.number().int().min(-30).max(30).default(0),
      time: time.optional(),
      mode: z.enum(["reached", "overdue"]).default("reached"),
    }),
    ports: out,
    outputs: [recordOut(), { key: "date", label: ["Datum", "Date"], type: "date" }],
  }),
  spec({
    type: "trigger.form.submitted",
    category: "trigger",
    name: ["Formularantwort", "Form answer"],
    description: ["Jemand schickt das Formular einer Datenbank ab.", "Someone submits a database's form."],
    icon: "ClipboardText",
    inline: true,
    event: "form.submitted",
    config: z.object({ database: id }),
    ports: out,
    outputs: [
      recordOut(),
      { key: "answers", label: ["Antworten", "Answers"], type: "object" },
      { key: "respondent", label: ["Absender", "Respondent"], type: "person", children: person },
    ],
  }),
  spec({
    type: "trigger.schedule",
    category: "trigger",
    name: ["Zeitplan", "Schedule"],
    description: ["Täglich, wöchentlich oder monatlich zu einer Uhrzeit.", "Daily, weekly or monthly at a time."],
    icon: "Clock",
    inline: false,
    event: "schedule",
    config: z.object({
      freq: z.enum(["daily", "weekly", "monthly"]).default("daily"),
      interval: z.number().int().min(1).max(365).default(1),
      weekday: z.number().int().min(1).max(7).default(1),
      day: z.number().int().min(1).max(31).default(1),
      time: time.default("09:00"),
      timeZone: z.string().min(1).max(100).optional(),
    }),
    ports: out,
    outputs: [{ key: "slot", label: ["Termin", "Slot"], type: "object", children: [{ key: "date", label: ["Datum", "Date"], type: "date" }, { key: "time", label: ["Uhrzeit", "Time"], type: "text" }] }],
  }),
  spec({
    type: "trigger.page.created",
    category: "trigger",
    name: ["Neue Seite", "New page"],
    description: ["Eine Seite wird angelegt.", "A page is created."],
    icon: "FilePlus",
    inline: false,
    event: "page.created",
    config: z.object({ scope, kinds: z.array(z.string().max(30)).max(10).default([]) }),
    ports: out,
    outputs: [pageOut(), actorOut],
  }),
  spec({
    type: "trigger.page.changed",
    category: "trigger",
    name: ["Seite geändert", "Page changed"],
    description: ["Titel oder Inhalt einer Seite ändert sich (2 Minuten nach der letzten Änderung).", "A page's title or content changes (2 minutes after the last change)."],
    icon: "NotePencil",
    inline: false,
    event: "page.changed",
    config: z.object({ scope, what: z.array(z.enum(["title", "content"])).min(1).max(2).default(["title", "content"]) }),
    ports: out,
    outputs: [pageOut(), actorOut, { key: "changes", label: ["Änderungen", "Changes"], type: "list", item: "text" }],
  }),
  spec({
    type: "trigger.page.moved",
    category: "trigger",
    name: ["Seite verschoben", "Page moved"],
    description: ["Eine Seite bekommt eine neue Elternseite oder einen neuen Bereich.", "A page gets a new parent or space."],
    icon: "ArrowsOutCardinal",
    inline: false,
    event: "page.moved",
    config: z.object({ scope, to: id.optional() }),
    ports: out,
    outputs: [pageOut(), pageOut("from", ["Von", "From"]), pageOut("to", ["Nach", "To"]), actorOut],
  }),
  spec({
    type: "trigger.page.tagged",
    category: "trigger",
    name: ["Tag hinzugefügt", "Tag added"],
    description: ["Eine Seite bekommt einen Tag.", "A page gets a tag."],
    icon: "Tag",
    inline: false,
    event: "page.tagged",
    config: z.object({ scope, tags: z.array(id).max(50).default([]) }),
    ports: out,
    outputs: [pageOut(), { key: "tag", label: ["Tag", "Tag"], type: "text" }, actorOut],
  }),
  spec({
    type: "trigger.comment.created",
    category: "trigger",
    name: ["Neuer Kommentar", "New comment"],
    description: ["Jemand kommentiert eine Seite oder einen Eintrag.", "Someone comments on a page or record."],
    icon: "ChatCircle",
    inline: false,
    event: "comment.created",
    config: z.object({ scope, on: z.array(z.enum(["pages", "records"])).min(1).max(2).default(["pages", "records"]), inline: z.boolean().default(true) }),
    ports: out,
    outputs: [
      { key: "comment", label: ["Kommentar", "Comment"], type: "object", children: [{ key: "id", label: ["ID", "ID"], type: "text" }, { key: "text", label: ["Text", "Text"], type: "text" }, { key: "url", label: ["Adresse", "URL"], type: "text" }] },
      pageOut(),
      recordOut(),
      actorOut,
    ],
  }),
  spec({
    type: "trigger.mention",
    category: "trigger",
    name: ["Erwähnung", "Mention"],
    description: ["Jemand wird in einer Seite, einem Eintrag oder Kommentar erwähnt.", "Someone is mentioned in a page, record or comment."],
    icon: "At",
    inline: false,
    event: "mention",
    config: z.object({ scope, who: z.enum(["any", "me", "people"]).default("any"), people: z.array(id).max(50).default([]) }),
    ports: out,
    outputs: [pageOut(), recordOut(), { key: "mentioned", label: ["Erwähnt", "Mentioned"], type: "person", children: person }, actorOut],
  }),
  spec({
    type: "trigger.manual",
    category: "trigger",
    name: ["Manuell starten", "Start manually"],
    description: ["Startet über „Ausführen“, die API oder einen Knopf.", "Starts with “Run”, the API or a button."],
    icon: "Play",
    inline: false,
    event: "manual",
    config: z.object({
      inputs: z
        .array(z.object({ name: z.string().trim().min(1).max(60), type: z.enum(["text", "number", "date", "boolean"]).default("text"), required: z.boolean().default(false) }))
        .max(20)
        .default([]),
      // Who may start it (open question 4: editors of the workflow by
      // default, members who see the page optionally; never guests).
      who: z.enum(["editors", "members"]).default("editors"),
    }),
    ports: out,
    outputs: [
      { key: "inputs", label: ["Eingaben", "Inputs"], type: "object" },
      { key: "startedBy", label: ["Gestartet von", "Started by"], type: "person", children: person },
      { key: "source", label: ["Quelle", "Source"], type: "text" },
    ],
  }),
  /* ---------- Logic ---------- */
  spec({
    type: "logic.if",
    category: "logic",
    name: ["Wenn", "If"],
    description: ["Verzweigt nach Bedingungen.", "Branches on conditions."],
    icon: "GitFork",
    inline: true,
    config: z.object({ condition: conditionGroupSchema }),
    ports: () => ["true", "false"],
    outputs: [{ key: "matched", label: ["Erfüllt", "Matched"], type: "boolean" }],
  }),
  spec({
    type: "logic.set",
    category: "logic",
    name: ["Werte setzen", "Set values"],
    description: ["Benannte Werte für spätere Knoten.", "Named values for later nodes."],
    icon: "Equals",
    inline: true,
    config: z.object({
      values: z
        .array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), value: tmpl, type: z.enum(["auto", "text", "number", "boolean", "date", "list"]).default("auto") }))
        .max(30)
        .default([]),
    }),
    ports: out,
    // The children are the named values (filled in by the editor).
    outputs: [],
  }),
  spec({
    type: "logic.stop",
    category: "logic",
    name: ["Beenden", "Stop"],
    description: ["Beendet den Lauf erfolgreich oder als Fehler.", "Ends the run as succeeded or failed."],
    icon: "StopCircle",
    inline: true,
    config: z.object({ result: z.enum(["succeeded", "failed"]).default("succeeded"), message: shortTmpl.default("") }),
    ports: () => [],
    outputs: [],
  }),
  /* ---------- Records ---------- */
  spec({
    type: "action.record.create",
    category: "records",
    name: ["Eintrag anlegen", "Create record"],
    description: ["Legt einen Eintrag in einer Datenbank an.", "Creates a record in a database."],
    icon: "Rows",
    inline: false,
    config: z.object({ database: id, values, template: z.string().max(60).default("") }),
    ports: out,
    outputs: [recordOut()],
  }),
  spec({
    type: "action.record.update",
    category: "records",
    name: ["Eintrag ändern", "Update record"],
    description: ["Ändert Eigenschaften eines Eintrags.", "Changes properties of a record."],
    icon: "PencilLine",
    // Inline only on the triggering record (lib/workflows/inline.ts).
    inline: true,
    config: z.object({
      // Empty: the triggering record; else a placeholder or a record id.
      record: shortTmpl.default(""),
      database: id.optional(),
      values,
      onlyEmpty: z.boolean().default(false),
    }),
    ports: out,
    outputs: [recordOut(), { key: "before", label: ["Vorher", "Before"], type: "object" }],
  }),
  spec({
    type: "action.record.find",
    category: "records",
    name: ["Einträge finden", "Find records"],
    description: ["Sucht Einträge nach Bedingungen.", "Finds records by conditions."],
    icon: "MagnifyingGlass",
    inline: false,
    config: z.object({
      database: id,
      // Conditions on the database's properties; `left` names a property id.
      filter: conditionGroupSchema,
      sort: z.object({ field: id, direction: z.enum(["asc", "desc"]).default("asc") }).optional(),
      limit: z.number().int().min(1).max(100).default(10),
    }),
    ports: out,
    outputs: [
      { key: "records", label: ["Einträge", "Records"], type: "list", item: "record" },
      recordOut("first"),
      { key: "count", label: ["Anzahl", "Count"], type: "number" },
    ],
  }),
  spec({
    type: "action.record.template",
    category: "records",
    name: ["Vorlage anwenden", "Apply template"],
    description: ["Wendet eine Eintragsvorlage auf einen Eintrag an.", "Applies a record template to a record."],
    icon: "Stamp",
    inline: true,
    config: z.object({ record: shortTmpl.default(""), database: id.optional(), template: z.string().min(1).max(60), mode: z.enum(["empty", "append"]).default("empty") }),
    ports: out,
    outputs: [recordOut()],
  }),
  /* ---------- Pages ---------- */
  spec({
    type: "action.page.create",
    category: "pages",
    name: ["Seite anlegen", "Create page"],
    description: ["Legt eine Seite unter einer Elternseite an.", "Creates a page below a parent page."],
    icon: "FilePlus",
    inline: false,
    config: z.object({
      parent: shortTmpl,
      title: shortTmpl,
      blocks: z.array(blockSchema).max(100).default([]),
      template: z.string().max(60).default(""),
      tags: z.array(id).max(30).default([]),
    }),
    ports: out,
    outputs: [pageOut()],
  }),
  spec({
    type: "action.page.append",
    category: "pages",
    name: ["An Seite anhängen", "Append to page"],
    description: ["Fügt Blöcke am Ende, am Anfang oder unter einer Überschrift ein.", "Adds blocks at the end, the start or below a heading."],
    icon: "ListPlus",
    inline: false,
    config: z.object({
      page: shortTmpl,
      where: z.object({ kind: z.enum(["end", "start", "heading"]).default("end"), heading: z.string().max(200).optional() }).default({ kind: "end" }),
      blocks: z.array(blockSchema).min(1).max(100),
      // Skip when a link to the same page is already there.
      noDuplicate: z.boolean().default(false),
    }),
    ports: out,
    outputs: [pageOut(), { key: "appended", label: ["Angehängt", "Appended"], type: "number" }],
  }),
  spec({
    type: "action.page.tag",
    category: "pages",
    name: ["Seite taggen", "Tag page"],
    description: ["Fügt einer Seite Tags hinzu oder entfernt sie.", "Adds tags to a page or removes them."],
    icon: "Tag",
    inline: false,
    config: z.object({ page: shortTmpl, op: z.enum(["add", "remove"]).default("add"), tags: z.array(id).min(1).max(30) }),
    ports: out,
    outputs: [pageOut()],
  }),
  spec({
    type: "action.page.move",
    category: "pages",
    name: ["Seite verschieben", "Move page"],
    description: ["Verschiebt eine Seite unter eine neue Elternseite.", "Moves a page below a new parent."],
    icon: "ArrowBendDownRight",
    inline: false,
    config: z.object({ page: shortTmpl, parent: shortTmpl, position: z.enum(["start", "end"]).default("end") }),
    ports: out,
    outputs: [pageOut()],
  }),
  /* ---------- Notify ---------- */
  spec({
    type: "notify.person",
    category: "notify",
    name: ["Person benachrichtigen", "Notify person"],
    description: ["Benachrichtigung in der App, per Push, E-Mail oder Chat-App.", "A notification in the app, by push, email or chat app."],
    icon: "Bell",
    inline: true,
    config: z.object({
      // User ids, "@actor", "@creator", "@runner", "field:<id>" of the
      // triggering record, or placeholders on people.
      to: recipients.min(1),
      title: shortTmpl.default(""),
      message: z.string().max(2_000).default(""),
      // "trigger": the triggering page/record; "none"; else a placeholder.
      link: shortTmpl.default("trigger"),
      channels: z.array(channel).min(1).max(4).default(["inbox", "push"]),
      // "automation": a database rule's notification (lib/automations.ts
      // wording and kind); "workflow" for workflows.
      kind: z.enum(["workflow", "automation"]).default("workflow"),
      ruleName: z.string().max(120).optional(),
    }),
    ports: out,
    outputs: [{ key: "notified", label: ["Benachrichtigt", "Notified"], type: "number" }],
  }),
];

export const nodeSpecs = new Map(NODE_TYPES.map((n) => [n.type, n]));
export const nodeSpec = (type: string) => nodeSpecs.get(type);
export const isTrigger = (type: string) => type.startsWith("trigger.");
export const TRIGGER_EVENTS = NODE_TYPES.filter((n) => n.event).map((n) => n.event!);
// Triggers on one database: their scope is the database.
export const RECORD_TRIGGERS = new Set(["trigger.record.created", "trigger.record.changed", "trigger.record.done", "trigger.form.submitted", "trigger.record.date"]);

// The catalogue as JSON for the editor and GET /api/workflows/catalog:
// config schemas as JSON Schema.
export function catalogJson() {
  return NODE_TYPES.map((n) => ({
    type: n.type,
    category: n.category,
    name: n.name,
    description: n.description,
    icon: n.icon,
    inline: n.inline,
    event: n.event ?? null,
    ports: n.ports({}),
    outputs: n.outputs,
    config: z.toJSONSchema(n.config, { io: "input", unrepresentable: "any" }),
  }));
}
