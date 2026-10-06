"use client";
import { useState } from "react";
import { Lightning, Plus, Trash, PencilSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import type { Automation, AutomationAction, DatabaseSettings } from "@/lib/database-settings-schema";
import { doneRule } from "@/lib/database-settings-schema";
import type { Field, User } from "@/lib/types";

type Props = {
  fields: Field[];
  settings: DatabaseSettings;
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  save: (patch: Partial<DatabaseSettings> | Record<string, null>) => Promise<boolean>;
};
type Condition = Automation["conditions"][number];
const newId = () => crypto.randomUUID().slice(0, 12);
// The natural first value of a "set" action for a property.
const startValue = (f: Field | undefined): unknown =>
  !f ? "" : f.type === "date" ? "@today" : f.type === "person" ? "@actor" : f.type === "checkbox" ? true : f.type === "select" ? f.options?.[0] || "" : "";
const settable = (f: Field) => !["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "files", "relation", "checklist"].includes(f.type);

// Rules of a database: "When …, only if …, then …". Each rule can be
// switched off; suggestions fill in the usual cases.
export function DatabaseAutomations({ fields, settings, members, editable, save }: Props) {
  const t = useT();
  const rules = settings.automations || [];
  const [draft, setDraft] = useState<Automation | null>(null);
  const [busy, setBusy] = useState(false);
  const status = doneRule(fields, settings);
  const dates = fields.filter((f) => f.type === "date");
  const people = fields.filter((f) => f.type === "person");

  const store = async (next: Automation[]) => {
    setBusy(true);
    try {
      return await save({ automations: next });
    } finally {
      setBusy(false);
    }
  };
  // The three usual rules, with this database's properties.
  const suggestions: { label: string; rule: () => Automation }[] = [];
  if (status && status.field.type === "select" && dates.length)
    suggestions.push({
      label: t(`Wenn ${status.field.name} → ${status.values[0]}, Datum setzen`, `When ${status.field.name} → ${status.values[0]}, set a date`),
      rule: () => ({
        id: newId(),
        name: t("Abschlussdatum setzen", "Set completion date"),
        enabled: true,
        trigger: { type: "changed", field: status.field.id, to: status.values[0] },
        conditions: [],
        actions: [{ type: "set", field: (dates.find((f) => /erledigt|abgeschlossen|done|closed|fertig/i.test(f.name)) || dates[0]).id, value: "@today" }],
      }),
    });
  if (dates.length)
    suggestions.push({
      label: t("Wenn die Fälligkeit überschritten ist, benachrichtigen", "When the due date has passed, notify"),
      rule: () => ({
        id: newId(),
        name: t("Überfällig", "Overdue"),
        enabled: true,
        trigger: { type: "overdue", field: (dates.find((f) => /fällig|due|deadline|frist/i.test(f.name)) || dates[0]).id },
        conditions: [],
        actions: [{ type: "notify", to: people[0] ? `field:${people[0].id}` : "@creator", message: t("Überfällig", "Overdue") }],
      }),
    });
  if (people.length)
    suggestions.push({
      label: t("Neue Formular-Einträge zuweisen", "Assign new form records"),
      rule: () => ({
        id: newId(),
        name: t("Formular zuweisen", "Assign form records"),
        enabled: true,
        trigger: { type: "form" },
        conditions: [],
        actions: [{ type: "set", field: people[0].id, value: members[0]?.id || "@creator" }],
      }),
    });
  const empty = (): Automation => ({ id: newId(), name: "", enabled: true, trigger: { type: "created" }, conditions: [], actions: [{ type: "notify", to: "@creator", message: "" }] });

  if (draft)
    return (
      <AutomationEditor
        rule={draft}
        fields={fields}
        members={members}
        busy={busy}
        onCancel={() => setDraft(null)}
        onSave={async (rule) => {
          const exists = rules.some((r) => r.id === rule.id);
          if (await store(exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule])) setDraft(null);
        }}
      />
    );
  return (
    <div className="automations">
      <p className="muted">
        {t(
          "Regeln erledigen wiederkehrende Handgriffe: Wenn etwas passiert und eine Bedingung zutrifft, setzt Flowplan Eigenschaften oder benachrichtigt jemanden.",
          "Rules take care of recurring steps: when something happens and a condition holds, Flowplan sets properties or notifies someone.",
        )}
      </p>
      {rules.length > 0 && (
        <ul className="automation-list">
          {rules.map((rule) => (
            <li key={rule.id} data-enabled={rule.enabled}>
              <Lightning weight={rule.enabled ? "fill" : "regular"} aria-hidden />
              <div>
                <strong>{rule.name || t("Regel", "Rule")}</strong>
                <span>{describe(rule, fields, members, t)}</span>
              </div>
              {editable && (
                <>
                  <label className="switch" title={rule.enabled ? t("Ausschalten", "Switch off") : t("Einschalten", "Switch on")}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t(`${rule.name || "Regel"} aktiv`, `${rule.name || "Rule"} active`)}
                      checked={rule.enabled}
                      disabled={busy}
                      onChange={(e) => void store(rules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r)))}
                    />
                  </label>
                  <button type="button" className="icon-button" aria-label={t("Bearbeiten", "Edit")} onClick={() => setDraft(rule)}>
                    <PencilSimple />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("Löschen", "Delete")}
                    disabled={busy}
                    onClick={() => void store(rules.filter((r) => r.id !== rule.id))}
                  >
                    <Trash />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="automation-add">
          <p className="muted">{rules.length ? t("Weitere Regel:", "Another rule:") : t("Vorschläge:", "Suggestions:")}</p>
          {suggestions.map((s) => (
            <button key={s.label} type="button" className="button compact" onClick={() => setDraft(s.rule())}>
              <Lightning /> {s.label}
            </button>
          ))}
          <button type="button" className="button compact" onClick={() => setDraft(empty())}>
            <Plus /> {t("Eigene Regel", "Custom rule")}
          </button>
        </div>
      )}
    </div>
  );
}

// "When Status changes to Done → set Closed on = today"
function describe(rule: Automation, fields: Field[], members: Pick<User, "id" | "name">[], t: (de: string, en: string) => string) {
  const name = (id: string) => fields.find((f) => f.id === id)?.name || "?";
  const tr = rule.trigger;
  const when =
    tr.type === "created"
      ? t("Neuer Eintrag", "New record")
      : tr.type === "form"
        ? t("Neuer Eintrag über ein Formular", "New record through a form")
        : tr.type === "overdue"
          ? t(`${name(tr.field)} überschritten`, `${name(tr.field)} passed`)
          : tr.to
            ? `${name(tr.field)} → ${tr.to}`
            : t(`${name(tr.field)} ändert sich`, `${name(tr.field)} changes`);
  const then = rule.actions
    .map((a) =>
      a.type === "set"
        ? `${name(a.field)} = ${valueLabel(a.value, members, t)}`
        : t(`benachrichtigen: ${whoLabel(a.to, fields, members, t)}`, `notify: ${whoLabel(a.to, fields, members, t)}`),
    )
    .join(", ");
  const only = rule.conditions.length ? t(` (mit ${rule.conditions.length} Bedingung${rule.conditions.length > 1 ? "en" : ""})`, ` (with ${rule.conditions.length} condition${rule.conditions.length > 1 ? "s" : ""})`) : "";
  return `${when}${only} → ${then}`;
}
function valueLabel(value: unknown, members: Pick<User, "id" | "name">[], t: (de: string, en: string) => string) {
  if (value === "@today") return t("heute", "today");
  if (value === "@now") return t("jetzt", "now");
  if (value === "@actor") return t("auslösende Person", "person who triggered it");
  if (value === "@creator") return t("Ersteller", "creator");
  if (value === "@clear") return t("leer", "empty");
  if (typeof value === "boolean") return value ? "✓" : "–";
  return members.find((m) => m.id === value)?.name || String(value ?? "");
}
function whoLabel(to: string, fields: Field[], members: Pick<User, "id" | "name">[], t: (de: string, en: string) => string) {
  if (to.startsWith("field:")) return fields.find((f) => f.id === to.slice(6))?.name || "?";
  if (to === "@creator") return t("Ersteller", "creator");
  if (to === "@actor") return t("auslösende Person", "person who triggered it");
  return members.find((m) => m.id === to)?.name || "?";
}

function AutomationEditor({
  rule,
  fields,
  members,
  busy,
  onSave,
  onCancel,
}: {
  rule: Automation;
  fields: Field[];
  members: Pick<User, "id" | "name">[];
  busy: boolean;
  onSave: (rule: Automation) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [r, setR] = useState(rule);
  const trigger = r.trigger;
  const triggerField = "field" in trigger ? fields.find((f) => f.id === trigger.field) : undefined;
  const watchable = fields.filter((f) => !["created_at", "updated_at", "created_by", "updated_by", "id", "formula", "rollup"].includes(f.type));
  const setAction = (i: number, a: AutomationAction) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) });
  const setCondition = (i: number, c: Condition) => setR({ ...r, conditions: r.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <form
      className="automation-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(r);
      }}
    >
      <label>
        {t("Name", "Name")}
        <input value={r.name} maxLength={120} placeholder={t("z. B. Abschlussdatum setzen", "e.g. Set completion date")} onChange={(e) => setR({ ...r, name: e.target.value })} />
      </label>
      <fieldset>
        <legend>{t("Wenn", "When")}</legend>
        <Select
          aria-label={t("Auslöser", "Trigger")}
          value={trigger.type}
          onChange={(e) => {
            const type = e.target.value as Automation["trigger"]["type"];
            const firstDate = fields.find((f) => f.type === "date")?.id || fields[0].id;
            setR({
              ...r,
              trigger:
                type === "changed"
                  ? { type, field: watchable[0]?.id || fields[0].id }
                  : type === "overdue"
                    ? { type, field: firstDate }
                    : { type },
            });
          }}
        >
          <option value="created">{t("ein Eintrag erstellt wird", "a record is created")}</option>
          <option value="form">{t("ein Eintrag über ein Formular kommt", "a record arrives through a form")}</option>
          <option value="changed">{t("sich eine Eigenschaft ändert", "a property changes")}</option>
          <option value="overdue" disabled={!fields.some((f) => f.type === "date")}>
            {t("ein Datum überschritten ist", "a date has passed")}
          </option>
        </Select>
        {(trigger.type === "changed" || trigger.type === "overdue") && (
          <Select
            aria-label={t("Eigenschaft des Auslösers", "Trigger property")}
            value={trigger.field}
            onChange={(e) => setR({ ...r, trigger: { ...trigger, field: e.target.value, ...(trigger.type === "changed" ? { to: undefined } : {}) } })}
          >
            {(trigger.type === "overdue" ? fields.filter((f) => f.type === "date") : watchable).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        )}
        {trigger.type === "changed" && triggerField && (
          <ValueInput
            label={t("auf (leer: beliebig)", "to (empty: any value)")}
            field={triggerField}
            members={members}
            value={trigger.to ?? ""}
            plain
            onChange={(v) => setR({ ...r, trigger: { ...trigger, to: v === "" || v === undefined ? undefined : String(v) } })}
          />
        )}
        {trigger.type === "overdue" && (
          <p className="muted">{t("Einmal je Eintrag und Datum, nur solange er nicht erledigt ist.", "Once per record and date, only while it is not done.")}</p>
        )}
      </fieldset>
      <fieldset>
        <legend>{t("Nur wenn (optional)", "Only if (optional)")}</legend>
        {r.conditions.map((c, i) => {
          const field = fields.find((f) => f.id === c.field) || fields[0];
          return (
            <div className="automation-row" key={i}>
              <Select aria-label={t("Eigenschaft der Bedingung", "Condition property")} value={c.field} onChange={(e) => setCondition(i, { ...c, field: e.target.value, value: "" })}>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
              <Select aria-label={t("Vergleich", "Comparison")} value={c.op} onChange={(e) => setCondition(i, { ...c, op: e.target.value as Condition["op"] })}>
                <option value="eq">{t("ist", "is")}</option>
                <option value="neq">{t("ist nicht", "is not")}</option>
                <option value="contains">{t("enthält", "contains")}</option>
                <option value="empty">{t("ist leer", "is empty")}</option>
                <option value="notempty">{t("ist nicht leer", "is not empty")}</option>
              </Select>
              {!["empty", "notempty"].includes(c.op) && (
                <ValueInput label={t("Wert", "Value")} field={field} members={members} value={c.value} plain onChange={(v) => setCondition(i, { ...c, value: String(v ?? "") })} />
              )}
              <button type="button" className="icon-button" aria-label={t("Bedingung entfernen", "Remove condition")} onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}>
                <Trash />
              </button>
            </div>
          );
        })}
        {r.conditions.length < 10 && (
          <button type="button" className="text-button" onClick={() => setR({ ...r, conditions: [...r.conditions, { field: fields[0].id, op: "eq", value: "" }] })}>
            <Plus /> {t("Bedingung", "Condition")}
          </button>
        )}
      </fieldset>
      <fieldset>
        <legend>{t("Dann", "Then")}</legend>
        {r.actions.map((a, i) => (
          <div className="automation-row" key={i}>
            <Select
              aria-label={t("Aktion", "Action")}
              value={a.type}
              onChange={(e) =>
                setAction(
                  i,
                  e.target.value === "set"
                    ? { type: "set", field: (fields.find(settable) || fields[0]).id, value: startValue(fields.find(settable)) }
                    : { type: "notify", to: "@creator", message: "" },
                )
              }
            >
              <option value="set">{t("Eigenschaft setzen", "Set property")}</option>
              <option value="notify">{t("Benachrichtigen", "Notify")}</option>
            </Select>
            {a.type === "set" ? (
              <>
                <Select aria-label={t("Eigenschaft der Aktion", "Action property")} value={a.field} onChange={(e) => setAction(i, { ...a, field: e.target.value, value: startValue(fields.find((f) => f.id === e.target.value)) })}>
                  {fields.filter(settable).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
                <ValueInput
                  label={t("Neuer Wert", "New value")}
                  field={fields.find((f) => f.id === a.field) || fields[0]}
                  members={members}
                  value={a.value}
                  onChange={(v) => setAction(i, { ...a, value: v })}
                />
              </>
            ) : (
              <>
                <Select aria-label={t("Empfänger", "Recipient")} value={a.to} onChange={(e) => setAction(i, { ...a, to: e.target.value })}>
                  {fields
                    .filter((f) => f.type === "person")
                    .map((f) => (
                      <option key={f.id} value={`field:${f.id}`}>
                        {t(`Person in „${f.name}“`, `Person in “${f.name}”`)}
                      </option>
                    ))}
                  <option value="@creator">{t("Ersteller des Eintrags", "Creator of the record")}</option>
                  <option value="@actor">{t("Auslösende Person", "Person who triggered it")}</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                <input aria-label={t("Nachricht", "Message")} placeholder={t("Nachricht (optional)", "Message (optional)")} maxLength={300} value={a.message} onChange={(e) => setAction(i, { ...a, message: e.target.value })} />
              </>
            )}
            {r.actions.length > 1 && (
              <button type="button" className="icon-button" aria-label={t("Aktion entfernen", "Remove action")} onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}>
                <Trash />
              </button>
            )}
          </div>
        ))}
        {r.actions.length < 10 && (
          <button type="button" className="text-button" onClick={() => setR({ ...r, actions: [...r.actions, { type: "notify", to: "@creator", message: "" }] })}>
            <Plus /> {t("Aktion", "Action")}
          </button>
        )}
      </fieldset>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onCancel}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? t("Wird gespeichert …", "Saving …") : t("Regel speichern", "Save rule")}
        </button>
      </div>
    </form>
  );
}

