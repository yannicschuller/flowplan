"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  At,
  CalendarBlank,
  CaretCircleDown,
  CheckSquare,
  Clock,
  Copy,
  Gauge,
  GridFour,
  Hash,
  Link as LinkIcon,
  ListNumbers,
  Paperclip,
  Phone,
  Plus,
  RadioButton,
  Rows,
  SlidersHorizontal,
  Star,
  TextAlignLeft,
  TextT,
  ThumbsUp,
  Trash,
  Article,
  DotsThreeOutline,
} from "@phosphor-icons/react";
import { useT, useLocale } from "./i18n";
import { Select } from "./select";
import { SurveyRunner } from "./survey-runner";
import { SurveyResults } from "./survey-results";
import { choiceTypes, isQuestion, newQuestion, surveySchema, type Condition, type Survey, type SurveyItem, type SurveyQuestion, type SurveyType } from "@/lib/survey";
import type { FormConfig } from "@/lib/form-settings";
import type { Field, Row } from "@/lib/types";

type Texts = Record<string, { title: string; options?: string[] }>;
type Form = { token: string; enabled: number; internal: number; anonymous: number; config: FormConfig } | null;

export const typeInfo: Record<SurveyType, { icon: typeof TextT; de: string; en: string }> = {
  short: { icon: TextT, de: "Kurze Antwort", en: "Short answer" },
  long: { icon: TextAlignLeft, de: "Langer Text", en: "Long text" },
  single: { icon: RadioButton, de: "Einfachauswahl", en: "Single choice" },
  multiple: { icon: CheckSquare, de: "Mehrfachauswahl", en: "Multiple choice" },
  dropdown: { icon: CaretCircleDown, de: "Dropdown", en: "Dropdown" },
  yesno: { icon: ThumbsUp, de: "Ja / Nein", en: "Yes / no" },
  rating: { icon: Star, de: "Sterne", en: "Star rating" },
  nps: { icon: Gauge, de: "Weiterempfehlung (NPS)", en: "Net Promoter Score" },
  scale: { icon: DotsThreeOutline, de: "Skala", en: "Scale" },
  slider: { icon: SlidersHorizontal, de: "Schieberegler", en: "Slider" },
  number: { icon: Hash, de: "Zahl", en: "Number" },
  email: { icon: At, de: "E-Mail", en: "E-mail" },
  phone: { icon: Phone, de: "Telefon", en: "Phone" },
  url: { icon: LinkIcon, de: "Website", en: "Website" },
  date: { icon: CalendarBlank, de: "Datum", en: "Date" },
  time: { icon: Clock, de: "Uhrzeit", en: "Time" },
  file: { icon: Paperclip, de: "Datei-Upload", en: "File upload" },
  matrix: { icon: GridFour, de: "Matrix (Likert)", en: "Matrix (Likert)" },
  ranking: { icon: ListNumbers, de: "Rangfolge", en: "Ranking" },
};

// A survey made from an existing form: its questions as survey questions.
export function surveyFromForm(fields: Field[], config: FormConfig, de: boolean): { survey: Survey; texts: Texts } {
  if (config.survey?.items.length) {
    const texts: Texts = {};
    for (const item of config.survey.items)
      if (isQuestion(item)) {
        const f = fields.find((x) => x.id === item.field);
        texts[item.id] = { title: item.title || f?.name || "", options: f?.options };
      }
    return { survey: config.survey, texts };
  }
  const survey = surveySchema.parse({ enabled: true });
  const texts: Texts = {};
  const order = config.fieldOrder;
  const asked = fields
    .filter((f) => !config.hiddenFields.includes(f.id) && ["text", "number", "select", "multiselect", "email", "phone", "url", "date", "files"].includes(f.type))
    .sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : 999) - (order.includes(b.id) ? order.indexOf(b.id) : 999));
  for (const f of asked) {
    const style = config.questionStyles?.[f.id];
    const type: SurveyType =
      f.type === "text"
        ? style === "long"
          ? "long"
          : "short"
        : f.type === "select"
          ? style === "buttons"
            ? "single"
            : "dropdown"
          : f.type === "multiselect"
            ? "multiple"
            : f.type === "number"
              ? style === "scale"
                ? "scale"
                : "number"
              : f.type === "files"
                ? "file"
                : (f.type as SurveyType);
    const { question } = newQuestion(type, de);
    const q: SurveyQuestion = { ...question, field: f.id, title: f.name, required: config.requiredFields.includes(f.id), description: config.descriptions[f.id] || "", ...(type === "scale" ? { min: 1, max: 10, minLabel: "", maxLabel: "" } : {}) };
    survey.items.push(q);
    texts[q.id] = { title: f.name, options: f.options };
  }
  return { survey, texts };
}

