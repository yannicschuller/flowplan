"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { useState } from "react";
import { api } from "./ui";
import { SurveyRunner } from "./survey-runner";
import { FormFlow, FormThanks, useFormDraft } from "./form-flow";
import { formRedirect, localizedFormTexts, type FormConfig } from "@/lib/form-settings";
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
  const texts = localizedFormTexts(config, t);
  // The answers sent (for the thank-you placeholders); null before sending.
  const [done, setDone] = useState<Record<string, unknown> | null>(null),
    // Customer portal: the private link to the request.
    [ticket, setTicket] = useState<{ url: string; mailed: boolean } | null>(null);
  // Signed-in people (forms that are not anonymous) can continue later.
  const draft = useFormDraft(token, !anonymous && !closed);
  const redirect = formRedirect(config);
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
  const submit = async (answers: Record<string, unknown>) => {
    const result = await send(answers);
    if (!result) throw new Error(t("Antwort konnte nicht gespeichert werden.", "The answer could not be saved."));
    if (result.ticket) setTicket({ url: `/ticket/${result.ticket}`, mailed: !!result.mailed });
    setDone(answers);
  };
  const ticketLink = ticket && (
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
              {draft.loaded ? (
                <SurveyRunner
                  survey={config.survey}
                  fields={fields}
                  texts={{ title, description: config.description, ...texts }}
                  after={ticketLink}
                  redirect={redirect}
                  initial={draft.draft}
                  draft={draft.enabled ? draft : undefined}
                  onSubmit={async (answers) => {
                    const result = await send(answers);
                    if (result?.ticket) setTicket({ url: `/ticket/${result.ticket}`, mailed: !!result.mailed });
                  }}
                />
              ) : (
                <p className="muted">{t("Wird geladen …", "Loading …")}</p>
              )}
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
          <FormThanks title={texts.successTitle} message={texts.successMessage} fields={fields} values={done} redirect={redirect}>
            {ticketLink}
          </FormThanks>
        ) : draft.loaded ? (
          <FormFlow
            fields={fields}
            config={config}
            internal={internal}
            members={members}
            related={related}
            submitLabel={texts.submitLabel}
            initial={draft.draft}
            draft={draft.enabled ? draft : undefined}
            onSubmit={submit}
          />
        ) : (
          <p className="muted">{t("Wird geladen …", "Loading …")}</p>
        )}
      </div>
    </main>
  );
}
