"use client";
// The settings of a node in the side panel, built from its configuration
// schema in the catalogue (lib/workflows/catalog.ts, as JSON Schema): every
// property gets a control by its type – text with placeholders, number,
// yes/no, a choice, a list, a group – and the properties that name
// something in the workspace get the matching picker (database, property,
// page, space, person, record template), conditions their own editor.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Plus, Trash, Copy, ArrowsClockwise, Warning } from "@phosphor-icons/react";
import { z } from "zod";
import { Select } from "../select";
import { nodeSpec } from "@/lib/workflows/catalog";
import { operatorNames, operatorsFor, valuelessOperators } from "@/lib/database-filters";
import type { WorkflowNode } from "@/lib/workflows/graph";
import type { Field } from "@/lib/types";
import { TemplateInput, type PickerContext } from "./template-input";
import { isUuid, recipientName, displayContext, type Credential, type Resources, type T, type Workspace, useStableT } from "./model";
import { api, Modal } from "../ui";
import type { DatabaseInfo } from "./use-databases";
import { useLocale } from "../i18n";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  const?: string;
  oneOf?: Schema[];
  anyOf?: Schema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  additionalProperties?: Schema | boolean;
  propertyNames?: Schema;
};
const schemas = new Map<string, Schema>();
export function configSchema(type: string): Schema {
  let s = schemas.get(type);
  if (!s) {
    const spec = nodeSpec(type);
    s = spec ? (z.toJSONSchema(spec.config, { io: "input", unrepresentable: "any" }) as Schema) : {};
    schemas.set(type, s);
  }
  return s;
}
// A new node's settings: the schema's defaults and a sensible start.
export function initialConfig(type: string, context: { database?: string } = {}): Record<string, unknown> {
  const s = configSchema(type);
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(s.properties || {})) if (p.default !== undefined) out[k] = structuredClone(p.default);
  if (s.properties?.database && context.database && type.startsWith("trigger.record") ) out.database = context.database;
  if (type === "action.page.append") out.blocks = [{ type: "bullet", text: "" }];
  if (type === "notify.person") out.to = ["@actor"];
  if (type === "action.page.create") Object.assign(out, { parent: "", title: "" });
  if (type === "action.page.move") Object.assign(out, { page: "", parent: "" });
  if (type === "action.page.tag") Object.assign(out, { page: "", tags: [] });
  if (type === "action.task.create") Object.assign(out, { page: "", text: "", assignee: [] });
  if (type === "logic.if") out.condition = { kind: "group", join: "and", rules: [{ kind: "condition", left: "", op: "eq", value: "" }] };
  if (type === "action.record.find") out.filter = { kind: "group", join: "and", rules: [] };
  if (type === "logic.switch") out.cases = [{ id: newCaseId(), label: "", op: "eq", value: "" }];
  if (type === "logic.approval") out.approvers = ["@runner"];
  if (type === "notify.email") out.to = ["@runner"];
  if (type === "ai.classify") out.categories = [{ name: "", description: "" }];
  if (type === "ai.extract") out.fields = [{ name: "name", type: "text", description: "" }];
  return out;
}
export const newCaseId = () => Math.random().toString(36).slice(2, 10);

