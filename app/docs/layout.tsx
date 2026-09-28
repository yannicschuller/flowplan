import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { DocsNav, DocsSearch } from "@/components/docs/docs-nav";
import { docGroupsFor, docSearchIndex } from "@/lib/docs";
import { currentUser } from "@/lib/auth";
import s from "@/components/docs/docs.module.css";

export const metadata: Metadata = {
  title: { template: "%s · Flowplan-Dokumentation", default: "Dokumentation · Flowplan" },
  description: "Alle Funktionen von Flowplan erklärt: Dokumente, Datenbanken, Whiteboards, Journal und Zusammenarbeit.",
};

// Public documentation: readable without an account, same paper and ink as
// the start page, calmer (DESIGN.md).
export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  // Pages about running the instance are for administrators only.
  const admin = !!(await currentUser().catch(() => null))?.isAdmin;
  const index = docSearchIndex(admin);
  return (
    <div className={s.root}>
      <header className={s.header}>
        <a href="/" className={s.brand} aria-label="Flowplan, zur Startseite">
          <BrandMark size={26} />
          <span>flowplan</span>
        </a>
        <a href="/docs" className={s.section}>
          Dokumentation
        </a>
        <DocsSearch index={index} />
        <a href="/" className={s.back}>
          Zur Startseite
        </a>
      </header>
      <div className={s.shell}>
        <DocsNav groups={docGroupsFor(admin)} />
        {children}
      </div>
    </div>
  );
}
