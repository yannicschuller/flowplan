import { currentUser, HttpError } from "@/lib/auth";
import { getForm } from "@/lib/forms";
import FormClient from "@/components/form-client";
export const dynamic = "force-dynamic";
export default async function FormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  try {
    const form = getForm(token, await currentUser());
    return (
      <FormClient
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
        <h1>Formular</h1>
        <p>
          {e instanceof HttpError
            ? e.message
            : "Formular konnte nicht geladen werden."}
        </p>
        {e instanceof HttpError && e.status === 401 && (
          <a className="button primary" href="/api/auth/login">
            Mit SSO anmelden
          </a>
        )}
      </main>
    );
  }
}