// i18n-table: 1 – [German, English] pairs (names of the settings)
const KEY_TEXT: Record<string, [string, string]> = {
  database: ["Datenbank", "Database"],
  includeForm: ["Auch Formularantworten", "Form answers too"],
  fields: ["Nur bei diesen Eigenschaften", "Only for these properties"],
  from: ["Von (Wert vorher)", "From (value before)"],
  to: ["Nach (neuer Wert)", "To (new value)"],
  field: ["Datumseigenschaft", "Date property"],
  offsetDays: ["Tage davor (−) oder danach (+)", "Days before (−) or after (+)"],
  time: ["Uhrzeit", "Time"],
  mode: ["Art", "Kind"],
  freq: ["Wiederholung", "Repeats"],
  interval: ["Alle … (Abstand)", "Every … (interval)"],
  weekday: ["Wochentag", "Weekday"],
  day: ["Tag im Monat", "Day of the month"],
  timeZone: ["Zeitzone", "Time zone"],
  scope: ["Wo", "Where"],
  kinds: ["Nur diese Seitentypen", "Only these page types"],
  what: ["Was sich ändert", "What changes"],
  tags: ["Tags (IDs)", "Tags (ids)"],
  on: ["Kommentare an", "Comments on"],
  inline: ["Auch Textkommentare", "Text comments too"],
  who: ["Wer", "Who"],
  people: ["Personen", "People"],
  inputs: ["Eingabefelder", "Input fields"],
  name: ["Name", "Name"],
  type: ["Typ", "Type"],
  required: ["Pflicht", "Required"],
  condition: ["Bedingungen", "Conditions"],
  values: ["Werte", "Values"],
  value: ["Wert", "Value"],
  result: ["Ergebnis", "Result"],
  message: ["Nachricht", "Message"],
  template: ["Eintragsvorlage", "Record template"],
  record: ["Eintrag (leer: der auslösende)", "Record (empty: the triggering one)"],
  onlyEmpty: ["Nur leere Eigenschaften füllen", "Fill empty properties only"],
  filter: ["Bedingungen", "Conditions"],
  sort: ["Sortierung", "Sort"],
  direction: ["Richtung", "Direction"],
  limit: ["Höchstens", "At most"],
  parent: ["Elternseite", "Parent page"],
  title: ["Titel", "Title"],
  blocks: ["Inhalt", "Content"],
  page: ["Seite", "Page"],
  where: ["Position", "Position"],
  kind: ["Stelle", "Place"],
  heading: ["Überschrift", "Heading"],
  noDuplicate: ["Nicht doppelt (Link schon da: nichts anhängen)", "Not twice (link already there: append nothing)"],
  op: ["Aktion", "Action"],
  position: ["Position", "Position"],
  link: ["Link in der Benachrichtigung", "Link in the notification"],
  channels: ["Kanäle", "Channels"],
  cases: ["Fälle", "Cases"],
  label: ["Bezeichnung", "Label"],
  list: ["Liste", "List"],
  parallel: ["Gleichzeitig höchstens", "At most at once"],
  amount: ["Dauer", "Duration"],
  unit: ["Einheit", "Unit"],
  until: ["Bis (Datum oder Zeitpunkt)", "Until (date or moment)"],
  weekdays: ["Nur an Werktagen", "Working days only"],
  approvers: ["Freigebende", "Approvers"],
  deadline: ["Frist", "Deadline"],
  onTimeout: ["Nach Ablauf der Frist", "When the deadline passes"],
  text: ["Text", "Text"],
  length: ["Länge", "Length"],
  language: ["Sprache", "Language"],
  languageCode: ["Sprachcode (z. B. de, en, fr)", "Language code (e.g. de, en, fr)"],
  source: ["Kategorien aus", "Categories from"],
  categories: ["Kategorien", "Categories"],
  description: ["Beschreibung", "Description"],
  multiple: ["Mehrere Kategorien erlaubt", "Several categories allowed"],
  unclear: ["Ausgang „unklar“, wenn keine passt", "Output “unclear” when none fits"],
  options: ["Auswahlwerte", "Choices"],
  system: ["Systemhinweis (optional)", "System hint (optional)"],
  prompt: ["Anweisung", "Prompt"],
  format: ["Antwort als", "Answer as"],
  maxTokens: ["Höchstens Tokens", "At most tokens"],
  temperature: ["Temperatur (0–2)", "Temperature (0–2)"],
  method: ["Methode", "Method"],
  url: ["Adresse (https://…, fester Host)", "Address (https://…, fixed host)"],
  query: ["Query-Parameter", "Query parameters"],
  headers: ["Header", "Headers"],
  bodyKind: ["Inhalt", "Body"],
  body: ["Inhalt", "Body"],
  credential: ["Zugangsdaten", "Credential"],
  timeoutSeconds: ["Zeitlimit (Sekunden)", "Time limit (seconds)"],
  failOnStatus: ["Fehler bei Status ab 400", "Fail on status 400 and above"],
  runInDry: ["Auch im Probelauf ausführen (nur GET)", "Also run in dry runs (GET only)"],
  subject: ["Betreff", "Subject"],
  webhook: ["Chat-Webhook", "Chat webhook"],
  address: ["E-Mail-Adresse", "E-mail address"],
  senders: ["Absender", "Senders"],
  journal: ["Journal", "Journal"],
  target: ["Wohin", "Where"],
  assignee: ["Person", "Person"],
  due: ["Fällig am (Datum oder Platzhalter)", "Due on (date or placeholder)"],
};
// Names that mean something else in another node.
// i18n-table: 1 – [German, English] pairs (names per node type)
const TYPE_KEY_TEXT: Record<string, [string, string]> = {
  "ai.extract:fields": ["Felder", "Fields"],
  "ai.prompt:fields": ["Felder der JSON-Antwort", "Fields of the JSON answer"],
  "trigger.webhook:fields": ["Erwartete Felder (für die Platzhalter)", "Expected fields (for placeholders)"],
  "trigger.webhook:mode": ["Absicherung", "Protection"],
  "logic.wait:mode": ["Warten", "Wait"],
  "logic.foreach:mode": ["Reihenfolge", "Order"],
  "logic.foreach:limit": ["Höchstens Elemente", "At most items"],
  "logic.switch:value": ["Wert", "Value"],
  "ai.classify:field": ["Auswahleigenschaft", "Select property"],
  "trigger.mail.received:address": ["E-Mail-Eingang", "Inbound address"],
  "notify.email:to": ["An", "To"],
  "notify.person:to": ["Empfänger", "Recipients"],
  "action.task.create:text": ["Aufgabe", "Task"],
  "action.task.create:heading": ["Unter der Überschrift (optional)", "Below the heading (optional)"],
};
// i18n-table: 1 – [German, English] pairs (choices)
const ENUM_TEXT: Record<string, [string, string]> = {
  "mode.reached": ["Erreicht", "Reached"],
  "mode.overdue": ["Überfällig", "Overdue"],
  "freq.daily": ["Täglich", "Daily"],
  "freq.weekly": ["Wöchentlich", "Weekly"],
  "freq.monthly": ["Monatlich", "Monthly"],
  "what.title": ["Titel", "Title"],
  "what.content": ["Inhalt", "Content"],
  "on.pages": ["Seiten", "Pages"],
  "on.records": ["Einträge", "Records"],
  "who.any": ["Irgendwer", "Anyone"],
  "who.me": ["Ich", "Me"],
  "who.people": ["Diese Personen", "These people"],
  "who.editors": ["Bearbeitende des Workflows", "Editors of the workflow"],
  "who.members": ["Alle Mitglieder, die die Seite sehen", "All members who see the page"],
  "type.text": ["Text", "Text"],
  "type.number": ["Zahl", "Number"],
  "type.date": ["Datum", "Date"],
  "type.boolean": ["Ja/Nein", "Yes/no"],
  "type.auto": ["Automatisch", "Automatic"],
  "type.list": ["Liste", "List"],
  "type.paragraph": ["Absatz", "Paragraph"],
  "type.heading": ["Überschrift", "Heading"],
  "type.bullet": ["Aufzählung", "Bullet"],
  "type.task": ["Aufgabe", "Task"],
  "type.link": ["Seitenlink", "Page link"],
  "type.divider": ["Trennlinie", "Divider"],
  "result.succeeded": ["Erfolgreich", "Succeeded"],
  "result.failed": ["Als Fehler", "As failed"],
  "direction.asc": ["Aufsteigend", "Ascending"],
  "direction.desc": ["Absteigend", "Descending"],
  "kind.end": ["Am Ende", "At the end"],
  "kind.start": ["Am Anfang", "At the start"],
  "kind.heading": ["Unter einer Überschrift", "Below a heading"],
  "op.add": ["Hinzufügen", "Add"],
  "op.remove": ["Entfernen", "Remove"],
  "position.start": ["Als erste", "First"],
  "position.end": ["Als letzte", "Last"],
  "mode.empty": ["Nur leere Teile füllen", "Fill empty parts only"],
  "mode.append": ["Anhängen", "Append"],
  "channels.inbox": ["Posteingang", "Inbox"],
  "channels.push": ["Push", "Push"],
  "channels.email": ["E-Mail", "Email"],
  "channels.messenger": ["Chat-App", "Chat app"],
  "depth.children": ["Nur direkt darunter", "Directly below only"],
  "depth.all": ["Alles darunter", "Everything below"],
  "join.and": ["Alle Bedingungen", "All conditions"],
  "join.or": ["Eine der Bedingungen", "Any condition"],
  "mode.sequential": ["Nacheinander", "One after the other"],
  "mode.parallel": ["Parallel (bis 5)", "In parallel (up to 5)"],
  "mode.duration": ["Eine Dauer", "For a duration"],
  "mode.until": ["Bis zu einem Zeitpunkt", "Until a moment"],
  "mode.next": ["Bis zur nächsten Uhrzeit", "Until the next time of day"],
  "mode.signed": ["Signiert (empfohlen)", "Signed (recommended)"],
  "mode.token": ["Nur Token", "Token only"],
  "unit.minutes": ["Minuten", "Minutes"],
  "unit.hours": ["Stunden", "Hours"],
  "unit.days": ["Tage", "Days"],
  "onTimeout.timeout": ["Ausgang „Frist abgelaufen“", "Output “timed out”"],
  "onTimeout.rejected": ["Als abgelehnt", "As rejected"],
  "length.sentence": ["Ein Satz", "One sentence"],
  "length.short": ["Kurz (2–3 Sätze)", "Short (2–3 sentences)"],
  "length.paragraph": ["Ein Absatz", "One paragraph"],
  "length.bullets": ["Stichpunkte", "Bullet points"],
  "language.auto": ["Wie der Text", "Like the text"],
  "language.workflow": ["Sprache des Workflows", "The workflow’s language"],
  "language.fixed": ["Feste Sprache", "A fixed language"],
  "source.list": ["Eigener Liste", "A list of my own"],
  "source.field": ["Optionen einer Auswahleigenschaft", "The options of a select property"],
  "format.text": ["Text", "Text"],
  "format.json": ["JSON mit Feldern", "JSON with fields"],
  "type.select": ["Auswahl", "Choice"],
  "type.object": ["Gruppe", "Group"],
  "bodyKind.none": ["Kein Inhalt", "No body"],
  "bodyKind.json": ["JSON", "JSON"],
  "bodyKind.form": ["Formular", "Form"],
  "bodyKind.text": ["Text", "Text"],
  "senders.verified": ["Nur geprüfte Absender (SPF/DKIM/DMARC bestanden)", "Verified senders only (SPF/DKIM/DMARC passed)"],
  "senders.not_failed": ["Alle außer durchgefallenen", "All but failed ones"],
  "senders.any": ["Alle erlaubten Absender", "All allowed senders"],
  "target.page": ["In eine Seite", "Into a page"],
  "target.personal": ["In die eigene Aufgabenseite (Meine Aufgaben)", "Into the own task page (My tasks)"],
};
// i18n-table: 1 – [German, English] pairs (page types)
const KIND_TEXT: Record<string, [string, string]> = {
  document: ["Dokument", "Document"],
  database: ["Datenbank", "Database"],
  whiteboard: ["Whiteboard", "Whiteboard"],
  journal: ["Journal", "Journal"],
  dashboard: ["Dashboard", "Dashboard"],
  notebook: ["Notizbuch", "Notebook"],
};
// i18n-table: 1 – [German, English] pairs (weekdays)
const WEEKDAYS: [string, string][] = [
  ["Montag", "Monday"],
  ["Dienstag", "Tuesday"],
  ["Mittwoch", "Wednesday"],
  ["Donnerstag", "Thursday"],
  ["Freitag", "Friday"],
  ["Samstag", "Saturday"],
  ["Sonntag", "Sunday"],
];
// Internal settings of database rules opened in the canvas: not shown.
const HIDDEN = new Set(["notify.person:kind", "notify.person:ruleName"]);

