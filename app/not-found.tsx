import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { serverT } from "@/lib/i18n-server";

// Shown for unknown addresses and whenever a page calls notFound(), e.g. a
// published page that is no longer public.
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await serverT())("Seite nicht gefunden · Flowplan", "Page not found · Flowplan"),
    robots: { index: false, follow: false },
  };
}

export default async function NotFound() {
  const t = await serverT();
  return (
    <main className="not-found">
      <a className="not-found-brand" href="/">
        <BrandMark size={22} /> flowplan
      </a>
      <section className="not-found-body" aria-labelledby="not-found-title">
        <p className="not-found-code" aria-hidden="true">
          404<span>.</span>
        </p>
        <h1 id="not-found-title">{t("Diese Seite gibt es hier nicht.", "This page doesn't exist here.")}</h1>
        <p className="not-found-lead">
          {t("Der Link führt ins Leere. Meist hat einer dieser Gründe:", "The link leads nowhere. Usually for one of these reasons:")}
        </p>
        <ul className="not-found-reasons">
          <li>
            <strong>{t("Nicht mehr öffentlich.", "No longer public.")}</strong>{" "}
            {t("Die Seite wurde nicht mehr geteilt oder der Link zurückgezogen.", "The page is no longer shared or the link was withdrawn.")}
          </li>
          <li>
            <strong>{t("Gelöscht oder verschoben.", "Deleted or moved.")}</strong>{" "}
            {t("Die Seite liegt im Papierkorb oder hat eine neue Adresse.", "The page is in the trash or has a new address.")}
          </li>
          <li>
            <strong>{t("Tippfehler.", "Typo.")}</strong>{" "}
            {t("Die Adresse ist unvollständig oder falsch kopiert.", "The address is incomplete or copied wrongly.")}
          </li>
        </ul>
        <p className="not-found-hint">
          {t(
            "Gehört die Seite zu deinem Arbeitsbereich? Nach der Anmeldung findest du sie über die Suche – sofern du sie sehen darfst.",
            "Does the page belong to your workspace? After signing in, find it with the search – if you may see it.",
          )}
        </p>
        <div className="not-found-actions">
          <a className="button primary" href="/">
            {t("Zur Startseite", "Go to the start page")}
          </a>
          <a className="button" href="/login">
            {t("Anmelden", "Sign in")}
          </a>
        </div>
      </section>
    </main>
  );
}