// A value fitting a property; `plain` for comparisons (no "today" etc.).
function ValueInput({
  label,
  field,
  members,
  value,
  plain = false,
  onChange,
}: {
  label: string;
  field: Field;
  members: Pick<User, "id" | "name">[];
  value: unknown;
  plain?: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const v = value === undefined || value === null ? "" : value;
  if (field.type === "select" || field.type === "multiselect")
    return (
      <Select aria-label={label} value={String(v)} onChange={(e) => onChange(field.type === "multiselect" && !plain ? (e.target.value ? [e.target.value] : []) : e.target.value)}>
        <option value="">{plain ? t("beliebig", "any") : t("leer", "empty")}</option>
        {(field.options || []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  if (field.type === "checkbox")
    return (
      <Select aria-label={label} value={String(v === true || v === "true")} onChange={(e) => onChange(plain ? e.target.value : e.target.value === "true")}>
        <option value="true">{t("abgehakt", "checked")}</option>
        <option value="false">{t("nicht abgehakt", "unchecked")}</option>
      </Select>
    );
  if (field.type === "person")
    return (
      <Select aria-label={label} value={String(v)} onChange={(e) => onChange(e.target.value)}>
        <option value="">{plain ? t("beliebig", "any") : t("niemand", "nobody")}</option>
        {!plain && <option value="@actor">{t("Auslösende Person", "Person who triggered it")}</option>}
        {!plain && <option value="@creator">{t("Ersteller", "Creator")}</option>}
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </Select>
    );
  if (field.type === "date" && !plain)
    return (
      <Select aria-label={label} value={String(v || "@today")} onChange={(e) => onChange(e.target.value)}>
        <option value="@today">{t("Heute", "Today")}</option>
        <option value="@now">{t("Jetzt (mit Uhrzeit)", "Now (with time)")}</option>
        <option value="@clear">{t("Leeren", "Clear")}</option>
      </Select>
    );
  return (
    <input
      aria-label={label}
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      value={String(v)}
      onChange={(e) => onChange(field.type === "number" && !plain ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
    />
  );
}