const keyLabel = (key: string, t: T, type?: string) => {
  const own = type ? TYPE_KEY_TEXT[`${type}:${key}`] : undefined;
  if (own) return t(own[0], own[1]);
  return KEY_TEXT[key] ? t(KEY_TEXT[key][0], KEY_TEXT[key][1]) : key;
};
const enumLabel = (key: string, value: string, t: T) => (ENUM_TEXT[`${key}.${value}`] ? t(ENUM_TEXT[`${key}.${value}`][0], ENUM_TEXT[`${key}.${value}`][1]) : value);
const typeOf = (s: Schema) => (Array.isArray(s.type) ? s.type[0] : s.type);

export type FormContext = {
  // The workflow page (resources, credentials, webhook addresses).
  pageId?: string;
  node: WorkflowNode;
  ws: Workspace;
  databases: Map<string, DatabaseInfo>;
  picker: PickerContext;
  // The database of the triggering record (for "the triggering record").
  triggerDatabase: string | null;
  disabled: boolean;
};

export function ConfigForm({ ctx, onChange }: { ctx: FormContext; onChange: (config: Record<string, unknown>) => void }) {
  const t = useStableT();
  const schema = configSchema(ctx.node.type);
  const config = ctx.node.config as Record<string, unknown>;
  return (
    <div className="wf-form">
      {Object.entries(schema.properties || {}).map(([key, s]) =>
        HIDDEN.has(`${ctx.node.type}:${key}`) || !visible(ctx.node.type, key, config) ? null : (
          <Property key={key} name={key} schema={s} value={config[key]} ctx={ctx} config={config} required={schema.required?.includes(key)} t={t} onChange={(v) => onChange(v === undefined ? omit(config, key) : { ...config, [key]: v })} />
        ),
      )}
    </div>
  );
}
const omit = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
// Settings that only matter for some choices.
function visible(type: string, key: string, c: Record<string, unknown>) {
  if (type === "trigger.schedule") {
    if (key === "weekday") return c.freq === "weekly";
    if (key === "day") return c.freq === "monthly";
  }
  if (type === "trigger.mention" && key === "people") return c.who === "people";
  if ((type === "action.record.update" || type === "action.record.template") && key === "database") return !!String(c.record || "").trim();
  if (type === "logic.wait") {
    if (key === "amount" || key === "unit") return (c.mode || "duration") === "duration";
    if (key === "until") return c.mode === "until";
    if (key === "time") return c.mode === "until" || c.mode === "next";
    if (key === "weekdays") return c.mode === "next";
  }
  if (type === "logic.foreach" && key === "parallel") return c.mode === "parallel";
  if (type === "action.task.create" && key === "page") return c.target !== "personal";
  if (type === "logic.approval" && key === "onTimeout") return !!c.deadline;
  if (type === "ai.summarize" && key === "languageCode") return c.language === "fixed";
  if (type === "ai.classify") {
    if (key === "categories") return c.source !== "field";
    if (key === "database" || key === "field") return c.source === "field";
  }
  if (type === "ai.prompt" && key === "fields") return c.format === "json";
  if (type === "http.request" && (key === "bodyKind" || key === "body")) return (c.method || "GET") !== "GET" && (key === "bodyKind" || (c.bodyKind && c.bodyKind !== "none"));
  return true;
}

function Property({ name, schema, value, onChange, ctx, config, required, t }: { name: string; schema: Schema; value: unknown; onChange: (v: unknown) => void; ctx: FormContext; config: Record<string, unknown>; required?: boolean; t: T }) {
  const id = useId();
  const type = ctx.node.type;
  const label = keyLabel(name, t, type) + (required ? " *" : "");
  const db = (typeof config.database === "string" && config.database) || ctx.triggerDatabase || "";
  const info = ctx.databases.get(db);
  // Pickers for references.
  if (name === "database") return <Labeled id={id} label={label}><DatabaseSelect id={id} value={String(value || "")} ws={ctx.ws} disabled={ctx.disabled} onChange={onChange} t={t} /></Labeled>;
  if (name === "field" && type === "trigger.record.date")
    return <Labeled id={id} label={label}><FieldSelect id={id} fields={(info?.fields || []).filter((f) => ["date", "created_at", "updated_at"].includes(f.type))} value={String(value || "")} disabled={ctx.disabled} onChange={onChange} t={t} /></Labeled>;
  if (name === "fields" && type === "trigger.record.changed")
    return <CheckList label={label} options={(info?.fields || []).map((f) => [f.id, f.name])} value={(value as string[]) || []} disabled={ctx.disabled} onChange={onChange} />;
  if (name === "template" && (type === "action.record.create" || type === "action.record.template"))
    return (
      <Labeled id={id} label={label}>
        <Select id={id} value={String(value || "")} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("Keine", "None")}</option>
          {(info?.templates || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
      </Labeled>
    );
  if (name === "scope") return <ScopeEditor value={value as Scope} ws={ctx.ws} disabled={ctx.disabled} onChange={onChange} t={t} />;
  // Wave 2 (§6): their own editors.
  if (name === "cases" && type === "logic.switch") return <CasesEditor label={label} value={(value as Case[]) || []} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "approvers" && type === "logic.approval") return <Recipients label={label} value={(value as string[]) || []} ctx={ctx} fields={info?.fields || []} onChange={onChange} t={t} noActor={false} />;
  if (name === "deadline" && type === "logic.approval") return <DeadlineEditor label={label} value={value as Deadline | undefined} disabled={ctx.disabled} onChange={onChange} t={t} />;
  if (name === "to" && type === "notify.email") return <Recipients label={label} value={(value as string[]) || []} ctx={ctx} fields={info?.fields || []} onChange={onChange} t={t} addresses />;
  if (name === "webhook" && type === "notify.chat") return <ResourceSelect id={id} label={label} kind="chatHooks" value={String(value || "")} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "address" && type === "trigger.mail.received") return <ResourceSelect id={id} label={label} kind="addresses" value={String(value || "")} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "journal" && type === "trigger.journal.day") return <ResourceSelect id={id} label={label} kind="journals" value={String(value || "")} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "credential" && type === "http.request") return <CredentialSelect id={id} label={label} value={String(value || "")} url={String(config.url || "")} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "mode" && type === "trigger.webhook")
    return (
      <>
        <Generic name={name} label={label} schema={schema} value={value} ctx={ctx} onChange={onChange} t={t} />
        {value === "token" && (
          <p className="wf-warning small">
            <Warning aria-hidden /> {t("Wer die Adresse kennt, kann den Workflow starten. Nur wählen, wenn der Sender nicht signieren kann; höchstens 10 Aufrufe je Minute.", "Anyone who knows the address can start the workflow. Choose it only when the sender cannot sign; at most 10 calls a minute.")}
          </p>
        )}
        <HookBox ctx={ctx} t={t} mode={value === "token" ? "token" : "signed"} />
      </>
    );
  if (name === "field" && type === "ai.classify")
    return <Labeled id={id} label={label}><FieldSelect id={id} fields={(info?.fields || []).filter((f) => f.type === "select" || f.type === "multiselect")} value={String(value || "")} disabled={ctx.disabled} onChange={onChange} t={t} /></Labeled>;
  if (name === "tags" && (type === "action.page.tag" || type === "trigger.page.tagged")) return <TagPicker label={keyLabel("tags", t).replace(/ \(IDs\)| \(ids\)/, "")} value={(value as string[]) || []} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "kinds") return <CheckList label={label} options={Object.entries(KIND_TEXT).map(([k, v]) => [k, t(v[0], v[1])])} value={(value as string[]) || []} disabled={ctx.disabled} onChange={onChange} />;
  if (name === "people") return <CheckList label={label} options={ctx.ws.members.map((m) => [m.id, m.name])} value={(value as string[]) || []} disabled={ctx.disabled} onChange={onChange} />;
  if (name === "weekday")
    return (
      <Labeled id={id} label={label}>
        <Select id={id} value={String(value ?? 1)} disabled={ctx.disabled} onChange={(e) => onChange(Number(e.target.value))}>
          {WEEKDAYS.map((d, i) => <option key={i} value={i + 1}>{t(d[0], d[1])}</option>)}
        </Select>
      </Labeled>
    );
  if ((name === "condition" && type === "logic.if") || (name === "filter" && type === "action.record.find"))
    return <ConditionEditor label={label} value={value as Group} fields={name === "filter" ? info?.fields || [] : null} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "values" && (type === "action.record.create" || type === "action.record.update"))
    return <ValuesEditor label={label} value={(value as Record<string, unknown>) || {}} fields={info?.fields || []} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "blocks") return <BlocksEditor label={label} value={(value as Block[]) || []} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "to" && type === "notify.person") return <Recipients label={label} value={(value as string[]) || []} ctx={ctx} fields={info?.fields || []} onChange={onChange} t={t} />;
  // One person at most (#208).
  if (name === "assignee" && type === "action.task.create")
    return <Recipients label={label} value={(value as string[]) || []} ctx={ctx} fields={info?.fields || []} onChange={onChange} t={t} single />;
  if ((name === "page" || name === "parent") && typeOf(schema) === "string")
    return <PageRef label={label} value={String(value ?? "")} ctx={ctx} onChange={onChange} t={t} />;
  if (name === "where" && type === "action.page.append") {
    const w = (value as { kind?: string; heading?: string } | undefined) || { kind: "end" };
    return (
      <>
        <Labeled id={id} label={label}>
          <Select id={id} value={w.kind || "end"} disabled={ctx.disabled} onChange={(e) => onChange({ ...w, kind: e.target.value })}>
            {["end", "start", "heading"].map((k) => <option key={k} value={k}>{enumLabel("kind", k, t)}</option>)}
          </Select>
        </Labeled>
        {w.kind === "heading" && (
          <Labeled id={`${id}-heading`} label={keyLabel("heading", t)}>
            <input id={`${id}-heading`} type="text" value={w.heading || ""} maxLength={200} disabled={ctx.disabled} onChange={(e) => onChange({ ...w, heading: e.target.value })} />
          </Labeled>
        )}
      </>
    );
  }
  if (name === "sort" && type === "action.record.find") {
    const s = (value as { field?: string; direction?: string } | undefined) || undefined;
    return (
      <Labeled id={id} label={label}>
        <div className="wf-inline">
          <FieldSelect id={id} fields={info?.fields || []} value={s?.field || ""} disabled={ctx.disabled} empty={t("Nicht sortieren", "Do not sort")} onChange={(f) => onChange(f ? { field: f, direction: s?.direction || "asc" } : undefined)} t={t} />
          {s?.field && (
            <Select aria-label={keyLabel("direction", t)} value={s.direction || "asc"} disabled={ctx.disabled} onChange={(e) => onChange({ ...s, direction: e.target.value })}>
              <option value="asc">{enumLabel("direction", "asc", t)}</option>
              <option value="desc">{enumLabel("direction", "desc", t)}</option>
            </Select>
          )}
        </div>
      </Labeled>
    );
  }
  return <Generic name={name} label={label} schema={schema} value={value} ctx={ctx} onChange={onChange} t={t} />;
}

