import { PublicOutline } from "./document-outline";
import { requestLocale, serverT } from "@/lib/i18n-server";
import { localeTag } from "@/lib/i18n";
import { imageFileId } from "@/lib/page-appearance";
import { ReadOnlyDocument } from "./read-only-document";
import { WhiteboardStatic } from "./whiteboard/render";
import { PublicNotebook } from "./notebook/public-notebook";
import { publicNotebookSheets, withInkPictures } from "@/lib/ink-export";
import { whiteboardSnapshotItems } from "@/lib/whiteboard";
import { rowOrderRanks } from "@/lib/row-order";
import { PageIcon } from "./ui";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { SHARE_COOKIE, shareState, withShareCookie } from "@/lib/share-access";
import { SharePasswordForm } from "./share-password-form";
import { one } from "@/lib/db";
import { database, publicRows as rows } from "@/lib/api";
import { publicPage, publishedHtml, publicFile } from "@/lib/publication";
import { renderedTheme } from "@/lib/custom-domains";
import { publicPluginIds } from "@/lib/plugins";
import { cleanHtml } from "@/lib/document-server";
import { withPublicEmbeds } from "@/lib/public-embeds";
import { cellText, computedCells, queryRows } from "@/lib/database";
import { documentPreview } from "@/lib/document-preview";
import {
  configuredGroups,
  databaseGroups,
  groupingField,
} from "@/lib/database-groups";
import { displayText } from "@/lib/field-format";
import { PublicationCopy } from "./publication-copy";
import { HttpError } from "@/lib/auth";
import type { Field, Row, View } from "@/lib/types";
import {
  guestFields,
  sharedContent,
  publicFieldsOf,
} from "@/lib/shared-content";
import { fileIdOf, fileUrls } from "@/lib/file-cells";
import { SharedInteractions } from "./shared-interactions";
import {
  PublicCalendar,
  PublicChart,
  PublicTimeline,
  publicLayout,
  publicMonth,
} from "./public-views";

