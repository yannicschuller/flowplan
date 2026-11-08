// Workflow templates (docs/specs/workflows.md §10.6): the six starting
// points of the gallery, each a graph with gaps ("Lücken") the assistant
// asks for – a page, a database, a property of it, a person, an option, a
// chat webhook, an inbound address – before the draft is written. The
// imported workflows of another instance use the same gaps for the
// references that could not be matched (lib/workflows/portable.ts): a
// token "$ask:<gap>" stands where the id goes.
//
// Client-safe: data and pure functions. The texts are the builder's
// language (t); what a workflow writes is never translated later (§13).
import type { Field, FieldType } from "../types";
import { layeredLayout } from "../whiteboard-autolayout";
import { GRAPH_FORMAT, GRAPH_VERSION, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from "./graph";

type T = (de: string, en: string) => string;

export type GapKind = "page" | "database" | "field" | "option" | "routing" | "person" | "chatHook" | "address" | "toggle";
export type Gap = {
  id: string;
  kind: GapKind;
  label: string;
  help?: string;
  // field / option / routing: the database gap (or, for an option or a
  // routing, the field gap) it belongs to.
  of?: string;
  // field: the property types that fit.
  types?: FieldType[];
  optional?: boolean;
  // toggle: its default.
  value?: unknown;
};
export type GapAnswers = Record<string, unknown>;
export type TemplateContext = {
  t: T;
  timeZone: string;
  // The properties of a chosen database (for options and routing).
  fields: (databaseId: string) => Field[] | undefined;
};
export type WorkflowTemplate = {
  id: string;
  icon: string;
  name: string;
  description: string;
  gaps: Gap[];
  build: (answers: GapAnswers, ctx: TemplateContext) => WorkflowGraph;
};

export const TEMPLATE_IDS = ["subpages-overview", "due-reminder", "form-triage", "weekly-report", "mail-ticket", "webhook-record"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/* ---------- Building blocks ---------- */

const str = (v: unknown) => (typeof v === "string" ? v : "");
const node = (id: string, type: string, label: string, config: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  type,
  typeVersion: 1,
  label,
  note: "",
  position: { x: 0, y: 0 },
  disabled: false,
  config,
  ...extra,
});
const link = (from: string, to: string, port = "out"): WorkflowEdge => ({ id: `e_${from.slice(2)}_${to.slice(2)}_${port.replace(/[^a-z0-9]/g, "")}`, from: { node: from, port }, to: { node: to, port: "in" } });

// Left to right with the whiteboards' layered layout (§10.1), on a 20 px grid.
export function layoutGraph(graph: WorkflowGraph): WorkflowGraph {
  const layout = layeredLayout(
    graph.nodes.map((n) => ({ id: n.id, w: 240, h: 100 })),
    graph.edges.map((e) => ({ from: e.from.node, to: e.to.node })),
    { direction: "LR", rankGap: 80, nodeGap: 40 },
  );
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = layout.get(n.id);
      return p ? { ...n, position: { x: Math.round(p.x / 20) * 20, y: Math.round(p.y / 20) * 20 } } : n;
    }),
  };
}
// Unique edge ids (the layout of a template is deterministic).
function finish(nodes: WorkflowNode[], edges: WorkflowEdge[], timeZone: string): WorkflowGraph {
  const seen = new Set<string>();
  const unique = edges.map((e, i) => {
    let id = e.id.slice(0, 22);
    if (seen.has(id)) id = `e_${i}_${id.slice(2)}`.slice(0, 22);
    seen.add(id);
    return { ...e, id };
  });
  return layoutGraph({ format: GRAPH_FORMAT, version: GRAPH_VERSION, settings: { timeZone, triggerOnOwnChanges: false, limits: {} }, nodes, edges: unique });
}
const fieldsOf = (ctx: TemplateContext, answers: GapAnswers, gap: string) => ctx.fields(str(answers[gap])) || [];

/* ---------- The six templates ---------- */

