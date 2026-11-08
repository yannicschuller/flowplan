"use client";
// The settings of a node in the side panel, built from its configuration
// schema in the catalogue (lib/workflows/catalog.ts, as JSON Schema): every
// property gets a control by its type – text with placeholders, number,
// yes/no, a choice, a list, a group – and the properties that name
// something in the workspace get the matching picker (database, property,
// page, space, person, record template), conditions their own editor.
import { useId, useMemo, useState, type ReactNode } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { z } from "zod";
import { Select } from "../select";
import { nodeSpec } from "@/lib/workflows/catalog";
import { operatorNames, operatorsFor, valuelessOperators } from "@/lib/database-filters";
import type { WorkflowNode } from "@/lib/workflows/graph";
import type { Field } from "@/lib/types";
import { TemplateInput, type PickerContext } from "./template-input";
import { isUuid, recipientName, displayContext, type T, type Workspace, useStableT } from "./model";
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
  if (type === "logic.if") out.condition = { kind: "group", join: "and", rules: [{ kind: "condition", left: "", op: "eq", value: "" }] };
  if (type === "action.record.find") out.filter = { kind: "group", join: "and", rules: [] };
  return out;
}

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

const keyLabel = (key: string, t: T) => (KEY_TEXT[key] ? t(KEY_TEXT[key][0], KEY_TEXT[key][1]) : key);
const enumLabel = (key: string, value: string, t: T) => (ENUM_TEXT[`${key}.${value}`] ? t(ENUM_TEXT[`${key}.${value}`][0], ENUM_TEXT[`${key}.${value}`][1]) : value);
const typeOf = (s: Schema) => (Array.isArray(s.type) ? s.type[0] : s.type);

export type FormContext = {
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
  return true;
}

function Property({ name, schema, value, onChange, ctx, config, required, t }: { name: string; schema: Schema; value: unknown; onChange: (v: unknown) => void; ctx: FormContext; config: Record<string, unknown>; required?: boolean; t: T }) {
  const id = useId();
  const label = keyLabel(name, t) + (required ? " *" : "");
  const type = ctx.node.type;
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

function Labeled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
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
      return <TemplateInput label={label} value={String(value ?? "")} picker={ctx.picker} disabled={ctx.disabled} multiline={name === "message" || name === "text" || name === "value"} onChange={onChange} />;
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
                  <Generic key={k} name={k} label={keyLabel(k, t)} schema={s} value={(v as Record<string, unknown>)?.[k]} ctx={ctx} onChange={(x) => onChange(items.map((y, j) => (j === i ? { ...(y as object), [k]: x } : y)))} t={t} />
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

function DatabaseSelect({ id, value, ws, disabled, onChange, t }: { id: string; value: string; ws: Workspace; disabled: boolean; onChange: (v: string) => void; t: T }) {
  const dbs = ws.pages.filter((p) => p.kind === "database");
  return (
    <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("Datenbank wählen …", "Choose a database …")}</option>
      {value && !dbs.some((d) => d.id === value) && <option value={value}>{t("Datenbank ohne Zugriff", "Database without access")}</option>}
      {dbs.map((d) => <option key={d.id} value={d.id}>{d.title || t("Ohne Titel", "Untitled")}</option>)}
    </Select>
  );
}
function FieldSelect({ id, fields, value, disabled, onChange, t, empty }: { id?: string; fields: Field[]; value: string; disabled: boolean; onChange: (v: string) => void; t: T; empty?: string }) {
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
// Conditions: one level is edited here; nested groups (from imports) stay
// as they are and are named.
function ConditionEditor({ label, value, fields, ctx, onChange, t }: { label: string; value: Group | undefined; fields: Field[] | null; ctx: FormContext; onChange: (v: Group) => void; t: T }) {
  const g: Group = value || { kind: "group", join: "and", rules: [] };
  const set = (i: number, c: Condition) => onChange({ ...g, rules: g.rules.map((r, j) => (j === i ? c : r)) });
  return (
    <fieldset className="wf-group wf-conditions">
      <legend>{label}</legend>
      {g.rules.length > 1 && (
        <Select aria-label={t("Verknüpfung", "Combination")} value={g.join} disabled={ctx.disabled} onChange={(e) => onChange({ ...g, join: e.target.value as "and" | "or" })}>
          <option value="and">{enumLabel("join", "and", t)}</option>
          <option value="or">{enumLabel("join", "or", t)}</option>
        </Select>
      )}
      {g.rules.map((r, i) =>
        r.kind === "group" ? (
          <p key={i} className="muted">
            {t(`Gruppe mit ${r.rules.length} Bedingungen (unverändert)`, `Group of ${r.rules.length} conditions (unchanged)`)}
          </p>
        ) : (
          <div key={i} className="wf-condition">
            {fields ? (
              <FieldSelect fields={fields} value={r.left} disabled={ctx.disabled} onChange={(left) => set(i, { ...r, left })} t={t} />
            ) : (
              <TemplateInput label={t(`Bedingung ${i + 1}: Wert`, `Condition ${i + 1}: value`)} value={r.left} picker={ctx.picker} disabled={ctx.disabled} onChange={(left) => set(i, { ...r, left })} />
            )}
            <Select aria-label={t(`Bedingung ${i + 1}: Vergleich`, `Condition ${i + 1}: comparison`)} value={r.op} disabled={ctx.disabled} onChange={(e) => set(i, { ...r, op: e.target.value })}>
              {(fields ? operatorsFor(fields.find((f) => f.id === r.left)) : (Object.keys(operatorNames) as (keyof typeof operatorNames)[])).map((op) => (
                <option key={op} value={op}>
                  {t(operatorNames[op])}
                </option>
              ))}
            </Select>
            {!valuelessOperators.has(r.op) && (
              <TemplateInput label={t(`Bedingung ${i + 1}: Vergleichswert`, `Condition ${i + 1}: compared with`)} value={r.value || ""} picker={ctx.picker} disabled={ctx.disabled} onChange={(v) => set(i, { ...r, value: v })} />
            )}
            {!ctx.disabled && (
              <button type="button" className="icon-button" aria-label={t(`Bedingung ${i + 1} entfernen`, `Remove condition ${i + 1}`)} onClick={() => onChange({ ...g, rules: g.rules.filter((_, j) => j !== i) })}>
                <Trash />
              </button>
            )}
          </div>
        ),
      )}
      {!ctx.disabled && (
        <button type="button" className="button compact" onClick={() => onChange({ ...g, rules: [...g.rules, { kind: "condition", left: "", op: "eq", value: "" }] })}>
          <Plus /> {t("Bedingung", "Condition")}
        </button>
      )}
    </fieldset>
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

function Recipients({ label, value, ctx, fields, onChange, t }: { label: string; value: string[]; ctx: FormContext; fields: Field[]; onChange: (v: string[]) => void; t: T }) {
  const locale = useLocale();
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
      {!ctx.disabled && (
        <Select aria-label={t("Empfänger hinzufügen", "Add a recipient")} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{t("+ Empfänger …", "+ Recipient …")}</option>
          {options.filter((o) => !value.includes(o[0])).map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}
        </Select>
      )}
    </fieldset>
  );
}
