import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { DocsNav, DocsSearch } from "@/components/docs/docs-nav";
import { docGroups, docSearchIndex } from "@/lib/docs";
import s from "@/components/docs/docs.module.css";

export const metadata: Metadata = {
  title: { template: "%s · Flowplan-Dokumentation", default: "Dokumentation · Flowplan" },
  description: "Flowplan selbst betreiben und benutzen: Installation, Anmeldung, Speicher und alle Funktionen.",
};

// Public documentation: readable without an account, same paper and ink as
// the start page, calmer (DESIGN.md).
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const index = docSearchIndex();
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
        <DocsNav groups={docGroups} />
        {children}
      </div>
    </div>
  );
}