export function workflowTemplates(t: T): WorkflowTemplate[] {
  return [
    {
      // The example of issue #168.
      id: "subpages-overview",
      icon: "ListPlus",
      name: t("Unterseiten auf der Übersicht verlinken", "Link sub-pages on the overview"),
      description: t(
        "Wird direkt unter einer Seite eine neue Seite angelegt, hängt der Workflow einen Link mit einem Satz Beschreibung an die Übersicht an – nie doppelt.",
        "When a new page is created directly below a page, the workflow appends a link with a one-sentence description to the overview – never twice.",
      ),
      gaps: [
        { id: "overview", kind: "page", label: t("Übersichtsseite", "Overview page"), help: t("Neue Unterseiten dieser Seite werden hier verlinkt.", "New sub-pages of this page are linked here.") },
        { id: "summary", kind: "toggle", label: t("Kurzbeschreibung mit KI", "Short description with AI"), value: true, optional: true },
      ],
      build: (a, ctx) => {
        const overview = str(a.overview);
        const ai = a.summary !== false;
        const nodes = [
          node("n_trigger", "trigger.page.created", t("Neue Unterseite", "New sub-page"), { scope: { kind: "below", pageId: overview, depth: "children" }, kinds: ["document"] }),
          ...(ai
            ? [node("n_summary", "ai.summarize", t("Kurzbeschreibung", "Short description"), { text: "{{n_trigger.page.title}}: {{n_trigger.page.text}}", length: "sentence", language: "auto" }, { onError: { retry: 1, then: "port" } })]
            : []),
          node("n_append", "action.page.append", t("Auf Übersicht eintragen", "Add to the overview"), {
            page: overview,
            where: { kind: "end" },
            blocks: [{ type: "bullet", text: ai ? "{{n_trigger.page.link}} – {{n_summary.summary | truncate: 140}}" : "{{n_trigger.page.link}}" }],
            noDuplicate: true,
          }),
        ];
        const edges = ai ? [link("n_trigger", "n_summary"), link("n_summary", "n_append"), link("n_summary", "n_append", "error")] : [link("n_trigger", "n_append")];
        return finish(nodes, edges, ctx.timeZone);
      },
    },
    {
      id: "due-reminder",
      icon: "CalendarCheck",
      name: t("Erinnerung vor Fälligkeit", "Reminder before the due date"),
      description: t(
        "Zwei Tage vor dem Fälligkeitsdatum um 9:00 bekommen die Verantwortlichen eine Push-Nachricht – nur wenn der Eintrag noch nicht erledigt ist.",
        "Two days before the due date at 9:00 the people responsible get a push notification – only if the record is not done yet.",
      ),
      gaps: [
        { id: "database", kind: "database", label: t("Datenbank", "Database") },
        { id: "due", kind: "field", of: "database", types: ["date"], label: t("Fälligkeitsdatum", "Due date") },
        { id: "assignee", kind: "field", of: "database", types: ["person"], label: t("Verantwortliche", "Responsible") },
        { id: "status", kind: "field", of: "database", types: ["select"], label: t("Status (optional)", "Status (optional)"), optional: true },
        { id: "done", kind: "option", of: "status", label: t("Wert für erledigt", "Value for done"), optional: true },
      ],
      build: (a, ctx) => {
        const db = str(a.database);
        const status = str(a.status);
        const done = str(a.done);
        const check = !!(status && done);
        const nodes = [
          node("n_trigger", "trigger.record.date", t("Zwei Tage vor Fälligkeit", "Two days before due"), { database: db, field: str(a.due), offsetDays: -2, time: "09:00", mode: "reached" }),
          ...(check
            ? [
                node("n_isopen", "logic.if", t("Noch nicht erledigt", "Not done yet"), {
                  condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: `{{n_trigger.record.fields.${status}}}`, op: "neq", value: done }] },
                }),
              ]
            : []),
          node("n_notify", "notify.person", t("Verantwortliche erinnern", "Remind the people responsible"), {
            to: [`field:${str(a.assignee)}`],
            title: t("Fällig in 2 Tagen: {{n_trigger.record.title}}", "Due in 2 days: {{n_trigger.record.title}}"),
            message: t("„{{n_trigger.record.title}}“ ist am {{n_trigger.date}} fällig.", "“{{n_trigger.record.title}}” is due on {{n_trigger.date}}."),
            link: "trigger",
            channels: ["inbox", "push"],
            kind: "workflow",
          }),
        ];
        const edges = check ? [link("n_trigger", "n_isopen"), link("n_isopen", "n_notify", "true")] : [link("n_trigger", "n_notify")];
        return finish(nodes, edges, ctx.timeZone);
      },
    },
    {
      id: "form-triage",
      icon: "ClipboardText",
      name: t("Formular → KI-Kategorie → Zuweisung", "Form → AI category → assignment"),
      description: t(
        "Jede Formularantwort ordnet die KI einer Kategorie zu; je Kategorie wird eine Person zuständig und benachrichtigt. Ist die KI unsicher, entscheidet die Teamleitung.",
        "The AI puts every form answer into a category; each category makes a person responsible and notifies them. When the AI is unsure, the team lead decides.",
      ),
      gaps: [
        { id: "database", kind: "database", label: t("Datenbank mit Formular", "Database with the form") },
        { id: "category", kind: "field", of: "database", types: ["select"], label: t("Kategorie", "Category") },
        { id: "assignee", kind: "field", of: "database", types: ["person"], label: t("Zuständig (optional)", "Assignee (optional)"), optional: true },
        { id: "routing", kind: "routing", of: "category", label: t("Wer ist je Kategorie zuständig?", "Who is responsible per category?"), optional: true },
        { id: "lead", kind: "person", label: t("Teamleitung", "Team lead") },
      ],
      build: (a, ctx) => {
        const db = str(a.database);
        const category = str(a.category);
        const assignee = str(a.assignee);
        const lead = str(a.lead);
        const options = fieldsOf(ctx, a, "database").find((f) => f.id === category)?.options || [];
        const routing = (a.routing && typeof a.routing === "object" ? a.routing : {}) as Record<string, string>;
        const routes = options.filter((o) => routing[o]).slice(0, 20);
        const nodes: WorkflowNode[] = [
          node("n_trigger", "trigger.form.submitted", t("Formularantwort", "Form answer"), { database: db }),
          node("n_classify", "ai.classify", t("Kategorie bestimmen", "Determine the category"), {
            text: "{{n_trigger.record.title}}\n{{n_trigger.answers | json}}",
            source: "field",
            database: db,
            field: category,
            categories: [],
            multiple: false,
            unclear: true,
          }),
          node("n_unclear", "notify.person", t("Teamleitung entscheidet", "Team lead decides"), {
            to: [lead],
            title: t("Kategorie unklar: {{n_trigger.record.title}}", "Category unclear: {{n_trigger.record.title}}"),
            message: t("Bitte Kategorie und Zuständigkeit festlegen.", "Please set the category and who is responsible."),
            link: "trigger",
            channels: ["inbox", "push"],
            kind: "workflow",
          }),
        ];
        const edges: WorkflowEdge[] = [link("n_trigger", "n_classify"), link("n_classify", "n_unclear", "unclear")];
        if (!routes.length) {
          nodes.push(node("n_update", "action.record.update", t("Kategorie eintragen", "Set the category"), { record: "", values: { [category]: "{{n_classify.category}}" } }));
          edges.push(link("n_classify", "n_update"), link("n_update", "n_unclear"));
          nodes[2] = { ...nodes[2], label: t("Teamleitung benachrichtigen", "Notify the team lead") };
        } else {
          const cases = routes.map((o, i) => ({ id: `c${i + 1}`, label: o.slice(0, 60), op: "eq", value: o }));
          nodes.push(node("n_switch", "logic.switch", t("Nach Kategorie", "By category"), { value: "{{n_classify.category}}", cases }));
          edges.push(link("n_classify", "n_switch"), link("n_switch", "n_unclear", "default"));
          routes.forEach((o, i) => {
            const person = routing[o];
            const label = o.replace(/[.|{}[\]]/g, " ").trim().slice(0, 40) || String(i + 1);
            const up = `n_assign${i + 1}`,
              tell = `n_notify${i + 1}`;
            nodes.push(
              node(up, "action.record.update", t(`Zuweisen ${label}`, `Assign ${label}`), { record: "", values: { [category]: o, ...(assignee ? { [assignee]: person } : {}) } }),
              node(tell, "notify.person", t(`Benachrichtigen ${label}`, `Notify ${label}`), {
                to: [person],
                title: t("Neue Anfrage: {{n_trigger.record.title}}", "New request: {{n_trigger.record.title}}"),
                message: t(`Kategorie: ${o}`, `Category: ${o}`),
                link: "trigger",
                channels: ["inbox", "push"],
                kind: "workflow",
              }),
            );
            edges.push(link("n_switch", up, `case:c${i + 1}`), link(up, tell));
          });
        }
        return finish(nodes, edges, ctx.timeZone);
      },
    },
    {
      id: "weekly-report",
      icon: "Newspaper",
      name: t("Wochenbericht", "Weekly report"),
      description: t(
        "Freitags um 15:00 sucht der Workflow die in dieser Woche erledigten Einträge, lässt die KI zusammenfassen, legt eine Berichtsseite an und postet sie im Chat.",
        "On Fridays at 15:00 the workflow finds the records completed this week, has the AI summarise them, creates a report page and posts it to the chat.",
      ),
      gaps: [
        { id: "database", kind: "database", label: t("Datenbank", "Database") },
        { id: "doneDate", kind: "field", of: "database", types: ["date", "updated_at", "created_at"], label: t("Datum der Erledigung", "Date completed") },
        { id: "parent", kind: "page", label: t("Berichte ablegen unter", "Store the reports below") },
        { id: "chat", kind: "chatHook", label: t("Chat-Webhook (optional)", "Chat webhook (optional)"), optional: true },
      ],
      build: (a, ctx) => {
        const db = str(a.database);
        const chat = str(a.chat);
        const nodes = [
          node("n_trigger", "trigger.schedule", t("Freitags 15:00", "Fridays 15:00"), { freq: "weekly", interval: 1, weekday: 5, day: 1, time: "15:00", timeZone: ctx.timeZone }),
          node("n_records", "action.record.find", t("Diese Woche erledigt", "Completed this week"), {
            database: db,
            filter: { kind: "group", join: "and", rules: [{ kind: "condition", left: str(a.doneDate), op: "in_relative", value: "this_week", timeZone: ctx.timeZone }] },
            limit: 100,
          }),
          node("n_summary", "ai.summarize", t("Zusammenfassung", "Summary"), { text: '{{n_records.records | join: "\n"}}', length: "bullets", language: "workflow" }, { onError: { retry: 1, then: "continue" } }),
          node("n_report", "action.page.create", t("Berichtsseite anlegen", "Create the report page"), {
            parent: str(a.parent),
            title: t('Wochenbericht {{$today | date: "dd.MM.yyyy"}}', 'Weekly report {{$today | date: "yyyy-MM-dd"}}'),
            blocks: [
              { type: "paragraph", text: t("{{n_records.count}} Einträge erledigt.", "{{n_records.count}} records completed.") },
              { type: "paragraph", text: "{{n_summary.summary}}" },
            ],
            template: "",
            tags: [],
          }),
          ...(chat
            ? [node("n_chatpost", "notify.chat", t("Im Chat posten", "Post to the chat"), { webhook: chat, title: "{{n_report.page.title}}", message: t("{{n_records.count}} Einträge erledigt: {{n_report.page.url}}", "{{n_records.count}} records completed: {{n_report.page.url}}") })]
            : []),
        ];
        const edges = [link("n_trigger", "n_records"), link("n_records", "n_summary"), link("n_summary", "n_report"), ...(chat ? [link("n_report", "n_chatpost")] : [])];
        return finish(nodes, edges, ctx.timeZone);
      },
    },
    {
      id: "mail-ticket",
      icon: "EnvelopeSimpleOpen",
      name: t("Eingehende Mail → Ticket", "Inbound e-mail → ticket"),
      description: t(
        "Eine E-Mail an die Adresse des Workflows wird zum Eintrag: die KI liest Titel, Beschreibung und Dringlichkeit aus, der Absender bekommt eine Bestätigung.",
        "An e-mail to the workflow's address becomes a record: the AI reads the title, description and urgency, the sender gets a confirmation.",
      ),
      gaps: [
        { id: "address", kind: "address", label: t("E-Mail-Adresse", "E-mail address") },
        { id: "database", kind: "database", label: t("Ticket-Datenbank", "Ticket database") },
        { id: "description", kind: "field", of: "database", types: ["text", "url"], label: t("Beschreibung (optional)", "Description (optional)"), optional: true },
      ],
      build: (a, ctx) => {
        const db = str(a.database);
        const title = fieldsOf(ctx, a, "database")[0]?.id || "title";
        const description = str(a.description);
        const nodes = [
          node("n_trigger", "trigger.mail.received", t("E-Mail empfangen", "E-mail received"), { address: str(a.address), senders: "not_failed" }),
          node(
            "n_extract",
            "ai.extract",
            t("Felder auslesen", "Extract fields"),
            {
              text: "{{n_trigger.mail.subject}}\n\n{{n_trigger.mail.text | truncate: 8000}}",
              fields: [
                { name: "title", type: "text", description: t("Kurzer Titel des Anliegens", "Short title of the request") },
                { name: "summary", type: "text", description: t("Beschreibung in zwei bis drei Sätzen", "Description in two or three sentences") },
                { name: "urgent", type: "boolean", description: t("Ist es dringend?", "Is it urgent?") },
              ],
            },
            { onError: { retry: 1, then: "continue" } },
          ),
          node("n_create", "action.record.create", t("Ticket anlegen", "Create the ticket"), {
            database: db,
            values: {
              [title]: '{{n_extract.fields.title | default: n_trigger.mail.subject}}',
              ...(description ? { [description]: "{{n_extract.fields.summary}}\n\n{{n_trigger.mail.from}}" } : {}),
            },
            template: "",
          }),
          node("n_confirm", "notify.email", t("Absender bestätigen", "Confirm to the sender"), {
            to: ["{{n_trigger.mail.from}}"],
            subject: t("Eingegangen: {{n_trigger.mail.subject}}", "Received: {{n_trigger.mail.subject}}"),
            message: t("Danke, wir haben deine Nachricht erhalten und kümmern uns darum.", "Thank you, we have received your message and will take care of it."),
          }),
        ];
        return finish(nodes, [link("n_trigger", "n_extract"), link("n_extract", "n_create"), link("n_create", "n_confirm")], ctx.timeZone);
      },
    },
    {
      id: "webhook-record",
      icon: "Broadcast",
      name: t("Webhook → Eintrag", "Webhook → record"),
      description: t(
        "Ein anderer Dienst – Monitoring, ein fremdes Formular – ruft die Adresse des Workflows auf; daraus wird ein Eintrag in einer Datenbank.",
        "Another service – monitoring, a third-party form – calls the workflow's address; it becomes a record in a database.",
      ),
      gaps: [
        { id: "database", kind: "database", label: t("Datenbank", "Database") },
        { id: "description", kind: "field", of: "database", types: ["text", "url"], label: t("Beschreibung (optional)", "Description (optional)"), optional: true },
      ],
      build: (a, ctx) => {
        const db = str(a.database);
        const title = fieldsOf(ctx, a, "database")[0]?.id || "title";
        const description = str(a.description);
        const nodes = [
          node("n_trigger", "trigger.webhook", t("Eingehender Webhook", "Inbound webhook"), {
            mode: "signed",
            fields: [
              { name: "title", type: "text" },
              { name: "description", type: "text" },
            ],
          }),
          node("n_create", "action.record.create", t("Eintrag anlegen", "Create the record"), {
            database: db,
            values: { [title]: "{{n_trigger.body.title | required}}", ...(description ? { [description]: "{{n_trigger.body.description}}" } : {}) },
            template: "",
          }),
        ];
        return finish(nodes, [link("n_trigger", "n_create")], ctx.timeZone);
      },
    },
  ];
}
export const workflowTemplate = (id: string, t: T) => workflowTemplates(t).find((x) => x.id === id) || null;

