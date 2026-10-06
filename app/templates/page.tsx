import { serverT } from "@/lib/i18n-server";
import { publicTemplates } from "@/lib/public-templates";
import { templateCategories } from "@/lib/template-categories";
import { PageIcon } from "@/components/ui";
import { catalogFor } from "@/lib/template-catalogs";
import { requestLocale } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = await serverT();
  return {
    title: t("Vorlagen · Flowplan", "Templates · Flowplan"),
    description: t(
      "Fertige Seiten und Datenbanken für Flowplan: Projektplanung, Meeting-Notizen, Team-Wiki, OKRs, Kontakte und mehr – ansehen ohne Konto, mit einem Klick übernehmen.",
      "Ready-made pages and databases for Flowplan: project plans, meeting notes, a team wiki, OKRs, contacts and more – view without an account, take over in one click.",
    ),
    alternates: { canonical: "/templates" },
    robots: { index: true, follow: true },
  };
}

// Public template gallery, readable without an account.
export default async function Templates({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const t = await serverT();
  const { category } = await searchParams;
  const active = category && category in templateCategories ? category : "";
  const list = publicTemplates(active || undefined);
  // Templates that come with Flowplan, then those admins published.
  const builtIn = Object.entries(catalogFor(await requestLocale())).filter(([, t]) => !active || t.category === active);
  return (
    <main className="public-page template-gallery-page">
      <a href="/" className="public-brand">
        flowplan <span className="muted">/ Vorlagen</span>
      </a>
      <h1>{t("Vorlagengalerie", "Template gallery")}</h1>
      <p className="muted">
        {t("Fertige Seiten und Datenbanken zum Übernehmen in deinen Arbeitsbereich.", "Ready-made pages and databases to take into your workspace.")}
      </p>
      <nav className="public-views" aria-label={t("Kategorien", "Categories")}>
        <a href="/templates" aria-current={!active ? "page" : undefined}>
          {t("Alle", "All")}
        </a>
        {Object.entries(templateCategories).map(([id, label]) => (
          <a
            key={id}
            href={`/templates?category=${id}`}
            aria-current={active === id ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="template-cards">
        {builtIn.map(([key, template]) => (
          <a key={key} className="template-card" href={`/templates/starter-${key}`}>
            <span className="template-emoji" aria-hidden="true">
              {template.icon}
            </span>
            <strong>{template.name}</strong>
            <small>{template.description}</small>
            <small className="muted">
              {template.kind === "database" ? t("Datenbank", "Database") : t("Dokument", "Document")} · {t(templateCategories[template.category])}
            </small>
          </a>
        ))}
        {list.map((template) => (
          <a key={template.id} className="template-card" href={`/templates/${template.id}`}>
            <PageIcon
              name={template.kind === "database" ? "table" : "file"}
              size={22}
            />
            <strong>{template.name}</strong>
            <small className="muted">
              {template.kind === "database" ? t("Datenbank", "Database") : t("Dokument", "Document")}
              {template.category &&
                ` · ${t(templateCategories[template.category as keyof typeof templateCategories] || "")}`}
            </small>
          </a>
        ))}

      </div>
      <footer className="home-footnote">{t("Mit Flowplan veröffentlicht", "Published with Flowplan")}</footer>
    </main>
  );
}
