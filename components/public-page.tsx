import { imageFileId } from "@/lib/page-appearance";
import { ReadOnlyDocument } from "./read-only-document";
import { rowOrderRanks } from "@/lib/row-order";
import { PageIcon } from "./ui";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { database, rows } from "@/lib/api";
import { publicPage, publishedHtml, publicFile } from "@/lib/publication";
import { cellText, computedCells } from "@/lib/database";
import { HttpError } from "@/lib/auth";
import type { Row } from "@/lib/types";
import { sharedContent, publicField } from "@/lib/shared-content";
import { SharedInteractions } from "./shared-interactions";

export function PublishedPage({
  token,
  pageId,
  rowId,
}: {
  token: string;
  pageId?: string;
  rowId?: string;
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
  const visible = d?.fields.filter(publicField);
  const ranks = rowOrderRanks(d?.views[0]?.rowOrder);
  const records = d
    ? rows(page.id).sort(
        (a, b) =>
          (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) ||
          a.position - b.position,
      )
    : [];
  const record = rowId && d ? records.find((r) => r.id === rowId) : null;
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
  const href = (id: string) =>
    `/share/${token}${id === root.id ? "" : "/" + id}`;
  const children = pages.filter((p) => p.parent_id === page.id);
  return (
    <main className={`public-page ${page.full_width ? "public-wide" : ""}`}>
      <a href="/" className="public-brand">
        flowplan <span className="muted">/ Geteilte Seite</span>
      </a>
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
      {d && !record ? (
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
                        cellText(computedCells(r, d.fields)[f.id])
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
                    <dd>{cellText(record.cells[f.id]) || "—"}</dd>
                  </div>
                ))}
            </dl>
          )}
          <ReadOnlyDocument
            className={`font-${page.font}`}
            html={publishedHtml(html, token, pages)}
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
        token={token}
        initial={sharedContent(token, page.id, rowId)}
      />
      <footer className="home-footnote">Mit Flowplan veröffentlicht</footer>
    </main>
  );
}