/* ---------- Gaps ---------- */

// Which gaps still need an answer (optional ones and those whose database
// or field is missing do not).
export function missingGaps(gaps: Gap[], answers: GapAnswers): Gap[] {
  return gaps.filter((g) => {
    if (g.optional || g.kind === "toggle" || g.kind === "routing") return false;
    const v = answers[g.id];
    return v === undefined || v === null || v === "";
  });
}
// The value a field gap's database has (for the pickers).
export const gapDatabase = (gaps: Gap[], gap: Gap, answers: GapAnswers): string => {
  let g: Gap | undefined = gap;
  while (g && g.kind !== "database") g = gaps.find((x) => x.id === g!.of);
  return g ? str(answers[g.id]) : "";
};

// "$ask:<gap>" tokens of an imported graph, replaced by the answers (also
// inside strings like "field:$ask:g1" and as keys of `values`).
const TOKEN = /\$ask:([a-z0-9_]{1,40})/g;
export function fillTokens(graph: WorkflowGraph, answers: GapAnswers): WorkflowGraph {
  const replace = (s: string) => s.replace(TOKEN, (m, gap: string) => (typeof answers[gap] === "string" && answers[gap] ? (answers[gap] as string) : m));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replace(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [replace(k), walk(x)]));
    return v;
  };
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, config: walk(n.config) as Record<string, unknown> })) };
}
export const hasTokens = (graph: WorkflowGraph) => /\$ask:[a-z0-9_]/.test(JSON.stringify(graph.nodes));
