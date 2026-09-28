import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";

// Shown for unknown addresses and whenever a page calls notFound(), e.g. a
// published page that is no longer public.
export const metadata: Metadata = {
  title: "Seite nicht gefunden · Flowplan",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="not-found">
      <a className="not-found-brand" href="/">
        <BrandMark size={22} /> flowplan
      </a>
      <section className="not-found-body" aria-labelledby="not-found-title">
        <p className="not-found-code" aria-hidden="true">
          404<span>.</span>
        </p>
        <h1 id="not-found-title">Diese Seite gibt es hier nicht.</h1>
        <p className="not-found-lead">
          Der Link führt ins Leere. Meist hat einer dieser Gründe:
        </p>
        <ul className="not-found-reasons">
          <li>
            <strong>Nicht mehr öffentlich.</strong> Die Seite wurde nicht mehr
            geteilt oder der Link zurückgezogen.
          </li>
          <li>
            <strong>Gelöscht oder verschoben.</strong> Die Seite liegt im
            Papierkorb oder hat eine neue Adresse.
          </li>
          <li>
            <strong>Tippfehler.</strong> Die Adresse ist unvollständig oder
            falsch kopiert.
          </li>
        </ul>
        <p className="not-found-hint">
          Gehört die Seite zu deinem Arbeitsbereich? Nach der Anmeldung findest
          du sie über die Suche – sofern du sie sehen darfst.
        </p>
        <div className="not-found-actions">
          <a className="button primary" href="/">
            Zur Startseite
          </a>
          <a className="button" href="/login">
            Anmelden
          </a>
        </div>
      </section>
    </main>
  );
}