type PublishedPageProps = {
  token: string;
  // The verified custom domain the page is served under (lib/custom-domains.ts):
  // short addresses, no copying into a workspace.
  customHost?: string | null;
  pageId?: string;
  rowId?: string;
  viewId?: string;
  month?: string;
};
// A link with an end date or a password (lib/share-access.ts): after its end
// a short note, without the unlock cookie the password form. Everything
// else is rendered with the cookie in hand, so every check sees it.
export async function PublishedPage(props: PublishedPageProps) {
  const unlock = (await cookies()).get(SHARE_COOKIE)?.value;
  const state = shareState(props.token, unlock);
  if (state === "missing") notFound();
  if (state !== "open") {
    const t = await serverT();
    return (
      <main className="public-page share-gate">
        <a href="/" className="public-brand">
          flowplan <span className="muted">/ {t("Geteilte Seite", "Shared page")}</span>
        </a>
        <section className="share-gate-card">
          {state === "expired" ? (
            <>
              <h1>{t("Link abgelaufen", "Link expired")}</h1>
              <p className="muted">
                {t("Dieser Link ist abgelaufen. Bitte frage die Person, die ihn geteilt hat, nach einem neuen.", "This link has expired. Please ask the person who shared it for a new one.")}
              </p>
            </>
          ) : (
            <>
              <h1>{t("Passwort erforderlich", "Password required")}</h1>
              <p className="muted">{t("Diese Seite ist mit einem Passwort geschützt.", "This page is protected with a password.")}</p>
              <SharePasswordForm token={props.token} />
            </>
          )}
        </section>
      </main>
    );
  }
  return withShareCookie(unlock, () => renderPublishedPage(props));
}
async function renderPublishedPage({
  token,
  customHost,
  pageId,
  rowId,
  viewId,
  month: monthParam,
}: PublishedPageProps) {
  const t = await serverT();
  let context;
  try {
    context = publicPage(token, pageId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const { page, root, pages } = context;
  const d = page.kind === "database" ? database(page.id) : null;
  const visible = d?.fields.filter(publicFieldsOf(d.fields));
  // Views are published with their filters, sorting and order when their
  // layout only needs public properties; forms are never listed.
  const publicViews = (d?.views || []).filter((v) =>
    publicLayout(v, d!.fields),
  );
  const month = publicMonth(monthParam);
  // Without a publishable view the first one is shown as a plain table.
  const activeView: View | undefined =
    publicViews.find((v) => v.id === viewId) ||
    publicViews[0] ||
    (d?.views[0] && { ...d.views[0], type: "table" });
  const ranks = rowOrderRanks(activeView?.rowOrder);
  const allRecords = d ? rows(page.id) : [];
  const records =
    d && activeView
      ? queryRows(
          allRecords.map((r) => ({ ...r, cells: computedCells(r, d.fields) })),
          d.fields,
          activeView,
        )
      : allRecords.sort(
          (a, b) =>
            (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) ||
            a.position - b.position,
        );
  // Images are shown only when the publication serves them.
  const publicImage = (url: unknown) => {
    const fid = typeof url === "string" ? imageFileId(url) : undefined;
    if (!fid) return undefined;
    try {
      publicFile(token, fid);
      return `/api/share/${token}/files/${fid}`;
    } catch {
      return undefined;
    }
  };
  const record = rowId && d ? allRecords.find((r) => r.id === rowId) : null;
  if (rowId && !record) notFound();
  const html = record
    ? String(
        one("SELECT html FROM row_documents WHERE row_id=?", record.id)?.html ||
          record.content ||
          "",
      )
    : String(
        one("SELECT html FROM documents WHERE page_id=?", page.id)?.html || "",
      );
  let iconUrl = page.icon;
  const iconId = imageFileId(page.icon);
  if (iconId) {
    try {
      publicFile(token, iconId);
      iconUrl = `/api/share/${token}/files/${iconId}`;
    } catch {
      iconUrl = "";
    }
  }
  let coverUrl: string | undefined;
  const coverId = imageFileId(page.cover);
  if (coverId) {
    try {
      publicFile(token, coverId);
      coverUrl = `/api/share/${token}/files/${coverId}`;
    } catch {}
  }
  // Only real publications (not private share links) show metadata and copying.
  const publication =
    root.public_token === token
      ? one<{ published_at: string | null; allow_copy: number }>(
          // Behind a password, a publication is not offered for copying.
          "SELECT published_at,allow_copy AND password_hash IS NULL allow_copy FROM publications WHERE page_id=?",
          root.id,
        )
      : undefined;
  const tag = localeTag(await requestLocale());
  const date = (value: string | null | undefined) =>
    value
      ? new Date(value.replace(" ", "T") + "Z").toLocaleDateString(tag, {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "";
  const href = (id: string) =>
    customHost ? `/${id === root.id ? "" : id}` : `/share/${token}${id === root.id ? "" : "/" + id}`;
  // The look an owner chose for the publication (logo, accent, footer).
  const theme = publication ? renderedTheme(token, root.id) : null;
  // Blocks of block extensions their owners did not allow on published
  // pages keep only their text.
  const shownPlugins = publicPluginIds(root.workspace_id);
  const withPlugins = (value: string) =>
    value.includes("data-plugin")
      ? cleanHtml(value, (tagName, attribs) => {
          if (!attribs["data-plugin"] || shownPlugins.has(attribs["data-plugin"])) return { tagName, attribs };
          const attrs = { ...attribs };
          for (const key of ["data-plugin", "data-plugin-type", "data-plugin-data"]) delete attrs[key];
          return { tagName, attribs: attrs };
        })
      : value;
  // Links inside the documents use the short addresses on a custom domain.
  const shortLinks = (value: string) =>
    customHost ? value.replaceAll(`"/share/${token}/`, '"/').replaceAll(`"/share/${token}"`, '"/"') : value;
  const children = pages.filter((p) => p.parent_id === page.id);
  return (
    <main
      className={`public-page ${page.full_width ? "public-wide" : ""} ${theme?.accent ? "public-themed" : ""}`}
      style={theme?.accent ? ({ "--blue": theme.accent, "--accent-strong": theme.accent } as React.CSSProperties) : undefined}
    >
      {theme?.logo ? (
        <a href={href(root.id)} className="public-brand public-logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={theme.logo} alt={root.title} />
        </a>
      ) : (
        <a href="/" className="public-brand">
          {customHost ? root.title : "flowplan"}{" "}
          {!customHost && <span className="muted">/ {t("Geteilte Seite", "Shared page")}</span>}
        </a>
      )}
      {publication && (
        <div className="publication-meta">
          <span className="muted">
            {publication.published_at &&
              t(`Veröffentlicht am ${date(publication.published_at)} · `, `Published on ${date(publication.published_at)} · `)}
            {t("Zuletzt geändert am", "Last changed on")}{" "}{date(page.updated_at)}
          </span>
          {!!publication.allow_copy && !customHost && <PublicationCopy token={token} />}
        </div>
      )}
      {(page.id !== root.id || record) && (
        <nav className="public-breadcrumb">
          <a href={href(root.id)}>{root.title}</a>
          {page.id !== root.id && (
            <>
              {" "}
              / <a href={href(page.id)}>{page.title}</a>
            </>
          )}
          {record && ` / ${t("Eintrag", "Record")}`}
        </nav>
      )}
      {page.cover && (
        <div
          className="public-cover"
          style={{
            backgroundColor: /^#[a-f\d]{3,8}$/i.test(page.cover)
              ? page.cover
              : undefined,
          }}
        >
          {coverUrl && (
            <img
              src={coverUrl}
              alt={t("Seiten-Cover", "Page cover")}
              style={{ objectPosition: `50% ${page.cover_position ?? 50}%` }}
            />
          )}
        </div>
      )}
      {!record && <PageIcon name={iconUrl} size={40} />}
      <h1>{record ? cellText(record.cells["title"]) : page.title}</h1>
      {d && !record && publicViews.length > 1 && (
        <nav className="public-views" aria-label={t("Ansichten", "Views")}>
          {publicViews.map((v) => (
            <a
              key={v.id}
              href={`${href(page.id)}?view=${encodeURIComponent(v.id)}`}
              aria-current={v.id === activeView?.id ? "page" : undefined}
            >
              {v.name}
            </a>
          ))}
        </nav>
      )}
      {page.kind === "notebook" ? (
        <PublicNotebook label={page.title} sheets={publicNotebookSheets(page, token)} />
      ) : page.kind === "whiteboard" ? (
        <WhiteboardStatic
          height={640}
          pages={pages.map((p) => ({ id: p.id, title: p.title, kind: p.kind }))}
          items={whiteboardSnapshotItems(page).map((item) => {
            // Images only through the share, and only if they are published.
            const file = /^\/api\/files\/([\w-]+)$/.exec(item.src || "");
            if (!file) return item;
            try {
              publicFile(token, file[1]);
              return { ...item, src: `/api/share/${token}/files/${file[1]}` };
            } catch {
              return { ...item, src: undefined };
            }
          })}
        />
      ) : d && !record && activeView?.type === "calendar" ? (
        <PublicCalendar
          records={records}
          fields={d.fields}
          view={activeView}
          month={month}
          monthLink={(m) =>
            `${href(page.id)}?view=${encodeURIComponent(activeView.id)}&month=${m}`
          }
          recordLink={(r) => `${href(page.id)}?row=${r.id}`}
          editable={context.role === "editor" && !page.locked}
          token={token}
          pageId={page.id}
        />
      ) : d && !record && activeView?.type === "timeline" ? (
        <PublicTimeline
          records={records}
          fields={d.fields}
          view={activeView}
          month={month}
          monthLink={(m) =>
            `${href(page.id)}?view=${encodeURIComponent(activeView.id)}&month=${m}`
          }
          recordLink={(r) => `${href(page.id)}?row=${r.id}`}
        />
      ) : d && !record && activeView?.type === "feed" ? (
        <div className="public-feed">
          {records.slice(0, 50).map((r) => {
            const body = String(
              one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", r.id)?.html || r.content || "",
            );
            return (
              <article key={r.id} className="public-feed-entry">
                <h2>
                  <a href={`${href(page.id)}?row=${r.id}`}>
                    {cellText(r.cells[d.fields[0]?.id]) || t("Ohne Titel", "Untitled")}
                  </a>
                </h2>
                <p className="public-feed-meta">
                  {(visible || [])
                    .filter((f) => f.id !== d.fields[0]?.id && r.cells[f.id] != null && r.cells[f.id] !== "")
                    .slice(0, 4)
                    .map((f) => (
                      <span key={f.id}>
                        {f.name}: {displayText(f, r.cells[f.id], "UTC")}
                      </span>
                    ))}
                </p>
                {body.trim() && (
                  <ReadOnlyDocument
                    html={withPublicEmbeds(publishedHtml(body, token, pages), body, token, pages)}
                  />
                )}
              </article>
            );
          })}
          {records.length > 50 && (
            <p className="muted">{records.length - 50} {t("weitere Einträge – in der Tabelle oder Liste zu sehen.", "more records – visible in the table or list.")}</p>
          )}
        </div>
      ) : d && !record && activeView?.type === "chart" ? (
        <PublicChart records={records} fields={d.fields} view={activeView} />
      ) : d && !record && activeView?.type === "board" ? (
        <PublicBoard
          records={records}
          fields={d.fields}
          view={activeView}
          visible={visible || []}
          link={(r) => `${href(page.id)}?row=${r.id}`}
        />
      ) : d && !record && activeView?.type === "gallery" ? (
        <div className="gallery gallery-size-medium public-gallery">
          {records.map((r) => {
            const image =
              publicImage(r.cover) ||
              publicImage(documentPreview(String(r.content || "")).image);
            return (
              <a
                key={r.id}
                className="record-card"
                href={`${href(page.id)}?row=${r.id}`}
              >
                {image && (
                  <span className="gallery-cover">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image} alt="" />
                  </span>
                )}
                <strong>
                  {cellText(r.cells[d.fields[0]?.id]) || t("Ohne Titel", "Untitled")}
                </strong>
                <span className="card-properties">
                  {(visible || [])
                    .filter(
                      (f) =>
                        f.id !== d.fields[0]?.id &&
                        r.cells[f.id] != null &&
                        r.cells[f.id] !== "",
                    )
                    .slice(0, 3)
                    .map((f) => (
                      <span key={f.id}>
                        {displayText(f, r.cells[f.id], "UTC")}
                      </span>
                    ))}
                </span>
              </a>
            );
          })}
        </div>
      ) : d && !record && activeView?.type === "list" ? (
        <div className="record-list public-list">
          {records.map((r) => (
            <a
              key={r.id}
              className="record-list-item"
              href={`${href(page.id)}?row=${r.id}`}
            >
              <span>{cellText(r.cells[d.fields[0]?.id]) || t("Ohne Titel", "Untitled")}</span>
              <span>
                {(visible || [])
                  .filter((f) => f.id !== d.fields[0]?.id)
                  .slice(0, 3)
                  .map((f) => (
                    <span key={f.id}>
                      {displayText(f, r.cells[f.id], "UTC")}
                    </span>
                  ))}
              </span>
            </a>
          ))}
        </div>
      ) : d && !record ? (
        <div className="data-table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {visible?.map((f) => (
                  <th key={f.id}>{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r: Row) => (
                <tr key={r.id}>
                  {visible?.map((f) => (
                    <td key={f.id}>
                      {f.id === "title" ? (
                        <a href={`${href(page.id)}?row=${r.id}`}>
                          {cellText(r.cells[f.id]) || t("Ohne Titel", "Untitled")}
                        </a>
                      ) : (
                        displayText(f, r.cells[f.id], "UTC")
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {record && d && (
            <dl className="public-properties">
              {guestFields(d.fields, pages)
                .filter((f) => f.id !== d.fields[0]?.id)
                .map((f) => (
                  <div key={f.id}>
                    <dt>{f.name}</dt>
                    <dd>
                      {f.type === "relation" ? (
                        <PublicRelation
                          ids={record.cells[f.id]}
                          target={f.relationPage!}
                          link={(pid, rid) => `${href(pid)}?row=${rid}`}
                        />
                      ) : f.type === "files" ? (
                        <PublicFiles
                          value={record.cells[f.id]}
                          token={token}
                          pageId={page.id}
                        />
                      ) : (
                        displayText(f, record.cells[f.id], "UTC") || "—"
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
            title={page.title}
            html={(record ? (value: string) => value : (value: string) => withInkPictures(value, page))(
              shortLinks(
                withPlugins(
                  withPublicEmbeds(
                    publishedHtml(html, token, pages),
                    html,
                    token,
                    pages,
                  ),
                ),
              ),
            )}
          />
        </>
      )}
      {!record && children.length > 0 && (
        <nav className="public-children" aria-label={t("Unterseiten", "Sub-pages")}>
          <h2>{t("Unterseiten", "Sub-pages")}</h2>
          {children.map((p) => (
            <a key={p.id} href={href(p.id)}>
              <PageIcon name={p.icon} /> {p.title}
              <span>→</span>
            </a>
          ))}
        </nav>
      )}
      <SharedInteractions
        key={`${page.id}:${rowId || ""}`}
        token={token}
        initial={sharedContent(token, page.id, rowId)}
      />
      {theme?.footer && <footer className="public-theme-footer">{theme.footer}</footer>}
      {!theme?.hideBranding && (
        <footer className="home-footnote">{t("Mit Flowplan veröffentlicht", "Published with Flowplan")}</footer>
      )}
    </main>
  );
}
async function PublicBoard({
  records,
  fields,
  view,
  visible,
  link,
}: {
  records: Row[];
  fields: Field[];
  view: View;
  visible: Field[];
  link: (row: Row) => string;
}) {
  const t = await serverT();
  const field = groupingField(fields, view);
  // Groups by people or relations would reveal hidden data.
  const groups =
    field && visible.some((f) => f.id === field.id)
      ? configuredGroups(databaseGroups(records, field, {}), view)
      : [{ key: "all", label: t("Alle Einträge", "All records"), value: null, rows: records }];
  return (
    <div className="board public-board">
      {groups.map((g) => (
        <section
          className="board-column"
          key={g.key}
          aria-label={t(`Gruppe ${g.label}`, `Group ${g.label}`)}
        >
          <header>
            <span className="tag tag-gray">{g.label}</span>
            <span className="muted">{g.rows.length}</span>
          </header>
          {g.rows.map((r) => (
            <a key={r.id} className="record-card" href={link(r)}>
              <strong>
                {cellText(r.cells[fields[0]?.id]) || t("Ohne Titel", "Untitled")}
              </strong>
              <span className="card-properties">
                {visible
                  .filter((f) => f.id !== fields[0]?.id && f.id !== field?.id)
                  .filter((f) => r.cells[f.id] != null && r.cells[f.id] !== "")
                  .slice(0, 3)
                  .map((f) => (
                    <span key={f.id}>
                      {displayText(f, r.cells[f.id], "UTC")}
                    </span>
                  ))}
              </span>
            </a>
          ))}
        </section>
      ))}
    </div>
  );
}

// Related records of a shared database, linked to their public pages.
async function PublicRelation({
  ids,
  target,
  link,
}: {
  ids: unknown;
  target: string;
  link: (pageId: string, rowId: string) => string;
}) {
  const t = await serverT();
  const list = Array.isArray(ids) ? (ids as string[]).slice(0, 50) : [];
  if (!list.length) return <>—</>;
  const fields = database(target).fields;
  const titles = new Map(
    rows(target).map((r) => [
      r.id,
      cellText(r.cells[fields[0]?.id]) || t("Ohne Titel", "Untitled"),
    ]),
  );
  return (
    <span className="public-relations">
      {list
        .filter((rid) => titles.has(rid))
        .map((rid) => (
          <a key={rid} href={link(target, rid)}>
            {titles.get(rid)}
          </a>
        ))}
    </span>
  );
}
// Files of a published record; external links stay external.
function PublicFiles({
  value,
  token,
  pageId,
}: {
  value: unknown;
  token: string;
  pageId: string;
}) {
  const urls = fileUrls(value);
  if (!urls.length) return <>—</>;
  return (
    <span className="public-relations">
      {urls.map((url) => {
        const fid = fileIdOf(url);
        if (!fid)
          return (
            <a key={url} href={url} rel="noopener noreferrer" target="_blank">
              {url}
            </a>
          );
        const file = one<{ name: string }>(
          "SELECT name FROM files WHERE id=? AND page_id=?",
          fid,
          pageId,
        );
        return file ? (
          <a key={url} href={`/api/share/${token}/files/${fid}`}>
            {file.name}
          </a>
        ) : null;
      })}
    </span>
  );
}
