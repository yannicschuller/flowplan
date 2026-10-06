"use client";
import { useState } from "react";
import { useT } from "./i18n";
import { Select } from "./select";
import { doneRule, type DatabaseSettings } from "@/lib/database-settings-schema";
import type { Field } from "@/lib/types";

type Workflow = NonNullable<DatabaseSettings["workflow"]>;

// When a record counts as done, and optionally a status workflow: which
// changes are allowed, what a status needs, which statuses only owners set.
export function DatabaseWorkflow({
  fields,
  settings,
  editable,
  save,
}: {
  fields: Field[];
  settings: DatabaseSettings;
  editable: boolean;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const t = useT();
  const selects = fields.filter((f) => f.type === "select" && f.options?.length);
  const doneFields = fields.filter((f) => (f.type === "select" && f.options?.length) || f.type === "checkbox");
  const detected = doneRule(fields, settings);
  const [done, setDone] = useState(settings.done || (detected ? { field: detected.field.id, values: detected.values } : undefined));
  const [flow, setFlow] = useState<Workflow | undefined>(settings.workflow);
  const [busy, setBusy] = useState(false);
  const doneField = fields.find((f) => f.id === done?.field);
  const flowField = fields.find((f) => f.id === flow?.field);
  const options = flowField?.options || [];
  const others = fields.filter((f) => f.id !== flow?.field && !["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id"].includes(f.type));
  const allowed = (from: string, to: string) => !flow?.transitions[from] || flow.transitions[from].includes(to);
  const toggle = (from: string, to: string, on: boolean) => {
    if (!flow) return;
    const current = flow.transitions[from] || options.filter((o) => o !== from);
    const next = on ? [...new Set([...current, to])] : current.filter((o) => o !== to);
    const transitions = { ...flow.transitions };
    // Everything allowed again: no entry (free).
    if (options.filter((o) => o !== from).every((o) => next.includes(o))) delete transitions[from];
    else transitions[from] = next;
    setFlow({ ...flow, transitions });
  };
  return (
    <form
      className="workflow-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await save({ done: done ?? null, workflow: flow ?? null });
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={!editable}>
        <legend>{t("Wann ist ein Eintrag erledigt?", "When is a record done?")}</legend>
        <p className="muted">
          {t(
            "Gilt für Sprints, Fortschritt von Unteraufgaben, überfällige Einträge und „Meine Aufgaben“.",
            "Used for sprints, subtask progress, overdue records and “My tasks”.",
          )}
        </p>
        <Select
          aria-label={t("Eigenschaft für erledigt", "Property for done")}
          value={done?.field || ""}
          onChange={(e) => {
            const field = fields.find((f) => f.id === e.target.value);
            setDone(field ? { field: field.id, values: field.type === "checkbox" ? ["true"] : [] } : undefined);
          }}
        >
          <option value="">{t("Nicht festgelegt", "Not set")}</option>
          {doneFields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        {doneField?.type === "select" && (
          <div className="check-grid">
            {(doneField.options || []).map((o) => (
              <label className="checkbox-label" key={o}>
                <input
                  type="checkbox"
                  checked={done!.values.includes(o)}
                  onChange={(e) => setDone({ ...done!, values: e.target.checked ? [...done!.values, o] : done!.values.filter((v) => v !== o) })}
                />
                {o}
              </label>
            ))}
          </div>
        )}
        {doneField?.type === "checkbox" && <p className="muted">{t("Erledigt, wenn abgehakt.", "Done when checked.")}</p>}
      </fieldset>
      <fieldset disabled={!editable}>
        <legend>{t("Status-Workflow", "Status workflow")}</legend>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!flow}
            disabled={!selects.length}
            onChange={(e) =>
              setFlow(e.target.checked ? { field: (selects.find((f) => f.id === done?.field) || selects[0]).id, transitions: {}, required: {}, ownersOnly: [] } : undefined)
            }
          />
          {t("Erlaubte Wechsel und Pflichtfelder festlegen", "Set allowed changes and required properties")}
        </label>
        {!selects.length && <p className="muted">{t("Dafür braucht die Datenbank eine Auswahl-Eigenschaft wie „Status“.", "This needs a select property such as “Status”.")}</p>}
        {flow && (
          <>
            <Select
              aria-label={t("Status-Eigenschaft", "Status property")}
              value={flow.field}
              onChange={(e) => setFlow({ field: e.target.value, transitions: {}, required: {}, ownersOnly: [] })}
            >
              {selects.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            <div className="workflow-matrix-wrap">
              <table className="workflow-matrix">
                <caption>{t("Von (Zeile) nach (Spalte) erlaubt", "Allowed from (row) to (column)")}</caption>
                <thead>
                  <tr>
                    <th scope="col" />
                    {options.map((o) => (
                      <th key={o} scope="col">
                        {o}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {["", ...options].map((from) => (
                    <tr key={from || "-"}>
                      <th scope="row">{from || t("(leer)", "(empty)")}</th>
                      {options.map((to) => (
                        <td key={to}>
                          {from !== to && (
                            <input
                              type="checkbox"
                              aria-label={t(`Von ${from || "leer"} nach ${to}`, `From ${from || "empty"} to ${to}`)}
                              checked={allowed(from, to)}
                              onChange={(e) => toggle(from, to, e.target.checked)}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="workflow-statuses">
              {options.map((o) => (
                <details key={o}>
                  <summary>
                    <strong>{o}</strong>
                    <span className="muted">
                      {[
                        (flow.required[o] || []).length ? t(`braucht ${(flow.required[o] || []).length}`, `needs ${(flow.required[o] || []).length}`) : "",
                        flow.ownersOnly.includes(o) ? t("nur Verantwortliche", "owners only") : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </summary>
                  <p className="muted">{t(`Pflicht, um „${o}“ zu setzen:`, `Required to set “${o}”:`)}</p>
                  <div className="check-grid">
                    {others.map((f) => (
                      <label className="checkbox-label" key={f.id}>
                        <input
                          type="checkbox"
                          checked={(flow.required[o] || []).includes(f.id)}
                          onChange={(e) => {
                            const list = flow.required[o] || [];
                            const next = e.target.checked ? [...list, f.id] : list.filter((x) => x !== f.id);
                            const required = { ...flow.required, [o]: next };
                            if (!next.length) delete required[o];
                            setFlow({ ...flow, required });
                          }}
                        />
                        {f.name}
                      </label>
                    ))}
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={flow.ownersOnly.includes(o)}
                      onChange={(e) => setFlow({ ...flow, ownersOnly: e.target.checked ? [...flow.ownersOnly, o] : flow.ownersOnly.filter((x) => x !== o) })}
                    />
                    {t("Nur Verantwortliche der Datenbank dürfen das setzen", "Only owners of the database may set this")}
                  </label>
                </details>
              ))}
            </div>
          </>
        )}
      </fieldset>
      {editable && (
        <div className="modal-actions">
          <button className="button primary" disabled={busy}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Speichern", "Save")}
          </button>
        </div>
      )}
    </form>
  );
}
