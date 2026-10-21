import { readableDatabase } from "./field-access";
import { visibleRows } from "./row-access";
import { hiddenFileIds } from "./row-files";
import { fileUrls } from "./file-cells";
import { readFileSync, statSync } from "node:fs";
import { resolve, posix } from "node:path";
import { all, one, transaction, audit } from "./db";
import { HttpError, appUrl } from "./auth";
import { requirePage, pageRole, spaceRole } from "./permissions";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
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
import { ct } from "./content-locale";
import { dashboardSummary } from "./dashboard";
import { commentText } from "./comment-content";
import { toFrontmatter, type Frontmatter, type FrontmatterValue } from "./frontmatter";
import { aliasList, pageAliases } from "./aliases";
import { whiteboardSnapshotItems } from "./whiteboard";
import { whiteboardSvg } from "./whiteboard-svg";
import type { Identity, Page, Row, Field, Space } from "./types";
export type MarkdownExportOptions = {
  // One page (with its sub-pages) or a whole space: every top-level page
  // in a folder of its own, named like the scheduled export
  // (<title>-<id8>/), so both unpack into the same layout.
  pageId?: string;
  spaceId?: string;
  format: "markdown" | "zip";
  includeSubpages: boolean;
  // One record of the database instead of the whole database.
  rowId?: string;
  // ZIP only: comments (<file>.comments.md) and earlier versions
  // (<file>.versions/<date>.md) of every page and record.
  history?: boolean;
  // For a prompt (lib/ai/content.ts): no values from other databases –
  // relations, rollups and formulas may show data the AI may not read.
  forAi?: boolean;
};
const unavailable = () => ct("Nicht verfügbar", "Not available"),
  recordWord = () => ct("Eintrag", "Record");
// Values the database computes; exported, but not read back on import.
export const computedTypes = ["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress", "time"];
const MAX_BYTES = 250 * 1024 * 1024,
  MAX_TEXT = 30 * 1024 * 1024;
// The folder of a top-level page in a space export and in the scheduled
// export (lib/scheduled-markdown-export.ts).
export const exportFolder = (page: { id: string; title: string }) => `${exportName(page.title).slice(0, 60)}-${page.id.slice(0, 8)}`;

