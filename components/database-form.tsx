"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { Fragment, useState } from "react";
import { Article, ChartBar, Copy, Rows, SlidersHorizontal, Trash } from "@phosphor-icons/react";
import { Modal } from "./ui";
import { FormFlow, FormThanks } from "./form-flow";
import { FormConditionEditor, FormFollowUpSettings, fieldTarget, type ConditionTarget } from "./form-logic-editor";
import { validRedirect } from "@/lib/form-logic";
import {
  formConfigSchema,
  formRedirect,
  localizedFormTexts,
  publicFormFields,
  type FormBlock,
  type FormConfig,
  questionStyles,
  type QuestionStyle,
} from "@/lib/form-settings";
import type { Field, Page, Row } from "@/lib/types";
import { SurveyBuilder } from "./survey-builder";
import { SurveyRunner } from "./survey-runner";
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
  const survey = config.survey?.enabled ? config.survey : null;
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
        <p>
          {config.description ||
            t("Deine Antworten werden als neuer Eintrag gespeichert.", "Your answers are saved as a new record.")}
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
          config={config}
          disabled={!editable}
          submitLabel={texts.submitLabel}
          onSubmit={async (values) => {
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
          )}
        </div>
      )}
      <Modal
        open={design}
        onClose={() => setDesign(false)}
        title={t("Formular gestalten", "Design form")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              if (await act({ action: "form.update", config: draft }))
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
          <label>
            {t("Beschreibung", "Description")}
            <textarea
              aria-label={t("Beschreibung", "Description")}
              value={draft.description}
              maxLength={3000}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          <h3>{t("Fragen", "Questions")}</h3>
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
                    disabled={draft.hiddenFields.includes(f.id)}
                    checked={draft.requiredFields.includes(f.id)}
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
              <label>
                {t("Hinweis zu", "Hint for")}{" "}{f.name}
                <input
                  maxLength={1000}
                  value={draft.descriptions[f.id] || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      descriptions: {
                        ...draft.descriptions,
                        [f.id]: e.target.value,
                      },
                    })
                  }
                />
              </label>
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
          <button className="button primary" disabled={busy || !validRedirect(draft.redirectUrl)}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Formular speichern", "Save form")}
          </button>
        </form>
      </Modal>
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
