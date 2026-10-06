import { serverT } from "@/lib/i18n-server";
import { currentUser, HttpError } from "@/lib/auth";
import { getForm } from "@/lib/forms";
import FormClient from "@/components/form-client";
import { surveyClosed } from "@/lib/survey";
import { one } from "@/lib/db";
export const dynamic = "force-dynamic";
export default async function FormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const t = await serverT();
  const { token } = await params;
  try {
    const form = getForm(token, await currentUser());
    const survey = form.config.survey?.enabled ? form.config.survey : null;
    const state = survey ? surveyClosed(survey, one<{ n: number }>("SELECT count(*) n FROM form_submissions WHERE form_token=?", token)?.n || 0) : null;
    return (
      <FormClient
        closed={state === "full" ? t("Diese Umfrage hat genug Antworten – danke für dein Interesse.", "This survey has enough answers – thank you for your interest.") : state ? t("Diese Umfrage ist geschlossen.", "This survey is closed.") : ""}
        token={token}
        config={form.config}
        title={form.title}
        fields={form.fields}
        anonymous={!!form.anonymous}
        internal={!!form.internal}
        members={form.members}
        related={form.related}
      />
    );
  } catch (e) {
    return (
      <main className="public-page">
        <a className="public-brand" href="/">
          flowplan
        </a>
        <h1>{t("Formular", "Form")}</h1>
        <p>
          {e instanceof HttpError
            ? e.message
            : t("Formular konnte nicht geladen werden.", "The form could not be loaded.")}
        </p>
        {e instanceof HttpError && e.status === 401 && (
          <a className="button primary" href="/api/auth/login">
            {t("Mit SSO anmelden", "Sign in with SSO")}
          </a>
        )}
      </main>
    );
  }
}
