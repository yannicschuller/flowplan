import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { docGroups, loadDoc } from "@/lib/docs";
import { requestLocale } from "@/lib/i18n-server";
import { translate } from "@/lib/i18n";
import s from "@/components/docs/docs.module.css";

// One line under each group, in the order of the groups.
const intros: [string, string][] = [
  ["Konto, erster Arbeitsbereich, Seitenbaum.", "Account, first workspace, page tree."],
  ["Jede Funktion, Schritt für Schritt.", "Every feature, step by step."],
  ["Mitglieder, Rechte und Arbeitsbereiche.", "Members, permissions and workspaces."],
  [
    "Flowplan auf dem eigenen Server: Docker, Anmeldung, Speicher, Sicherung und Betrieb.",
    "Flowplan on your own server: Docker, sign-in, storage, backups and operations.",
  ],
];

export default async function DocsHome() {
  const locale = await requestLocale();
  const t = translate(locale);
  return (
    <main className={s.main} id="inhalt">
      <article className={s.article}>
        <p className={s.eyebrow}>{t("Dokumentation", "Documentation")}</p>
        <h1 className={s.title}>{t("Flowplan Schritt für Schritt.", "Flowplan, step by step.")}</h1>
        <p className={s.lead}>
          {t(
            "Flowplan ist ein Arbeitsbereich für Dokumente, Datenbanken, Whiteboards und ein tägliches Journal – Open Source, gehostet in Deutschland oder auf deinem eigenen Server. Diese Dokumentation erklärt jede Funktion und den Betrieb einer eigenen Instanz.",
            "Flowplan is a workspace for documents, databases, whiteboards and a daily journal – open source, hosted in Germany or on your own server. This documentation explains every feature and how to run your own instance.",
          )}
        </p>
        <div className={s.paths}>
          <a href="/docs/erste-schritte" className={s.path}>
            <span>{t("Ich arbeite mit Flowplan", "I work with Flowplan")}</span>
            <strong>{t("Erste Schritte", "First steps")}</strong>
            <small>{t("Anmelden, erste Seite, Seitenbaum und Suche.", "Sign in, first page, page tree and search.")}</small>
            <ArrowRight size={18} />
          </a>
          <a href="/docs/installation" className={s.path}>
            <span>{t("Ich betreibe Flowplan selbst", "I run Flowplan myself")}</span>
            <strong>{t("Installation mit Docker", "Installation with Docker")}</strong>
            <small>{t("Container starten, Anmeldung, Speicher und Updates.", "Start the container, sign-in, storage and updates.")}</small>
            <ArrowRight size={18} />
          </a>
        </div>
        {docGroups(locale).map((group, i) => (
          <section key={group.title} className={s.groupBlock}>
            <h2>{group.title}</h2>
            <p className={s.groupIntro}>{t(...intros[i])}</p>
            <ul className={s.cards}>
              {group.pages.map((page) => {
                const doc = loadDoc(page.slug, locale)!;
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
