"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { api } from "./ui";
import FormQuestions from "./form-questions";
import { SurveyRunner } from "./survey-runner";
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
  closed = "",
}: {
  // Why a survey takes no answers (closed, full), already in the reader's language.
  closed?: string;
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
    // Customer portal: the private link to the request.
    [ticket, setTicket] = useState<{ url: string; mailed: boolean } | null>(null),
    [error, setError] = useState(""),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  // Sends the answers (with files as multipart) and returns the reply.
  const send = async (answers: Record<string, unknown>) => {
    const files = Object.entries(answers).filter(([, v]) => Array.isArray(v) && v.some((x) => x instanceof File));
    if (!files.length) return api<{ ticket?: string; mailed?: boolean }>(`/api/forms/${token}`, { cells: answers });
    const body = new FormData();
    body.set("payload", JSON.stringify({ cells: Object.fromEntries(Object.entries(answers).filter(([key]) => !files.some(([id]) => id === key))) }));
    for (const [key, list] of files) for (const file of list as File[]) body.append(`file:${key}`, file);
    const response = await fetch(`/api/forms/${token}`, { method: "POST", body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(serverMessage(data.error) || t("Antwort konnte nicht gespeichert werden.", "The answer could not be saved."));
    return data as { ticket?: string; mailed?: boolean };
  };
  const ticketLink = ticket && (
    <div className="ticket-link">
      <a className="button primary" href={ticket.url}>
        {t("Anfrage ansehen", "View request")}
      </a>
    </div>
  );
  // Surveys: their own flow (pages, conditions, welcome and thank-you).
  if (config.survey?.enabled)
    return (
      <main className="public-page survey-page">
        <a href="/" className="public-brand">
          flowplan
        </a>
        <div className="form-preview">
          {closed ? (
            <div className="survey-done">
              <h1>{title}</h1>
              <p>{closed}</p>
            </div>
          ) : (
            <>
              {!config.survey.welcome.enabled && (
                <div className="form-heading">
                  <h1>{title}</h1>
                  {config.description && <p>{config.description}</p>}
                </div>
              )}
              <SurveyRunner
                survey={config.survey}
                fields={fields}
                texts={{ title, description: config.description, submitLabel: config.submitLabel, successTitle: config.successTitle, successMessage: config.successMessage }}
                after={ticketLink}
                onSubmit={async (answers) => {
                  const result = await send(answers);
                  if (result.ticket) setTicket({ url: `/ticket/${result.ticket}`, mailed: !!result.mailed });
                }}
              />
              <p className="muted small survey-privacy">
                {anonymous
                  ? t("Diese Umfrage erfasst keine Benutzeridentität.", "This survey does not record who you are.")
                  : t("Deine Antwort wird deinem angemeldeten Konto zugeordnet.", "Your answer is linked to your signed-in account.")}
              </p>
            </>
          )}
        </div>
      </main>
    );
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
            {ticket && (
              <div className="ticket-link">
                <p>
                  {ticket.mailed
                    ? t(
                        "Unter diesem Link siehst du den Stand deiner Anfrage und kannst antworten. Wir haben ihn dir auch per E-Mail geschickt.",
                        "At this link you can see the status of your request and reply. We also sent it to you by e-mail.",
                      )
                    : t(
                        "Unter diesem Link siehst du den Stand deiner Anfrage und kannst antworten. Speichere ihn dir.",
                        "At this link you can see the status of your request and reply. Save it.",
                      )}
                </p>
                <a className="button primary" href={ticket.url}>
                  {t("Anfrage ansehen", "View request")}
                </a>
              </div>
            )}
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
                let result: { ticket?: string; mailed?: boolean } = {};
                if (!files.length)
                  result = await api(`/api/forms/${token}`, { cells: values });
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
                  const data = await response.json().catch(() => ({}));
                  if (!response.ok)
                    throw new Error(
                      serverMessage(data.error) ||
                        t("Antwort konnte nicht gespeichert werden.", "The answer could not be saved."),
                    );
                  result = data;
                }
                if (result.ticket) setTicket({ url: `/ticket/${result.ticket}`, mailed: !!result.mailed });
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
