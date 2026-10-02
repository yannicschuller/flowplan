import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { DocsNav, DocsSearch } from "@/components/docs/docs-nav";
import { docGroups, docSearchIndex } from "@/lib/docs";
import { requestLocale } from "@/lib/i18n-server";
import { translate } from "@/lib/i18n";
import { LanguageSwitch } from "@/components/i18n";
import s from "@/components/docs/docs.module.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = translate(await requestLocale());
  return {
    title: {
      template: t("%s · Flowplan-Dokumentation", "%s · Flowplan documentation"),
      default: t("Dokumentation · Flowplan", "Documentation · Flowplan"),
    },
    description: t(
      "Alle Funktionen von Flowplan erklärt: Dokumente, Datenbanken, Whiteboards, Journal und Zusammenarbeit.",
      "Every feature of Flowplan explained: documents, databases, whiteboards, journal and collaboration.",
    ),
  };
}

// Public documentation: readable without an account, same paper and ink as
// the start page, calmer (DESIGN.md).
export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const locale = await requestLocale();
  const t = translate(locale);
  const index = docSearchIndex(locale);
  return (
    <div className={s.root}>
      <header className={s.header}>
        <a href="/" className={s.brand} aria-label={t("Flowplan, zur Startseite", "Flowplan, to the start page")}>
          <BrandMark size={26} />
          <span>flowplan</span>
        </a>
        <a href="/docs" className={s.section}>
          {t("Dokumentation", "Documentation")}
        </a>
        <DocsSearch index={index} />
        <LanguageSwitch className={s.lang} />
        <a href="/" className={s.back}>
          {t("Zur Startseite", "Start page")}
        </a>
      </header>
      <div className={s.shell}>
        <DocsNav groups={docGroups(locale)} />
        {children}
      </div>
    </div>
  );
}
