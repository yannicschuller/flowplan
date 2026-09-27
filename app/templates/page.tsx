import { publicTemplates } from "@/lib/public-templates";
import { templateCategories } from "@/lib/template-categories";
import { PageIcon } from "@/components/ui";
import { templateCatalog } from "@/lib/template-catalog";
export const dynamic = "force-dynamic";
export const metadata = { title: "Vorlagen · Flowplan" };

// Public template gallery, readable without an account.
export default async function Templates({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = category && category in templateCategories ? category : "";
  const list = publicTemplates(active || undefined);
  // Templates that come with Flowplan, then those admins published.
  const builtIn = Object.entries(templateCatalog).filter(([, t]) => !active || t.category === active);
  return (
    <main className="public-page template-gallery-page">
      <a href="/" className="public-brand">
        flowplan <span className="muted">/ Vorlagen</span>
      </a>
      <h1>Vorlagengalerie</h1>
      <p className="muted">
        Fertige Seiten und Datenbanken zum Übernehmen in deinen Arbeitsbereich.
      </p>
      <nav className="public-views" aria-label="Kategorien">
        <a href="/templates" aria-current={!active ? "page" : undefined}>
          Alle
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
        {builtIn.map(([key, t]) => (
          <a key={key} className="template-card" href={`/templates/starter-${key}`}>
            <span className="template-emoji" aria-hidden="true">
              {t.icon}
            </span>
            <strong>{t.name}</strong>
            <small>{t.description}</small>
            <small className="muted">
              {t.kind === "database" ? "Datenbank" : "Dokument"} · {templateCategories[t.category]}
            </small>
          </a>
        ))}
        {list.map((t) => (
          <a key={t.id} className="template-card" href={`/templates/${t.id}`}>
            <PageIcon
              name={t.kind === "database" ? "table" : "file"}
              size={22}
            />
            <strong>{t.name}</strong>
            <small className="muted">
              {t.kind === "database" ? "Datenbank" : "Dokument"}
              {t.category &&
                ` · ${templateCategories[t.category as keyof typeof templateCategories] || ""}`}
            </small>
          </a>
        ))}

      </div>
      <footer className="home-footnote">Mit Flowplan veröffentlicht</footer>
    </main>
  );
}
