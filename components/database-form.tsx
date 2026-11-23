"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { formSuggestSource } from "./form-suggest-input";
import { Article, ChartBar, Copy, Info, ListBullets, QrCode, Rows, SlidersHorizontal, Trash } from "@phosphor-icons/react";
import { FormQrDialog } from "./form-qr";
import { Modal, requireConnection } from "./ui";
import { FormFlow, FormThanks } from "./form-flow";
import { FormConditionEditor, FormFollowUpSettings, fieldTarget, type ConditionTarget } from "./form-logic-editor";
import { validRedirect } from "@/lib/form-logic";
import {
  cleanSuggestionList,
  SUGGESTION_LIST_ITEM_MAX,
  SUGGESTION_LIST_MAX,
  suggestionListProblem,
} from "@/lib/form-suggestion-list";
import {
  formConfigSchema,
  formRedirect,
  localizedFormTexts,
  publicFormFields,
  type FormBlock,
  type FormConfig,
  questionStyles,
  type QuestionStyle,
  formSuggestionsAllowed,
  suggestible,
  type SuggestionScope,
  withRequiredProperties,
} from "@/lib/form-settings";
import { isRequired } from "@/lib/field-required";
import type { Field, Page, Row } from "@/lib/types";
import { SurveyBuilder } from "./survey-builder";
import { SurveyRunner } from "./survey-runner";
import { FormText } from "./inline-text";
import { FormTextInput } from "./form-text-input";
type Form = {
  token: string;
  enabled: number;
  internal: number;
  anonymous: number;
  config: FormConfig;
} | null;
export default function DatabaseForm({
  page,
  fields,
  form,
  editable,
  act,
  members = [],
  related = {},
  upload,
  rows = [],
  version = 0,
}: {
  rows?: Row[];
  version?: number;
  members?: { id: string; name: string }[];
  related?: Record<string, { id: string; cells: { title: string } }[]>;
  upload?: (file: File) => Promise<string>;
  page: Page;
  fields: Field[];
  form: Form;
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const config = form?.config || formConfigSchema.parse({});
  const texts = localizedFormTexts(config, t);
  const [sent, setSent] = useState<Record<string, unknown> | null>(null),
    [done, setDone] = useState(false),
    [design, setDesign] = useState(false),
    [qr, setQr] = useState(false),
    [builder, setBuilder] = useState(false),
    [draft, setDraft] = useState(config),
    [busy, setBusy] = useState(false);
  const [sharingPending, setSharingPending] = useState<Partial<
    Record<"enabled" | "internal" | "anonymous", boolean>
  > | null>(null);
  async function updateSharing(
    key: "enabled" | "internal" | "anonymous",
    value: boolean,
  ) {
    setSharingPending({ [key]: value });
    try {
      await act({ action: "form.update", [key]: value });
    } finally {
      setSharingPending(null);
    }
  }
  // Earlier answers need a members-only form that records who answered
  // (#385): one step from the designer, which stays open.
  async function membersOnly() {
    setSharingPending({ internal: true, anonymous: false });
    try {
      await act({ action: "form.update", internal: true, anonymous: false });
    } finally {
      setSharingPending(null);
    }
  }
  // Properties a customer may see: no people, relations or files.
  const portalCandidates = fields.filter(
    (f) => !["person", "relation", "created_by", "updated_by", "files"].includes(f.type),
  );
  const [portalBusy, setPortalBusy] = useState(false);
  async function updatePortal(change: Partial<FormConfig>) {
    const next = { ...config, ...change };
    // Switching it on shows a status property right away, if there is one.
    if (change.portal && !config.portalFields.length) {
      const status = portalCandidates.find((f) => f.type === "select" && /status|stand/i.test(f.name))
        || portalCandidates.find((f) => f.type === "select");
      if (status) next.portalFields = [status.id];
    }
    setPortalBusy(true);
    try {
      await act({ action: "form.update", config: next });
    } finally {
      setPortalBusy(false);
    }
  }
  const designFields = [...publicFormFields(fields, !!form?.internal)].sort(
    (a, b) =>
      (draft.fieldOrder.includes(a.id) ? draft.fieldOrder.indexOf(a.id) : 999) -
      (draft.fieldOrder.includes(b.id) ? draft.fieldOrder.indexOf(b.id) : 999),
  );
  function moveField(index: number, delta: number) {
    const order = designFields.map((f) => f.id);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    setDraft({ ...draft, fieldOrder: order });
  }
  // Conditions may look at shown questions before the item.
  const targetsBefore = (index: number) =>
    designFields
      .slice(0, index)
      .filter((f) => !draft.hiddenFields.includes(f.id))
      .map((f) => fieldTarget(f))
      .filter((x): x is ConditionTarget => !!x);
  const addBlock = (kind: "text" | "page", before: string) =>
    setDraft({
      ...draft,
      blocks: [...draft.blocks, { id: Math.random().toString(36).slice(2, 10), kind, before, title: kind === "text" ? t("Abschnitt", "Section") : "", body: "" }].slice(0, 100),
    });
  const updateBlock = (id: string, patch: Partial<FormBlock>) => setDraft({ ...draft, blocks: draft.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const removeBlock = (id: string) => setDraft({ ...draft, blocks: draft.blocks.filter((b) => b.id !== id) });
  // The preview asks required properties (#443) as the form does.
  const asked = withRequiredProperties(fields, config);
  const survey = asked.survey?.enabled ? asked.survey : null;
  // Fixed suggestion lists (#385): cleaned on saving; too long ones block it.
  const listsInvalid = Object.values(draft.suggestionLists || {}).some((lines) => !!suggestionListProblem(cleanSuggestionList(lines)));
  // Earlier answers (#374) only in members-only forms that record who
  // answered; a form never saved is members-only by default.
  const suggestionsAllowed = formSuggestionsAllowed({ internal: form ? form.internal : 1, anonymous: form?.anonymous ?? 0 });
  // Why earlier answers are off: one notice above the questions (#385);
  // after switching to members only, the focus moves to the first switch
  // that can now be used instead of getting lost with the button.
  const lockedNoticeId = useId();
  const designRef = useRef<HTMLFormElement>(null);
  const [focusSuggest, setFocusSuggest] = useState(false);
  useEffect(() => {
    if (!focusSuggest || !suggestionsAllowed) return;
    designRef.current?.querySelector<HTMLInputElement>(".form-suggest-design input[type=checkbox]:not(:disabled)")?.focus();
    setFocusSuggest(false);
  }, [focusSuggest, suggestionsAllowed]);
  const suggest = useMemo(
    () => (form?.enabled && suggestionsAllowed && Object.keys(config.suggestions || {}).length ? formSuggestSource(form.token) : undefined),
    [form?.enabled, form?.token, suggestionsAllowed, config.suggestions],
  );
  const builderModal = (
    <Modal open={builder} onClose={() => setBuilder(false)} title={t("Umfrage bauen", "Build survey")} wide className="survey-builder-modal">
      {builder && <SurveyBuilder pageTitle={page.title} fields={fields} version={version} form={form} rows={rows} editable={editable} act={act} members={members} />}
    </Modal>
  );
  if (survey)
    return (
      <div className="form-preview survey-in-app">
        <div className="survey-form-cta">
          <button className="button primary" onClick={() => setBuilder(true)}>
            <SlidersHorizontal /> {editable ? t("Umfrage bearbeiten", "Edit survey") : t("Umfrage ansehen", "View survey")}
          </button>
          <span className="muted">
            {t(`${rows.length} Antworten`, `${rows.length} answers`)} · {form?.enabled ? t("geöffnet", "open") : t("nicht geöffnet", "not open")}
          </span>
        </div>
        <SurveyRunner
          key={done ? "again" : "first"}
          survey={survey}
          fields={fields}
          texts={{ title: config.title || page.title, description: config.description, ...texts }}
          onSubmit={async (answers) => {
            const files = Object.values(answers).some((v) => Array.isArray(v) && v.some((x) => x instanceof File));
            if (files) throw new Error(t("Dateien lassen sich nur über den Link der Umfrage hochladen.", "Files can only be uploaded through the survey link."));
            // An answer is checked by the server (#333): offline the note.
            requireConnection();
            if (!(await act({ action: "form.submit", cells: answers }))) throw new Error(t("Antwort konnte nicht gespeichert werden.", "The answer could not be saved."));
          }}
          after={
            <button className="button" onClick={() => setDone((d) => !d)}>
              {t("Weitere Antwort", "Another answer")}
            </button>
          }
        />
        {builderModal}
      </div>
    );
  return (
    <div className="form-preview">
      {builderModal}
      <div className="form-heading">
        <h2>{config.title || page.title}</h2>
        <p className="form-description">
          {config.description ? <FormText value={config.description} /> : t("Deine Antworten werden als neuer Eintrag gespeichert.", "Your answers are saved as a new record.")}
        </p>
        {editable && (
          <div className="form-heading-actions">
            <button
              className="button"
              onClick={() => {
                setDraft(config);
                setDesign(true);
              }}
            >
              <SlidersHorizontal />
              {t("Formular gestalten", "Design form")}
            </button>
            <button className="button" onClick={() => setBuilder(true)}>
              <ChartBar />
              {t("Als Umfrage gestalten", "Turn into a survey")}
            </button>
          </div>
        )}
      </div>
      {sent ? (
        <FormThanks heading="h3" title={texts.successTitle} message={texts.successMessage} fields={fields} values={sent} redirect={formRedirect(config)} preview>
          <button className="button" onClick={() => setSent(null)}>
            {t("Weitere Antwort", "Another answer")}
          </button>
        </FormThanks>
      ) : (
        <FormFlow
          key={JSON.stringify([config.logic, config.blocks, config.fieldOrder, config.hiddenFields])}
          internal
          members={members}
          related={related}
          upload={upload}
          fields={fields}
          config={asked}
          disabled={!editable}
          suggest={suggest}
          submitLabel={texts.submitLabel}
          onSubmit={async (values) => {
            requireConnection();
            if (!(await act({ action: "form.submit", cells: values }))) throw new Error(t("Antwort konnte nicht gespeichert werden.", "The answer could not be saved."));
            setSent(values);
          }}
        />
      )}
      {editable && (
        <div className="form-sharing">
          <h3>{t("Formular teilen", "Share form")}</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sharingPending?.enabled ?? !!form?.enabled}
              disabled={sharingPending !== null}
              onChange={(e) => updateSharing("enabled", e.target.checked)}
            />
            {t("Formular aktivieren", "Enable form")}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sharingPending?.internal ?? form?.internal !== 0}
              disabled={sharingPending !== null}
              onChange={(e) => updateSharing("internal", e.target.checked)}
            />
            {t("Nur für Mitglieder", "Members only")}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sharingPending?.anonymous ?? !!form?.anonymous}
              disabled={sharingPending !== null}
              onChange={(e) => updateSharing("anonymous", e.target.checked)}
            />
            {t("Anonyme Antworten", "Anonymous answers")}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.portal}
              disabled={portalBusy}
              onChange={(e) => updatePortal({ portal: e.target.checked })}
            />
            {t("Kundenportal: Einsendende sehen den Stand ihrer Anfrage", "Customer portal: senders see the status of their request")}
          </label>
          {config.portal && (
            <fieldset className="portal-fields">
              <legend>{t("Im Kundenportal sichtbar", "Visible in the customer portal")}</legend>
              <p className="muted">
                {t(
                  "Wer das Formular absendet, bekommt einen privaten Link (per E-Mail, wenn eine E-Mail-Frage beantwortet wurde) und kann dort dem Team antworten. Antworten gebt ihr im Eintrag.",
                  "Whoever sends the form gets a private link (by e-mail if an e-mail question was answered) and can reply to the team there. You answer in the record.",
                )}
              </p>
              {portalCandidates.map((f) => (
                <label className="checkbox-label" key={f.id}>
                  <input
                    type="checkbox"
                    checked={config.portalFields.includes(f.id)}
                    disabled={portalBusy}
                    onChange={(e) =>
                      updatePortal({
                        portalFields: e.target.checked
                          ? [...config.portalFields, f.id]
                          : config.portalFields.filter((id) => id !== f.id),
                      })
                    }
                  />
                  {f.name}
                </label>
              ))}
            </fieldset>
          )}
          {!!form?.enabled && (
            <div className="form-link-actions">
              <button
                className="button"
                onClick={() =>
                  navigator.clipboard.writeText(
                    `${location.origin}/forms/${form.token}`,
                  )
                }
              >
                <Copy />
                {t("Formularlink kopieren", "Copy form link")}
              </button>
              <button className="button" onClick={() => setQr(true)}>
                <QrCode />
                {t("QR-Code", "QR code")}
              </button>
              {qr && (
                <FormQrDialog
                  open
                  onClose={() => setQr(false)}
                  url={`${location.origin}/forms/${form.token}`}
                  title={config.title || page.title}
                />
              )}
            </div>
          )}
        </div>
      )}
      <Modal
        open={design}
        onClose={() => setDesign(false)}
        title={t("Formular gestalten", "Design form")}
      >
        <form
          ref={designRef}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const suggestionLists = Object.fromEntries(
                Object.entries(draft.suggestionLists || {})
                  .map(([id, lines]) => [id, cleanSuggestionList(lines)] as const)
                  .filter(([, list]) => list.length),
              );
              if (await act({ action: "form.update", config: { ...draft, suggestionLists } }))
                setDesign(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Formulartitel", "Form title")}
            <input
              value={draft.title}
              maxLength={200}
              placeholder={page.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <div className="field-group form-text-label">
            <span>{t("Beschreibung", "Description")}</span>
            <FormTextInput
              label={t("Beschreibung", "Description")}
              value={draft.description}
              maxLength={3000}
              onChange={(description) => setDraft((d) => ({ ...d, description }))}
            />
          </div>
          <h3>{t("Fragen", "Questions")}</h3>
          {!suggestionsAllowed && designFields.some((f) => suggestible(f, draft) && !draft.hiddenFields.includes(f.id)) && (
            <div className="form-suggest-locked">
              <Info aria-hidden />
              <p id={lockedNoticeId}>
                {t(
                  "Frühere Antworten vorschlagen geht nur in Formularen „Nur für Mitglieder“ ohne anonyme Antworten – sonst könnte jede Person mit dem Link fremde Antworten lesen. Feste Vorschlagslisten gehen in jedem Formular.",
                  "Suggesting earlier answers only works in “Members only” forms without anonymous answers – otherwise anyone with the link could read other people's answers. Fixed suggestion lists work in every form.",
                )}
              </p>
              {form && (
                <button
                  type="button"
                  className="button compact"
                  disabled={sharingPending !== null}
                  onClick={async () => {
                    await membersOnly();
                    setFocusSuggest(true);
                  }}
                >
                  {t("Auf „Nur für Mitglieder“ umstellen", "Switch to “Members only”")}
                </button>
              )}
            </div>
          )}
          {designFields.map((f, index) => (
            <Fragment key={f.id}>
            {draft.blocks.filter((b) => b.before === f.id).map((b) => (
              <BlockDesign key={b.id} block={b} targets={targetsBefore(index)} onChange={(patch) => updateBlock(b.id, patch)} onRemove={() => removeBlock(b.id)} />
            ))}
            <section className="form-field-design">
              <div className="property-order">
                <strong>{f.name}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(`${f.name} nach oben`, `${f.name} up`)}
                  disabled={index === 0}
                  onClick={() => moveField(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(`${f.name} nach unten`, `${f.name} down`)}
                  disabled={index === designFields.length - 1}
                  onClick={() => moveField(index, 1)}
                >
                  ↓
                </button>
              </div>
              <div className="form-field-options">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={!draft.hiddenFields.includes(f.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        hiddenFields: e.target.checked
                          ? draft.hiddenFields.filter((id) => id !== f.id)
                          : [...draft.hiddenFields, f.id],
                      })
                    }
                  />
                  {t("Sichtbar", "Visible")}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    aria-label={t(`${f.name} ist Pflichtfeld`, `${f.name} is required`)}
                    // A required property of the database (#443) is a
                    // required question wherever it is asked.
                    title={isRequired(f) ? t("Pflichtfeld der Datenbank", "Required in the database") : undefined}
                    disabled={draft.hiddenFields.includes(f.id) || isRequired(f)}
                    checked={draft.requiredFields.includes(f.id) || isRequired(f)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        requiredFields: e.target.checked
                          ? [...draft.requiredFields, f.id]
                          : draft.requiredFields.filter((id) => id !== f.id),
                      })
                    }
                  />
                  {t("Pflichtfeld", "Required")}
                </label>
                {questionStyles(f).length > 0 && (
                  <label>
                    {t("Fragetyp", "Question type")}
                    <Select
                      aria-label={t(`Fragetyp für ${f.name}`, `Question type for ${f.name}`)}
                      value={draft.questionStyles?.[f.id] || ""}
                      onChange={(e) => {
                        const next = { ...(draft.questionStyles || {}) };
                        if (e.target.value)
                          next[f.id] = e.target.value as QuestionStyle;
                        else delete next[f.id];
                        setDraft({ ...draft, questionStyles: next });
                      }}
                    >
                      <option value="">{t("Standard", "Default")}</option>
                      {questionStyles(f).map((style) => (
                        <option key={style} value={style}>
                          {
                            {
                              long: t("Langer Text", "Long text"),
                              buttons: t("Auswahlknöpfe", "Radio buttons"),
                              scale: t("Lineare Skala 1–10", "Linear scale 1–10"),
                            }[style]
                          }
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
              </div>
              {suggestible(f, draft) && !draft.hiddenFields.includes(f.id) && (
                <SuggestionDesign
                  field={f}
                  scope={draft.suggestions?.[f.id]}
                  allowed={suggestionsAllowed}
                  lockedNoticeId={lockedNoticeId}
                  lines={draft.suggestionLists?.[f.id] || []}
                  onLines={(lines) =>
                    setDraft((d) => ({ ...d, suggestionLists: { ...(d.suggestionLists || {}), [f.id]: lines } }))
                  }
                  onChange={(scope) => {
                    const suggestions = { ...(draft.suggestions || {}) };
                    if (scope) suggestions[f.id] = scope;
                    else delete suggestions[f.id];
                    setDraft({ ...draft, suggestions });
                  }}
                />
              )}
              <div className="field-group form-text-label">
                <span>
                  {t("Hinweis zu", "Hint for")}{" "}{f.name}
                </span>
                <FormTextInput
                  label={`${t("Hinweis zu", "Hint for")} ${f.name}`}
                  maxLength={1000}
                  value={draft.descriptions[f.id] || ""}
                  onChange={(text) => setDraft((d) => ({ ...d, descriptions: { ...d.descriptions, [f.id]: text } }))}
                />
              </div>
              {!draft.hiddenFields.includes(f.id) && (
                <FormConditionEditor
                  condition={draft.logic[f.id]}
                  targets={targetsBefore(index)}
                  onChange={(c) => {
                    const logic = { ...draft.logic };
                    if (c) logic[f.id] = c;
                    else delete logic[f.id];
                    setDraft({ ...draft, logic });
                  }}
                />
              )}
              <div className="form-block-add">
                <button type="button" className="text-button" onClick={() => addBlock("text", f.id)}>
                  <Article aria-hidden /> {t("Textblock davor", "Text block before")}
                </button>
                {index > 0 && (
                  <button type="button" className="text-button" onClick={() => addBlock("page", f.id)}>
                    <Rows aria-hidden /> {t("Neue Seite ab hier", "New page from here")}
                  </button>
                )}
              </div>
            </section>
            </Fragment>
          ))}
          {draft.blocks.filter((b) => !designFields.some((f) => f.id === b.before)).map((b) => (
            <BlockDesign key={b.id} block={b} targets={targetsBefore(designFields.length)} onChange={(patch) => updateBlock(b.id, patch)} onRemove={() => removeBlock(b.id)} />
          ))}
          <div className="form-block-add">
            <button type="button" className="text-button" onClick={() => addBlock("text", "")}>
              <Article aria-hidden /> {t("Textblock am Ende", "Text block at the end")}
            </button>
          </div>
          {draft.blocks.some((b) => b.kind === "page") && (
            <label className="checkbox-label">
              <input type="checkbox" checked={draft.progress} onChange={(e) => setDraft({ ...draft, progress: e.target.checked })} />
              {t("Fortschrittsbalken bei mehreren Seiten", "Progress bar for several pages")}
            </label>
          )}
          <label>
            {t("Beschriftung der Senden-Schaltfläche", "Submit button label")}
            <input
              required
              maxLength={80}
              value={draft.submitLabel}
              onChange={(e) =>
                setDraft({ ...draft, submitLabel: e.target.value })
              }
            />
          </label>
          <label>
            {t("Titel nach dem Absenden", "Title after submitting")}
            <input
              required
              maxLength={200}
              value={draft.successTitle}
              onChange={(e) =>
                setDraft({ ...draft, successTitle: e.target.value })
              }
            />
          </label>
          <label>
            {t("Bestätigungstext", "Confirmation text")}
            <textarea
              maxLength={3000}
              aria-label={t("Bestätigungstext", "Confirmation text")}
              value={draft.successMessage}
              onChange={(e) =>
                setDraft({ ...draft, successMessage: e.target.value })
              }
            />
          </label>
          <FormFollowUpSettings
            value={draft}
            members={members}
            anonymous={!!form?.anonymous}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
          />
          <button className="button primary" disabled={busy || listsInvalid || !validRedirect(draft.redirectUrl)}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Formular speichern", "Save form")}
          </button>
        </form>
      </Modal>
    </div>
  );
}

// Suggestions for a text question. A fixed list (#385) the author types
// in works in every form. Earlier answers (#374) are off by default: the
// person's own answers or all they may read, and only in members-only
// forms that record who answered – otherwise anyone with the link could
// read other people's answers. Then the reason stands next to the switch,
// with a button that makes the form members-only.
function SuggestionDesign({
  field,
  scope,
  allowed,
  lockedNoticeId,
  lines,
  onLines,
  onChange,
}: {
  field: Field;
  scope?: SuggestionScope;
  allowed: boolean;
  // The one notice above the questions that says why earlier answers are off.
  lockedNoticeId: string;
  lines: string[];
  onLines: (lines: string[]) => void;
  onChange: (scope: SuggestionScope | undefined) => void;
}) {
  const t = useT();
  const id = useId();
  const on = allowed && !!scope;
  const list = cleanSuggestionList(lines);
  const problem = suggestionListProblem(list);
  const [listOpen, setListOpen] = useState(list.length > 0);
  return (
    <div className="form-suggest-design">
      <label className="checkbox-label">
        <input
          type="checkbox"
          aria-label={t(`Frühere Antworten für ${field.name} vorschlagen`, `Suggest earlier answers for ${field.name}`)}
          aria-describedby={allowed ? `${id}-earlier` : lockedNoticeId}
          checked={on}
          disabled={!allowed}
          onChange={(e) => onChange(e.target.checked ? scope || "own" : undefined)}
        />
        {t("Frühere Antworten vorschlagen", "Suggest earlier answers")}
      </label>
      {on && (
        <label>
          {t("Vorschläge aus", "Suggestions from")}
          <Select
            aria-label={t(`Vorschläge für ${field.name} aus`, `Suggestions for ${field.name} from`)}
            value={scope}
            onChange={(e) => onChange(e.target.value as SuggestionScope)}
          >
            <option value="own">{t("Nur eigene Antworten", "Own answers")}</option>
            <option value="all">{t("Alle Antworten", "All answers")}</option>
          </Select>
        </label>
      )}
      {allowed
        ? on && (
            <p className="muted small" id={`${id}-earlier`}>
              {t(
                "Ab zwei Buchstaben erscheinen bis zu acht frühere Antworten – nur aus Einträgen, die die antwortende Person sehen darf.",
                "From two letters on, up to eight earlier answers appear – only from records the person answering may see.",
              )}
            </p>
          )
        : null}
      {listOpen ? (
        <div className="form-suggest-list-design">
          <label htmlFor={`${id}-list`}>{t("Feste Vorschläge, einer pro Zeile", "Fixed suggestions, one per line")}</label>
          <textarea
            id={`${id}-list`}
            rows={4}
            aria-label={t(`Feste Vorschläge für ${field.name}`, `Fixed suggestions for ${field.name}`)}
            aria-describedby={`${id}-list-hint`}
            aria-invalid={problem ? true : undefined}
            value={lines.join("\n")}
            onChange={(e) => onLines(e.target.value.split(/\r?\n/))}
          />
          <p className={problem ? "error small" : "muted small"} id={`${id}-list-hint`}>
            {problem === "count"
              ? t(`Höchstens ${SUGGESTION_LIST_MAX} Vorschläge – es sind ${list.length}.`, `At most ${SUGGESTION_LIST_MAX} suggestions – there are ${list.length}.`)
              : problem === "length"
                ? t(`Ein Vorschlag darf höchstens ${SUGGESTION_LIST_ITEM_MAX} Zeichen lang sein.`, `A suggestion may be at most ${SUGGESTION_LIST_ITEM_MAX} characters long.`)
                : t(
                    `Erscheinen beim Tippen in jedem Formular, auch in öffentlichen – zuerst, vor früheren Antworten. ${list.length} von ${SUGGESTION_LIST_MAX}.`,
                    `Appear while typing in every form, public ones too – first, before earlier answers. ${list.length} of ${SUGGESTION_LIST_MAX}.`,
                  )}
          </p>
        </div>
      ) : (
        <button type="button" className="text-button" aria-label={t(`Feste Vorschläge für ${field.name} eingeben`, `Enter fixed suggestions for ${field.name}`)} onClick={() => setListOpen(true)}>
          <ListBullets aria-hidden /> {t("Feste Vorschläge eingeben", "Enter fixed suggestions")}
        </button>
      )}
    </div>
  );
}

// A text block or page break between the questions, with its condition.
function BlockDesign({
  block,
  targets,
  onChange,
  onRemove,
}: {
  block: FormBlock;
  targets: ConditionTarget[];
  onChange: (patch: Partial<FormBlock>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const page = block.kind === "page";
  const name = page ? t("Seitenumbruch", "Page break") : t("Textblock", "Text block");
  return (
    <section className={`form-field-design form-block-design kind-${block.kind}`}>
      <div className="property-order">
        <strong>
          {page ? <Rows aria-hidden /> : <Article aria-hidden />} {name}
        </strong>
        <button type="button" className="icon-button" aria-label={t(`${name} entfernen`, `Remove ${name}`)} onClick={onRemove}>
          <Trash />
        </button>
      </div>
      <label>
        {page ? t("Titel der neuen Seite (optional)", "Title of the new page (optional)") : t("Überschrift", "Heading")}
        <input value={block.title} maxLength={300} onChange={(e) => onChange({ title: e.target.value })} />
      </label>
      {!page && (
        <label>
          {t("Text", "Text")}
          <textarea rows={3} value={block.body} maxLength={5000} onChange={(e) => onChange({ body: e.target.value })} />
        </label>
      )}
      <FormConditionEditor
        condition={block.showIf}
        targets={targets}
        label={page ? t("Seite nur zeigen, wenn …", "Only show this page if …") : undefined}
        onChange={(c) => onChange({ showIf: c })}
      />
    </section>
  );
}