// The survey builder: questions with their types and options, conditions,
// pages, a preview, settings, sharing and results – saved in one step.
export function SurveyBuilder({
  pageTitle,
  fields,
  version,
  form,
  rows,
  editable,
  act,
}: {
  pageTitle: string;
  fields: Field[];
  version: number;
  form: Form;
  rows: Row[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const de = useLocale() === "de";
  const config = form?.config;
  const initial = useMemo(() => surveyFromForm(fields, config || ({ fieldOrder: [], hiddenFields: [], requiredFields: [], descriptions: {}, questionStyles: {} } as unknown as FormConfig), de), [fields, config, de]);
  const [survey, setSurvey] = useState<Survey>({ ...initial.survey, enabled: true });
  const [texts, setTexts] = useState<Texts>(initial.texts);
  const [formTexts, setFormTexts] = useState({
    title: config?.title || "",
    description: config?.description || "",
    submitLabel: config?.submitLabel || t("Absenden", "Submit"),
    successTitle: config?.successTitle || t("Vielen Dank!", "Thank you!"),
    successMessage: config?.successMessage || "",
  });
  const [selected, setSelected] = useState<string | null>(initial.survey.items[0]?.id ?? null);
  const [tab, setTab] = useState<"questions" | "preview" | "settings" | "share" | "results">("questions");
  const [picker, setPicker] = useState(!initial.survey.items.length);
  // Saved automatically shortly after the last change; nothing is saved
  // before the first change (opening the builder alone changes nothing).
  const [dirty, setDirtyState] = useState(false);
  const [status, setStatus] = useState<"saved" | "saving" | "failed">("saved");
  const revision = useRef(0);
  const failedRevision = useRef(-1);
  const saving = useRef(false);
  const knownVersion = useRef(version);
  useEffect(() => {
    if (version > knownVersion.current) knownVersion.current = version;
  }, [version]);
  const setDirty = (on: true) => {
    revision.current += 1;
    setDirtyState(on);
  };
  const [copied, setCopied] = useState(false);
  // Sharing switches answer at once and fall back when saving fails.
  const [share, setShare] = useState({ enabled: !!form?.enabled, public: form ? form.internal === 0 : false, anonymous: !!form?.anonymous });
  const toggle = async (key: "enabled" | "public" | "anonymous", on: boolean) => {
    const before = share;
    setShare({ ...share, [key]: on });
    const body = key === "public" ? { internal: !on } : { [key]: on };
    if (!(await act({ action: "form.update", ...body }))) setShare(before);
  };
  const items = survey.items;
  const item = items.find((i) => i.id === selected);
  const change = (next: SurveyItem[]) => {
    setSurvey({ ...survey, items: next });
    setDirty(true);
  };
  const update = (id: string, patch: Partial<SurveyQuestion> | Partial<SurveyItem>) => change(items.map((i) => (i.id === id ? ({ ...i, ...patch } as SurveyItem) : i)));
  const setText = (id: string, patch: Partial<{ title: string; options: string[] }>) => {
    setTexts({ ...texts, [id]: { ...texts[id], ...patch } as { title: string; options?: string[] } });
    setDirty(true);
  };
  const add = (type: SurveyType | "text" | "page") => {
    const at = item ? items.indexOf(item) + 1 : items.length;
    let created: SurveyItem;
    if (type === "text") created = { kind: "text", id: Math.random().toString(36).slice(2, 10), title: t("Abschnitt", "Section"), body: "" };
    else if (type === "page") created = { kind: "page", id: Math.random().toString(36).slice(2, 10), title: "" };
    else {
      const made = newQuestion(type, de);
      created = made.question;
      setTexts((x) => ({ ...x, [made.question.id]: { title: made.title, options: made.options } }));
    }
    change([...items.slice(0, at), created, ...items.slice(at)]);
    setSelected(created.id);
    setPicker(false);
  };
  const move = (id: string, d: number) => {
    const i = items.findIndex((x) => x.id === id);
    if (i + d < 0 || i + d >= items.length) return;
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    change(next);
  };
  const remove = (id: string) => {
    const q = items.find((x) => x.id === id);
    // Conditions that depended on the question are dropped.
    const fieldsOf = q && isQuestion(q) ? (q.type === "matrix" ? q.rows.map((r) => r.field) : [q.field]) : [];
    change(items.filter((x) => x.id !== id).map((x) => (x.kind !== "page" && x.showIf && fieldsOf.includes(x.showIf.field) ? { ...x, showIf: undefined } : x)));
    setSelected(null);
  };
  // What keeps the draft from being saved (checked here, so typing does not
  // produce error messages from the server).
  const problem = useMemo(() => {
    for (const q of items.filter(isQuestion)) {
      const text = texts[q.id];
      const name = text?.title.trim();
      if (!name) return t("Eine Frage hat noch keinen Text.", "A question has no text yet.");
      if (["single", "dropdown", "multiple", "ranking", "yesno"].includes(q.type)) {
        const options = text.options || [];
        if (!options.length) return t(`„${name}“ braucht mindestens eine Antwort.`, `“${name}” needs at least one answer.`);
        if (options.some((o) => !o.trim())) return t(`„${name}“ hat eine leere Antwort.`, `“${name}” has an empty answer.`);
      }
      if (q.type === "matrix" && (!q.rows.length || q.columns.length < 2 || q.rows.some((r) => !r.label.trim()) || q.columns.some((c) => !c.trim())))
        return t(`„${name}“: Jede Zeile und Spalte braucht einen Text.`, `“${name}”: every row and column needs a text.`);
      if (q.type === "scale" && (q.min ?? 1) >= (q.max ?? 5)) return t(`„${name}“: „Bis“ muss größer sein als „Von“.`, `“${name}”: “To” must be larger than “From”.`);
    }
    return "";
  }, [items, texts, t]);
  const save = async () => {
    if (saving.current || !editable) return;
    saving.current = true;
    const at = revision.current;
    setStatus("saving");
    const questions = Object.fromEntries(items.filter(isQuestion).map((q) => [q.id, texts[q.id]]));
    const result = (await act({ action: "survey.save", version: knownVersion.current, survey, questions, form: formTexts })) as { fields: Record<string, string> } | null;
    saving.current = false;
    if (!result) {
      failedRevision.current = at;
      setStatus("failed");
      return;
    }
    knownVersion.current += 1;
    // New questions got their properties; the draft (which may have changed
    // while saving) takes the ids over.
    const id = (ref: string) => result.fields[ref] || ref;
    setSurvey((now) => ({
      ...now,
      items: now.items.map((i) =>
        i.kind === "page"
          ? i
          : {
              ...i,
              ...(i.showIf ? { showIf: { ...i.showIf, field: id(i.showIf.field) } } : {}),
              ...(isQuestion(i) ? { field: id(i.field), rows: i.rows.map((r) => ({ ...r, field: id(r.field) })) } : {}),
            },
      ),
    }));
    if (revision.current === at) setDirtyState(false);
    setStatus("saved");
  };
  const latestSave = useRef(save);
  latestSave.current = save;
  const pending = useRef({ dirty, problem });
  pending.current = { dirty, problem };
  useEffect(() => {
    if (!editable || !dirty || status === "saving" || problem || failedRevision.current === revision.current) return;
    const timer = setTimeout(() => void latestSave.current(), 900);
    return () => clearTimeout(timer);
  }, [survey, texts, formTexts, dirty, status, problem, editable]);
  // Closing the builder right after typing still saves.
  useEffect(
    () => () => {
      if (pending.current.dirty && !pending.current.problem) void latestSave.current();
    },
    [],
  );
  // Fields for the preview: saved ones plus drafts of new questions.
  const previewFields: Field[] = useMemo(() => {
    const list = [...fields];
    for (const q of items.filter(isQuestion)) {
      const text = texts[q.id];
      const set = (id: string, name: string, options?: string[]) => {
        const at = list.findIndex((f) => f.id === id);
        const f = { id, name, type: "text" as const, options };
        if (at >= 0) list[at] = { ...list[at], name, options: options ?? list[at].options };
        else list.push(f);
      };
      if (q.type === "matrix") q.rows.forEach((r) => set(r.field, `${text?.title} – ${r.label}`, q.columns));
      else set(q.field, text?.title || "", text?.options);
    }
    return list;
  }, [fields, items, texts]);
  const previewSurvey = { ...survey, items: items.map((i) => (isQuestion(i) ? { ...i, title: texts[i.id]?.title || "" } : i)) };
  const link = form?.token ? `${typeof location === "undefined" ? "" : location.origin}/forms/${form.token}` : "";
  const questionsBefore = (id: string) => items.slice(0, items.findIndex((x) => x.id === id)).filter(isQuestion);
  return (
    <div className="survey-builder">
      <div className="survey-builder-bar">
        <div className="survey-tabs" role="tablist" aria-label={t("Umfrage", "Survey")}>
          {(
            [
              ["questions", t("Fragen", "Questions")],
              ["preview", t("Vorschau", "Preview")],
              ["settings", t("Einstellungen", "Settings")],
              ["share", t("Teilen", "Share")],
              ["results", t(`Ergebnisse (${rows.length})`, `Results (${rows.length})`)],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
        {editable && (
          <SaveStatus
            state={status === "failed" ? "failed" : dirty && problem ? "paused" : status === "saving" ? "saving" : dirty ? "pending" : "saved"}
            problem={problem}
            onRetry={() => {
              failedRevision.current = -1;
              void save();
            }}
          />
        )}
      </div>
      {tab === "questions" && (
        <div className="survey-builder-body">
          <nav className="survey-outline" aria-label={t("Ablauf der Umfrage", "Survey outline")}>
            <ol>
              {items.map((i, index) => {
                const Icon = i.kind === "question" ? typeInfo[i.type].icon : i.kind === "text" ? Article : Rows;
                const label = i.kind === "question" ? texts[i.id]?.title : i.kind === "text" ? i.title || t("Textblock", "Text block") : i.title || t("Neue Seite", "New page");
                const number = i.kind === "question" ? items.slice(0, index + 1).filter(isQuestion).length : null;
                const page = i.kind === "page" ? items.slice(0, index + 1).filter((x) => x.kind === "page").length + 1 : null;
                return (
                  <li key={i.id} className={`${selected === i.id && !picker ? "selected" : ""} kind-${i.kind}`}>
                    <button
                      type="button"
                      className="survey-outline-item"
                      aria-current={selected === i.id && !picker}
                      onClick={() => {
                        setSelected(i.id);
                        setPicker(false);
                      }}
                    >
                      {number !== null ? <span className="survey-outline-number">{number}</span> : <Icon aria-hidden />}
                      <span className="survey-outline-title">{page !== null ? `${t(`Seite ${page}`, `Page ${page}`)}${i.title ? ` · ${i.title}` : ""}` : label || <em>{t("Ohne Text", "No text")}</em>}</span>
                      {i.kind === "question" && i.required && (
                        <span className="survey-required" title={t("Pflichtfrage", "Required")}>
                          *
                        </span>
                      )}
                      {i.kind !== "page" && i.showIf && <span className="survey-if">{t("wenn", "if")}</span>}
                    </button>
                    {editable && (
                      <span className="survey-outline-actions">
                        <button type="button" className="icon-button" aria-label={t(`${label} nach oben`, `${label} up`)} disabled={index === 0} onClick={() => move(i.id, -1)}>
                          <ArrowUp />
                        </button>
                        <button type="button" className="icon-button" aria-label={t(`${label} nach unten`, `${label} down`)} disabled={index === items.length - 1} onClick={() => move(i.id, 1)}>
                          <ArrowDown />
                        </button>
                        <button type="button" className="icon-button" aria-label={t(`${label} löschen`, `Delete ${label}`)} onClick={() => remove(i.id)}>
                          <Trash />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            {editable && (
              <div className="survey-add">
                <button type="button" className="survey-add-question" onClick={() => setPicker(true)} aria-pressed={picker}>
                  <Plus aria-hidden /> {t("Frage hinzufügen", "Add question")}
                </button>
                <div className="survey-add-more">
                  <button type="button" onClick={() => add("text")}>
                    <Article aria-hidden /> {t("Text", "Text")}
                  </button>
                  <button type="button" onClick={() => add("page")}>
                    <Rows aria-hidden /> {t("Seitenumbruch", "Page break")}
                  </button>
                </div>
              </div>
            )}
          </nav>
          <div className="survey-editor">
            {picker && editable ? (
              <div className="survey-type-picker">
                <div className="survey-pane-head">
                  <h3>{t("Welche Art von Frage?", "What kind of question?")}</h3>
                  {items.length > 0 && (
                    <button type="button" className="text-button" onClick={() => setPicker(false)}>
                      {t("Abbrechen", "Cancel")}
                    </button>
                  )}
                </div>
                {typeGroups.map((group) => (
                  <section key={group.en} aria-label={de ? group.de : group.en}>
                    <h4>{de ? group.de : group.en}</h4>
                    <div className="survey-type-grid" role="group">
                      {group.types.map((type) => {
                        const Icon = typeInfo[type].icon;
                        return (
                          <button key={type} type="button" onClick={() => add(type)}>
                            <Icon aria-hidden />
                            {de ? typeInfo[type].de : typeInfo[type].en}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ) : !item ? (
              <div className="survey-editor-empty">
                <p>{items.length ? t("Wähle links eine Frage, um sie zu bearbeiten.", "Choose a question on the left to edit it.") : t("Füge die erste Frage hinzu.", "Add the first question.")}</p>
              </div>
            ) : item.kind === "page" ? (
              <div className="survey-card">
                <p className="survey-eyebrow">
                  <Rows aria-hidden /> {t("Seitenumbruch", "Page break")}
                </p>
                <label>
                  {t("Titel der neuen Seite (optional)", "Title of the new page (optional)")}
                  <input disabled={!editable} value={item.title} maxLength={300} onChange={(e) => update(item.id, { title: e.target.value })} />
                </label>
              </div>
            ) : item.kind === "text" ? (
              <div className="survey-card">
                <p className="survey-eyebrow">
                  <Article aria-hidden /> {t("Textblock", "Text block")}
                </p>
                <label>
                  {t("Überschrift", "Heading")}
                  <input disabled={!editable} value={item.title} maxLength={300} onChange={(e) => update(item.id, { title: e.target.value })} />
                </label>
                <label>
                  {t("Text", "Text")}
                  <textarea disabled={!editable} rows={5} value={item.body} maxLength={5000} onChange={(e) => update(item.id, { body: e.target.value })} />
                </label>
                <ConditionEditor condition={item.showIf} before={questionsBefore(item.id)} texts={texts} fields={previewFields} disabled={!editable} onChange={(c) => update(item.id, { showIf: c })} />
              </div>
            ) : (
              <div className="survey-card">
                <p className="survey-eyebrow">
                  {(() => {
                    const Icon = typeInfo[item.type].icon;
                    return <Icon aria-hidden />;
                  })()}
                  {t(`Frage ${items.filter(isQuestion).indexOf(item) + 1}`, `Question ${items.filter(isQuestion).indexOf(item) + 1}`)} · {de ? typeInfo[item.type].de : typeInfo[item.type].en}
                </p>
                <QuestionEditor
                  q={item}
                  text={texts[item.id] || { title: "" }}
                  fields={previewFields}
                  before={questionsBefore(item.id)}
                  texts={texts}
                  disabled={!editable}
                  onChange={(patch) => update(item.id, patch)}
                  onText={(patch) => setText(item.id, patch)}
                />
              </div>
            )}
          </div>
        </div>
      )}
      {tab === "preview" && (
        <div className="survey-preview">
          <p className="muted">{t("So sieht die Umfrage für Teilnehmende aus. Antworten aus der Vorschau werden nicht gespeichert.", "This is how people see the survey. Answers in the preview are not saved.")}</p>
          <SurveyRunner
            key={JSON.stringify(previewSurvey).length}
            survey={previewSurvey}
            fields={previewFields}
            texts={{ ...formTexts, title: formTexts.title || pageTitle }}
            preview
            onSubmit={async () => {}}
          />
        </div>
      )}
      {tab === "settings" && (
        <div className="survey-settings">
          <fieldset disabled={!editable}>
            <legend>{t("Titel und Abschluss", "Title and ending")}</legend>
            <label>
              {t("Titel", "Title")}
              <input value={formTexts.title} placeholder={pageTitle} maxLength={200} onChange={(e) => (setFormTexts({ ...formTexts, title: e.target.value }), setDirty(true))} />
            </label>
            <label>
              {t("Einleitung", "Introduction")}
              <textarea rows={3} value={formTexts.description} maxLength={3000} onChange={(e) => (setFormTexts({ ...formTexts, description: e.target.value }), setDirty(true))} />
            </label>
            <label>
              {t("Beschriftung zum Absenden", "Submit button label")}
              <input value={formTexts.submitLabel} maxLength={80} onChange={(e) => (setFormTexts({ ...formTexts, submitLabel: e.target.value }), setDirty(true))} />
            </label>
            <label>
              {t("Dankeschön-Titel", "Thank-you title")}
              <input value={formTexts.successTitle} maxLength={200} onChange={(e) => (setFormTexts({ ...formTexts, successTitle: e.target.value }), setDirty(true))} />
            </label>
            <label>
              {t("Dankeschön-Text", "Thank-you text")}
              <textarea rows={2} value={formTexts.successMessage} maxLength={3000} onChange={(e) => (setFormTexts({ ...formTexts, successMessage: e.target.value }), setDirty(true))} />
            </label>
            <label>
              {t("Danach weiterleiten zu (optional)", "Then redirect to (optional)")}
              <input type="url" placeholder="https://" value={survey.redirect || ""} maxLength={500} onChange={(e) => (setSurvey({ ...survey, redirect: e.target.value || undefined }), setDirty(true))} />
            </label>
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>{t("Ablauf", "Flow")}</legend>
            <label className="checkbox-label">
              <input type="checkbox" checked={survey.welcome.enabled} onChange={(e) => (setSurvey({ ...survey, welcome: { ...survey.welcome, enabled: e.target.checked } }), setDirty(true))} />
              {t("Begrüßungsseite zeigen", "Show a welcome page")}
            </label>
            {survey.welcome.enabled && (
              <>
                <input aria-label={t("Titel der Begrüßung", "Welcome title")} placeholder={formTexts.title || pageTitle} value={survey.welcome.title} maxLength={200} onChange={(e) => (setSurvey({ ...survey, welcome: { ...survey.welcome, title: e.target.value } }), setDirty(true))} />
                <textarea aria-label={t("Text der Begrüßung", "Welcome text")} rows={2} value={survey.welcome.text} maxLength={3000} onChange={(e) => (setSurvey({ ...survey, welcome: { ...survey.welcome, text: e.target.value } }), setDirty(true))} />
                <input aria-label={t("Knopf der Begrüßung", "Welcome button")} placeholder={t("Los geht's", "Start")} value={survey.welcome.button} maxLength={60} onChange={(e) => (setSurvey({ ...survey, welcome: { ...survey.welcome, button: e.target.value } }), setDirty(true))} />
              </>
            )}
            <label className="checkbox-label">
              <input type="checkbox" checked={survey.progress} onChange={(e) => (setSurvey({ ...survey, progress: e.target.checked }), setDirty(true))} />
              {t("Fortschrittsbalken bei mehreren Seiten", "Progress bar for several pages")}
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={survey.onePerPerson} onChange={(e) => (setSurvey({ ...survey, onePerPerson: e.target.checked }), setDirty(true))} />
              {t("Nur eine Antwort pro Person", "One answer per person")}
            </label>
            <label>
              {t("Schließt am (optional)", "Closes on (optional)")}
              <input
                type="datetime-local"
                value={survey.closesAt ? toLocal(survey.closesAt) : ""}
                onChange={(e) => (setSurvey({ ...survey, closesAt: e.target.value ? new Date(e.target.value).toISOString() : undefined }), setDirty(true))}
              />
            </label>
            <label>
              {t("Höchstens so viele Antworten (optional)", "At most this many answers (optional)")}
              <input type="number" min={1} value={survey.limit ?? ""} onChange={(e) => (setSurvey({ ...survey, limit: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined }), setDirty(true))} />
            </label>
            <div role="radiogroup" aria-label={t("Farbe", "Colour")} className="survey-accents">
              {(["blue", "violet", "green", "orange", "rose", "slate"] as const).map((a) => (
                <button key={a} type="button" role="radio" aria-checked={survey.accent === a} aria-label={a} className={`survey-accent-${a}`} onClick={() => (setSurvey({ ...survey, accent: a }), setDirty(true))} />
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {tab === "share" && (
        <div className="survey-share">
          {dirty && problem && <p className="callout-inline">{t(`Noch nicht gespeichert – ${problem}`, `Not saved yet – ${problem}`)}</p>}
          <label className="checkbox-label">
            <input type="checkbox" disabled={!editable} checked={share.enabled} onChange={(e) => void toggle("enabled", e.target.checked)} />
            {t("Umfrage ist geöffnet (Link aktiv)", "Survey is open (link active)")}
          </label>
          <label className="checkbox-label">
            <input type="checkbox" disabled={!editable} checked={share.public} onChange={(e) => void toggle("public", e.target.checked)} />
            {t("Öffentlich: jede Person mit dem Link kann teilnehmen", "Public: anyone with the link can take part")}
          </label>
          <label className="checkbox-label">
            <input type="checkbox" disabled={!editable} checked={share.anonymous} onChange={(e) => void toggle("anonymous", e.target.checked)} />
            {t("Anonym: ohne Anmeldung und ohne Namen", "Anonymous: without signing in and without names")}
          </label>
          {share.enabled && link ? (
            <div className="copy-field">
              <input readOnly value={link} aria-label={t("Link zur Umfrage", "Survey link")} onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                className="button compact"
                onClick={async () => {
                  await navigator.clipboard.writeText(link).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy /> {copied ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
              </button>
              <a className="button compact" href={link} target="_blank" rel="noreferrer">
                {t("Öffnen", "Open")}
              </a>
            </div>
          ) : (
            <p className="muted">{t("Öffne die Umfrage, um den Link zu bekommen.", "Open the survey to get the link.")}</p>
          )}
          <p className="muted small">
            {t(
              "Jede Antwort wird ein Eintrag in dieser Datenbank – filtern, sortieren, auswerten, als CSV exportieren und mit Automationen weiterverarbeiten wie jeden anderen Eintrag.",
              "Every answer becomes a record in this database – filter, sort, analyse, export as CSV and process it with automations like any other record.",
            )}
          </p>
        </div>
      )}
      {tab === "results" && <SurveyResults survey={previewSurvey} fields={fields} rows={rows} />}
    </div>
  );
}
// The question types in the picker, grouped like people look for them.
const typeGroups: { de: string; en: string; types: SurveyType[] }[] = [
  { de: "Auswahl", en: "Choice", types: ["single", "multiple", "dropdown", "yesno", "ranking"] },
  { de: "Bewertung", en: "Rating", types: ["rating", "nps", "scale", "slider", "matrix"] },
  { de: "Text und Angaben", en: "Text and details", types: ["short", "long", "number", "email", "phone", "url", "date", "time", "file"] },
];

// The quiet save indicator: a dot and one short word. While typing it does
// not change its text; only a failed save or a draft that cannot be saved
// asks for attention.
function SaveStatus({ state, problem, onRetry }: { state: "saved" | "pending" | "saving" | "paused" | "failed"; problem: string; onRetry: () => void }) {
  const t = useT();
  const calm = state === "saved" || state === "pending" || state === "saving";
  return (
    <div className={`survey-save-status is-${state}`} title={state === "paused" ? problem : calm ? t("Änderungen werden automatisch gespeichert", "Changes are saved automatically") : undefined}>
      <span className="survey-save-dot" aria-hidden />
      <span role="status">{calm ? t("Automatisch gespeichert", "Saved automatically") : state === "paused" ? t(`Entwurf – ${problem}`, `Draft – ${problem}`) : t("Nicht gespeichert", "Not saved")}</span>
      {state === "failed" && (
        <button type="button" className="text-button" onClick={onRetry}>
          {t("Erneut versuchen", "Try again")}
        </button>
      )}
    </div>
  );
}

const toLocal = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function QuestionEditor({
  q,
  text,
  fields,
  before,
  texts,
  disabled,
  onChange,
  onText,
}: {
  q: SurveyQuestion;
  text: { title: string; options?: string[] };
  fields: Field[];
  before: SurveyQuestion[];
  texts: Texts;
  disabled: boolean;
  onChange: (patch: Partial<SurveyQuestion>) => void;
  onText: (patch: Partial<{ title: string; options: string[] }>) => void;
}) {
  const t = useT();
  const de = useLocale() === "de";
  const options = text.options || [];
  const num = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <div className="question-editor">
      <label className="question-title">
        {t("Frage", "Question")}
        <textarea
          rows={1}
          aria-label={t("Frage", "Question")}
          placeholder={t("Wie lautet die Frage?", "What is the question?")}
          value={text.title}
          disabled={disabled}
          maxLength={300}
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          onChange={(e) => onText({ title: e.target.value.replace(/\s*\n\s*/g, " ") })}
        />
      </label>
      <label>
        {t("Hinweis (optional)", "Hint (optional)")}
        <input placeholder={t("Erklärt die Frage, falls nötig", "Explains the question if needed")} value={q.description} disabled={disabled} maxLength={1000} onChange={(e) => onChange({ description: e.target.value })} />
      </label>
      <div className="question-editor-row">
        <label>
          {t("Fragetyp", "Question type")}
          <Select
            value={q.type}
            disabled={disabled}
            onChange={(e) => {
              const type = e.target.value as SurveyType;
              const fresh = newQuestion(type, de);
              // A new answer type is stored in a new property when saved.
              onChange({ ...fresh.question, id: q.id, field: q.field.startsWith("new:") || storageCompatible(q.type, type) ? q.field : `new:${q.id}-${type}`, title: q.title, description: q.description, required: q.required, showIf: q.showIf });
              if (fresh.options && !(choiceTypes.has(q.type) && choiceTypes.has(type))) onText({ options: fresh.options });
            }}
          >
            {(Object.keys(typeInfo) as SurveyType[]).map((type) => (
              <option key={type} value={type}>
                {de ? typeInfo[type].de : typeInfo[type].en}
              </option>
            ))}
          </Select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" disabled={disabled} checked={q.required} onChange={(e) => onChange({ required: e.target.checked })} />
          {t("Pflichtfrage", "Required")}
        </label>
      </div>
      {["single", "dropdown", "multiple", "ranking"].includes(q.type) && (
        <fieldset className="question-options">
          <legend>{t("Antworten", "Answers")}</legend>
          {options.map((o, i) => (
            <div key={i} className="question-option">
              <input
                aria-label={t(`Antwort ${i + 1}`, `Answer ${i + 1}`)}
                value={o}
                disabled={disabled}
                maxLength={100}
                onChange={(e) => onText({ options: options.map((x, j) => (j === i ? e.target.value : x)) })}
                onPaste={(e) => {
                  // Several lines pasted: one answer each.
                  const lines = e.clipboardData.getData("text").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  if (lines.length < 2) return;
                  e.preventDefault();
                  onText({ options: [...options.slice(0, i), ...lines, ...options.slice(i + 1)].slice(0, 60) });
                }}
              />
              <button type="button" className="icon-button" aria-label={t(`Antwort ${i + 1} entfernen`, `Remove answer ${i + 1}`)} disabled={disabled || options.length <= 1} onClick={() => onText({ options: options.filter((_, j) => j !== i) })}>
                <Trash />
              </button>
            </div>
          ))}
          <button type="button" className="text-button" disabled={disabled || options.length >= 60} onClick={() => onText({ options: [...options, t(`Option ${options.length + 1}`, `Option ${options.length + 1}`)] })}>
            <Plus /> {t("Antwort hinzufügen", "Add answer")}
          </button>
          <small className="muted">{t("Tipp: mehrere Zeilen einfügen legt mehrere Antworten an.", "Tip: pasting several lines adds several answers.")}</small>
          <div className="question-editor-row">
            {q.type !== "ranking" && (
              <label className="checkbox-label">
                <input type="checkbox" disabled={disabled} checked={q.other} onChange={(e) => onChange({ other: e.target.checked })} />
                {t("„Andere“ mit Textfeld", "“Other” with a text field")}
              </label>
            )}
            <label className="checkbox-label">
              <input type="checkbox" disabled={disabled} checked={q.randomize} onChange={(e) => onChange({ randomize: e.target.checked })} />
              {t("Reihenfolge zufällig", "Random order")}
            </label>
          </div>
          {q.type === "multiple" && (
            <div className="question-editor-row">
              <label>
                {t("Mindestens", "At least")}
                <input type="number" min={0} disabled={disabled} value={q.minChoices ?? ""} onChange={(e) => onChange({ minChoices: num(e.target.value) })} />
              </label>
              <label>
                {t("Höchstens", "At most")}
                <input type="number" min={1} disabled={disabled} value={q.maxChoices ?? ""} onChange={(e) => onChange({ maxChoices: num(e.target.value) })} />
              </label>
            </div>
          )}
        </fieldset>
      )}
      {q.type === "yesno" && (
        <div className="question-editor-row">
          {options.map((o, i) => (
            <label key={i}>
              {i === 0 ? t("Ja-Antwort", "Yes answer") : t("Nein-Antwort", "No answer")}
              <input value={o} disabled={disabled} maxLength={100} onChange={(e) => onText({ options: options.map((x, j) => (j === i ? e.target.value : x)) })} />
            </label>
          ))}
        </div>
      )}
      {q.type === "rating" && (
        <label>
          {t("Anzahl Sterne", "Number of stars")}
          <Select value={String(q.max ?? 5)} disabled={disabled} onChange={(e) => onChange({ max: Number(e.target.value) })}>
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
      )}
      {(q.type === "scale" || q.type === "slider" || q.type === "number") && (
        <div className="question-editor-row">
          <label>
            {t("Von", "From")}
            <input type="number" disabled={disabled} value={q.min ?? ""} onChange={(e) => onChange({ min: num(e.target.value) })} />
          </label>
          <label>
            {t("Bis", "To")}
            <input type="number" disabled={disabled} value={q.max ?? ""} onChange={(e) => onChange({ max: num(e.target.value) })} />
          </label>
          {q.type === "slider" && (
            <label>
              {t("Schritt", "Step")}
              <input type="number" min={0.01} disabled={disabled} value={q.step ?? ""} onChange={(e) => onChange({ step: num(e.target.value) })} />
            </label>
          )}
        </div>
      )}
      {q.type === "scale" && (q.min ?? 1) >= (q.max ?? 5) && <p className="error">{t("„Bis“ muss größer sein als „Von“.", "“To” must be larger than “From”.")}</p>}
      {["scale", "slider", "nps"].includes(q.type) && (
        <div className="question-editor-row">
          <label>
            {t("Beschriftung links", "Left label")}
            <input value={q.minLabel} disabled={disabled} maxLength={80} onChange={(e) => onChange({ minLabel: e.target.value })} />
          </label>
          <label>
            {t("Beschriftung rechts", "Right label")}
            <input value={q.maxLabel} disabled={disabled} maxLength={80} onChange={(e) => onChange({ maxLabel: e.target.value })} />
          </label>
        </div>
      )}
      {["short", "long", "email", "phone", "url", "number"].includes(q.type) && (
        <label>
          {t("Platzhalter (optional)", "Placeholder (optional)")}
          <input value={q.placeholder} disabled={disabled} maxLength={200} onChange={(e) => onChange({ placeholder: e.target.value })} />
        </label>
      )}
      {q.type === "matrix" && (
        <div className="question-matrix">
          <fieldset>
            <legend>{t("Zeilen (Aussagen)", "Rows (statements)")}</legend>
            {q.rows.map((r, i) => (
              <div key={r.field} className="question-option">
                <input aria-label={t(`Zeile ${i + 1}`, `Row ${i + 1}`)} value={r.label} disabled={disabled} maxLength={300} onChange={(e) => onChange({ rows: q.rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <button type="button" className="icon-button" aria-label={t(`Zeile ${i + 1} entfernen`, `Remove row ${i + 1}`)} disabled={disabled || q.rows.length <= 1} onClick={() => onChange({ rows: q.rows.filter((_, j) => j !== i) })}>
                  <Trash />
                </button>
              </div>
            ))}
            <button type="button" className="text-button" disabled={disabled || q.rows.length >= 30} onClick={() => onChange({ rows: [...q.rows, { field: `new:${q.id}-${Math.random().toString(36).slice(2, 7)}`, label: t(`Aussage ${q.rows.length + 1}`, `Statement ${q.rows.length + 1}`) }] })}>
              <Plus /> {t("Zeile", "Row")}
            </button>
          </fieldset>
          <fieldset>
            <legend>{t("Spalten (Antworten)", "Columns (answers)")}</legend>
            {q.columns.map((c, i) => (
              <div key={i} className="question-option">
                <input aria-label={t(`Spalte ${i + 1}`, `Column ${i + 1}`)} value={c} disabled={disabled} maxLength={100} onChange={(e) => onChange({ columns: q.columns.map((x, j) => (j === i ? e.target.value : x)) })} />
                <button type="button" className="icon-button" aria-label={t(`Spalte ${i + 1} entfernen`, `Remove column ${i + 1}`)} disabled={disabled || q.columns.length <= 2} onClick={() => onChange({ columns: q.columns.filter((_, j) => j !== i) })}>
                  <Trash />
                </button>
              </div>
            ))}
            <button type="button" className="text-button" disabled={disabled || q.columns.length >= 12} onClick={() => onChange({ columns: [...q.columns, t(`Antwort ${q.columns.length + 1}`, `Answer ${q.columns.length + 1}`)] })}>
              <Plus /> {t("Spalte", "Column")}
            </button>
          </fieldset>
        </div>
      )}
      <ConditionEditor condition={q.showIf} before={before} texts={texts} fields={fields} disabled={disabled} onChange={(c) => onChange({ showIf: c })} />
    </div>
  );
}

// "Only show if <earlier question> <is / is not / …> <answer>".
function ConditionEditor({
  condition,
  before,
  texts,
  fields,
  disabled,
  onChange,
}: {
  condition?: Condition;
  before: SurveyQuestion[];
  texts: Texts;
  fields: Field[];
  disabled: boolean;
  onChange: (c: Condition | undefined) => void;
}) {
  const t = useT();
  const targets = before.flatMap((q) =>
    q.type === "matrix" ? q.rows.map((r) => ({ field: r.field, label: `${texts[q.id]?.title} – ${r.label}`, options: q.columns, q })) : q.type === "file" ? [] : [{ field: q.field, label: texts[q.id]?.title || "", options: texts[q.id]?.options || [], q }],
  );
  if (!targets.length && !condition) return null;
  const target = targets.find((x) => x.field === condition?.field);
  const numeric = target && ["rating", "nps", "scale", "slider", "number"].includes(target.q.type);
  void fields;
  return (
    <fieldset className="question-condition">
      <legend>{t("Bedingung", "Condition")}</legend>
      <label className="checkbox-label">
        <input type="checkbox" disabled={disabled || !targets.length} checked={!!condition} onChange={(e) => onChange(e.target.checked ? { field: targets[0].field, op: "is", value: targets[0].options[0] || "" } : undefined)} />
        {t("Nur zeigen, wenn …", "Only show if …")}
      </label>
      {condition && (
        <div className="question-editor-row">
          <Select aria-label={t("Frage der Bedingung", "Condition question")} disabled={disabled} value={condition.field} onChange={(e) => {
            const next = targets.find((x) => x.field === e.target.value)!;
            onChange({ field: next.field, op: "is", value: next.options[0] || "" });
          }}>
            {targets.map((x) => (
              <option key={x.field} value={x.field}>
                {x.label}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Vergleich", "Comparison")} disabled={disabled} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as Condition["op"] })}>
            <option value="is">{t("ist", "is")}</option>
            <option value="isNot">{t("ist nicht", "is not")}</option>
            {target?.q.type === "multiple" && <option value="includes">{t("enthält", "includes")}</option>}
            {numeric && <option value="gte">{t("ist mindestens", "is at least")}</option>}
            {numeric && <option value="lte">{t("ist höchstens", "is at most")}</option>}
            <option value="answered">{t("ist beantwortet", "is answered")}</option>
            <option value="notAnswered">{t("ist nicht beantwortet", "is not answered")}</option>
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
              <input aria-label={t("Wert der Bedingung", "Condition value")} disabled={disabled} value={condition.value} maxLength={300} onChange={(e) => onChange({ ...condition, value: e.target.value })} />
            ))}
        </div>
      )}
    </fieldset>
  );
}

// Changing between these keeps the same property (same stored type).
function storageCompatible(a: SurveyType, b: SurveyType) {
  const group = (x: SurveyType) =>
    ["short", "long", "time"].includes(x) ? "text" : ["single", "dropdown", "yesno"].includes(x) ? "select" : ["multiple", "ranking"].includes(x) ? "multi" : ["rating", "nps", "scale", "slider", "number"].includes(x) ? "number" : x;
  return group(a) === group(b);
}