export function Labeled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="wf-field">
      <label className="wf-field-label" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

// Any other property by its schema.
function Generic({ name, label, schema, value, ctx, onChange, t }: { name: string; label: string; schema: Schema; value: unknown; ctx: FormContext; onChange: (v: unknown) => void; t: T }) {
  const id = useId();
  const type = typeOf(schema);
  if (schema.enum && type === "string")
    return (
      <Labeled id={id} label={label}>
        <Select id={id} value={String(value ?? schema.default ?? "")} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
          {schema.enum.map((v) => <option key={v} value={v}>{enumLabel(name, v, t)}</option>)}
        </Select>
        {name === "senders" && String(value ?? schema.default) === "verified" && (
          <small className="muted">
            {t(
              "Braucht INBOUND_MAIL_AUTHSERV_ID auf dem Server (die Kennung des eigenen Mailservers in Authentication-Results) – ohne gilt kein Absender als geprüft.",
              "Needs INBOUND_MAIL_AUTHSERV_ID on the server (your own mail server’s id in Authentication-Results) – without it no sender counts as verified.",
            )}
          </small>
        )}
      </Labeled>
    );
  if (type === "boolean")
    return (
      <label className="wf-check">
        <input type="checkbox" checked={!!(value ?? schema.default)} disabled={ctx.disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  if (type === "integer" || type === "number")
    return (
      <Labeled id={id} label={label}>
        <input
          id={id}
          type="number"
          className="wf-number"
          min={schema.minimum}
          max={schema.maximum}
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={schema.default !== undefined ? String(schema.default) : ""}
          disabled={ctx.disabled}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </Labeled>
    );
  if (type === "string") {
    // Ids and short codes are plain fields, longer texts take placeholders.
    if ((schema.maxLength ?? 0) >= 500)
      return <TemplateInput label={label} value={String(value ?? "")} picker={ctx.picker} disabled={ctx.disabled} multiline={["message", "text", "prompt", "body", "system"].includes(name) || (name === "value" && ctx.node.type !== "logic.switch")} onChange={onChange} />;
    return (
      <Labeled id={id} label={label}>
        <input id={id} type={name === "time" ? "time" : "text"} value={String(value ?? "")} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value === "" && !schema.minLength ? undefined : e.target.value)} />
      </Labeled>
    );
  }
  if (type === "array" && schema.items) {
    const items = (value as unknown[]) || [];
    if (schema.items.enum)
      return <CheckList label={label} options={schema.items.enum.map((v) => [v, enumLabel(name, v, t)])} value={items as string[]} disabled={ctx.disabled} onChange={onChange} />;
    const item = schema.items;
    return (
      <fieldset className="wf-list">
        <legend>{label}</legend>
        {items.map((v, i) => (
          <div className="wf-list-item" key={i}>
            {typeOf(item) === "object" ? (
              <div className="wf-group">
                {Object.entries(item.properties || {}).map(([k, s]) => (
                  <Generic key={k} name={k} label={keyLabel(k, t, ctx.node.type)} schema={s} value={(v as Record<string, unknown>)?.[k]} ctx={ctx} onChange={(x) => onChange(items.map((y, j) => (j === i ? { ...(y as object), [k]: x } : y)))} t={t} />
                ))}
              </div>
            ) : (
              <Generic name={name} label={`${label} ${i + 1}`} schema={item} value={v} ctx={ctx} onChange={(x) => onChange(items.map((y, j) => (j === i ? x : y)))} t={t} />
            )}
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`${label} ${i + 1} entfernen`, `Remove ${label} ${i + 1}`)} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                <Trash />
              </button>
            )}
          </div>
        ))}
        {!ctx.disabled && (
          <button type="button" className="button compact" onClick={() => onChange([...items, typeOf(item) === "object" ? defaults(item) : ""])}>
            <Plus /> {t("Hinzufügen", "Add")}
          </button>
        )}
      </fieldset>
    );
  }
  if (type === "object" && schema.properties)
    return (
      <fieldset className="wf-group">
        <legend>{label}</legend>
        {Object.entries(schema.properties).map(([k, s]) => (
          <Generic key={k} name={k} label={keyLabel(k, t)} schema={s} value={(value as Record<string, unknown>)?.[k]} ctx={ctx} onChange={(x) => onChange({ ...((value as object) || {}), [k]: x })} t={t} />
        ))}
      </fieldset>
    );
  // Anything else as JSON.
  return (
    <Labeled id={id} label={label}>
      <textarea
        id={id}
        className="wf-json"
        rows={3}
        defaultValue={JSON.stringify(value ?? null, null, 1)}
        disabled={ctx.disabled}
        onBlur={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {}
        }}
      />
    </Labeled>
  );
}
function defaults(s: Schema) {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(s.properties || {})) out[k] = p.default ?? (typeOf(p) === "string" ? "" : undefined);
  return out;
}

