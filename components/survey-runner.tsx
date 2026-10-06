"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Star } from "@phosphor-icons/react";
import { useT, useLocale } from "./i18n";
import { FormFiles } from "./form-questions";
import { isQuestion, range, surveyPages, validateSurvey, visible, type Survey, type SurveyItem, type SurveyQuestion } from "@/lib/survey";
import type { Field } from "@/lib/types";

type Texts = { title: string; description: string; submitLabel: string; successTitle: string; successMessage: string };

// Shuffles once per visit (options of questions with "random order").
function shuffled<T>(list: T[], seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    const j = Math.abs(h) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A survey for the person answering it: welcome screen, pages with a
// progress bar, all question types, conditions, thank-you screen.
export function SurveyRunner({
  survey,
  fields,
  texts,
  onSubmit,
  after,
  preview = false,
}: {
  survey: Survey;
  fields: Field[];
  texts: Texts;
  // Throws with a message when the answer could not be saved.
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  // Shown on the thank-you screen (e.g. the link of a customer portal).
  after?: React.ReactNode;
  preview?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [started, setStarted] = useState(!survey.welcome.enabled);
  const [page, setPage] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const seed = useMemo(() => Math.random().toString(36), []);
  const pages = surveyPages(survey);
  // Pages without a visible item are skipped.
  const shown = pages.map((p) => p.items.filter((i) => visible(i, values)));
  const indexes = shown.flatMap((items, i) => (items.length || i === 0 ? [i] : []));
  const at = Math.max(0, indexes.indexOf(page));
  const last = at === indexes.length - 1;
  useEffect(() => {
    if (done && survey.redirect && /^https?:\/\//.test(survey.redirect) && !preview) {
      const timer = setTimeout(() => location.assign(survey.redirect!), 2500);
      return () => clearTimeout(timer);
    }
  }, [done, survey.redirect, preview]);
  const set = (field: string, value: unknown) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: "" }));
  };
  // Checks the current page only (the server checks everything).
  const check = () => {
    const part = { ...survey, items: shown[page] || [] };
    const result = validateSurvey(part, fields, values, locale === "de");
    // Files are held as File objects until sending.
    for (const item of part.items)
      if (isQuestion(item) && item.type === "file" && item.required && !(Array.isArray(values[item.field]) && (values[item.field] as unknown[]).length))
        result.errors[item.field] = t("Bitte eine Datei wählen.", "Please choose a file.");
    setErrors(result.errors);
    return !Object.keys(result.errors).length;
  };
  const next = async () => {
    if (!check()) return;
    if (!last) {
      setPage(indexes[at + 1]);
      window.scrollTo?.({ top: 0, behavior: "smooth" });
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Answers of questions hidden by conditions are not sent.
      const hidden = new Set(survey.items.filter((i) => isQuestion(i) && !visible(i, values)).flatMap((i) => (isQuestion(i) ? (i.type === "matrix" ? i.rows.map((r) => r.field) : [i.field]) : [])));
      await onSubmit(Object.fromEntries(Object.entries(values).filter(([k]) => !hidden.has(k))));
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const progress = indexes.length > 1 ? Math.round((at / indexes.length) * 100) : 0;
  return (
    <div className={`survey survey-accent-${survey.accent}`}>
      {!started ? (
        <div className="survey-welcome">
          <h2>{survey.welcome.title || texts.title}</h2>
          {(survey.welcome.text || texts.description) && <p>{survey.welcome.text || texts.description}</p>}
          <button className="button primary survey-primary" onClick={() => setStarted(true)}>
            {survey.welcome.button || t("Los geht's", "Start")} <ArrowRight />
          </button>
        </div>
      ) : done ? (
        <div className="survey-done" role="status">
          <span className="survey-done-check">
            <Check weight="bold" />
          </span>
          <h2>{texts.successTitle}</h2>
          {texts.successMessage && <p>{texts.successMessage}</p>}
          {after}
        </div>
      ) : (
        <>
          {survey.progress && indexes.length > 1 && (
            <div className="survey-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t("Fortschritt", "Progress")}>
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
          {pages[page]?.title && <h2 className="survey-page-title">{pages[page].title}</h2>}
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void next();
            }}
          >
            {(shown[page] || []).map((item) => (
              <Item key={item.id} item={item} fields={fields} values={values} errors={errors} seed={seed} disabled={busy} onChange={set} />
            ))}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="survey-nav">
              {at > 0 && (
                <button type="button" className="button" disabled={busy} onClick={() => setPage(indexes[at - 1])}>
                  <ArrowLeft /> {t("Zurück", "Back")}
                </button>
              )}
              <button className="button primary survey-primary" disabled={busy}>
                {busy ? t("Wird gesendet …", "Sending …") : last ? texts.submitLabel : t("Weiter", "Next")}
                {!last && <ArrowRight />}
              </button>
              {indexes.length > 1 && (
                <span className="muted survey-step">
                  {t(`Seite ${at + 1} von ${indexes.length}`, `Page ${at + 1} of ${indexes.length}`)}
                </span>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function Item({
  item,
  fields,
  values,
  errors,
  seed,
  disabled,
  onChange,
}: {
  item: SurveyItem;
  fields: Field[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  seed: string;
  disabled: boolean;
  onChange: (field: string, value: unknown) => void;
}) {
  if (item.kind === "text")
    return (
      <div className="survey-text">
        {item.title && <h3>{item.title}</h3>}
        {item.body && <p>{item.body}</p>}
      </div>
    );
  if (item.kind !== "question") return null;
  const field = fields.find((f) => f.id === item.field);
  const title = item.title || field?.name || "";
  const errorIds = item.type === "matrix" ? item.rows.map((r) => r.field) : [item.field];
  const message = errorIds.map((id) => errors[id]).find(Boolean);
  const id = `q-${item.id}`;
  return (
    <fieldset className="survey-question" aria-describedby={message ? `${id}-error` : undefined} aria-invalid={!!message}>
      <legend>
        {title}
        {item.required && <span className="survey-required" aria-hidden> *</span>}
      </legend>
      {item.description && <p className="question-description">{item.description}</p>}
      <Answer q={item} field={field} values={values} seed={seed} disabled={disabled} onChange={onChange} label={title} />
      {message && (
        <p className="error field-error" id={`${id}-error`} role="alert">
          {message}
        </p>
      )}
    </fieldset>
  );
}

function Answer({
  q,
  field,
  values,
  seed,
  disabled,
  label,
  onChange,
}: {
  q: SurveyQuestion;
  field?: Field;
  values: Record<string, unknown>;
  seed: string;
  disabled: boolean;
  label: string;
  onChange: (field: string, value: unknown) => void;
}) {
  const t = useT();
  const value = values[q.field];
  const set = (v: unknown) => onChange(q.field, v);
  const options = q.randomize ? shuffled(field?.options || [], `${seed}${q.id}`) : field?.options || [];
  const otherValue = typeof value === "string" && value && !options.includes(value) ? value : "";
  const [otherOn, setOtherOn] = useState(!!otherValue);
  const r = range(q);
  switch (q.type) {
    case "long":
      return <textarea aria-label={label} rows={5} maxLength={10000} placeholder={q.placeholder} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value)} />;
    case "short":
    case "email":
    case "phone":
    case "url":
    case "number":
    case "date":
    case "time":
      return (
        <input
          aria-label={label}
          type={{ short: "text", email: "email", phone: "tel", url: "url", number: "number", date: "date", time: "time" }[q.type]}
          inputMode={q.type === "number" ? "decimal" : undefined}
          min={q.type === "number" ? q.min : undefined}
          max={q.type === "number" ? q.max : undefined}
          step={q.type === "number" ? (q.step ?? "any") : undefined}
          placeholder={q.placeholder || (q.type === "url" ? "https://" : "")}
          disabled={disabled}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => set(q.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
        />
      );
    case "single":
    case "yesno":
      return (
        <div className={`survey-choices${q.type === "yesno" ? " survey-yesno" : ""}`} role="radiogroup" aria-label={label}>
          {options.map((o) => (
            <label key={o} className={`survey-choice${value === o ? " active" : ""}`}>
              <input type="radio" name={q.id} disabled={disabled} checked={value === o && !otherOn} onChange={() => (setOtherOn(false), set(o))} />
              <span>{o}</span>
            </label>
          ))}
          {q.other && q.type === "single" && (
            <label className={`survey-choice survey-other${otherOn ? " active" : ""}`}>
              <input type="radio" name={q.id} disabled={disabled} checked={otherOn} onChange={() => (setOtherOn(true), set(otherValue))} />
              <span>{t("Andere:", "Other:")}</span>
              <input aria-label={t(`${label}: andere Antwort`, `${label}: other answer`)} maxLength={300} disabled={disabled || !otherOn} value={otherValue} onChange={(e) => set(e.target.value)} />
            </label>
          )}
        </div>
      );
    case "dropdown":
      return (
        <div className="survey-dropdown">
          <select aria-label={label} disabled={disabled} value={otherOn ? "@other" : typeof value === "string" ? value : ""} onChange={(e) => (e.target.value === "@other" ? (setOtherOn(true), set("")) : (setOtherOn(false), set(e.target.value)))}>
            <option value="">{t("Bitte wählen …", "Please choose …")}</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
            {q.other && <option value="@other">{t("Andere …", "Other …")}</option>}
          </select>
          {otherOn && <input aria-label={t(`${label}: andere Antwort`, `${label}: other answer`)} maxLength={300} disabled={disabled} value={otherValue} onChange={(e) => set(e.target.value)} />}
        </div>
      );
    case "multiple": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      const extra = list.find((v) => !options.includes(v)) ?? (otherOn ? "" : undefined);
      const toggle = (o: string, on: boolean) => set(on ? [...list.filter((v) => options.includes(v) || v !== o), o] : list.filter((v) => v !== o));
      return (
        <div className="survey-choices" role="group" aria-label={label}>
          {options.map((o) => (
            <label key={o} className={`survey-choice${list.includes(o) ? " active" : ""}`}>
              <input type="checkbox" disabled={disabled} checked={list.includes(o)} onChange={(e) => toggle(o, e.target.checked)} />
              <span>{o}</span>
            </label>
          ))}
          {q.other && (
            <label className={`survey-choice survey-other${otherOn ? " active" : ""}`}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={otherOn}
                onChange={(e) => {
                  setOtherOn(e.target.checked);
                  if (!e.target.checked) set(list.filter((v) => options.includes(v)));
                }}
              />
              <span>{t("Andere:", "Other:")}</span>
              <input
                aria-label={t(`${label}: andere Antwort`, `${label}: other answer`)}
                maxLength={300}
                disabled={disabled || !otherOn}
                value={extra ?? ""}
                onChange={(e) => set([...list.filter((v) => options.includes(v)), ...(e.target.value ? [e.target.value] : [])])}
              />
            </label>
          )}
          {(q.minChoices || q.maxChoices) && (
            <small className="muted">
              {q.minChoices && q.maxChoices
                ? t(`${q.minChoices} bis ${q.maxChoices} auswählen`, `Choose ${q.minChoices} to ${q.maxChoices}`)
                : q.maxChoices
                  ? t(`Höchstens ${q.maxChoices} auswählen`, `Choose at most ${q.maxChoices}`)
                  : t(`Mindestens ${q.minChoices} auswählen`, `Choose at least ${q.minChoices}`)}
            </small>
          )}
        </div>
      );
    }
    case "rating":
      return (
        <div className="survey-stars" role="radiogroup" aria-label={label}>
          {Array.from({ length: r.max! }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={t(`${n} von ${r.max} Sternen`, `${n} of ${r.max} stars`)}
              className={typeof value === "number" && n <= value ? "on" : ""}
              disabled={disabled}
              onClick={() => set(value === n ? null : n)}
            >
              <Star weight={typeof value === "number" && n <= value ? "fill" : "regular"} />
            </button>
          ))}
        </div>
      );
    case "nps":
    case "scale": {
      const numbers = Array.from({ length: r.max! - r.min! + 1 }, (_, i) => r.min! + i);
      return (
        <div className="survey-scale-wrap">
          <div className={`survey-scale${q.type === "nps" ? " nps" : ""}`} role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${numbers.length}, minmax(0, 1fr))` }}>
            {numbers.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={value === n}
                aria-label={`${label}: ${n}`}
                data-band={q.type === "nps" ? (n <= 6 ? "low" : n <= 8 ? "mid" : "high") : undefined}
                className={value === n ? "active" : ""}
                disabled={disabled}
                onClick={() => set(value === n ? null : n)}
              >
                {n}
              </button>
            ))}
          </div>
          {(q.minLabel || q.maxLabel) && (
            <div className="survey-scale-labels">
              <span>{q.minLabel}</span>
              <span>{q.maxLabel}</span>
            </div>
          )}
        </div>
      );
    }
    case "slider": {
      const current = typeof value === "number" ? value : null;
      return (
        <div className="survey-slider">
          <input
            type="range"
            aria-label={label}
            min={r.min}
            max={r.max}
            step={r.step}
            disabled={disabled}
            value={current ?? ((r.min ?? 0) + (r.max ?? 100)) / 2}
            onChange={(e) => set(Number(e.target.value))}
          />
          <output>{current ?? "–"}</output>
          {(q.minLabel || q.maxLabel) && (
            <div className="survey-scale-labels">
              <span>{q.minLabel || r.min}</span>
              <span>{q.maxLabel || r.max}</span>
            </div>
          )}
        </div>
      );
    }
    case "ranking": {
      const order = Array.isArray(value) && (value as string[]).length === options.length ? (value as string[]) : options;
      const move = (i: number, d: number) => {
        const next = [...order];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        set(next);
      };
      return (
        <ol className="survey-ranking" aria-label={label}>
          {order.map((o, i) => (
            <li key={o}>
              <span className="survey-rank">{i + 1}</span>
              <span>{o}</span>
              <button type="button" className="icon-button" aria-label={t(`${o} nach oben`, `${o} up`)} disabled={disabled || i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </button>
              <button type="button" className="icon-button" aria-label={t(`${o} nach unten`, `${o} down`)} disabled={disabled || i === order.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </button>
            </li>
          ))}
          {!Array.isArray(value) && (
            <li className="survey-ranking-hint">
              <button type="button" className="text-button" disabled={disabled} onClick={() => set(order)}>
                {t("Reihenfolge so übernehmen", "Keep this order")}
              </button>
            </li>
          )}
        </ol>
      );
    }
    case "matrix":
      return (
        <div className="survey-matrix-wrap">
          <table className="survey-matrix">
            <thead>
              <tr>
                <th scope="col" />
                {q.columns.map((c) => (
                  <th scope="col" key={c}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.rows.map((row) => (
                <tr key={row.field} role="radiogroup" aria-label={row.label}>
                  <th scope="row">{row.label}</th>
                  {q.columns.map((c) => (
                    <td key={c} data-label={c}>
                      <input type="radio" name={`${q.id}-${row.field}`} aria-label={`${row.label}: ${c}`} disabled={disabled} checked={values[row.field] === c} onChange={() => onChange(row.field, c)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "file":
      return <FormFiles name={label} value={value} disabled={disabled} onChange={(files) => set(files)} />;
  }
}
