"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
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
  internal = false,
  members = [],
  related = {},
}: {
  internal?: boolean;
  members?: { id: string; name: string }[];
  related?: Record<string, { id: string; cells: { title: string } }[]>;
  token: string;
  title: string;
  fields: Field[];
  anonymous: boolean;
  config: FormConfig;
}) {
  const t = useT();
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
              ? t("Dieses Formular erfasst keine Benutzeridentität.", "This form does not record who you are.")
              : t("Deine Antwort wird deinem angemeldeten Konto zugeordnet.", "Your answer is linked to your signed-in account.")}
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
              const result = validateFormValues(
                fields,
                config,
                values,
                internal,
              );
              setErrors(result.errors);
              if (Object.keys(result.errors).length) return;
              setBusy(true);
              try {
                const files = Object.entries(values).filter(
                  ([, v]) =>
                    Array.isArray(v) && v.some((x) => x instanceof File),
                );
                if (!files.length)
                  await api(`/api/forms/${token}`, { cells: values });
                else {
                  const body = new FormData();
                  body.set(
                    "payload",
                    JSON.stringify({
                      cells: Object.fromEntries(
                        Object.entries(values).filter(
                          ([key]) => !files.some(([id]) => id === key),
                        ),
                      ),
                    }),
                  );
                  for (const [key, list] of files)
                    for (const file of list as File[])
                      body.append(`file:${key}`, file);
                  const response = await fetch(`/api/forms/${token}`, {
                    method: "POST",
                    body,
                  });
                  if (!response.ok)
                    throw new Error(
                      serverMessage((await response.json().catch(() => ({}))).error) ||
                        t("Antwort konnte nicht gespeichert werden.", "The answer could not be saved."),
                    );
                }
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
              internal={internal}
              members={members}
              related={related}
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
              {busy ? t("Wird gesendet …", "Sending …") : config.submitLabel}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
