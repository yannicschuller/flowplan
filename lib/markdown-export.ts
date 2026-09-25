import { visibleRows } from "./row-access";
import { fileUrls } from "./file-cells";
import { readFileSync, statSync } from "node:fs";
import { resolve, posix } from "node:path";
import { all, one, transaction, audit } from "./db";
import { HttpError, appUrl } from "./auth";
import { requirePage, pageRole } from "./permissions";
import { database, rows } from "./api";
import { relatedData } from "./related-data";
import { computedCells } from "./database";
import { cellText } from "./cell-text";
import { writeZip } from "./archive";
import {
  htmlToMarkdown,
  markdownText,
  markdownLink,
  markdownUrl,
  type MarkdownContext,
} from "./markdown";
import { exportName } from "./export-name";
import type { Identity, Page, Row, Field } from "./types";
export type MarkdownExportOptions = {
  pageId: string;
  format: "markdown" | "zip";
  includeSubpages: boolean;
};
const MAX_BYTES = 250 * 1024 * 1024,
  MAX_TEXT = 30 * 1024 * 1024;
function collect(user: Identity, options: MarkdownExportOptions) {
  const root = requirePage(user, options.pageId),
    zip = options.format === "zip";
  if (!zip && options.includeSubpages)
    throw new HttpError(400, "Unterseiten sind nur im ZIP-Export verfügbar.");
  const visible = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL ORDER BY position,id",
    root.workspace_id,
  ).filter((page) => pageRole(user, page));
  const selected: Page[] = [root],
    seen = new Set([root.id]);
  if (options.includeSubpages)
    for (let index = 0; index < selected.length; index++) {
      for (const page of visible.filter(
        (page) => page.parent_id === selected[index].id,
      ))
        if (!seen.has(page.id)) {
          seen.add(page.id);
          selected.push(page);
        }
      if (selected.length > 500)
        throw new HttpError(
          413,
          "Bitte höchstens 500 Seiten je Markdown-Export auswählen.",
        );
    }
  const paths = new Map(
    selected.map((page) => [
      page.id,
      page.id === root.id
        ? "index.md"
        : `pages/${exportName(page.title)}-${page.id}.md`,
    ]),
  );
  const entries = new Map<string, Buffer>();
  let total = 0,
    textBytes = 0;
  const add = (path: string, data: Buffer, text = false) => {
    if (entries.has(path)) return;
    total += data.length;
    if (text) textBytes += data.length;
    if (total > MAX_BYTES || textBytes > MAX_TEXT || entries.size >= 12000)
      throw new HttpError(
        413,
        "Markdown-Export zu groß (maximal 250 MB, davon 30 MB Text).",
      );
    entries.set(path, data);
  };
  const pageCache = new Map<string, Page | null>();
  const readable = (id: string) => {
    if (!pageCache.has(id)) {
      let page: Page | null = null;
      try {
        page = requirePage(user, id);
      } catch {}
      pageCache.set(id, page);
    }
    return pageCache.get(id)!;
  };
  const members = new Map(
    all<{ id: string; name: string }>(
      "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
      root.workspace_id,
    ).map((member) => [member.id, member.name]),
  );
  const dbs = new Map(
    selected
      .filter((page) => page.kind === "database")
      .map((page) => [
        page.id,
        {
          schema: database(page.id),
          rows: visibleRows(user, page, rows(page.id)),
          ...relatedData(user, page),
        },
      ]),
  );
  let rowCount = 0;
  const rowPaths = new Map<string, string>();
  for (const [pageId, data] of dbs)
    for (const row of data.rows) {
      if (++rowCount > 5000)
        throw new HttpError(
          413,
          "Bitte höchstens 5.000 Datensätze je Markdown-Export auswählen.",
        );
      rowPaths.set(
        row.id,
        `records/${pageId}/${exportName(cellText(row.cells[data.schema.fields[0].id]) || "Eintrag")}-${row.id}.md`,
      );
    }
  const relative = (from: string, to: string) =>
    posix.relative(posix.dirname(from), to) || posix.basename(to);
  const pageUrl = (id: string, from: string) =>
    zip && paths.has(id)
      ? relative(from, paths.get(id)!)
      : `${appUrl().replace(/\/$/, "")}/#page=${id}`;
  const fileInfo = (id: string) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    const file = one<{ id: string; page_id: string; name: string }>(
      "SELECT id,page_id,name FROM files WHERE id=?",
      id,
    );
    return file && readable(file.page_id) ? file : null;
  };
  function context(from: string): MarkdownContext {
    return {
      url(raw) {
        let url: URL;
        try {
          url = new URL(raw, appUrl());
        } catch {
          return null;
        }
        if (
          !["http:", "https:", "mailto:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return null;
        if (url.origin === new URL(appUrl()).origin) {
          const fileMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
          if (fileMatch) {
            const file = fileInfo(fileMatch[1]);
            if (!file) return null;
            if (!zip)
              return `${appUrl().replace(/\/$/, "")}/api/files/${file.id}`;
            const path = `assets/${file.id}-${exportName(file.name)}`;
            if (!entries.has(path)) {
              const source = resolve(
                process.env.FLOWPLAN_DATA_DIR || "./data",
                "uploads",
                file.id,
              );
              let size: number;
              try {
                const stat = statSync(source);
                if (!stat.isFile()) throw Error();
                size = stat.size;
              } catch {
                throw new HttpError(
                  409,
                  "Eine referenzierte Datei fehlt. Bitte den Anhang prüfen und den Export erneut starten.",
                );
              }
              if (total + size > MAX_BYTES)
                throw new HttpError(413, "Anhänge überschreiten 250 MB.");
              add(path, readFileSync(source));
            }
            return relative(from, path);
          }
          if (url.hash.startsWith("#page=")) {
            const id = new URLSearchParams(url.hash.slice(1)).get("page") || "";
            return readable(id) ? pageUrl(id, from) : null;
          }
        }
        return url.href;
      },
      linked(source) {
        const page = readable(source);
        return page && page.kind === "database"
          ? { title: page.title, url: pageUrl(page.id, from) }
          : null;
      },
    };
  }
  function render(html: string, ctx: MarkdownContext) {
    try {
      return htmlToMarkdown(html, ctx);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Markdown-Tabelle")
      )
        throw new HttpError(413, error.message);
      throw error;
    }
  }
  function property(
    value: unknown,
    field: Field,
    data: NonNullable<ReturnType<typeof dbs.get>>,
    from: string,
  ): { plain: string; md: string; numeric: boolean } {
    const ctx = context(from),
      values = Array.isArray(value)
        ? value
        : value === null || value === undefined
          ? []
          : [value];
    if (field.type === "relation") {
      const target = field.relationPage || "",
        available = data.related[target],
        targetFields = data.relatedSchemas[target];
      if (!available)
        return {
          plain: "Nicht verfügbar",
          md: "Nicht verfügbar",
          numeric: false,
        };
      const parts = values
        .map((id) => available.find((row) => row.id === String(id)))
        .filter((row): row is Row => !!row);
      const names = parts.map(
        (row) =>
          cellText(row.cells[targetFields?.[0]?.id || "title"]) || "Eintrag",
      );
      return {
        plain: names.join(", "),
        md: parts
          .map((row, index) =>
            markdownLink(
              names[index],
              zip && rowPaths.has(row.id)
                ? relative(from, rowPaths.get(row.id)!)
                : pageUrl(target, from),
            ),
          )
          .join(", "),
        numeric: false,
      };
    }
    if (["person", "created_by", "updated_by"].includes(field.type)) {
      const text = values
        .map((id) => members.get(String(id)) || "Nicht verfügbar")
        .join(", ");
      return { plain: text, md: markdownText(text), numeric: false };
    }
    if (field.type === "files") {
      const entries = fileUrls(value).map((raw) => {
        const url = ctx.url(raw),
          id = /\/api\/files\/([a-f0-9-]{36})/i.exec(raw)?.[1],
          name = id ? fileInfo(id)?.name || "Datei nicht verfügbar" : "Datei";
        return {
          plain: id ? name : raw,
          md: url ? markdownLink(name, url) : markdownText(id ? name : raw),
        };
      });
      return {
        plain: entries.map((e) => e.plain).join(", "),
        md: entries.map((e) => e.md).join(", "),
        numeric: false,
      };
    }
    const plain =
      field.type === "checkbox"
        ? value
          ? "Ja"
          : "Nein"
        : value === "#ACCESS"
          ? "Nicht verfügbar"
          : cellText(value);
    const url =
      field.type === "url" && plain
        ? ctx.url(plain)
        : field.type === "email" && plain
          ? ctx.url(`mailto:${plain}`)
          : null;
    return {
      plain,
      md: url ? markdownLink(plain, url) : markdownText(plain),
      numeric: typeof value === "number" && Number.isFinite(value),
    };
  }
  const tableCell = (text: string) => text.replace(/\r?\n/g, "<br>");
  for (const page of selected) {
    const path = paths.get(page.id)!,
      ctx = context(path);
    let markdown = `# ${markdownText(page.title)}\n\n`;
    if (page.cover.startsWith("/api/files/")) {
      const cover = ctx.url(page.cover);
      if (cover) markdown += `![Cover](<${markdownUrl(cover)}>)\n\n`;
    }
    if (page.kind === "document")
      markdown += render(
        one<{ html: string }>(
          "SELECT html FROM documents WHERE page_id=?",
          page.id,
        )?.html || "",
        ctx,
      );
    else {
      const data = dbs.get(page.id)!,
        fields = data.schema.fields;
      const values = data.rows.map((row) => {
        const computed = computedCells(
          row,
          fields,
          data.related,
          data.relatedSchemas,
        );
        return fields.map((field) =>
          property(computed[field.id], field, data, path),
        );
      });
      markdown +=
        "| " +
        fields.map((field) => tableCell(markdownText(field.name))).join(" | ") +
        " |\n| " +
        fields.map(() => "---").join(" | ") +
        " |\n";
      data.rows.forEach((row, index) => {
        const cells = values[index].map((v) => tableCell(v.md));
        const rowUrl = zip
          ? relative(path, rowPaths.get(row.id)!)
          : `#record-${row.id}`;
        cells[0] = tableCell(
          markdownLink(values[index][0]?.plain || "Eintrag", rowUrl),
        );
        markdown += "| " + cells.join(" | ") + " |\n";
      });
      const csv = (value: string, numeric = false) =>
        '"' +
        (!numeric && /^[\u0000-\u0020]*[=+\-@]|^[\t\r\n]/.test(value)
          ? "'"
          : "") +
        value.replaceAll('"', '""') +
        '"';
      if (zip)
        add(
          `tables/${page.id}.csv`,
          Buffer.from(
            "\uFEFF" +
              [
                fields.map((field) => csv(field.name)).join(","),
                ...values.map((row) =>
                  row.map((v) => csv(v.plain, v.numeric)).join(","),
                ),
              ].join("\r\n") +
              "\r\n",
          ),
          true,
        );
      for (const row of data.rows) {
        const recordPath = zip ? rowPaths.get(row.id)! : path,
          recordContext = context(recordPath),
          computed = computedCells(
            row,
            fields,
            data.related,
            data.relatedSchemas,
          );
        const title = cellText(computed[fields[0].id]) || "Eintrag";
        let document =
          (zip ? "# " : `<a id="record-${row.id}"></a>\n\n## `) +
          markdownText(title) +
          "\n\n";
        document +=
          "| Eigenschaft | Wert |\n| --- | --- |\n" +
          fields
            .map(
              (field) =>
                `| ${tableCell(markdownText(field.name))} | ${tableCell(property(computed[field.id], field, data, recordPath).md)} |`,
            )
            .join("\n") +
          "\n\n";
        const content =
          one<{ html: string }>(
            "SELECT html FROM row_documents WHERE row_id=?",
            row.id,
          )?.html ??
          row.content ??
          "";
        document += content.trimStart().startsWith("<")
          ? render(content, recordContext)
          : markdownText(content) + "\n";
        if (zip) add(recordPath, Buffer.from(document), true);
        else markdown += "\n\n" + document;
      }
    }
    const children = visible.filter((child) => child.parent_id === page.id);
    if (children.length)
      markdown +=
        "\n\n## Unterseiten\n\n" +
        children
          .map(
            (child) =>
              "- " + markdownLink(child.title, pageUrl(child.id, path)),
          )
          .join("\n") +
        "\n";
    add(path, Buffer.from(markdown.trimEnd() + "\n"), true);
  }
  return { entries, root };
}
export async function exportMarkdown(
  user: Identity,
  options: MarkdownExportOptions,
) {
  const { entries, root } = transaction(() => collect(user, options));
  if (options.format === "markdown")
    return {
      bytes: entries.get("index.md")!,
      name: `${exportName(root.title)}.md`,
      mime: "text/markdown; charset=utf-8",
    };
  entries.set(
    "README.txt",
    Buffer.from(
      "Flowplan Markdown-Export\n\nÖffne index.md. Unterseiten liegen unter pages/, Datensatzdokumente unter records/, Tabellen zusätzlich als CSV unter tables/ und lokale Anhänge unter assets/. Links innerhalb dieses Exports sind relativ. Andere Seitenlinks benötigen weiterhin eine Anmeldung bei Flowplan. Externe Medien werden als Links exportiert und nicht heruntergeladen.\n\nDie Datenbankausgabe enthält alle Datensätze und Eigenschaften, unabhängig von Ansichtfiltern. Markdown stellt Spalten nacheinander dar und normalisiert verbundene Tabellenzellen. Formeln verwenden math-Codezäune, Diagramme mermaid-Codezäune. Textwerte in CSV, die wie Tabellenkalkulationsformeln beginnen, erhalten ein führendes Apostroph.\n\nDies ist ein portables Inhaltsformat, kein Flowplan-Wiederherstellungsarchiv. Kommentare, Versionsverläufe, Berechtigungen und Ansichtsdefinitionen sind nicht enthalten.\n",
    ),
  );
  const bytes = await writeZip(entries);
  audit(user.id, "page.markdown.export", root.id);
  return {
    bytes,
    name: `${exportName(root.title)}.zip`,
    mime: "application/zip",
  };
}
