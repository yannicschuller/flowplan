"use client";
// Editing form logic: "only show if <earlier question> <comparison>
// <answer>" for questions, text blocks and page breaks (forms and surveys),
// and what happens after sending (redirect, confirmation e-mail, team
// notification).
import { useT } from "./i18n";
import { Select } from "./select";
import { validRedirect, type Condition, type ConditionOp } from "@/lib/form-logic";
import type { FormConfig } from "@/lib/form-settings";
import type { Field } from "@/lib/types";

// What a condition can look at: an earlier question and how its answer
// compares.
export type ConditionTarget = { field: string; label: string; options: string[]; kind: "choice" | "multi" | "number" | "text" | "flag" };
export function fieldTarget(f: Field, label = f.name): ConditionTarget | null {
  if (["person", "relation", "files", "checklist", "created_by", "updated_by", "created_at", "updated_at", "id", "formula", "rollup"].includes(f.type)) return null;
  const kind = f.type === "select" ? "choice" : f.type === "multiselect" ? "multi" : f.type === "number" ? "number" : f.type === "checkbox" ? "flag" : "text";
  return { field: f.id, label, options: kind === "choice" || kind === "multi" ? f.options || [] : [], kind };
}
const opsFor: Record<ConditionTarget["kind"], ConditionOp[]> = {
  choice: ["is", "isNot", "answered", "notAnswered"],
  multi: ["includes", "notIncludes", "answered", "notAnswered"],
  number: ["is", "isNot", "gt", "lt", "gte", "lte", "answered", "notAnswered"],
  text: ["is", "isNot", "contains", "answered", "notAnswered"],
  flag: ["answered", "notAnswered"],
};