function CheckList({ label, options, value, disabled, onChange }: { label: string; options: [string, string][]; value: string[]; disabled: boolean; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="wf-checks">
      <legend>{label}</legend>
      {options.map(([v, text]) => (
        <label key={v} className="wf-check">
          <input type="checkbox" checked={value.includes(v)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...value, v] : value.filter((x) => x !== v))} />
          <span>{text}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function DatabaseSelect({ id, value, ws, disabled, onChange, t }: { id: string; value: string; ws: Workspace; disabled: boolean; onChange: (v: string) => void; t: T }) {
  const dbs = ws.pages.filter((p) => p.kind === "database");
  return (
    <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("Datenbank wählen …", "Choose a database …")}</option>
      {value && !dbs.some((d) => d.id === value) && <option value={value}>{t("Datenbank ohne Zugriff", "Database without access")}</option>}
      {dbs.map((d) => <option key={d.id} value={d.id}>{d.title || t("Ohne Titel", "Untitled")}</option>)}
    </Select>
  );
}
export function FieldSelect({ id, fields, value, disabled, onChange, t, empty }: { id?: string; fields: Field[]; value: string; disabled: boolean; onChange: (v: string) => void; t: T; empty?: string }) {
  return (
    <Select id={id} aria-label={id ? undefined : t("Eigenschaft", "Property")} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty || t("Eigenschaft wählen …", "Choose a property …")}</option>
      {value && !fields.some((f) => f.id === value) && <option value={value}>{value}</option>}
      {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </Select>
  );
}

type Scope = { kind: "workspace" } | { kind: "space"; spaceId: string } | { kind: "below"; pageId: string; depth?: "children" | "all" };
function ScopeEditor({ value, ws, disabled, onChange, t }: { value: Scope | undefined; ws: Workspace; disabled: boolean; onChange: (v: Scope) => void; t: T }) {
  const id = useId();
  const v = value || { kind: "workspace" };
  return (
    <fieldset className="wf-group">
      <legend>{keyLabel("scope", t)}</legend>
      <Select
        aria-label={keyLabel("scope", t)}
        value={v.kind}
        disabled={disabled}
        onChange={(e) => {
          const kind = e.target.value;
          onChange(kind === "space" ? { kind: "space", spaceId: ws.spaces[0]?.id || "" } : kind === "below" ? { kind: "below", pageId: "", depth: "children" } : { kind: "workspace" });
        }}
      >
        <option value="workspace">{t("Im ganzen Arbeitsbereich", "In the whole workspace")}</option>
        <option value="space">{t("In einem Bereich", "In one space")}</option>
        <option value="below">{t("Unter einer Seite", "Below a page")}</option>
      </Select>
      {v.kind === "space" && (
        <Labeled id={id} label={t("Bereich", "Space")}>
          <Select id={id} value={v.spaceId} disabled={disabled} onChange={(e) => onChange({ kind: "space", spaceId: e.target.value })}>
            {ws.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Labeled>
      )}
      {v.kind === "below" && (
        <>
          <Labeled id={id} label={t("Seite", "Page")}>
            <PageSelect id={id} value={v.pageId} ws={ws} disabled={disabled} onChange={(pageId) => onChange({ ...v, pageId })} t={t} />
          </Labeled>
          <Select aria-label={t("Tiefe", "Depth")} value={v.depth || "children"} disabled={disabled} onChange={(e) => onChange({ ...v, depth: e.target.value as "children" | "all" })}>
            <option value="children">{enumLabel("depth", "children", t)}</option>
            <option value="all">{enumLabel("depth", "all", t)}</option>
          </Select>
        </>
      )}
    </fieldset>
  );
}

export function PageSelect({ id, value, ws, disabled, onChange, t }: { id?: string; value: string; ws: Workspace; disabled: boolean; onChange: (v: string) => void; t: T }) {
  // Pages by space, indented below their parents.
  const options = useMemo(() => {
    const out: { id: string; label: string; group: string }[] = [];
    const kids = new Map<string | null, typeof ws.pages>();
    for (const p of ws.pages) {
      const key = p.parent_id && ws.pages.some((x) => x.id === p.parent_id) ? p.parent_id : `space:${p.space_id}`;
      kids.set(key, [...(kids.get(key) || []), p]);
    }
    const walk = (key: string, depth: number, group: string) => {
      for (const p of kids.get(key) || []) {
        if (p.kind === "workflow") continue;
        out.push({ id: p.id, label: `${"  ".repeat(depth)}${p.title || t("Ohne Titel", "Untitled")}`, group });
        if (depth < 6) walk(p.id, depth + 1, group);
      }
    };
    for (const s of ws.spaces) walk(`space:${s.id}`, 0, s.name);
    return out;
  }, [ws, t]);
  return (
    <Select id={id} aria-label={id ? undefined : t("Seite", "Page")} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("Seite wählen …", "Choose a page …")}</option>
      {value && isUuid(value) && !options.some((o) => o.id === value) && <option value={value}>{t("Seite ohne Zugriff", "Page without access")}</option>}
      {ws.spaces.map((s) => (
        <optgroup key={s.id} label={s.name}>
          {options.filter((o) => o.group === s.name).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

// A page: chosen from the tree, or a placeholder ({{Trigger.page.parent}}).
function PageRef({ label, value, ctx, onChange, t }: { label: string; value: string; ctx: FormContext; onChange: (v: string) => void; t: T }) {
  const id = useId();
  const [mode, setMode] = useState<"page" | "placeholder">(!value || isUuid(value) ? "page" : "placeholder");
  const chosen = mode === "page";
  return (
    <fieldset className="wf-group wf-ref">
      <legend>{label}</legend>
      <div className="wf-segmented" role="radiogroup" aria-label={label}>
        <label>
          <input type="radio" name={id} checked={chosen} disabled={ctx.disabled} onChange={() => (setMode("page"), onChange(""))} /> {t("Seite wählen", "Choose a page")}
        </label>
        <label>
          <input type="radio" name={id} checked={!chosen} disabled={ctx.disabled} onChange={() => (setMode("placeholder"), onChange(""))} /> {t("Aus Platzhalter", "From a placeholder")}
        </label>
      </div>
      {chosen ? (
        <PageSelect value={value} ws={ctx.ws} disabled={ctx.disabled} onChange={onChange} t={t} />
      ) : (
        <TemplateInput label={t("Platzhalter oder Seiten-ID", "Placeholder or page id")} value={value} picker={ctx.picker} disabled={ctx.disabled} onChange={onChange} />
      )}
    </fieldset>
  );
}

type Condition = { kind: "condition"; left: string; op: string; value?: string; values?: string[] };
type Group = { kind: "group"; join: "and" | "or"; rules: (Condition | Group)[] };
// Conditions with groups inside (and/or, two levels below the top, as the
// schema allows): each group has its own combination.
function ConditionEditor({ label, value, fields, ctx, onChange, t }: { label: string; value: Group | undefined; fields: Field[] | null; ctx: FormContext; onChange: (v: Group) => void; t: T }) {
  const g: Group = value || { kind: "group", join: "and", rules: [] };
  return (
    <fieldset className="wf-group wf-conditions">
      <legend>{label}</legend>
      <GroupEditor group={g} depth={0} path={[]} fields={fields} ctx={ctx} onChange={onChange} t={t} />
    </fieldset>
  );
}
function GroupEditor({ group: g, depth, path, fields, ctx, onChange, onRemove, t }: { group: Group; depth: number; path: number[]; fields: Field[] | null; ctx: FormContext; onChange: (v: Group) => void; onRemove?: () => void; t: T }) {
  const set = (i: number, c: Condition | Group) => onChange({ ...g, rules: g.rules.map((r, j) => (j === i ? c : r)) });
  const name = (i: number) => [...path, i + 1].join(".");
  return (
    <div className={`wf-cond-group depth-${depth}`}>
      {(g.rules.length > 1 || depth > 0) && (
        <div className="wf-inline">
          <Select aria-label={depth ? t(`Gruppe ${path.join(".")}: Verknüpfung`, `Group ${path.join(".")}: combination`) : t("Verknüpfung", "Combination")} value={g.join} disabled={ctx.disabled} onChange={(e) => onChange({ ...g, join: e.target.value as "and" | "or" })}>
            <option value="and">{enumLabel("join", "and", t)}</option>
            <option value="or">{enumLabel("join", "or", t)}</option>
          </Select>
          {onRemove && !ctx.disabled && (
            <button type="button" className="icon-button" aria-label={t(`Gruppe ${path.join(".")} entfernen`, `Remove group ${path.join(".")}`)} onClick={onRemove}>
              <Trash />
            </button>
          )}
        </div>
      )}
      {g.rules.map((r, i) =>
        r.kind === "group" ? (
          <GroupEditor key={i} group={r} depth={depth + 1} path={[...path, i + 1]} fields={fields} ctx={ctx} onChange={(x) => set(i, x)} onRemove={() => onChange({ ...g, rules: g.rules.filter((_, j) => j !== i) })} t={t} />
        ) : (
          <div key={i} className="wf-condition">
            {fields ? (
              <FieldSelect fields={fields} value={r.left} disabled={ctx.disabled} onChange={(left) => set(i, { ...r, left })} t={t} />
            ) : (
              <TemplateInput label={t(`Bedingung ${name(i)}: Wert`, `Condition ${name(i)}: value`)} value={r.left} picker={ctx.picker} disabled={ctx.disabled} onChange={(left) => set(i, { ...r, left })} />
            )}
            <Select aria-label={t(`Bedingung ${name(i)}: Vergleich`, `Condition ${name(i)}: comparison`)} value={r.op} disabled={ctx.disabled} onChange={(e) => set(i, { ...r, op: e.target.value })}>
              {(fields ? operatorsFor(fields.find((f) => f.id === r.left)) : (Object.keys(operatorNames) as (keyof typeof operatorNames)[])).map((op) => (
                <option key={op} value={op}>
                  {t(operatorNames[op])}
                </option>
              ))}
            </Select>
            {!valuelessOperators.has(r.op) && (
              <TemplateInput label={t(`Bedingung ${name(i)}: Vergleichswert`, `Condition ${name(i)}: compared with`)} value={r.value || ""} picker={ctx.picker} disabled={ctx.disabled} onChange={(v) => set(i, { ...r, value: v })} />
            )}
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`Bedingung ${name(i)} entfernen`, `Remove condition ${name(i)}`)} onClick={() => onChange({ ...g, rules: g.rules.filter((_, j) => j !== i) })}>
                <Trash />
              </button>
            )}
          </div>
        ),
      )}
      {!ctx.disabled && (
        <div className="wf-inline">
          <button type="button" className="button compact" onClick={() => onChange({ ...g, rules: [...g.rules, { kind: "condition", left: "", op: "eq", value: "" }] })}>
            <Plus /> {t("Bedingung", "Condition")}
          </button>
          {depth < 2 && (
            <button type="button" className="button compact" onClick={() => onChange({ ...g, rules: [...g.rules, { kind: "group", join: g.join === "and" ? "or" : "and", rules: [{ kind: "condition", left: "", op: "eq", value: "" }] }] })}>
              <Plus /> {t("Gruppe", "Group")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Property → value, values with placeholders (fixed values of rules stay).
function ValuesEditor({ label, value, fields, ctx, onChange, t }: { label: string; value: Record<string, unknown>; fields: Field[]; ctx: FormContext; onChange: (v: Record<string, unknown>) => void; t: T }) {
  const free = fields.filter((f) => !(f.id in value) && !["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id"].includes(f.type));
  return (
    <fieldset className="wf-group">
      <legend>{label}</legend>
      {!fields.length && <p className="muted">{t("Zuerst die Datenbank wählen.", "Choose the database first.")}</p>}
      {Object.entries(value).map(([fid, v]) => {
        const name = fields.find((f) => f.id === fid)?.name || fid;
        return (
          <div key={fid} className="wf-list-item">
            {typeof v === "string" ? (
              <TemplateInput label={name} value={v} picker={ctx.picker} disabled={ctx.disabled} onChange={(x) => onChange({ ...value, [fid]: x })} />
            ) : (
              <p className="wf-fixed">
                <span className="wf-field-label">{name}</span> <code>{JSON.stringify(v)}</code>
              </p>
            )}
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`„${name}“ entfernen`, `Remove “${name}”`)} onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k !== fid)))}>
                <Trash />
              </button>
            )}
          </div>
        );
      })}
      {!ctx.disabled && free.length > 0 && (
        <Select aria-label={t("Eigenschaft hinzufügen", "Add a property")} value="" onChange={(e) => e.target.value && onChange({ ...value, [e.target.value]: "" })}>
          <option value="">{t("+ Eigenschaft …", "+ Property …")}</option>
          {free.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      )}
    </fieldset>
  );
}

type Block = { type: string; text?: string; level?: number; page?: string; checked?: boolean };
function BlocksEditor({ label, value, ctx, onChange, t }: { label: string; value: Block[]; ctx: FormContext; onChange: (v: Block[]) => void; t: T }) {
  const set = (i: number, b: Block) => onChange(value.map((x, j) => (j === i ? b : x)));
  const types = ["paragraph", "heading", "bullet", "task", "link", "divider"];
  return (
    <fieldset className="wf-group">
      <legend>{label}</legend>
      {value.map((b, i) => (
        <div key={i} className="wf-block">
          <div className="wf-inline">
            <Select aria-label={t(`Block ${i + 1}: Art`, `Block ${i + 1}: kind`)} value={b.type} disabled={ctx.disabled} onChange={(e) => set(i, { ...b, type: e.target.value })}>
              {types.map((x) => <option key={x} value={x}>{enumLabel("type", x, t)}</option>)}
            </Select>
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`Block ${i + 1} entfernen`, `Remove block ${i + 1}`)} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <Trash />
              </button>
            )}
          </div>
          {b.type === "link" ? (
            <TemplateInput label={t(`Block ${i + 1}: Seite`, `Block ${i + 1}: page`)} value={b.page || ""} picker={ctx.picker} disabled={ctx.disabled} onChange={(page) => set(i, { ...b, page })} />
          ) : b.type !== "divider" ? (
            <TemplateInput label={t(`Block ${i + 1}: Text`, `Block ${i + 1}: text`)} value={b.text || ""} picker={ctx.picker} disabled={ctx.disabled} multiline onChange={(text) => set(i, { ...b, text })} />
          ) : null}
        </div>
      ))}
      {!ctx.disabled && (
        <button type="button" className="button compact" onClick={() => onChange([...value, { type: "bullet", text: "" }])}>
          <Plus /> {t("Block", "Block")}
        </button>
      )}
    </fieldset>
  );
}

