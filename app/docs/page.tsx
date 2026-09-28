import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { docGroupsFor, loadDoc } from "@/lib/docs";
import { currentUser } from "@/lib/auth";
import s from "@/components/docs/docs.module.css";


const intros: Record<string, string> = {
  Einstieg: "Konto, erster Arbeitsbereich, Seitenbaum.",
  "Betrieb der Instanz": "Nur für Admins: Administration, Installation, Anmeldung und Sicherung.",
  "Arbeiten mit Flowplan": "Jede Funktion, Schritt für Schritt.",
  Verwaltung: "Mitglieder, Rechte und die Instanz.",
};

export default async function DocsHome() {
  const admin = !!(await currentUser().catch(() => null))?.isAdmin;
  return (
    <main className={s.main} id="inhalt">
      <article className={s.article}>
        <p className={s.eyebrow}>Dokumentation</p>
        <h1 className={s.title}>Flowplan Schritt für Schritt.</h1>
        <p className={s.lead}>
          Flowplan ist ein Arbeitsbereich für Dokumente, Datenbanken,
          Whiteboards und ein tägliches Journal – betrieben in Deutschland.
          Diese Dokumentation erklärt jede Funktion der Oberfläche.
        </p>
        <div className={s.paths}>
          {admin && (
            <a href="/docs/administration" className={s.path}>
              <span>Ich verwalte die Instanz</span>
              <strong>Administration der Instanz</strong>
              <small>Konten, Speicher, Sicherungen und Betrieb.</small>
              <ArrowRight size={18} />
            </a>
          )}
          <a href="/docs/erste-schritte" className={s.path}>
            <span>Ich arbeite mit Flowplan</span>
            <strong>Erste Schritte</strong>
            <small>Anmelden, erste Seite, Seitenbaum und Suche.</small>
            <ArrowRight size={18} />
          </a>
        </div>
        {docGroupsFor(admin).map((group) => (
          <section key={group.title} className={s.groupBlock}>
            <h2>{group.title}</h2>
            <p className={s.groupIntro}>{intros[group.title]}</p>
            <ul className={s.cards}>
              {group.pages.map((page) => {
                const doc = loadDoc(page.slug, admin)!;
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
