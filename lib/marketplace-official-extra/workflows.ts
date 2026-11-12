// Workflow templates of the marketplace (see ./types.ts): graphs with
// "$ask:<gap>" tokens where the importing person picks a database, a
// property, a page or a person (the import clears what is still open and
// lists it). Only node types of lib/workflows/catalog.ts; laid out by
// lib/marketplace-official.ts.
import type { WorkflowEdge, WorkflowNode } from "../workflows/graph";
import type { ExtraWorkflow } from "./types";

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
const edge = (from: string, to: string, port = "out"): WorkflowEdge => ({ id: `e_${from.slice(2)}_${to.slice(2)}`.slice(0, 22), from: { node: from, port }, to: { node: to, port: "in" } });
const TZ = "Europe/Berlin";

export const extraWorkflows: ExtraWorkflow[] = [
  {
    kind: "workflow",
    id: "status-change-notify",
    category: "projects",
    title: { de: "Statuswechsel melden", en: "Notify on status change" },
    tags: ["Workflow", "Status", "Benachrichtigung"],
    summary: {
      de: "Ändert sich der Status eines Eintrags, bekommen die Verantwortlichen und wer den Eintrag angelegt hat eine Benachrichtigung mit dem neuen Status.",
      en: "When a record's status changes, the people responsible and whoever created the record get a notification with the new status.",
    },
    description: {
      de: "Ein kleiner Workflow für jede Datenbank mit Status – Aufgaben, Fehler-Tracker, Anfragen.\n\n- **Auslöser**: Die Status-Eigenschaft eines Eintrags ändert sich.\n- **Aktion**: Benachrichtigung in der App und per Push an die Personen der Eigenschaft „Verantwortlich“ und an die Person, die den Eintrag angelegt hat.\n\nBeim Import Datenbank, Status-Eigenschaft und (optional) die Personen-Eigenschaft wählen. Der Workflow startet pausiert – nach dem Prüfen aktivieren.",
      en: "A small workflow for any database with a status – tasks, bug trackers, requests.\n\n- **trigger**: a record's status property changes.\n- **action**: an in-app and push notification to the people of the “responsible” property and to the person who created the record.\n\nPick the database, the status property and (optionally) the person property when importing. The workflow starts paused – activate it after checking.",
    },
    gaps: [
      { id: "database", kind: "database", label: { de: "Datenbank", en: "Database" } },
      { id: "status", kind: "field", label: { de: "Status-Eigenschaft", en: "Status property" } },
      { id: "assignee", kind: "field", label: { de: "Verantwortliche (optional)", en: "Responsible (optional)" }, optional: true },
    ],
    nodes: [
      node("n_trigger", "trigger.record.changed", "Status geändert", { database: "$ask:database", fields: ["$ask:status"] }),
      node("n_notify", "notify.person", "Beteiligte benachrichtigen", {
        to: ["field:$ask:assignee", "@creator"],
        title: "Neuer Status: {{n_trigger.record.title}}",
        message: "„{{n_trigger.record.title}}“ ist jetzt „{{n_trigger.record.fields.$ask:status}}“ (geändert von {{n_trigger.actor.name}}).",
        link: "trigger",
        channels: ["inbox", "push"],
        kind: "workflow",
      }),
    ],
    edges: [edge("n_trigger", "n_notify")],
  },
  {
    kind: "workflow",
    id: "overdue-digest",
    category: "projects",
    title: { de: "Tägliche Übersicht überfälliger Einträge", en: "Daily digest of overdue records" },
    tags: ["Workflow", "Erinnerung", "Überfällig", "Zeitplan"],
    summary: {
      de: "Jeden Morgen um 8:00 sucht der Workflow alle Einträge, deren Fälligkeit überschritten ist und die noch nicht erledigt sind, und schickt einer Person die Liste.",
      en: "Every morning at 8:00 the workflow finds all records past their due date that are not done yet and sends the list to one person.",
    },
    description: {
      de: "Statt vieler einzelner Erinnerungen eine Übersicht am Morgen.\n\n- **Zeitplan**: täglich um 8:00 (Zeitzone Europe/Berlin – im Auslöser anpassbar)\n- **Einträge finden**: Fälligkeit vor heute und Status nicht „erledigt“\n- **Wenn** es welche gibt: Benachrichtigung mit Anzahl und Liste an die gewählte Person, verlinkt mit der Datenbank\n\nBeim Import Datenbank, Fälligkeitsdatum, Status-Eigenschaft, den Wert für „erledigt“ und die Person wählen.",
      en: "One overview in the morning instead of many single reminders.\n\n- **schedule**: daily at 8:00 (time zone Europe/Berlin – adjustable in the trigger)\n- **find records**: due before today and status not “done”\n- **if** there are any: a notification with the count and the list to the chosen person, linked to the database\n\nPick the database, the due date, the status property, the value for “done” and the person when importing.",
    },
    gaps: [
      { id: "database", kind: "database", label: { de: "Datenbank", en: "Database" } },
      { id: "due", kind: "field", label: { de: "Fälligkeitsdatum", en: "Due date" } },
      { id: "status", kind: "field", label: { de: "Status-Eigenschaft", en: "Status property" } },
      { id: "done", kind: "option", label: { de: "Wert für erledigt", en: "Value for done" } },
      { id: "person", kind: "person", label: { de: "Wer bekommt die Übersicht?", en: "Who gets the digest?" } },
    ],
    nodes: [
      node("n_trigger", "trigger.schedule", "Täglich 8 Uhr", { freq: "daily", interval: 1, weekday: 1, day: 1, time: "08:00", timeZone: TZ }),
      node("n_records", "action.record.find", "Überfällige finden", {
        database: "$ask:database",
        filter: {
          kind: "group",
          join: "and",
          rules: [
            { kind: "condition", left: "$ask:due", op: "before", value: "{{$today}}" },
            { kind: "condition", left: "$ask:status", op: "neq", value: "$ask:done" },
          ],
        },
        limit: 50,
      }),
      node("n_anydue", "logic.if", "Gibt es welche", { condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: "{{n_records.count}}", op: "gt", value: "0" }] } }),
      node("n_notify", "notify.person", "Übersicht schicken", {
        to: ["$ask:person"],
        title: "{{n_records.count}} überfällige Einträge",
        message: '{{n_records.records | join: "\n"}}',
        link: "$ask:database",
        channels: ["inbox", "push"],
        kind: "workflow",
      }),
    ],
    edges: [edge("n_trigger", "n_records"), edge("n_records", "n_anydue"), edge("n_anydue", "n_notify", "true")],
  },
  {
    kind: "workflow",
    id: "weekly-meeting-page",
    category: "meetings",
    title: { de: "Protokollseite für den Jour fixe anlegen", en: "Create the weekly meeting page" },
    tags: ["Workflow", "Jour fixe", "Protokoll", "Zeitplan"],
    summary: {
      de: "Jeden Montag um 8:00 legt der Workflow die Protokollseite für den Teamtermin mit Agenda, Ergebnissen und Aufgaben an und sagt der Moderation Bescheid.",
      en: "Every Monday at 8:00 the workflow creates the minutes page for the team meeting with agenda, outcomes and tasks and tells the facilitator.",
    },
    description: {
      de: "Nie wieder mit einer leeren Seite in den Termin.\n\n- **Zeitplan**: montags um 8:00 – Tag und Uhrzeit im Auslöser anpassen\n- **Seite anlegen** unter der gewählten Seite, Titel „Jour fixe“ mit Datum, mit festen Abschnitten\n- **Benachrichtigung** an die Moderation mit Link zur Seite\n\nBeim Import die Elternseite (z. B. „Protokolle“) und die Person wählen. Wer eine eigene Seitenvorlage hat, kann sie im Schritt „Seite anlegen“ auswählen.",
      en: "Never go into the meeting with an empty page again.\n\n- **schedule**: Mondays at 8:00 – change the day and time in the trigger\n- **create a page** below the chosen page, titled “Jour fixe” with the date, with fixed sections\n- **notify** the facilitator with a link to the page\n\nPick the parent page (e.g. “Minutes”) and the person when importing. If you have your own page template, choose it in the “create page” step.",
    },
    gaps: [
      { id: "parent", kind: "page", label: { de: "Protokolle ablegen unter", en: "Store the minutes below" } },
      { id: "host", kind: "person", label: { de: "Moderation", en: "Facilitator" } },
    ],
    nodes: [
      node("n_trigger", "trigger.schedule", "Montags 8 Uhr", { freq: "weekly", interval: 1, weekday: 1, day: 1, time: "08:00", timeZone: TZ }),
      node("n_newpage", "action.page.create", "Protokollseite anlegen", {
        parent: "$ask:parent",
        title: 'Jour fixe {{$today | date: "dd.MM.yyyy"}}',
        blocks: [
          { type: "heading", level: 2, text: "Agenda" },
          { type: "bullet", text: "Kurzrunde: Was ist seit letzter Woche passiert?" },
          { type: "bullet", text: "Aufgaben aus dem letzten Termin" },
          { type: "bullet", text: "Themen" },
          { type: "heading", level: 2, text: "Ergebnisse" },
          { type: "paragraph", text: "" },
          { type: "heading", level: 2, text: "Aufgaben" },
          { type: "task", text: "Aufgabe – Person – bis wann" },
        ],
        template: "",
        tags: [],
      }),
      node("n_notify", "notify.person", "Moderation informieren", {
        to: ["$ask:host"],
        title: "Die Seite für den Jour fixe ist bereit",
        message: "„{{n_newpage.page.title}}“ liegt bereit – Themen bitte bis zum Termin ergänzen.",
        link: "{{n_newpage.page.id}}",
        channels: ["inbox", "push"],
        kind: "workflow",
      }),
    ],
    edges: [edge("n_trigger", "n_newpage"), edge("n_newpage", "n_notify")],
  },
  {
    kind: "workflow",
    id: "journal-prompts",
    category: "personal",
    title: { de: "Fragen für den Journaltag", en: "Prompts for the journal day" },
    tags: ["Workflow", "Journal", "Tagebuch", "Reflexion"],
    summary: {
      de: "Jeder neue Tag im Journal bekommt automatisch Fragen für morgens und abends: Dankbarkeit, das Wichtigste heute und was ich gelernt habe.",
      en: "Every new day in the journal automatically gets prompts for the morning and evening: gratitude, the most important thing today and what I learned.",
    },
    description: {
      de: "Für alle, die ihr Journal regelmäßig, aber ohne leere Seite beginnen wollen.\n\n- **Auslöser**: Ein neuer Tag wird im Journal angelegt\n- **An Seite anhängen**: Abschnitte „Morgens“ und „Abends“ mit Fragen und einer Aufgabe für das Wichtigste des Tages\n\nBeim Import das Journal wählen (leer lassen: alle Journale). Die Fragen im Schritt „Fragen eintragen“ nach Belieben ändern.",
      en: "For everyone who wants to keep a journal regularly, without starting from an empty page.\n\n- **trigger**: a new day is created in the journal\n- **append to the page**: “morning” and “evening” sections with prompts and a task for the most important thing of the day\n\nPick the journal when importing (leave it empty for all journals). Change the prompts in the “add prompts” step as you like.",
    },
    gaps: [{ id: "journal", kind: "page", label: { de: "Journal (leer: alle)", en: "Journal (empty: all)" }, optional: true }],
    nodes: [
      node("n_trigger", "trigger.journal.day", "Neuer Journaltag", { journal: "$ask:journal" }),
      node("n_append", "action.page.append", "Fragen eintragen", {
        page: "{{n_trigger.day.id}}",
        where: { kind: "end" },
        blocks: [
          { type: "heading", level: 3, text: "Morgens" },
          { type: "paragraph", text: "Drei Dinge, für die ich heute dankbar bin:" },
          { type: "bullet", text: "…" },
          { type: "bullet", text: "…" },
          { type: "bullet", text: "…" },
          { type: "paragraph", text: "Was würde den heutigen Tag gut machen?" },
          { type: "task", text: "Das Wichtigste heute: …" },
          { type: "heading", level: 3, text: "Abends" },
          { type: "paragraph", text: "Was ist heute gut gelaufen? Was habe ich gelernt?" },
          { type: "paragraph", text: "Energie heute (1–5):" },
        ],
        noDuplicate: false,
      }),
    ],
    edges: [edge("n_trigger", "n_append")],
  },
  {
    kind: "workflow",
    id: "form-confirmation",
    category: "other",
    title: { de: "Formular: Bestätigung und Team informieren", en: "Form: confirmation and team notice" },
    tags: ["Workflow", "Formular", "E-Mail", "Anmeldung"],
    summary: {
      de: "Nach jeder Formularantwort bekommt die absendende Person eine Bestätigung per E-Mail und das Team eine Benachrichtigung in der App.",
      en: "After every form answer the sender gets a confirmation by e-mail and the team a notification in the app.",
    },
    description: {
      de: "Für Anmeldungen, Anfragen und Bewerbungen über das Formular einer Datenbank.\n\n- **Auslöser**: Jemand schickt das Formular ab\n- **Team informieren**: Benachrichtigung an die gewählte Person mit Link zum Eintrag\n- **Wenn** eine E-Mail-Adresse angegeben ist: **Bestätigung** an diese Adresse\n\nBeim Import Datenbank, die E-Mail-Eigenschaft des Formulars und die Person wählen; den Text der Bestätigung im Schritt „Bestätigung senden“ anpassen. E-Mails an Adressen außerhalb des Arbeitsbereichs müssen auf der Instanz erlaubt sein.",
      en: "For sign-ups, requests and applications through a database's form.\n\n- **trigger**: someone submits the form\n- **notify the team**: a notification to the chosen person with a link to the record\n- **if** an e-mail address was given: a **confirmation** to that address\n\nPick the database, the form's e-mail property and the person when importing; adapt the confirmation text in the “send confirmation” step. E-mail to addresses outside the workspace must be allowed on the instance.",
    },
    gaps: [
      { id: "database", kind: "database", label: { de: "Datenbank mit Formular", en: "Database with the form" } },
      { id: "email", kind: "field", label: { de: "E-Mail-Eigenschaft", en: "E-mail property" } },
      { id: "team", kind: "person", label: { de: "Wer wird informiert?", en: "Who is notified?" } },
    ],
    nodes: [
      node("n_trigger", "trigger.form.submitted", "Formularantwort", { database: "$ask:database" }),
      node("n_teaminfo", "notify.person", "Team informieren", {
        to: ["$ask:team"],
        title: "Neue Formularantwort: {{n_trigger.record.title}}",
        message: "Eine neue Antwort ist eingegangen.",
        link: "trigger",
        channels: ["inbox", "push"],
        kind: "workflow",
      }),
      node("n_hasmail", "logic.if", "E-Mail angegeben", {
        condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: "{{n_trigger.record.fields.$ask:email}}", op: "notempty", value: "" }] },
      }),
      node(
        "n_confirm",
        "notify.email",
        "Bestätigung senden",
        {
          to: ["{{n_trigger.record.fields.$ask:email}}"],
          subject: "Danke – deine Nachricht ist angekommen",
          message: "Hallo,\n\nvielen Dank! Deine Angaben zu „{{n_trigger.record.title}}“ sind bei uns eingegangen. Wir melden uns in den nächsten Tagen.\n\nViele Grüße",
        },
        // The record and the team notice stand even when the mail cannot go out.
        { onError: { retry: 1, then: "continue" } },
      ),
    ],
    edges: [edge("n_trigger", "n_teaminfo"), edge("n_trigger", "n_hasmail"), edge("n_hasmail", "n_confirm", "true")],
  },
];
