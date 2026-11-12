// The node catalogue of workflows (docs/specs/workflows.md §6): every node
// type with its names, symbol, category, whether it can run in the
// immediate part (§2), its configuration schema, its output ports and the
// shape of its output (for the placeholder picker). Client-safe: schemas
// and data only; the execution lives in lib/workflows/nodes/*.ts.
//
// Wave 1 brought the record and page triggers, form, schedule, date,
// comment, mention and manual triggers, the record and page actions,
// notify.person and logic.if/set/stop; wave 2 the inbound webhook, e-mail
// and journal triggers, switch, for-each, wait and approval, the AI nodes,
// http.request, notify.email and notify.chat. A graph naming a type that
// is not here is refused by the check.
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
// i18n-table: 1 – [German, English] pairs
const OUTPUT_LABELS: Record<string, [string, string]> = {
  record: ["Eintrag", "Record"],
  first: ["Erster", "First"],
  page: ["Seite", "Page"],
  actor: ["Ausgelöst von", "Triggered by"],
  from: ["Von", "From"],
  to: ["Nach", "To"],
};
const recordOut = (key = "record"): OutputField => ({ key, label: OUTPUT_LABELS[key], type: "record", children: RECORD_OUTPUT });
const pageOut = (key = "page", label: [string, string] = OUTPUT_LABELS.page): OutputField => ({ key, label, type: "page", children: PAGE_OUTPUT });
const actorOut: OutputField = { key: "actor", label: OUTPUT_LABELS.actor, type: "person", children: person };

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

