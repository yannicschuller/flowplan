import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { docGroups, loadDoc } from "@/lib/docs";
import s from "@/components/docs/docs.module.css";

export const dynamic = "force-static";

const intros: Record<string, string> = {
  Einstieg: "Konto, erster Arbeitsbereich, Seitenbaum.",
  "Selbst hosten": "Vom Container bis zur laufenden Sicherung.",
  "Arbeiten mit Flowplan": "Jede Funktion, Schritt für Schritt.",
  Verwaltung: "Mitglieder, Rechte und die Instanz.",
};

export default function DocsHome() {
  return (
    <main className={s.main} id="inhalt">
      <article className={s.article}>
        <p className={s.eyebrow}>Dokumentation</p>
        <h1 className={s.title}>Flowplan betreiben und benutzen.</h1>
        <p className={s.lead}>
          Flowplan ist ein selbst gehosteter Arbeitsbereich für Dokumente,
          Datenbanken, Whiteboards und ein tägliches Journal. Diese
          Dokumentation führt von der Installation auf dem eigenen Server bis
          zu jeder Funktion der Oberfläche.
        </p>
        <div className={s.paths}>
          <a href="/docs/installation" className={s.path}>
            <span>Ich betreibe Flowplan</span>
            <strong>Installation mit Docker</strong>
            <small>Container starten, Anmeldung einrichten, Daten sichern.</small>
            <ArrowRight size={18} />
          </a>
          <a href="/docs/erste-schritte" className={s.path}>
            <span>Ich arbeite mit Flowplan</span>
            <strong>Erste Schritte</strong>
            <small>Anmelden, erste Seite, Seitenbaum und Suche.</small>
            <ArrowRight size={18} />
          </a>
        </div>
        {docGroups.map((group) => (
          <section key={group.title} className={s.groupBlock}>
            <h2>{group.title}</h2>
            <p className={s.groupIntro}>{intros[group.title]}</p>
            <ul className={s.cards}>
              {group.pages.map((page) => {
                const doc = loadDoc(page.slug)!;
                return (
                  <li key={page.slug}>
                    <a href={`/docs/${page.slug}`}>
                      <strong>{doc.title}</strong>
                      <span>{doc.summary}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </article>
    </main>
  );
}