function Recipients({ label, value, ctx, fields, onChange, t, addresses = false, single = false }: { label: string; value: string[]; ctx: FormContext; fields: Field[]; onChange: (v: string[]) => void; t: T; addresses?: boolean; noActor?: boolean; single?: boolean }) {
  // `single`: one person (a task's assignee); remove it to choose another.
  const adding = !ctx.disabled && !(single && value.length >= 1);
  const locale = useLocale();
  const [free, setFree] = useState("");
  const freeId = useId();
  const dctx = useMemo(() => displayContext(ctx.picker.graph, locale, ctx.ws), [ctx.picker.graph, locale, ctx.ws]);
  const options: [string, string][] = [
    ["@actor", recipientName("@actor", ctx.ws, dctx, t)],
    ["@creator", recipientName("@creator", ctx.ws, dctx, t)],
    ["@runner", recipientName("@runner", ctx.ws, dctx, t)],
    ...fields.filter((f) => f.type === "person").map((f): [string, string] => [`field:${f.id}`, t(`Personen aus „${f.name}“`, `People from “${f.name}”`)]),
    ...ctx.ws.members.map((m): [string, string] => [m.id, m.name]),
  ];
  return (
    <fieldset className="wf-group">
      <legend>{label}</legend>
      <ul className="wf-chips">
        {value.map((r) => (
          <li key={r}>
            <span>{options.find((o) => o[0] === r)?.[1] || recipientName(r, ctx.ws, dctx, t)}</span>
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t("Entfernen", "Remove")} onClick={() => onChange(value.filter((x) => x !== r))}>
                <Trash />
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <Select aria-label={single ? t("Person wählen", "Choose a person") : t("Empfänger hinzufügen", "Add a recipient")} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{single ? t("+ Person …", "+ Person …") : t("+ Empfänger …", "+ Recipient …")}</option>
          {options.filter((o) => !value.includes(o[0])).map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}
        </Select>
      )}
      {adding && (
        // An address (e-mail) or a placeholder on people or addresses.
        <div className="wf-inline">
          <TemplateInput
            id={freeId}
            label={addresses ? t("Adresse oder Platzhalter", "Address or placeholder") : t("Oder aus Platzhalter", "Or from a placeholder")}
            value={free}
            picker={ctx.picker}
            onChange={setFree}
          />
          <button type="button" className="button compact" disabled={!free.trim() || value.includes(free.trim())} onClick={() => (onChange([...value, free.trim()]), setFree(""))}>
            <Plus /> {t("Hinzufügen", "Add")}
          </button>
        </div>
      )}
    </fieldset>
  );
}

