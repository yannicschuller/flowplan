// A single shared or published record (#231, lib/record-share.ts): its
// cover, icon, title, the properties chosen for visitors and its document –
// no database, no views, no other records. The path above starts at the
// record itself; links inside its document to other pages and records are
// removed (publishedHtml with the share's pages, none yet).
import { coloredChoices } from "./option-chips";
import { requestLocale, serverT } from "@/lib/i18n-server";
import { localeTag } from "@/lib/i18n";
import { imageFileId } from "@/lib/page-appearance";
import { ReadOnlyDocument } from "./read-only-document";
import { PublicOutline } from "./document-outline";
import { PageIcon } from "./ui";
import { publicFile, publishedHtml, publishedLinkPages } from "@/lib/publication";
import { recordHtml, recordReferenceNames, recordSharePages, recordTitle, type RecordScope } from "@/lib/record-share";
import { publicHiddenFieldIds, stripCells } from "@/lib/field-access";
import { computedCells } from "@/lib/database";
import { displayText } from "@/lib/field-format";
import { isFormattedText } from "@/lib/inline-markdown";
import { fileIdOf, fileUrls } from "@/lib/file-cells";
import { publicPluginIds } from "@/lib/plugins";
import { cleanHtml } from "@/lib/document-server";
import { workspaceLook } from "@/lib/workspace-fonts";
import { one } from "@/lib/db";
import { sharedContent } from "@/lib/shared-content";
import { mapAsync } from "@/lib/each-async";
import { InlineText } from "./inline-text";
import { WorkspaceThemeStyle } from "./workspace-theme-style";
import { SharedInteractions } from "./shared-interactions";
import type { Field, Row } from "@/lib/types";

const empty = (value: unknown) =>
  value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);

