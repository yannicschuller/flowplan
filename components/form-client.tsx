"use client";
import { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { api } from "./ui";
import FormQuestions from "./form-questions";
import { validateFormValues, type FormConfig } from "@/lib/form-settings";
import type { Field } from "@/lib/types";
export default function FormClient({
  token,
  title,
  fields,
  anonymous,
  config,
}: {
  token: string;
  title: string;
  fields: Field[];
  anonymous: boolean;
  config: FormConfig;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({}),
    [done, setDone] = useState(false),
    [error, setError] = useState(""),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  return (
    <main className="public-page">
      <a href="/" className="public-brand">
        flowplan
      </a>
      <div className="form-preview">
        <div className="form-heading">
          <h1>{title}</h1>
          {config.description && <p>{config.description}</p>}
          <p className="muted">
            {anonymous
              ? "Dieses Formular erfasst keine Benutzeridentität."
              : "Deine Antwort wird deinem angemeldeten Konto zugeordnet."}
          </p>
        </div>
        {done ? (
          <div className="success">
            <Check />
            <h2>{config.successTitle}</h2>
            <p>{config.successMessage}</p>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              if (!e.currentTarget.reportValidity()) return;
              const result = validateFormValues(fields, config, values);
              setErrors(result.errors);
              if (Object.keys(result.errors).length) return;
              setBusy(true);
              try {
                await api(`/api/forms/${token}`, { cells: values });
                setDone(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <FormQuestions
              fields={fields}
              config={config}
              values={values}
              errors={errors}
              disabled={busy}
              onChange={(id, value) =>
                setValues((previous) => ({ ...previous, [id]: value }))
              }
            />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? "Wird gesendet …" : config.submitLabel}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