/* ---------- Wave 2 editors ---------- */

type Case = { id: string; label: string; op: string; value: string };
// The cases of "Switch": a label, a comparison and a value each, in order.
function CasesEditor({ label, value, ctx, onChange, t }: { label: string; value: Case[]; ctx: FormContext; onChange: (v: Case[]) => void; t: T }) {
  const set = (i: number, c: Case) => onChange(value.map((x, j) => (j === i ? c : x)));
  return (
    <fieldset className="wf-group">
      <legend>{label}</legend>
      {value.map((c, i) => (
        <div key={c.id} className="wf-case">
          <div className="wf-inline">
            <input aria-label={t(`Fall ${i + 1}: Bezeichnung`, `Case ${i + 1}: label`)} placeholder={t(`Fall ${i + 1}`, `Case ${i + 1}`)} value={c.label} maxLength={60} disabled={ctx.disabled} onChange={(e) => set(i, { ...c, label: e.target.value })} />
            <Select aria-label={t(`Fall ${i + 1}: Vergleich`, `Case ${i + 1}: comparison`)} value={c.op} disabled={ctx.disabled} onChange={(e) => set(i, { ...c, op: e.target.value })}>
              {(Object.keys(operatorNames) as (keyof typeof operatorNames)[]).map((op) => (
                <option key={op} value={op}>
                  {t(operatorNames[op])}
                </option>
              ))}
            </Select>
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`Fall ${i + 1} entfernen`, `Remove case ${i + 1}`)} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <Trash />
              </button>
            )}
          </div>
          {!valuelessOperators.has(c.op) && <TemplateInput label={t(`Fall ${i + 1}: Vergleichswert`, `Case ${i + 1}: compared with`)} value={c.value} picker={ctx.picker} disabled={ctx.disabled} onChange={(v) => set(i, { ...c, value: v })} />}
        </div>
      ))}
      {!ctx.disabled && value.length < 20 && (
        <button type="button" className="button compact" onClick={() => onChange([...value, { id: newCaseId(), label: "", op: "eq", value: "" }])}>
          <Plus /> {t("Fall", "Case")}
        </button>
      )}
      <p className="muted small">{t("Der erste passende Fall gewinnt; sonst geht es über „sonst“ weiter.", "The first matching case wins; otherwise it goes on through “otherwise”.")}</p>
    </fieldset>
  );
}

type Deadline = { amount: number; unit: "minutes" | "hours" | "days" };
function DeadlineEditor({ label, value, disabled, onChange, t }: { label: string; value: Deadline | undefined; disabled: boolean; onChange: (v: Deadline | undefined) => void; t: T }) {
  const id = useId();
  return (
    <fieldset className="wf-group">
      <legend>{label}</legend>
      <label className="wf-check">
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked ? { amount: 2, unit: "days" } : undefined)} />
        <span>{t("Mit Frist", "With a deadline")}</span>
      </label>
      {value && (
        <div className="wf-inline">
          <input id={id} aria-label={t("Frist: Dauer", "Deadline: duration")} type="number" className="wf-number" min={1} value={value.amount} disabled={disabled} onChange={(e) => onChange({ ...value, amount: Math.max(1, Number(e.target.value) || 1) })} />
          <Select aria-label={t("Frist: Einheit", "Deadline: unit")} value={value.unit} disabled={disabled} onChange={(e) => onChange({ ...value, unit: e.target.value as Deadline["unit"] })}>
            {["minutes", "hours", "days"].map((u) => <option key={u} value={u}>{enumLabel("unit", u, t)}</option>)}
          </Select>
        </div>
      )}
    </fieldset>
  );
}

// What the editor may pick, per workflow page (loaded once, refreshed on demand).
const resourceCache = new Map<string, Promise<Resources>>();
export function useResources(pageId: string | undefined) {
  const [res, setRes] = useState<Resources | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!pageId) return;
    let live = true;
    if (tick) resourceCache.delete(pageId);
    if (!resourceCache.has(pageId)) resourceCache.set(pageId, api<Resources>(`/api/workflows/${pageId}/resources`).catch(() => ({ chatHooks: [], addresses: [], journals: [] })));
    void resourceCache.get(pageId)!.then((r) => live && setRes(r));
    return () => {
      live = false;
    };
  }, [pageId, tick]);
  return { res, reload: () => setTick((n) => n + 1) };
}
function ResourceSelect({ id, label, kind, value, ctx, onChange, t }: { id: string; label: string; kind: keyof Resources; value: string; ctx: FormContext; onChange: (v: string) => void; t: T }) {
  const { res } = useResources(ctx.pageId);
  const items: [string, string][] =
    kind === "chatHooks"
      ? (res?.chatHooks || []).map((h) => [h.id, `${h.format === "json" ? "JSON" : h.format[0].toUpperCase() + h.format.slice(1)} · ${h.host}`])
      : kind === "addresses"
        ? (res?.addresses || []).map((a) => [a.id, `${a.label || t("Ohne Namen", "Unnamed")}${a.signed ? "" : t(" · ohne Signierschlüssel", " · without signing key")}`])
        : (res?.journals || []).filter((j) => !j.locked).map((j) => [j.id, j.title || t("Ohne Titel", "Untitled")]);
  const empty =
    kind === "journals" ? t("Jedes Journal, das du siehst", "Any journal you see") : kind === "chatHooks" ? t("Webhook wählen …", "Choose a webhook …") : t("Adresse wählen …", "Choose an address …");
  return (
    <Labeled id={id} label={label}>
      <Select id={id} value={value} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty}</option>
        {value && !items.some((i) => i[0] === value) && <option value={value}>{t("Nicht (mehr) verfügbar", "Not available (any more)")}</option>}
        {items.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </Select>
      {res && !items.length && kind !== "journals" && (
        <small className="muted">
          {kind === "chatHooks"
            ? t("Noch kein Webhook für Workflows freigegeben: Eigentümer tun das in den Einstellungen unter Webhooks.", "No webhook released for workflows yet: owners do that in the settings under Webhooks.")
            : t("Noch keine Adresse, die an diesen Workflow geht: Eigentümer legen sie in den Einstellungen unter E-Mail-Eingang an (Ziel: diese Seite).", "No address goes to this workflow yet: owners create one in the settings under Inbound e-mail (target: this page).")}
        </small>
      )}
    </Labeled>
  );
}