// i18n-table: 1 – [German, English] pairs
const NODE_TEXT: Record<string, { name: [string, string]; description: [string, string] }> = {
  "trigger.record.created": {
    name: ["Neuer Eintrag", "New record"],
    description: ["Ein Eintrag wird in einer Datenbank angelegt.", "A record is created in a database."],
  },
  "trigger.record.changed": {
    name: ["Eintrag geändert", "Record changed"],
    description: ["Eigenschaften eines Eintrags ändern sich.", "Properties of a record change."],
  },
  "trigger.record.done": {
    name: ["Eintrag erledigt", "Record done"],
    description: ["Ein Eintrag wird erledigt.", "A record becomes done."],
  },
  "trigger.record.date": {
    name: ["Datum erreicht", "Date reached"],
    description: ["Ein Datum eines Eintrags ist erreicht oder überfällig.", "A date of a record is reached or overdue."],
  },
  "trigger.form.submitted": {
    name: ["Formularantwort", "Form answer"],
    description: ["Jemand schickt das Formular einer Datenbank ab.", "Someone submits a database's form."],
  },
  "trigger.schedule": {
    name: ["Zeitplan", "Schedule"],
    description: ["Täglich, wöchentlich oder monatlich zu einer Uhrzeit.", "Daily, weekly or monthly at a time."],
  },
  "trigger.page.created": {
    name: ["Neue Seite", "New page"],
    description: ["Eine Seite wird angelegt.", "A page is created."],
  },
  "trigger.page.changed": {
    name: ["Seite geändert", "Page changed"],
    description: ["Titel oder Inhalt einer Seite ändert sich (2 Minuten nach der letzten Änderung).", "A page's title or content changes (2 minutes after the last change)."],
  },
  "trigger.page.moved": {
    name: ["Seite verschoben", "Page moved"],
    description: ["Eine Seite bekommt eine neue Elternseite oder einen neuen Bereich.", "A page gets a new parent or space."],
  },
  "trigger.page.tagged": {
    name: ["Tag hinzugefügt", "Tag added"],
    description: ["Eine Seite bekommt einen Tag.", "A page gets a tag."],
  },
  "trigger.comment.created": {
    name: ["Neuer Kommentar", "New comment"],
    description: ["Jemand kommentiert eine Seite oder einen Eintrag.", "Someone comments on a page or record."],
  },
  "trigger.mention": {
    name: ["Erwähnung", "Mention"],
    description: ["Jemand wird in einer Seite, einem Eintrag oder Kommentar erwähnt.", "Someone is mentioned in a page, record or comment."],
  },
  "trigger.manual": {
    name: ["Manuell starten", "Start manually"],
    description: ["Startet über „Ausführen“, die API oder einen Knopf.", "Starts with “Run”, the API or a button."],
  },
  "trigger.webhook": {
    name: ["Eingehender Webhook", "Inbound webhook"],
    description: ["Ein anderer Dienst ruft die Adresse des Workflows auf.", "Another service calls the workflow’s address."],
  },
  "trigger.mail.received": {
    name: ["E-Mail empfangen", "E-mail received"],
    description: ["Eine E-Mail kommt an einer Adresse an, die an diesen Workflow geht.", "An e-mail arrives at an address that goes to this workflow."],
  },
  "trigger.journal.day": {
    name: ["Neuer Journaltag", "New journal day"],
    description: ["Die Seite eines Tages wird im Journal angelegt.", "A day’s page is created in a journal."],
  },
  "logic.if": {
    name: ["Wenn", "If"],
    description: ["Verzweigt nach Bedingungen.", "Branches on conditions."],
  },
  "logic.set": {
    name: ["Werte setzen", "Set values"],
    description: ["Benannte Werte für spätere Knoten.", "Named values for later nodes."],
  },
  "logic.stop": {
    name: ["Beenden", "Stop"],
    description: ["Beendet den Lauf erfolgreich oder als Fehler.", "Ends the run as succeeded or failed."],
  },
  "logic.switch": {
    name: ["Unterscheiden", "Switch"],
    description: ["Verzweigt nach dem ersten passenden Fall.", "Branches on the first matching case."],
  },
  "logic.foreach": {
    name: ["Für jedes", "For each"],
    description: ["Führt die folgenden Knoten für jedes Element einer Liste aus.", "Runs the following nodes for every item of a list."],
  },
  "logic.wait": {
    name: ["Warten", "Wait"],
    description: ["Wartet eine Dauer, bis zu einem Zeitpunkt oder bis zur nächsten Uhrzeit.", "Waits for a duration, until a point in time or until the next time of day."],
  },
  "logic.approval": {
    name: ["Freigabe", "Approval"],
    description: ["Wartet, bis eine Person genehmigt oder ablehnt.", "Waits until a person approves or rejects."],
  },
  "ai.summarize": {
    name: ["KI: Zusammenfassen", "AI: Summarize"],
    description: ["Fasst einen Text zusammen.", "Summarizes a text."],
  },
  "ai.classify": {
    name: ["KI: Einordnen", "AI: Classify"],
    description: ["Ordnet einen Text einer der Kategorien zu.", "Puts a text into one of the categories."],
  },
  "ai.extract": {
    name: ["KI: Felder auslesen", "AI: Extract fields"],
    description: ["Liest benannte Werte aus einem Text.", "Reads named values from a text."],
  },
  "ai.prompt": {
    name: ["KI: Eigene Anweisung", "AI: Custom prompt"],
    description: ["Eine eigene Anweisung, Antwort als Text oder JSON.", "A prompt of your own, answered as text or JSON."],
  },
  "http.request": {
    name: ["HTTP-Anfrage", "HTTP request"],
    description: ["Ruft eine HTTPS-Adresse auf (fester Host).", "Calls an HTTPS address (fixed host)."],
  },
  "notify.email": {
    name: ["E-Mail senden", "Send e-mail"],
    description: ["Schickt eine E-Mail an Personen oder Adressen.", "Sends an e-mail to people or addresses."],
  },
  "notify.chat": {
    name: ["Chat-Nachricht", "Chat message"],
    description: ["Postet in einen Chat-Webhook des Arbeitsbereichs (Slack, Matrix, Teams, Discord).", "Posts to a chat webhook of the workspace (Slack, Matrix, Teams, Discord)."],
  },
  "action.record.create": {
    name: ["Eintrag anlegen", "Create record"],
    description: ["Legt einen Eintrag in einer Datenbank an.", "Creates a record in a database."],
  },
  "action.record.update": {
    name: ["Eintrag ändern", "Update record"],
    description: ["Ändert Eigenschaften eines Eintrags.", "Changes properties of a record."],
  },
  "action.record.find": {
    name: ["Einträge finden", "Find records"],
    description: ["Sucht Einträge nach Bedingungen.", "Finds records by conditions."],
  },
  "action.record.template": {
    name: ["Vorlage anwenden", "Apply template"],
    description: ["Wendet eine Eintragsvorlage auf einen Eintrag an.", "Applies a record template to a record."],
  },
  "action.page.create": {
    name: ["Seite anlegen", "Create page"],
    description: [
      "Legt eine Seite unter einer Elternseite an, auf Wunsch aus einer Seitenvorlage. Der Titel (mit Platzhaltern) gilt auch dann; der Name der Vorlage nur, wenn er leer bleibt.",
      "Creates a page below a parent page, from a page template if you like. The title (with placeholders) applies then as well; the template’s name only when it comes out empty.",
    ],
  },
  "action.page.append": {
    name: ["An Seite anhängen", "Append to page"],
    description: ["Fügt Blöcke am Ende, am Anfang oder unter einer Überschrift ein.", "Adds blocks at the end, the start or below a heading."],
  },
  "action.page.tag": {
    name: ["Seite taggen", "Tag page"],
    description: ["Fügt einer Seite Tags hinzu oder entfernt sie.", "Adds tags to a page or removes them."],
  },
  "action.page.move": {
    name: ["Seite verschieben", "Move page"],
    description: ["Verschiebt eine Seite unter eine neue Elternseite.", "Moves a page below a new parent."],
  },
  "action.task.create": {
    name: ["Aufgabe erstellen", "Create task"],
    description: ["Schreibt eine Aufgabe in eine Seite, auf Wunsch mit Person und Fälligkeit.", "Writes a task into a page, with a person and a due date if you like."],
  },
  "action.journal.append": {
    name: ["An Journaltag anhängen", "Append to journal day"],
    description: [
      "Schreibt Markdown mit Platzhaltern in den heutigen, gestrigen oder einen bestimmten Tag eines Journals – am Ende oder unter einer Überschrift. Fehlt der Tag, wird er wie beim Öffnen angelegt.",
      "Writes Markdown with placeholders into today’s, yesterday’s or a given day of a journal – at the end or below a heading. A missing day is created as opening it would.",
    ],
  },
  "notify.person": {
    name: ["Person benachrichtigen", "Notify person"],
    description: ["Benachrichtigung in der App, per Push, E-Mail oder Chat-App.", "A notification in the app, by push, email or chat app."],
  },
};