// Called (not rendered as a component) inside withShareCookie(), like
// renderPublishedPage: every check below needs the link's unlock cookie,
// which lives in the request's async context.
export async function renderPublicRecord(scope: RecordScope) {
  const t = await serverT();
  const { token, page, row } = scope;
  // Images only through this share, and only the record's own.
  const shareImage = async (value: string | undefined) => {
    const fid = imageFileId(value || "");
    if (!fid) return undefined;
    try {
      await publicFile(token, fid);
      return `/api/share/${token}/files/${fid}`;
    } catch {
      return undefined;
    }
  };
  const iconUrl = imageFileId(row.icon || "") ? (await shareImage(row.icon)) || "" : row.icon || "";
  const coverColor = /^#[a-f\d]{3,8}$/i.test(row.cover || "") ? row.cover : undefined;
  const coverUrl = coverColor ? undefined : await shareImage(row.cover);
  const title = recordTitle(scope) || t("Ohne Titel", "Untitled");
  // Formulas see the record's public cells; visitors see only the chosen ones.
  const base = stripCells(JSON.parse(row.cells || "{}"), publicHiddenFieldIds(scope.fields)) as Record<string, unknown>;
  const values = computedCells({ ...(row as unknown as Row), cells: base }, scope.fields);
  const names = await recordReferenceNames(scope);
  const shown = scope.shown.filter((f) =>
    f.type === "relation" ? !!names.relations[f.id]?.length : ["person", "created_by", "updated_by"].includes(f.type) ? !!names.people[f.id]?.length : !empty(values[f.id]),
  );
  const pages = await recordSharePages(scope);
  const children = pages.filter((p) => p.parent_id === page.id && p.parent_row_id === row.id);
  // Links to the included sub-pages show their icons (#96).
  const linkPages = await publishedLinkPages(token, pages);
  const html = await recordHtml(scope);
  const shownPlugins = await publicPluginIds(page.workspace_id);
  const withPlugins = (value: string) =>
    value.includes("data-plugin")
      ? cleanHtml(value, (tagName, attribs) => {
          if (!attribs["data-plugin"] || shownPlugins.has(attribs["data-plugin"])) return { tagName, attribs };
          const attrs = { ...attribs };
          for (const key of ["data-plugin", "data-plugin-type", "data-plugin-data"]) delete attrs[key];
          return { tagName, attribs: attrs };
        })
      : value;
  const tag = localeTag(await requestLocale());
  const date = (value: number | string | null | undefined) =>
    value
      ? new Date(typeof value === "number" ? value : value.replace(" ", "T") + "Z").toLocaleDateString(tag, {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "";
  return (
    <main className={`public-page public-record ${page.full_width ? "public-wide" : ""}`}>
      <WorkspaceThemeStyle look={await workspaceLook(page.workspace_id)} fontUrl={(id) => `/api/share/${token}/fonts/${id}`} />
      <a href="/" className="public-brand">
        flowplan{" "}
        <span className="muted">
          / {scope.publication ? t("Veröffentlichter Eintrag", "Published record") : t("Geteilter Eintrag", "Shared record")}
        </span>
      </a>
      {scope.publication && (
        <div className="publication-meta">
          <span className="muted">
            {t(`Veröffentlicht am ${date(scope.share.created_at)} · `, `Published on ${date(scope.share.created_at)} · `)}
            {t("Zuletzt geändert am", "Last changed on")} {date(row.updated_at)}
          </span>
        </div>
      )}
      {/* The path starts at the shared record (its sub-pages follow it). */}
      <nav className="public-breadcrumb" aria-label={t("Pfad", "Path")}>
        <a href={`/share/${token}`} aria-current="page">
          {title}
        </a>
      </nav>
      {row.cover && (coverColor || coverUrl) && (
        <div className="public-cover" style={{ backgroundColor: coverColor }}>
          {coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt={t("Cover des Eintrags", "Record cover")} />
          )}
        </div>
      )}
      {iconUrl && <PageIcon name={iconUrl} size={40} />}
      <h1>{title}</h1>
      {shown.length > 0 && (
        <dl className="public-properties">
          {await mapAsync(shown, async (f) => (
            <div key={f.id}>
              <dt>{f.name}</dt>
              <dd>
                {f.type === "relation" ? (
                  <span className="public-relations">{names.relations[f.id].map((name, i) => <span key={i}>{name}</span>)}</span>
                ) : ["person", "created_by", "updated_by"].includes(f.type) ? (
                  names.people[f.id].join(", ")
                ) : f.type === "files" ? (
                  await recordFiles(values[f.id], token, page.id)
                ) : f.type === "checkbox" ? (
                  t("Ja", "Yes")
                ) : (
                  propertyValue(f, values[f.id], scope.fields)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <PublicOutline />
      <ReadOnlyDocument
        className={`font-${page.font}`}
        shareToken={token}
        linkPages={linkPages}
        title={title}
        html={withPlugins(await publishedHtml(html, token, pages))}
      />
      {/* Its sub-pages, when the share includes them (#231). */}
      {children.length > 0 && (
        <nav className="public-children" aria-label={t("Unterseiten", "Sub-pages")}>
          <h2>{t("Unterseiten", "Sub-pages")}</h2>
          {children.map((p) => (
            <a key={p.id} href={`/share/${token}/${p.id}`}>
              <PageIcon name={linkPages.find((l) => l.id === p.id)?.icon || "file"} /> {p.title}
              <span>→</span>
            </a>
          ))}
        </nav>
      )}
      {/* A publication only reads: no permission line, no guest comments. */}
      {!scope.publication && <SharedInteractions key={row.id} token={token} initial={await sharedContent(token, page.id, row.id)} />}
      <footer className="home-footnote">{t("Mit Flowplan geteilt", "Shared with Flowplan")}</footer>
    </main>
  );
}
function propertyValue(f: Field, value: unknown, fields: Field[]) {
  const chips = coloredChoices(f, value);
  if (chips) return chips;
  if (!isFormattedText(f, fields)) return displayText(f, value, "UTC");
  if (typeof value !== "string" || !value.trim()) return "";
  return <InlineText value={value} links oneLine={false} />;
}
// The record's files through the share; web links stay external.
async function recordFiles(value: unknown, token: string, pageId: string) {
  return (
    <span className="public-relations">
      {await mapAsync(fileUrls(value), async (url) => {
        const fid = fileIdOf(url);
        if (!fid)
          return (
            <a key={url} href={url} rel="noopener noreferrer" target="_blank">
              {url}
            </a>
          );
        const file = await one<{ name: string }>("SELECT name FROM files WHERE id=? AND page_id=?", fid, pageId);
        try {
          await publicFile(token, fid);
        } catch {
          return null;
        }
        return file ? (
          <a key={url} href={`/api/share/${token}/files/${fid}`}>
            {file.name}
          </a>
        ) : null;
      })}
    </span>
  );
}
