import type { Metadata } from "next";
import { serverT, requestLocale } from "@/lib/i18n-server";
import { HttpError } from "@/lib/auth";
import { withContentLocale } from "@/lib/content-locale";
import { customerTicket } from "@/lib/service-desk";
import TicketClient from "@/components/ticket-client";
export const dynamic = "force-dynamic";
// The link is private: no indexing, no referrer to other sites.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function TicketPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const locale = await requestLocale();
  const { token } = await params;
  try {
    const ticket = withContentLocale(locale, () => customerTicket(token));
    return <TicketClient token={token} initial={ticket} />;
  } catch (e) {
    return (
      <main className="public-page">
        <a className="public-brand" href="/">
          flowplan
        </a>
        <h1>{t("Anfrage", "Request")}</h1>
        <p>
          {e instanceof HttpError && e.status === 404
            ? t(
                "Diese Anfrage gibt es nicht oder nicht mehr. Prüfe den Link aus deiner E-Mail.",
                "This request does not exist or no longer exists. Check the link from your e-mail.",
              )
            : t("Die Anfrage konnte nicht geladen werden.", "The request could not be loaded.")}
        </p>
      </main>
    );
  }
}