export function FormConditionEditor({
  condition,
  targets,
  disabled = false,
  label,
  onChange,
}: {
  condition?: Condition;
  targets: ConditionTarget[];
  disabled?: boolean;
  label?: string;
  onChange: (c: Condition | undefined) => void;
}) {
  const t = useT();
  if (!targets.length && !condition) return null;
  const target = targets.find((x) => x.field === condition?.field);
  const opLabel: Record<ConditionOp, string> = {
    is: t("ist", "is"),
    isNot: t("ist nicht", "is not"),
    includes: t("enthält", "includes"),
    notIncludes: t("enthält nicht", "does not include"),
    contains: t("enthält den Text", "contains the text"),
    gt: t("ist größer als", "is greater than"),
    lt: t("ist kleiner als", "is less than"),
    gte: t("ist mindestens", "is at least"),
    lte: t("ist höchstens", "is at most"),
    answered: target?.kind === "flag" ? t("ist angehakt", "is checked") : t("ist beantwortet", "is answered"),
    notAnswered: target?.kind === "flag" ? t("ist nicht angehakt", "is not checked") : t("ist nicht beantwortet", "is not answered"),
  };
  const first = (x: ConditionTarget): Condition => {
    const op = opsFor[x.kind][0];
    return { field: x.field, op, value: x.options[0] || "" };
  };
  const ops = target ? opsFor[target.kind] : [];
  return (
    <fieldset className="question-condition">
      <legend>{t("Bedingung", "Condition")}</legend>
      <label className="checkbox-label">
        <input type="checkbox" disabled={disabled || !targets.length} checked={!!condition} onChange={(e) => onChange(e.target.checked ? first(targets[0]) : undefined)} />
        {label || t("Nur zeigen, wenn …", "Only show if …")}
      </label>
      {condition && (
        <div className="question-editor-row">
          <Select
            aria-label={t("Frage der Bedingung", "Condition question")}
            disabled={disabled}
            value={condition.field}
            onChange={(e) => {
              const next = targets.find((x) => x.field === e.target.value);
              if (next) onChange(first(next));
            }}
          >
            {!target && <option value={condition.field}>{t("(Frage fehlt)", "(question missing)")}</option>}
            {targets.map((x) => (
              <option key={x.field} value={x.field}>
                {x.label}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Vergleich", "Comparison")} disabled={disabled} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })}>
            {(ops.includes(condition.op) ? ops : [condition.op, ...ops]).map((op) => (
              <option key={op} value={op}>
                {opLabel[op]}
              </option>
            ))}
          </Select>
          {!["answered", "notAnswered"].includes(condition.op) &&
            (target?.options.length ? (
              <Select aria-label={t("Wert der Bedingung", "Condition value")} disabled={disabled} value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
                {target.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <input
                aria-label={t("Wert der Bedingung", "Condition value")}
                inputMode={target?.kind === "number" ? "decimal" : undefined}
                disabled={disabled}
                value={condition.value}
                maxLength={300}
                onChange={(e) => onChange({ ...condition, value: e.target.value })}
              />
            ))}
        </div>
      )}
    </fieldset>
  );
}

type FollowUp = Pick<FormConfig, "redirectUrl" | "redirectDelay" | "confirmation" | "notifyMembers">;
// After sending: redirect, confirmation e-mail and who on the team hears
// about new answers.
export function FormFollowUpSettings({
  value,
  members,
  disabled = false,
  anonymous = false,
  onChange,
}: {
  value: FollowUp;
  members: { id: string; name: string }[];
  disabled?: boolean;
  anonymous?: boolean;
  onChange: (patch: Partial<FollowUp>) => void;
}) {
  const t = useT();
  const badRedirect = !validRedirect(value.redirectUrl.trim());
  const placeholderHint = t(
    "Platzhalter: {Name der Frage} setzt die Antwort auf diese Frage ein – im Dankeschön-Text, in der Weiterleitung und in der E-Mail.",
    "Placeholders: {Name of the question} inserts the answer to that question – in the thank-you text, the redirect and the e-mail.",
  );
  return (
    <>
      <fieldset className="form-followup" disabled={disabled}>
        <legend>{t("Nach dem Absenden", "After sending")}</legend>
        <label>
          {t("Danach weiterleiten zu (optional)", "Then redirect to (optional)")}
          <input
            type="url"
            inputMode="url"
            placeholder="https://"
            value={value.redirectUrl}
            maxLength={500}
            aria-invalid={badRedirect}
            onChange={(e) => onChange({ redirectUrl: e.target.value.trim() })}
          />
        </label>
        {badRedirect && (
          <p className="error small">
            {t(
              "Bitte eine Adresse mit https:// angeben. Platzhalter sind erst nach dem Domainnamen erlaubt.",
              "Please enter an address starting with https://. Placeholders are only allowed after the domain name.",
            )}
          </p>
        )}
        {value.redirectUrl && (
          <label>
            {t("Weiterleiten nach (Sekunden)", "Redirect after (seconds)")}
            <input
              type="number"
              min={0}
              max={60}
              value={value.redirectDelay}
              onChange={(e) => onChange({ redirectDelay: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })}
            />
          </label>
        )}
        <p className="muted small">{placeholderHint}</p>
      </fieldset>
      <fieldset className="form-followup" disabled={disabled}>
        <legend>{t("Bestätigung per E-Mail", "Confirmation by e-mail")}</legend>
        <label className="checkbox-label">
          <input type="checkbox" checked={value.confirmation.enabled} onChange={(e) => onChange({ confirmation: { ...value.confirmation, enabled: e.target.checked } })} />
          {t("Bestätigung per E-Mail an die Antwortenden", "Confirmation by e-mail to the people answering")}
        </label>
        <p className="muted small">
          {anonymous
            ? t(
                "Geht an die erste beantwortete E-Mail-Frage – nur, wenn die Person ihre Adresse selbst eingibt. Enthält deinen Text und ihre Antworten; mit Kundenportal auch den Link zur Anfrage. Nur wenn auf dieser Instanz E-Mail eingerichtet ist.",
                "Goes to the first answered e-mail question – only when the person types their address. Contains your text and their answers; with the customer portal also the link to the request. Only when e-mail is set up on this instance.",
              )
            : t(
                "Geht an die erste beantwortete E-Mail-Frage, sonst an die Adresse des angemeldeten Kontos. Enthält deinen Text und die Antworten; mit Kundenportal auch den Link zur Anfrage. Nur wenn auf dieser Instanz E-Mail eingerichtet ist.",
                "Goes to the first answered e-mail question, otherwise to the signed-in account's address. Contains your text and the answers; with the customer portal also the link to the request. Only when e-mail is set up on this instance.",
              )}
        </p>
        {value.confirmation.enabled && (
          <>
            <label>
              {t("Betreff (optional)", "Subject (optional)")}
              <input
                value={value.confirmation.subject}
                maxLength={200}
                placeholder={t("Deine Antwort: …", "Your answer: …")}
                onChange={(e) => onChange({ confirmation: { ...value.confirmation, subject: e.target.value } })}
              />
            </label>
            <label>
              {t("Text der E-Mail (optional)", "Text of the e-mail (optional)")}
              <textarea
                rows={3}
                value={value.confirmation.message}
                maxLength={3000}
                placeholder={t("Danke, deine Antwort ist angekommen.", "Thank you, your answer has arrived.")}
                onChange={(e) => onChange({ confirmation: { ...value.confirmation, message: e.target.value } })}
              />
            </label>
            <p className="muted small">{placeholderHint}</p>
          </>
        )}
      </fieldset>
      {members.length > 0 && (
        <fieldset className="form-followup" disabled={disabled}>
          <legend>{t("Team benachrichtigen", "Notify the team")}</legend>
          <p className="muted small">
            {t(
              "Diese Mitglieder bekommen bei jeder neuen Antwort eine Benachrichtigung (Art „Gastkommentare und Gasteinträge“).",
              "These members get a notification for each new answer (kind “Guest comments and guest records”).",
            )}
          </p>
          <div className="form-followup-members">
            {members.map((m) => (
              <label key={m.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={value.notifyMembers.includes(m.id)}
                  onChange={(e) =>
                    onChange({ notifyMembers: e.target.checked ? [...value.notifyMembers, m.id].slice(0, 50) : value.notifyMembers.filter((id) => id !== m.id) })
                  }
                />
                {m.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}