// Credentials of the HTTP node: chosen by name; set and changed in a dialog,
// never shown again (§9.5).
function CredentialSelect({ id, label, value, url, ctx, onChange, t }: { id: string; label: string; value: string; url: string; ctx: FormContext; onChange: (v: string) => void; t: T }) {
  const [list, setList] = useState<Credential[] | null>(null);
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const load = async () => {
    if (!ctx.pageId) return;
    try {
      setList((await api<{ credentials: Credential[] }>(`/api/workflows/${ctx.pageId}/credentials`)).credentials);
    } catch {
      setList([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.pageId]);
  const host = /^https?:\/\/([^/?#{}]+)/i.exec(url.trim())?.[1]?.toLowerCase() || "";
  const chosen = list?.find((c) => c.id === value);
  return (
    <Labeled id={id} label={label}>
      <div className="wf-inline">
        <Select id={id} value={value} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("Keine", "None")}</option>
          {value && list && !chosen && <option value={value}>{t("Nicht (mehr) da", "Gone")}</option>}
          {(list || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.host}
            </option>
          ))}
        </Select>
        {!ctx.disabled && (
          <button type="button" className="button compact" onClick={() => setEditing(chosen || "new")}>
            {chosen ? t("Ändern", "Change") : t("Neu", "New")}
          </button>
        )}
      </div>
      {chosen && host && chosen.host !== host && <small className="wf-field-error">{t(`Diese Zugangsdaten gelten nur für ${chosen.host}.`, `This credential only applies to ${chosen.host}.`)}</small>}
      {editing && (
        <CredentialDialog
          pageId={ctx.pageId!}
          credential={editing === "new" ? null : editing}
          host={host}
          onClose={() => setEditing(null)}
          onSaved={async (cid) => {
            setEditing(null);
            await load();
            if (cid) onChange(cid);
            else onChange("");
          }}
          t={t}
        />
      )}
    </Labeled>
  );
}
function CredentialDialog({ pageId, credential, host: suggested, onClose, onSaved, t }: { pageId: string; credential: Credential | null; host: string; onClose: () => void; onSaved: (id: string | null) => void; t: T }) {
  const ids = { name: useId(), kind: useId(), host: useId(), a: useId(), b: useId() };
  const [name, setName] = useState(credential?.name || "");
  const [kind, setKind] = useState(credential?.kind || "bearer");
  const [host, setHost] = useState(credential?.host || suggested);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hostChanged = !!credential && (credential.host !== host.trim().toLowerCase() || credential.kind !== kind);
  const secret = kind === "bearer" ? { token: a } : kind === "basic" ? { username: a, password: b } : { name: a, value: b };
  const filled = kind === "bearer" ? !!a : kind === "basic" ? !!(a || b) : !!(a && b);
  const save = async () => {
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/command", { action: "workflow.credential.set", pageId, id: credential?.id, name, kind, host: host.trim().toLowerCase(), ...(filled ? { secret } : {}) });
      onSaved(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={credential ? t("Zugangsdaten ändern", "Change the credential") : t("Neue Zugangsdaten", "New credential")}>
      <div className="wf-dialog">
        <p className="muted small">{t("Wird versiegelt gespeichert und nur an diesen Host gesendet; niemand sieht das Geheimnis wieder. Ein neuer Host braucht das Geheimnis neu.", "Stored sealed and sent to this host only; nobody sees the secret again. A new host needs the secret again.")}</p>
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={ids.name}>{t("Name", "Name")}</label>
          <input id={ids.name} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={ids.kind}>{t("Art", "Kind")}</label>
          <Select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="bearer">{t("Bearer-Token", "Bearer token")}</option>
            <option value="basic">{t("Benutzer und Passwort (Basic)", "User and password (Basic)")}</option>
            <option value="header">{t("Eigener Header", "Own header")}</option>
            <option value="query">{t("Query-Parameter", "Query parameter")}</option>
          </Select>
        </div>
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={ids.host}>{t("Host (z. B. api.github.com)", "Host (e.g. api.github.com)")}</label>
          <input id={ids.host} value={host} maxLength={260} autoComplete="off" onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="wf-field">
          <label className="wf-field-label" htmlFor={ids.a}>{kind === "bearer" ? t("Token", "Token") : kind === "basic" ? t("Benutzer", "User") : t("Name", "Name")}</label>
          <input id={ids.a} type={kind === "bearer" ? "password" : "text"} value={a} autoComplete="off" placeholder={credential ? t("unverändert", "unchanged") : ""} onChange={(e) => setA(e.target.value)} />
        </div>
        {kind !== "bearer" && (
          <div className="wf-field">
            <label className="wf-field-label" htmlFor={ids.b}>{kind === "basic" ? t("Passwort", "Password") : t("Wert", "Value")}</label>
            <input id={ids.b} type="password" value={b} autoComplete="new-password" placeholder={credential ? t("unverändert", "unchanged") : ""} onChange={(e) => setB(e.target.value)} />
          </div>
        )}
        {error && <p className="wf-step-error">{error}</p>}
        <div className="modal-actions">
          {credential && (
            <button
              type="button"
              className="button danger"
              onClick={async () => {
                try {
                  await api("/api/command", { action: "workflow.credential.remove", pageId, id: credential.id });
                  onSaved(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {t("Entfernen", "Remove")}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>{t("Abbrechen", "Cancel")}</button>
          <button type="button" className="button primary" disabled={!name.trim() || !host.trim() || ((!credential || hostChanged) && !filled)} onClick={save}>
            {t("Speichern", "Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// The address of a webhook trigger, its signing secret and how to sign.
function HookBox({ ctx, t, mode }: { ctx: FormContext; t: T; mode: "signed" | "token" }) {
  const [hook, setHook] = useState<{ url: string | null; secret: string | null; lastUsedAt: number | null; lastError: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (rotate: boolean) => {
    if (!ctx.pageId) return;
    setBusy(true);
    setError(null);
    try {
      setHook((await api<{ hook: typeof hook }>("/api/command", { action: "workflow.hook", pageId: ctx.pageId, nodeId: ctx.node.id, rotate })).hook);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!ctx.disabled) void call(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.node.id, ctx.pageId]);
  const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => {});
  if (ctx.disabled) return null;
  return (
    <div className="wf-hookbox">
      {error && <p className="wf-step-error">{error}</p>}
      {hook?.url && (
        <>
          <div className="wf-field">
            <span className="wf-field-label">{t("Adresse (POST)", "Address (POST)")}</span>
            <div className="wf-copy">
              <code>{hook.url}</code>
              <button type="button" className="icon-button" aria-label={t("Adresse kopieren", "Copy the address")} onClick={() => copy(hook.url!)}>
                <Copy />
              </button>
            </div>
          </div>
          {mode === "signed" && hook.secret && (
            <div className="wf-field">
              <span className="wf-field-label">{t("Signiergeheimnis", "Signing secret")}</span>
              <div className="wf-copy">
                <code className="wf-secret">{hook.secret}</code>
                <button type="button" className="icon-button" aria-label={t("Geheimnis kopieren", "Copy the secret")} onClick={() => copy(hook.secret!)}>
                  <Copy />
                </button>
              </div>
              <small className="muted">
                {t(
                  "Header X-Flowplan-Timestamp (Unix-Sekunden) und X-Flowplan-Signature: sha256=HMAC-SHA256(Geheimnis, Zeitstempel + \".\" + Inhalt). Gilt nur aktiviert.",
                  "Headers X-Flowplan-Timestamp (Unix seconds) and X-Flowplan-Signature: sha256=HMAC-SHA256(secret, timestamp + \".\" + body). Works once activated.",
                )}
              </small>
            </div>
          )}
          <p className="muted small">
            {hook.lastUsedAt ? t(`Zuletzt aufgerufen: ${new Date(hook.lastUsedAt).toLocaleString()}`, `Last called: ${new Date(hook.lastUsedAt).toLocaleString()}`) : t("Noch nicht aufgerufen.", "Not called yet.")}
            {hook.lastError ? ` · ${hook.lastError}` : ""}
          </p>
          <button type="button" className="button compact" disabled={busy} onClick={() => void call(true)}>
            <ArrowsClockwise /> {t("Adresse neu erzeugen (die alte gilt sofort nicht mehr)", "New address (the old one stops working at once)")}
          </button>
        </>
      )}
    </div>
  );
}

// Tags by name (stored by id).
const tagCache = new Map<string, Promise<{ id: string; name: string }[]>>();
function TagPicker({ label, value, ctx, onChange, t }: { label: string; value: string[]; ctx: FormContext; onChange: (v: string[]) => void; t: T }) {
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const workspaceId = ctx.ws.workspaceId;
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    if (!tagCache.has(workspaceId)) tagCache.set(workspaceId, api<{ tags: { id: string; name: string }[] }>(`/api/tags?workspaceId=${workspaceId}`).then((r) => r.tags || []).catch(() => []));
    void tagCache.get(workspaceId)!.then((r) => live && setTags(r));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const name = (id: string) => tags.find((x) => x.id === id)?.name || t("Tag ohne Zugriff", "Tag without access");
  return (
    <fieldset className="wf-group">
      <legend>{label}</legend>
      <ul className="wf-chips">
        {value.map((id) => (
          <li key={id}>
            <span>{name(id)}</span>
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`„${name(id)}“ entfernen`, `Remove “${name(id)}”`)} onClick={() => onChange(value.filter((x) => x !== id))}>
                <Trash />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!ctx.disabled && (
        <Select aria-label={t("Tag hinzufügen", "Add a tag")} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{t("+ Tag …", "+ Tag …")}</option>
          {tags.filter((x) => !value.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
      )}
    </fieldset>
  );
}
