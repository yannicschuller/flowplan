"use client";
import { useState } from "react";
import { Check, Copy, SlidersHorizontal } from "@phosphor-icons/react";
import { Modal } from "./ui";
import FormQuestions from "./form-questions";
import {
  formConfigSchema,
  publicFormFields,
  validateFormValues,
  type FormConfig,
} from "@/lib/form-settings";
import type { Field, Page } from "@/lib/types";
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
}: {
  members?: { id: string; name: string }[];
  related?: Record<string, { id: string; cells: { title: string } }[]>;
  upload?: (file: File) => Promise<string>;
  page: Page;
  fields: Field[];
  form: Form;
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const config = form?.config || formConfigSchema.parse({});
  const [values, setValues] = useState<Record<string, unknown>>({}),
    [done, setDone] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [design, setDesign] = useState(false),
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
  return (
    <div className="form-preview">
      <div className="form-heading">
        <h2>{config.title || page.title}</h2>
        <p>
          {config.description ||
            "Deine Antworten werden als neuer Eintrag gespeichert."}
        </p>
        {editable && (
          <button
            className="button"
            onClick={() => {
              setDraft(config);
              setDesign(true);
            }}
          >
            <SlidersHorizontal />
            Formular gestalten
          </button>
        )}
      </div>
      {done ? (
        <div className="success">
          <Check />
          <h3>{config.successTitle}</h3>
          <p>{config.successMessage}</p>
          <button
            className="button"
            onClick={() => {
              setDone(false);
              setValues({});
            }}
          >
            Weitere Antwort
          </button>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!e.currentTarget.reportValidity()) return;
            const result = validateFormValues(fields, config, values, true);
            setErrors(result.errors);
            if (Object.keys(result.errors).length) return;
            setBusy(true);
            try {
              if (await act({ action: "form.submit", cells: values }))
                setDone(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <FormQuestions
            internal
            members={members}
            related={related}
            upload={upload}
            fields={fields}
            config={config}
            values={values}
            errors={errors}
            disabled={!editable || busy}
            onChange={(id, value) =>
              setValues((previous) => ({ ...previous, [id]: value }))
            }
          />
          <button className="button primary" disabled={!editable || busy}>
            {busy ? "Wird gesendet …" : config.submitLabel}
          </button>
        </form>
      )}
      {editable && (
        <div className="form-sharing">
          <h3>Formular teilen</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sharingPending?.enabled ?? !!form?.enabled}
              disabled={sharingPending !== null}
              onChange={(e) => updateSharing("enabled", e.target.checked)}
            />
            Formular aktivieren
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sharingPending?.internal ?? form?.internal !== 0}
              disabled={sharingPending !== null}
              onChange={(e) => updateSharing("internal", e.target.checked)}
            />
            Nur für Mitglieder
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sharingPending?.anonymous ?? !!form?.anonymous}
              disabled={sharingPending !== null}
              onChange={(e) => updateSharing("anonymous", e.target.checked)}
            />
            Anonyme Antworten
          </label>
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
              Formularlink kopieren
            </button>
          )}
        </div>
      )}
      <Modal
        open={design}
        onClose={() => setDesign(false)}
        title="Formular gestalten"
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
            Formulartitel
            <input
              value={draft.title}
              maxLength={200}
              placeholder={page.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Beschreibung
            <textarea
              aria-label="Beschreibung"
              value={draft.description}
              maxLength={3000}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          <h3>Fragen</h3>
          {designFields.map((f, index) => (
            <section className="form-field-design" key={f.id}>
              <div className="property-order">
                <strong>{f.name}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${f.name} nach oben`}
                  disabled={index === 0}
                  onClick={() => moveField(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${f.name} nach unten`}
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
                  Sichtbar
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    aria-label={`${f.name} ist Pflichtfeld`}
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
                  Pflichtfeld
                </label>
              </div>
              <label>
                Hinweis zu {f.name}
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
            </section>
          ))}
          <label>
            Beschriftung der Senden-Schaltfläche
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
            Titel nach dem Absenden
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
            Bestätigungstext
            <textarea
              maxLength={3000}
              aria-label="Bestätigungstext"
              value={draft.successMessage}
              onChange={(e) =>
                setDraft({ ...draft, successMessage: e.target.value })
              }
            />
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? "Wird gespeichert …" : "Formular speichern"}
          </button>
        </form>
      </Modal>
    </div>
  );
}
