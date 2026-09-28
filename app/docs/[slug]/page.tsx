import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminDocSlugs, docSlugs, loadDoc } from "@/lib/docs";
import { currentUser } from "@/lib/auth";
import s from "@/components/docs/docs.module.css";

export const dynamicParams = false;
export function generateStaticParams() {
  return docSlugs.map((slug) => ({ slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const slug = (await params).slug;
  if (adminDocSlugs.has(slug) && !(await currentUser().catch(() => null))?.isAdmin) return {};
  const doc = loadDoc(slug);
  return doc ? { title: doc.title, description: doc.summary } : {};
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const admin = !!(await currentUser().catch(() => null))?.isAdmin;
  // Running the instance: not public.
  if (adminDocSlugs.has(slug) && !admin) notFound();
  const doc = loadDoc(slug, admin);
  if (!doc) notFound();
  return (
    <main className={s.main} id="inhalt">
      <article className={s.article}>
        <p className={s.eyebrow}>{doc.group}</p>
        <h1 className={s.title}>{doc.title}</h1>
        <p className={s.lead} dangerouslySetInnerHTML={{ __html: doc.leadHtml }} />
        <div className={s.prose} dangerouslySetInnerHTML={{ __html: doc.html }} />
        <nav className={s.pager} aria-label="Weiterlesen">
          {doc.prev ? (
            <a href={`/docs/${doc.prev.slug}`} data-dir="prev">
              <small>Zurück</small>
              {doc.prev.title}
            </a>
          ) : (
            <span />
          )}
          {doc.next && (
            <a href={`/docs/${doc.next.slug}`} data-dir="next">
              <small>Weiter</small>
              {doc.next.title}
            </a>
          )}
        </nav>
      </article>
      {doc.toc.length > 2 && (
        <aside className={s.toc} aria-label="Auf dieser Seite">
          <p>Auf dieser Seite</p>
          <ol>
            {doc.toc.map((entry) => (
              <li key={entry.id} data-depth={entry.depth}>
                <a href={`#${entry.id}`}>{entry.text}</a>
              </li>
            ))}
          </ol>
        </aside>
      )}
    </main>
  );
}