function collect(user: Identity, options: MarkdownExportOptions) {
  const zip = options.format === "zip";
  let space: Space | null = null,
    root: Page | null = null;
  if (options.spaceId) {
    if (options.pageId || options.rowId) throw new HttpError(400, "Entweder eine Seite oder einen Bereich exportieren.");
    if (!zip) throw new HttpError(400, "Ein Bereich lässt sich nur als ZIP exportieren.");
    space = one<Space>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", options.spaceId) || null;
    if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
    if (!spaceRole(user, space)) throw new HttpError(403, "Keine Berechtigung für diesen Bereich.");
  } else {
    if (!options.pageId) throw new HttpError(400, "Seite fehlt.");
    root = requirePage(user, options.pageId);
    requireUnlocked(user, root);
  }
  const workspaceId = space ? space.workspace_id : root!.workspace_id;
  const locked = lockedPageIds(user, workspaceId);
  if (!zip && options.includeSubpages)
    throw new HttpError(400, "Unterseiten sind nur im ZIP-Export verfügbar.");
  if (options.rowId && (root?.kind !== "database" || options.includeSubpages))
    throw new HttpError(400, "Nur ein Eintrag einer Datenbank.");
  const visible = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL ORDER BY position,id",
    workspaceId,
  ).filter((page) => !locked.has(page.id) && pageRole(user, page));
  // Top-level pages: the one page, or all the person may read in the space.
  const roots = space ? visible.filter((page) => page.space_id === space.id && !page.parent_id) : [root!];
  const selected: Page[] = [...roots],
    seen = new Set(roots.map((page) => page.id)),
    rootOf = new Map(roots.map((page) => [page.id, page]));
  if (options.includeSubpages || space)
    for (let index = 0; index < selected.length; index++) {
      for (const page of visible.filter(
        (page) => page.parent_id === selected[index].id,
      ))
        if (!seen.has(page.id)) {
          seen.add(page.id);
          selected.push(page);
          rootOf.set(page.id, rootOf.get(selected[index].id)!);
        }
      if (selected.length > 500)
        throw new HttpError(
          413,
          "Bitte höchstens 500 Seiten je Markdown-Export auswählen.",
        );
    }
  // In a space export everything of a top-level page goes below its folder.
  const folders = new Map(roots.map((page) => [page.id, space ? `${exportFolder(page)}/` : ""]));
  const prefix = (pageId: string) => folders.get(rootOf.get(pageId)!.id)!;
  const prefixOfPath = (path: string) => (space ? path.slice(0, path.indexOf("/") + 1) : "");
  const paths = new Map(
    selected.map((page) => [
      page.id,
      prefix(page.id) +
        (rootOf.get(page.id)!.id === page.id
          ? "index.md"
          : `pages/${exportName(page.title)}-${page.id}.md`),
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
      workspaceId,
    ).map((member) => [member.id, member.name]),
  );
  const dbs = new Map(
    selected
      .filter((page) => page.kind === "database")
      .map((page) => [
        page.id,
        {
          // Properties hidden from this person are left out (lib/field-access.ts).
          schema: readableDatabase(user, page, database(page.id)),
          rows: visibleRows(user, page, rows(page.id)).filter((row) => !options.rowId || row.id === options.rowId),
          ...relatedData(user, page),
        },
      ]),
  );
  if (options.rowId && !dbs.get(root!.id)?.rows.length) throw new HttpError(404, "Datensatz fehlt.");
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
        options.rowId ? "index.md" : `${prefix(pageId)}records/${pageId}/${exportName(cellText(row.cells[data.schema.fields[0].id]) || recordWord())}-${row.id}.md`,
      );
    }
  const relative = (from: string, to: string) =>
    posix.relative(posix.dirname(from), to) || posix.basename(to);
  const pageUrl = (id: string, from: string) =>
    zip && paths.has(id)
      ? relative(from, paths.get(id)!)
      : `${appUrl().replace(/\/$/, "")}/#page=${id}`;
  // A file comes along only if the person could download it: its page is
  // readable and unlocked, and it does not belong to a private record.
  const hiddenFiles = new Map<string, Set<string>>();
  const fileInfo = (id: string) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    const file = one<{ id: string; page_id: string; name: string }>(
      "SELECT id,page_id,name FROM files WHERE id=?",
      id,
    );
    const owner = file ? readable(file.page_id) : null;
    if (!file || !owner || locked.has(owner.id)) return null;
    try {
      requireUnlocked(user, owner);
    } catch {
      return null;
    }
    if (!hiddenFiles.has(owner.id)) hiddenFiles.set(owner.id, hiddenFileIds(user, owner));
    return hiddenFiles.get(owner.id)!.has(file.id) ? null : file;
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
            const path = `${prefixOfPath(from)}assets/${file.id}-${exportName(file.name)}`;
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
      whiteboard(pageId) {
        const page = readable(pageId);
        if (!page || page.kind !== "whiteboard" || locked.has(page.id)) return null;
        const image = zip ? boardImage(page, prefixOfPath(from)) : null;
        return {
          title: page.title,
          image: image ? relative(from, image) : null,
          url: `${appUrl().replace(/\/$/, "")}/#page=${page.id}`,
        };
      },
    };
  }
  // Whiteboards as SVG next to the attachments (#34), once per folder; null
  // for an empty board.
  const boards = new Map<string, string | null>();
  function boardImage(page: Page, folder: string) {
    const path = `${folder}assets/${exportName(page.title)}-${page.id}.svg`;
    if (boards.has(path)) return boards.get(path)!;
    const images = context(path);
    const svg = whiteboardSvg(
      whiteboardSnapshotItems(page),
      {
        image: (src) => images.url(src),
        page: (id) => {
          const target = readable(id);
          return target && !locked.has(target.id) ? { title: target.title, kind: target.kind } : null;
        },
        record: (databaseId, rowId) => {
          const db = readable(databaseId);
          if (!db || db.kind !== "database" || locked.has(db.id)) return null;
          const row = visibleRows(user, db, rows(db.id)).find((r) => r.id === rowId);
          if (!row) return null;
          const fields = database(db.id).fields;
          return { title: cellText(row.cells[fields[0]?.id || "title"]) || recordWord(), database: db.title };
        },
        label: ct,
      },
      page.title,
    );
    boards.set(path, svg ? path : null);
    if (svg) add(path, Buffer.from(svg), true);
    return svg ? path : null;
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
          plain: unavailable(),
          md: unavailable(),
          numeric: false,
        };
      const parts = values
        .map((id) => available.find((row) => row.id === String(id)))
        .filter((row): row is Row => !!row);
      const names = parts.map(
        (row) =>
          cellText(row.cells[targetFields?.[0]?.id || "title"]) || recordWord(),
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
        .map((id) => members.get(String(id)) || unavailable())
        .join(", ");
      return { plain: text, md: markdownText(text), numeric: false };
    }
    if (field.type === "files") {
      const entries = fileUrls(value).map((raw) => {
        const url = ctx.url(raw),
          id = /\/api\/files\/([a-f0-9-]{36})/i.exec(raw)?.[1],
          name = id ? fileInfo(id)?.name || ct("Datei nicht verfügbar", "File not available") : ct("Datei", "File");
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
          ? ct("Ja", "Yes")
          : ct("Nein", "No")
        : value === "#ACCESS"
          ? unavailable()
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
  // Comments and versions of a page or record, next to its file.
  const commentBody = (body: string) => {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object") return commentText(parsed);
    } catch {}
    return body;
  };
  function history(path: string, pageId: string, rowId: string | null, title: string) {
    if (!zip || !options.history) return;
    const base = path.replace(/\.md$/, "");
    const comments = all<{ name: string | null; body: string; resolved: number; created_at: string }>(
      `SELECT u.name,c.body,c.resolved,c.created_at FROM comments c LEFT JOIN users u ON u.id=c.author_id
       WHERE c.page_id=? AND ${rowId ? "c.row_id=?" : "c.row_id IS NULL"} ORDER BY c.created_at`,
      ...(rowId ? [pageId, rowId] : [pageId]),
    );
    const threads = all<{ id: string; anchor: string; resolved: number }>(
      `SELECT id,anchor,resolved FROM inline_threads WHERE page_id=? AND ${rowId ? "row_id=?" : "row_id IS NULL"} ORDER BY created_at`,
      ...(rowId ? [pageId, rowId] : [pageId]),
    );
    const when = (at: string) => at.replace("T", " ").slice(0, 16);
    let text = "";
    for (const c of comments)
      text += `## ${markdownText(c.name || ct("Unbekannt", "Unknown"))} · ${when(c.created_at)}${c.resolved ? ` · ${ct("erledigt", "resolved")}` : ""}\n\n${markdownText(commentBody(c.body))}\n\n`;
    for (const thread of threads) {
      let quote = "";
      try {
        quote = String(JSON.parse(thread.anchor).quote || "");
      } catch {}
      text += `## ${ct("Zur Textstelle", "On the passage")}${thread.resolved ? ` · ${ct("erledigt", "resolved")}` : ""}\n\n${quote ? `> ${markdownText(quote).replace(/\n/g, "\n> ")}\n\n` : ""}`;
      for (const m of all<{ author_name: string; body: string; created_at: string }>(
        "SELECT author_name,body,created_at FROM inline_messages WHERE thread_id=? AND deleted=0 ORDER BY created_at",
        thread.id,
      ))
        text += `- **${markdownText(m.author_name)}** · ${when(m.created_at)}: ${markdownText(commentBody(m.body)).replace(/\n/g, " ")}\n`;
      text += "\n";
    }
    if (text) add(`${base}.comments.md`, Buffer.from(`# ${ct("Kommentare", "Comments")} – ${markdownText(title)}\n\n${text.trimEnd()}\n`), true);
    const versions = rowId
      ? all<{ id: string; html: string; created_at: string }>(
          "SELECT id,html,created_at FROM row_snapshots WHERE row_id=? ORDER BY created_at DESC LIMIT 50",
          rowId,
        )
      : all<{ id: string; html: string; created_at: string }>(
          "SELECT id,html,created_at FROM snapshots WHERE page_id=? AND html IS NOT NULL AND html!='' ORDER BY created_at DESC LIMIT 50",
          pageId,
        );
    for (const version of versions) {
      const versionPath = `${base}.versions/${version.created_at.replace(/[: T]/g, "-").slice(0, 19)}-${version.id.slice(0, 8)}.md`;
      add(versionPath, Buffer.from(`# ${markdownText(title)} (${when(version.created_at)})\n\n${render(version.html, context(versionPath))}`), true);
    }
  }
  // Record properties as YAML frontmatter, readable by Obsidian and other
  // tools. Computed values (formulas, rollups, timestamps …) go below
  // "flowplan:" so an import does not take them for properties.
  function frontmatter(
    row: Row,
    computed: Record<string, unknown>,
    fields: Field[],
    data: NonNullable<ReturnType<typeof dbs.get>>,
    from: string,
  ): Frontmatter {
    const result: Frontmatter = { title: cellText(computed[fields[0].id]) || recordWord() };
    const flowplan: Frontmatter = { id: row.id };
    for (const field of fields.slice(1)) {
      const value = computed[field.id];
      const list = (Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value]) as unknown[];
      let out: FrontmatterValue;
      if (value === "#ACCESS") continue;
      if (options.forAi && ["relation", "rollup", "formula"].includes(field.type)) continue;
      if (field.type === "checkbox") out = !!value;
      else if (field.type === "number") out = typeof value === "number" && Number.isFinite(value) ? value : null;
      else if (field.type === "multiselect") out = list.map(String);
      else if (field.type === "aliases") {
        // Obsidian's key, so a round trip keeps them.
        const aliases = aliasList(value);
        if (aliases.length && !("aliases" in result)) result.aliases = aliases;
        continue;
      }
      else if (field.type === "checklist")
        out = (list as { text?: string; done?: boolean }[]).map((item) => `[${item?.done ? "x" : " "}] ${item?.text || ""}`);
      else if (field.type === "relation") {
        const available = data.related[field.relationPage || ""],
          titleField = data.relatedSchemas[field.relationPage || ""]?.[0]?.id || "title";
        if (!available) continue;
        out = list
          .map((rid) => available.find((r) => r.id === String(rid)))
          .filter((r): r is Row => !!r)
          .map((r) => cellText(r.cells[titleField]) || recordWord());
      } else if (field.type === "person") {
        const names = list.map((uid) => members.get(String(uid)) || unavailable());
        out = names.length === 1 ? names[0] : names;
      } else if (field.type === "files") out = fileUrls(value).map((raw) => context(from).url(raw) || "").filter(Boolean);
      else out = cellText(value) || null;
      if (out === null || (Array.isArray(out) && !out.length)) continue;
      if (computedTypes.includes(field.type)) flowplan[field.name] = out;
      else result[field.name in result ? `${field.name} (${field.id})` : field.name] = out;
    }
    result.flowplan = flowplan;
    return result;
  }
  for (const page of selected) {
    const path = paths.get(page.id)!,
      ctx = context(path);
    // Pages have frontmatter only for their aliases (as Obsidian reads them).
    const aliases = pageAliases(page);
    let markdown = (aliases.length ? toFrontmatter({ aliases }) + "\n" : "") + `# ${markdownText(page.title)}\n\n`;
    if (page.cover.startsWith("/api/files/")) {
      const cover = ctx.url(page.cover);
      if (cover) markdown += `![Cover](<${markdownUrl(cover)}>)\n\n`;
    }
    if (page.kind === "document") history(path, page.id, null, page.title);
    if (page.kind === "whiteboard") {
      const image = zip ? boardImage(page, prefix(page.id)) : null;
      markdown += image
        ? `![${markdownText(page.title || "Whiteboard")}](<${markdownUrl(relative(path, image))}>)\n`
        : zip
          ? ct("*Dieses Whiteboard ist leer.*", "*This whiteboard is empty.*") + "\n"
          : markdownLink(ct("Whiteboard in Flowplan öffnen", "Open the whiteboard in Flowplan"), `${appUrl().replace(/\/$/, "")}/#page=${page.id}`) + "\n";
    } else if (page.kind === "dashboard") {
      // A text summary: the data of the tiles depends on who looks.
      for (const tile of dashboardSummary(user, page)) {
        markdown += `## ${markdownText(tile.title)}\n\n`;
        if (tile.text) markdown += `${tile.text.trim()}\n\n`;
        else markdown += `*${markdownText(tile.source ? `${tile.kind} · ${tile.source}` : tile.kind)}*\n\n`;
      }
    } else if (page.kind === "document" || page.kind === "journal")
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
          markdownLink(values[index][0]?.plain || recordWord(), rowUrl),
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
      if (zip && !options.rowId)
        add(
          `${prefix(page.id)}tables/${page.id}.csv`,
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
        const title = cellText(computed[fields[0].id]) || recordWord();
        // A single record is its own file, with frontmatter in both formats.
        if (options.rowId) {
          const content =
            one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id)?.html ?? row.content ?? "";
          add(
            "index.md",
            Buffer.from(
              toFrontmatter(frontmatter(row, computed, fields, data, recordPath)) +
                "\n# " +
                markdownText(title) +
                "\n\n" +
                (content.trimStart().startsWith("<") ? render(content, recordContext) : markdownText(content) + "\n"),
            ),
            true,
          );
          continue;
        }
        let document = zip
          ? toFrontmatter(frontmatter(row, computed, fields, data, recordPath)) + "\n# " + markdownText(title) + "\n\n"
          : `<a id="record-${row.id}"></a>\n\n## ` + markdownText(title) + "\n\n";
        // In one Markdown file the records follow each other, with a table.
        if (!zip)
          document +=
            `| ${ct("Eigenschaft", "Property")} | ${ct("Wert", "Value")} |\n| --- | --- |\n` +
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
        if (zip) {
          add(recordPath, Buffer.from(document), true);
          history(recordPath, page.id, row.id, title);
        }
        else markdown += "\n\n" + document;
      }
    }
    const children = visible.filter((child) => child.parent_id === page.id);
    if (children.length)
      markdown +=
        `\n\n## ${ct("Unterseiten", "Sub-pages")}\n\n` +
        children
          .map(
            (child) =>
              "- " + markdownLink(child.title, pageUrl(child.id, path)),
          )
          .join("\n") +
        "\n";
    add(path, Buffer.from(markdown.trimEnd() + "\n"), true);
  }
  // The space's own index: its top-level pages.
  if (space)
    add(
      "index.md",
      Buffer.from(
        `# ${markdownText(space.name)}\n\n` +
          (roots.length
            ? roots.map((page) => "- " + markdownLink(page.title || ct("Ohne Titel", "Untitled"), paths.get(page.id)!)).join("\n") + "\n"
            : ct("Dieser Bereich enthält keine Seiten, die du lesen darfst.", "This space has no pages you may read.") + "\n"),
      ),
      true,
    );
  const record = options.rowId ? dbs.get(root!.id)!.rows[0] : null;
  const name = record ? cellText(record.cells[dbs.get(root!.id)!.schema.fields[0].id]) || recordWord() : space ? space.name : root!.title;
  return { entries, root, space, name };
}
export async function exportMarkdown(
  user: Identity,
  options: MarkdownExportOptions,
) {
  const { entries, root, space, name } = transaction(() => collect(user, options));
  if (options.format === "markdown")
    return {
      bytes: entries.get("index.md")!,
      name: `${exportName(name)}.md`,
      mime: "text/markdown; charset=utf-8",
    };
  const spaceNote = space
    ? ct(
        "Jede Seite der obersten Ebene dieses Bereichs liegt mit allem, was darunter hängt, in einem eigenen Ordner (<Titel>-<Kennung>/); index.md listet sie auf. Innerhalb jedes Ordners gilt:\n\n",
        "Every top-level page of this space is in a folder of its own (<title>-<id>/) with everything below it; index.md lists them. Inside each folder:\n\n",
      )
    : "";
  const historyNote = options.history
    ? ct(
        "Kommentare stehen in <Datei>.comments.md, frühere Versionen unter <Datei>.versions/. Berechtigungen und Ansichtsdefinitionen sind nicht enthalten.\n",
        "Comments are in <file>.comments.md, earlier versions in <file>.versions/. Permissions and view definitions are not included.\n",
      )
    : ct(
        "Kommentare, Versionsverläufe, Berechtigungen und Ansichtsdefinitionen sind nicht enthalten.\n",
        "Comments, version histories, permissions and view definitions are not included.\n",
      );
  entries.set(
    "README.txt",
    Buffer.from(
      ct("Flowplan Markdown-Export\n\n", "Flowplan Markdown export\n\n") +
        spaceNote +
        ct(
          "Öffne index.md. Unterseiten liegen unter pages/, Datensatzdokumente unter records/, Tabellen zusätzlich als CSV unter tables/ und lokale Anhänge unter assets/ – dort liegen auch Whiteboards als SVG-Bild. Links innerhalb dieses Exports sind relativ. Andere Seitenlinks benötigen weiterhin eine Anmeldung bei Flowplan. Externe Medien werden als Links exportiert und nicht heruntergeladen.\n\nJeder Datensatz unter records/ beginnt mit seinen Eigenschaften als YAML-Frontmatter (wie in Obsidian); berechnete Werte wie Formeln und Zeitstempel stehen unter \"flowplan:\". Eine Datenbank liest solche Dateien über „Markdown importieren“ wieder ein.\n\nDie Datenbankausgabe enthält alle Datensätze und Eigenschaften, unabhängig von Ansichtfiltern. Markdown stellt Spalten nacheinander dar und normalisiert verbundene Tabellenzellen. Formeln verwenden math-Codezäune, Diagramme mermaid-Codezäune. Textwerte in CSV, die wie Tabellenkalkulationsformeln beginnen, erhalten ein führendes Apostroph.\n\nDies ist ein portables Inhaltsformat, kein Flowplan-Wiederherstellungsarchiv. ",
          "Open index.md. Sub-pages are in pages/, record documents in records/, tables also as CSV in tables/ and local attachments in assets/ – where whiteboards are too, as SVG images. Links within this export are relative. Other page links still need a Flowplan sign-in. External media are exported as links and not downloaded.\n\nEvery record in records/ starts with its properties as YAML frontmatter (as in Obsidian); computed values such as formulas and timestamps are below \"flowplan:\". A database reads such files back with \"Import Markdown\".\n\nThe database output contains all records and properties, regardless of view filters. Markdown shows columns one after another and normalises merged table cells. Formulas use math code fences, diagrams mermaid code fences. Text values in CSV that start like spreadsheet formulas get a leading apostrophe.\n\nThis is a portable content format, not a Flowplan restore archive. ",
        ) +
        historyNote,
    ),
  );
  const bytes = await writeZip(entries);
  if (space) audit(user.id, "space.markdown.export", space.id);
  else audit(user.id, "page.markdown.export", root!.id);
  return {
    bytes,
    name: `${exportName(name)}.zip`,
    mime: "application/zip",
  };
}