const out = () => ["out"];
const spec = (s: Omit<NodeSpec, "name" | "description">): NodeSpec => ({ ...s, ...NODE_TEXT[s.type] });

// i18n-table: 1 – [German, English] pairs
const OUT: Record<string, [string, string]> = {
  via: ["Über", "Via"],
  before: ["Vorher", "Before"],
  changed: ["Geänderte Felder", "Changed fields"],
  date: ["Datum", "Date"],
  answers: ["Antworten", "Answers"],
  respondent: ["Absender", "Respondent"],
  slot: ["Termin", "Slot"],
  time: ["Uhrzeit", "Time"],
  changes: ["Änderungen", "Changes"],
  tag: ["Tag", "Tag"],
  comment: ["Kommentar", "Comment"],
  id: ["ID", "ID"],
  text: ["Text", "Text"],
  url: ["Adresse", "URL"],
  mentioned: ["Erwähnt", "Mentioned"],
  inputs: ["Eingaben", "Inputs"],
  startedBy: ["Gestartet von", "Started by"],
  source: ["Quelle", "Source"],
  matched: ["Erfüllt", "Matched"],
  records: ["Einträge", "Records"],
  count: ["Anzahl", "Count"],
  appended: ["Angehängt", "Appended"],
  notified: ["Benachrichtigt", "Notified"],
  body: ["Inhalt", "Body"],
  query: ["Query-Parameter", "Query parameters"],
  headers: ["Header", "Headers"],
  receivedAt: ["Empfangen am", "Received at"],
  mail: ["E-Mail", "E-mail"],
  from: ["Absender", "From"],
  to: ["Empfänger", "To"],
  subject: ["Betreff", "Subject"],
  html: ["HTML", "HTML"],
  messageId: ["Message-ID", "Message ID"],
  attachments: ["Anhänge", "Attachments"],
  authenticated: ["Absender geprüft", "Sender verified"],
  day: ["Tagesseite", "Day page"],
  journal: ["Journal", "Journal"],
  results: ["Ergebnisse", "Results"],
  waitedUntil: ["Gewartet bis", "Waited until"],
  decidedBy: ["Entschieden von", "Decided by"],
  decidedAt: ["Entschieden am", "Decided at"],
  summary: ["Zusammenfassung", "Summary"],
  category: ["Kategorie", "Category"],
  categories: ["Kategorien", "Categories"],
  confidence: ["Sicherheit", "Confidence"],
  fields: ["Felder", "Fields"],
  missing: ["Fehlend", "Missing"],
  json: ["JSON", "JSON"],
  status: ["Status", "Status"],
  sent: ["Gesendet", "Sent"],
  item: ["Element", "Item"],
  index: ["Index", "Index"],
  task: ["Aufgabe", "Task"],
  due: ["Fällig am", "Due on"],
  assignee: ["Zuständig", "Assignee"],
  created: ["Tag neu angelegt", "Day newly created"],
};

