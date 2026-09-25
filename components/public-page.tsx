import { imageFileId } from "@/lib/page-appearance";
import { ReadOnlyDocument } from "./read-only-document";
import { rowOrderRanks } from "@/lib/row-order";
import { PageIcon } from "./ui";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { database, rows } from "@/lib/api";
import { publicPage, publishedHtml, publicFile } from "@/lib/publication";
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
import { sharedContent, publicFieldsOf } from "@/lib/shared-content";
import { SharedInteractions } from "./shared-interactions";
import {
  PublicCalendar,
  PublicChart,
  PublicTimeline,
  publicLayout,
  publicMonth,
} from "./public-views";

export function PublishedPage({
  token,
  pageId,
  rowId,
  viewId,
  month: monthParam,
}: {
  token: string;
  pageId?: string;
  rowId?: string;
  viewId?: string;
  month?: string;
}) {
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
          "SELECT published_at,allow_copy FROM publications WHERE page_id=?",
          root.id,
        )
      : undefined;
  const date = (value: string | null | undefined) =>
    value
      ? new Date(value.replace(" ", "T") + "Z").toLocaleDateString("de-DE", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "";
  const href = (id: string) =>
    `/share/${token}${id === root.id ? "" : "/" + id}`;
  const children = pages.filter((p) => p.parent_id === page.id);
  return (
    <main className={`public-page ${page.full_width ? "public-wide" : ""}`}>
      <a href="/" className="public-brand">
        flowplan <span className="muted">/ Geteilte Seite</span>
      </a>
      {publication && (
        <div className="publication-meta">
          <span className="muted">
            {publication.published_at &&
              `Veröffentlicht am ${date(publication.published_at)} · `}
            Zuletzt geändert am {date(page.updated_at)}
          </span>
          {!!publication.allow_copy && <PublicationCopy token={token} />}
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
          {record && " / Eintrag"}
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
              alt="Seiten-Cover"
              style={{ objectPosition: `50% ${page.cover_position ?? 50}%` }}
            />
          )}
        </div>
      )}
      {!record && <PageIcon name={iconUrl} size={40} />}
      <h1>{record ? cellText(record.cells["title"]) : page.title}</h1>
      {d && !record && publicViews.length > 1 && (
        <nav className="public-views" aria-label="Ansichten">
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
      {d && !record && activeView?.type === "calendar" ? (
        <PublicCalendar
          records={records}
          fields={d.fields}
          view={activeView}
          month={month}
          monthLink={(m) =>
            `${href(page.id)}?view=${encodeURIComponent(activeView.id)}&month=${m}`
          }
          recordLink={(r) => `${href(page.id)}?row=${r.id}`}
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
                  {cellText(r.cells[d.fields[0]?.id]) || "Ohne Titel"}
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
              <span>{cellText(r.cells[d.fields[0]?.id]) || "Ohne Titel"}</span>
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
                          {cellText(r.cells[f.id]) || "Ohne Titel"}
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
          {record && (
            <dl className="public-properties">
              {visible
                ?.filter((f) => f.id !== "title")
                .map((f) => (
                  <div key={f.id}>
                    <dt>{f.name}</dt>
                    <dd>{displayText(f, record.cells[f.id], "UTC") || "—"}</dd>
                  </div>
                ))}
            </dl>
          )}
          <ReadOnlyDocument
            className={`font-${page.font}`}
            html={withPublicEmbeds(
              publishedHtml(html, token, pages),
              html,
              token,
              pages,
            )}
          />
        </>
      )}
      {!record && children.length > 0 && (
        <nav className="public-children" aria-label="Unterseiten">
          <h2>Unterseiten</h2>
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
      <footer className="home-footnote">Mit Flowplan veröffentlicht</footer>
    </main>
  );
}
function PublicBoard({
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
  const field = groupingField(fields, view);
  // Groups by people or relations would reveal hidden data.
  const groups =
    field && visible.some((f) => f.id === field.id)
      ? configuredGroups(databaseGroups(records, field, {}), view)
      : [{ key: "all", label: "Alle Einträge", value: null, rows: records }];
  return (
    <div className="board public-board">
      {groups.map((g) => (
        <section
          className="board-column"
          key={g.key}
          aria-label={`Gruppe ${g.label}`}
        >
          <header>
            <span className="tag tag-gray">{g.label}</span>
            <span className="muted">{g.rows.length}</span>
          </header>
          {g.rows.map((r) => (
            <a key={r.id} className="record-card" href={link(r)}>
              <strong>
                {cellText(r.cells[fields[0]?.id]) || "Ohne Titel"}
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