// Typed fields that an AI answer fills (ai.extract, ai.prompt as JSON).
export const aiFieldSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/),
  type: z.enum(["text", "number", "date", "boolean", "select"]).default("text"),
  description: z.string().max(500).default(""),
  options: z.array(z.string().max(100)).max(50).optional(),
});
export type AiField = z.infer<typeof aiFieldSchema>;
const aiOutputType = (t: AiField["type"]): OutputType => (t === "select" ? "text" : t);
// A switch case: an operator of the filters and a value (§6.3).
export const switchCaseSchema = z.object({ id: z.string().regex(/^[a-z0-9]{1,12}$/), label: z.string().max(60).default(""), op: z.enum(filterOperators).default("eq"), value: shortTmpl.default("") });
const duration = z.object({ amount: z.number().int().min(1).max(100_000), unit: z.enum(["minutes", "hours", "days"]).default("hours") });
export const durationMs = (d: { amount: number; unit: string }) => d.amount * (d.unit === "minutes" ? 60_000 : d.unit === "hours" ? 3_600_000 : 86_400_000);
// A URL whose scheme and host are fixed text (§6.6): no placeholder before the path.
// (http:// only matters with FLOWPLAN_WORKFLOW_HTTP_ALLOW_PRIVATE, see nodes/http.ts.)
export const fixedHost = (url: string) => {
  const m = /^https?:\/\/([^/?#{}\\@\s]+)(?:[/?#]|$)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
};
// i18n-table: 1 – [German, English] pairs (output ports; also in the marketplace meta)
export const PORT_TEXT: Record<string, [string, string]> = {
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
const nameValue = z.object({ name: z.string().trim().max(200), value: shortTmpl.default("") });

export const NODE_TYPES: NodeSpec[] = [
  /* ---------- Triggers ---------- */
  spec({
    type: "trigger.record.created",
    category: "trigger",
    icon: "PlusCircle",
    inline: true,
    event: "record.created",
    config: z.object({ database: id, includeForm: z.boolean().default(true) }),
    ports: out,
    outputs: [recordOut(), actorOut, { key: "via", label: OUT.via, type: "text" }],
  }),
  spec({
    type: "trigger.record.changed",
    category: "trigger",
    icon: "PencilSimple",
    inline: true,
    event: "record.changed",
    config: z.object({ database: id, fields: z.array(id).max(50).default([]), from: z.string().max(500).optional(), to: z.string().max(500).optional() }),
    ports: out,
    outputs: [
      recordOut(),
      { key: "before", label: OUT.before, type: "object" },
      { key: "changed", label: OUT.changed, type: "list", item: "text" },
      actorOut,
    ],
  }),
  spec({
    type: "trigger.record.done",
    category: "trigger",
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
    outputs: [recordOut(), { key: "date", label: OUT.date, type: "date" }],
  }),
  spec({
    type: "trigger.form.submitted",
    category: "trigger",
    icon: "ClipboardText",
    inline: true,
    event: "form.submitted",
    config: z.object({ database: id }),
    ports: out,
    outputs: [
      recordOut(),
      { key: "answers", label: OUT.answers, type: "object" },
      { key: "respondent", label: OUT.respondent, type: "person", children: person },
    ],
  }),
  spec({
    type: "trigger.schedule",
    category: "trigger",
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
    outputs: [{ key: "slot", label: OUT.slot, type: "object", children: [{ key: "date", label: OUT.date, type: "date" }, { key: "time", label: OUT.time, type: "text" }] }],
  }),
  spec({
    type: "trigger.page.created",
    category: "trigger",
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
    icon: "NotePencil",
    inline: false,
    event: "page.changed",
    config: z.object({ scope, what: z.array(z.enum(["title", "content"])).min(1).max(2).default(["title", "content"]) }),
    ports: out,
    outputs: [pageOut(), actorOut, { key: "changes", label: OUT.changes, type: "list", item: "text" }],
  }),
  spec({
    type: "trigger.page.moved",
    category: "trigger",
    icon: "ArrowsOutCardinal",
    inline: false,
    event: "page.moved",
    config: z.object({ scope, to: id.optional() }),
    ports: out,
    outputs: [pageOut(), pageOut("from", OUTPUT_LABELS.from), pageOut("to", OUTPUT_LABELS.to), actorOut],
  }),
  spec({
    type: "trigger.page.tagged",
    category: "trigger",
    icon: "Tag",
    inline: false,
    event: "page.tagged",
    config: z.object({ scope, tags: z.array(id).max(50).default([]) }),
    ports: out,
    outputs: [pageOut(), { key: "tag", label: OUT.tag, type: "text" }, actorOut],
  }),
  spec({
    type: "trigger.comment.created",
    category: "trigger",
    icon: "ChatCircle",
    inline: false,
    event: "comment.created",
    config: z.object({ scope, on: z.array(z.enum(["pages", "records"])).min(1).max(2).default(["pages", "records"]), inline: z.boolean().default(true) }),
    ports: out,
    outputs: [
      { key: "comment", label: OUT.comment, type: "object", children: [{ key: "id", label: OUT.id, type: "text" }, { key: "text", label: OUT.text, type: "text" }, { key: "url", label: OUT.url, type: "text" }] },
      pageOut(),
      recordOut(),
      actorOut,
    ],
  }),
  spec({
    type: "trigger.mention",
    category: "trigger",
    icon: "At",
    inline: false,
    event: "mention",
    config: z.object({ scope, who: z.enum(["any", "me", "people"]).default("any"), people: z.array(id).max(50).default([]) }),
    ports: out,
    outputs: [pageOut(), recordOut(), { key: "mentioned", label: OUT.mentioned, type: "person", children: person }, actorOut],
  }),
  spec({
    type: "trigger.manual",
    category: "trigger",
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
      { key: "inputs", label: OUT.inputs, type: "object" },
      { key: "startedBy", label: OUT.startedBy, type: "person", children: person },
      { key: "source", label: OUT.source, type: "text" },
    ],
  }),
  spec({
    type: "trigger.webhook",
    category: "trigger",
    icon: "Broadcast",
    inline: false,
    event: "webhook",
    config: z.object({
      // "signed" (default) or "token" – only for senders that cannot sign (with a warning).
      mode: z.enum(["signed", "token"]).default("signed"),
      // Expected fields of the body (for the picker only).
      fields: z.array(z.object({ name: z.string().trim().min(1).max(60), type: z.enum(["text", "number", "boolean", "date", "object", "list"]).default("text") })).max(50).default([]),
    }),
    ports: out,
    outputs: [
      { key: "body", label: OUT.body, type: "object" },
      { key: "query", label: OUT.query, type: "object" },
      { key: "headers", label: OUT.headers, type: "object" },
      { key: "receivedAt", label: OUT.receivedAt, type: "datetime" },
    ],
  }),
  spec({
    type: "trigger.mail.received",
    category: "trigger",
    icon: "EnvelopeSimpleOpen",
    inline: false,
    event: "mail.received",
    config: z.object({
      // An inbound address (lib/inbound-mail.ts) whose target is this workflow page.
      address: z.string().max(100).default(""),
      // Which senders start runs: only verified (SPF/DKIM pass), all but failed (default), any.
      senders: z.enum(["verified", "not_failed", "any"]).default("not_failed"),
    }),
    ports: out,
    outputs: [
      {
        key: "mail",
        label: OUT.mail,
        type: "object",
        children: [
          { key: "from", label: OUT.from, type: "text" },
          { key: "to", label: OUT.to, type: "list", item: "text" },
          { key: "subject", label: OUT.subject, type: "text" },
          { key: "text", label: OUT.text, type: "text" },
          { key: "html", label: OUT.html, type: "text" },
          { key: "date", label: OUT.date, type: "datetime" },
          { key: "messageId", label: OUT.messageId, type: "text" },
          { key: "attachments", label: OUT.attachments, type: "list", item: "file" },
        ],
      },
      { key: "authenticated", label: OUT.authenticated, type: "text" },
    ],
  }),
  spec({
    type: "trigger.journal.day",
    category: "trigger",
    icon: "Notebook",
    inline: false,
    event: "journal.day",
    config: z.object({ journal: z.string().max(100).default("") }),
    ports: out,
    outputs: [pageOut("day", OUT.day), { key: "date", label: OUT.date, type: "date" }, pageOut("journal", OUT.journal)],
  }),
  /* ---------- Logic ---------- */
  spec({
    type: "logic.if",
    category: "logic",
    icon: "GitFork",
    inline: true,
    config: z.object({ condition: conditionGroupSchema }),
    ports: () => ["true", "false"],
    outputs: [{ key: "matched", label: OUT.matched, type: "boolean" }],
  }),
  spec({
    type: "logic.set",
    category: "logic",
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
    icon: "StopCircle",
    inline: true,
    config: z.object({ result: z.enum(["succeeded", "failed"]).default("succeeded"), message: shortTmpl.default("") }),
    ports: () => [],
    outputs: [],
  }),
  spec({
    type: "logic.switch",
    category: "logic",
    icon: "Signpost",
    inline: true,
    config: z.object({ value: shortTmpl.default(""), cases: z.array(switchCaseSchema).max(20).default([]) }),
    ports: (c) => [...((c.cases as { id: string }[] | undefined) || []).map((x) => `case:${x.id}`), "default"],
    outputs: [{ key: "case", label: OUT.category, type: "text" }],
  }),
  spec({
    type: "logic.foreach",
    category: "logic",
    icon: "Repeat",
    inline: false,
    config: z.object({
      list: shortTmpl.default(""),
      limit: z.number().int().min(1).max(1000).default(100),
      mode: z.enum(["sequential", "parallel"]).default("sequential"),
      parallel: z.number().int().min(1).max(5).default(5),
    }),
    ports: () => ["item", "done"],
    outputs: [
      { key: "count", label: OUT.count, type: "number" },
      { key: "results", label: OUT.results, type: "list", item: "object" },
    ],
  }),
  spec({
    type: "logic.wait",
    category: "logic",
    icon: "Hourglass",
    inline: false,
    config: z.object({
      mode: z.enum(["duration", "until", "next"]).default("duration"),
      amount: z.number().int().min(1).max(525_600).default(1),
      unit: z.enum(["minutes", "hours", "days"]).default("hours"),
      // "until": a placeholder on a date or date-time, optionally with a time of day.
      until: shortTmpl.default(""),
      time: time.optional(),
      // "next": the next time of day, on working days only if asked.
      weekdays: z.boolean().default(false),
    }),
    ports: out,
    outputs: [{ key: "waitedUntil", label: OUT.waitedUntil, type: "datetime" }],
  }),
  spec({
    type: "logic.approval",
    category: "logic",
    icon: "SealCheck",
    inline: false,
    config: z.object({
      // User ids, "@runner", "@actor", "@creator", "field:<id>" or placeholders on people.
      approvers: recipients.min(1),
      message: z.string().max(2_000).default(""),
      deadline: duration.optional(),
      onTimeout: z.enum(["timeout", "rejected"]).default("timeout"),
    }),
    ports: (c) => ["approved", "rejected", ...(c.deadline && c.onTimeout !== "rejected" ? ["timeout"] : [])],
    outputs: [
      { key: "decidedBy", label: OUT.decidedBy, type: "person", children: person },
      { key: "comment", label: OUT.comment, type: "text" },
      { key: "decidedAt", label: OUT.decidedAt, type: "datetime" },
    ],
  }),
  /* ---------- Records ---------- */
  spec({
    type: "action.record.create",
    category: "records",
    icon: "Rows",
    inline: false,
    config: z.object({ database: id, values, template: z.string().max(60).default("") }),
    ports: out,
    outputs: [recordOut()],
  }),
  spec({
    type: "action.record.update",
    category: "records",
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
    outputs: [recordOut(), { key: "before", label: OUT.before, type: "object" }],
  }),
  spec({
    type: "action.record.find",
    category: "records",
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
      { key: "records", label: OUT.records, type: "list", item: "record" },
      recordOut("first"),
      { key: "count", label: OUT.count, type: "number" },
    ],
  }),
  spec({
    type: "action.record.template",
    category: "records",
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
    outputs: [pageOut(), { key: "appended", label: OUT.appended, type: "number" }],
  }),
  spec({
    type: "action.page.tag",
    category: "pages",
    icon: "Tag",
    inline: false,
    config: z.object({ page: shortTmpl, op: z.enum(["add", "remove"]).default("add"), tags: z.array(id).min(1).max(30) }),
    ports: out,
    outputs: [pageOut()],
  }),
  spec({
    type: "action.page.move",
    category: "pages",
    icon: "ArrowBendDownRight",
    inline: false,
    config: z.object({ page: shortTmpl, parent: shortTmpl, position: z.enum(["start", "end"]).default("end") }),
    ports: out,
    outputs: [pageOut()],
  }),
  // A task in a page (#208): a chosen page, or the own task page of the
  // person it runs as (My tasks, lib/personal-tasks.ts).
  spec({
    type: "action.task.create",
    category: "pages",
    icon: "CheckSquare",
    inline: false,
    config: z.object({
      target: z.enum(["page", "personal"]).default("page"),
      // target "page": the page (id or placeholder).
      page: shortTmpl.default(""),
      // Empty is caught by the check (lib/workflows/validate.ts, "no_task_text").
      text: shortTmpl.default(""),
      // One person: an id, "@actor", "@creator", "@runner", "field:<id>" or a placeholder.
      assignee: recipients.max(1).default([]),
      // A date or a placeholder on one; empty: none.
      due: shortTmpl.default(""),
      // Below the heading with this text (made at the end when missing); empty: the end.
      heading: z.string().max(200).default(""),
    }),
    ports: out,
    outputs: [
      pageOut(),
      {
        key: "task",
        label: OUT.task,
        type: "object",
        children: [
          { key: "text", label: OUT.text, type: "text" },
          { key: "due", label: OUT.due, type: "date" },
          { key: "assignee", label: OUT.assignee, type: "person", children: person },
        ],
      },
    ],
  }),
  // A journal day (#250): today or yesterday in the workflow's time zone,
  // or a date; made with the journal's template when missing.
  spec({
    type: "action.journal.append",
    category: "pages",
    icon: "Notebook",
    inline: false,
    config: z.object({
      // The journal (a page id); empty is caught by the check ("no_journal").
      journal: z.string().max(100).default(""),
      day: z.enum(["today", "yesterday", "date"]).default("today"),
      // day "date": a date, or a placeholder on a date or a moment.
      date: shortTmpl.default(""),
      // Markdown with placeholders; values go in as text (§7.4).
      content: tmpl.default(""),
      // At the end of the day, or at the end of the section below a heading (the end without it).
      place: z.enum(["end", "heading"]).default("end"),
      heading: z.string().max(200).default(""),
    }),
    ports: out,
    outputs: [pageOut("day", OUT.day), { key: "date", label: OUT.date, type: "date" }, pageOut("journal", OUT.journal), { key: "created", label: OUT.created, type: "boolean" }],
  }),
  /* ---------- Notify ---------- */
  spec({
    type: "notify.person",
    category: "notify",
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
    outputs: [{ key: "notified", label: OUT.notified, type: "number" }],
  }),
  spec({
    type: "notify.email",
    category: "notify",
    icon: "EnvelopeSimple",
    inline: false,
    config: z.object({
      // People (their address: ids, "@runner" …, placeholders) and addresses (also from placeholders).
      to: recipients.min(1),
      subject: shortTmpl.default(""),
      message: z.string().max(10_000).default(""),
    }),
    ports: out,
    outputs: [{ key: "sent", label: OUT.sent, type: "number" }],
  }),
  spec({
    type: "notify.chat",
    category: "notify",
    icon: "ChatsCircle",
    inline: false,
    config: z.object({ webhook: z.string().max(60).default(""), title: shortTmpl.default(""), message: z.string().max(2_000).default("") }),
    ports: out,
    outputs: [{ key: "sent", label: OUT.sent, type: "number" }],
  }),
  /* ---------- AI ---------- */
  spec({
    type: "ai.summarize",
    category: "ai",
    icon: "Sparkle",
    inline: false,
    config: z.object({
      text: tmpl.default(""),
      length: z.enum(["sentence", "short", "paragraph", "bullets"]).default("sentence"),
      language: z.enum(["auto", "workflow", "fixed"]).default("auto"),
      languageCode: z.string().max(10).optional(),
    }),
    ports: out,
    outputs: [{ key: "summary", label: OUT.summary, type: "text" }],
  }),
  spec({
    type: "ai.classify",
    category: "ai",
    icon: "Tag",
    inline: false,
    config: z.object({
      text: tmpl.default(""),
      // The categories: a list, or the options of a select property.
      source: z.enum(["list", "field"]).default("list"),
      categories: z.array(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(300).default("") })).max(50).default([]),
      database: id.optional(),
      field: id.optional(),
      multiple: z.boolean().default(false),
      // An answer outside the categories (or low confidence) goes to the port "unclear".
      unclear: z.boolean().default(true),
    }),
    ports: (c) => ["out", ...(c.unclear === false ? [] : ["unclear"])],
    outputs: [
      { key: "category", label: OUT.category, type: "text" },
      { key: "categories", label: OUT.categories, type: "list", item: "text" },
      { key: "confidence", label: OUT.confidence, type: "text" },
    ],
  }),
  spec({
    type: "ai.extract",
    category: "ai",
    icon: "ListMagnifyingGlass",
    inline: false,
    config: z.object({ text: tmpl.default(""), fields: z.array(aiFieldSchema).min(1).max(30) }),
    ports: out,
    outputs: [
      { key: "fields", label: OUT.fields, type: "object" },
      { key: "missing", label: OUT.missing, type: "list", item: "text" },
    ],
  }),
  spec({
    type: "ai.prompt",
    category: "ai",
    icon: "ChatTeardropText",
    inline: false,
    config: z.object({
      system: z.string().max(10_000).default(""),
      prompt: tmpl.default(""),
      format: z.enum(["text", "json"]).default("text"),
      fields: z.array(aiFieldSchema).max(30).default([]),
      maxTokens: z.number().int().min(1).max(8192).default(1024),
      temperature: z.number().min(0).max(2).default(0.3),
    }),
    ports: out,
    outputs: [
      { key: "text", label: OUT.text, type: "text" },
      { key: "json", label: OUT.json, type: "object" },
    ],
  }),
  /* ---------- HTTP ---------- */
  spec({
    type: "http.request",
    category: "http",
    icon: "Globe",
    inline: false,
    config: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      // Scheme and host are fixed text; path and query may hold placeholders (URL-encoded).
      url: shortTmpl.default("https://"),
      query: z.array(nameValue).max(30).default([]),
      headers: z.array(nameValue).max(30).default([]),
      bodyKind: z.enum(["none", "json", "form", "text"]).default("none"),
      body: tmpl.default(""),
      // A credential of this workflow (workflow_credentials), sent only to its host.
      credential: z.string().max(60).default(""),
      timeoutSeconds: z.number().int().min(1).max(30).default(15),
      failOnStatus: z.boolean().default(true),
      // Dry runs: GET requests only, and only when asked.
      runInDry: z.boolean().default(false),
    }),
    ports: out,
    outputs: [
      { key: "status", label: OUT.status, type: "number" },
      { key: "headers", label: OUT.headers, type: "object" },
      { key: "body", label: OUT.body, type: "text" },
      { key: "json", label: OUT.json, type: "object" },
    ],
  }),
];
// What the typed AI fields give the picker.
export const aiFieldOutputs = (fields: AiField[] | undefined): OutputField[] =>
  (fields || []).map((f) => ({ key: f.name, label: [f.name, f.name], type: aiOutputType(f.type) }));

export const nodeSpecs = new Map(NODE_TYPES.map((n) => [n.type, n]));
export const nodeSpec = (type: string) => nodeSpecs.get(type);
export const isTrigger = (type: string) => type.startsWith("trigger.");
export const TRIGGER_EVENTS = NODE_TYPES.filter((n) => n.event).map((n) => n.event!);
// Triggers on one database: their scope is the database.
export const RECORD_TRIGGERS = new Set(["trigger.record.created", "trigger.record.changed", "trigger.record.done", "trigger.form.submitted", "trigger.record.date"]);
// The scope a trigger is looked up by (workflow_triggers.scope_id): the
// database of record triggers, the address of the e-mail trigger, the
// journal of the journal trigger ('' = all), else '' (the whole workspace).
export function triggerScope(type: string, config: Record<string, unknown>): string {
  if (RECORD_TRIGGERS.has(type)) return String(config.database || "");
  if (type === "trigger.mail.received") return String(config.address || "");
  if (type === "trigger.journal.day") return String(config.journal || "");
  return "";
}
// Nodes that act outside Flowplan's database or wait (no immediate part).
export const AI_TYPES = new Set(["ai.summarize", "ai.classify", "ai.extract", "ai.prompt"]);

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
