// The import report: after an import, a page "Importbericht" in the target
// space lists what was not carried over or only approximated – unknown
// blocks, formulas and rollups without counterpart, embeds kept as links,
// files too large or missing, relations that could not be resolved, synced
// blocks copied – each with a link to the imported page it concerns.
// Importers push entries into the tree's collector (lib/importers/types.ts
// importReport); lib/importers/write.ts and lib/zip-import.ts write the page
// once everything else is written, inside the import's transaction.
import { run } from "../db";
import { createPage } from "../seed";
import { cleanHtml, htmlState } from "../document-server";
import { ct } from "../content-locale";
import { esc } from "./html";
import type { ImportReport, ReportEntry, ReportKind } from "./types";

export const REPORT_KINDS: ReportKind[] = ["block", "synced", "embed", "formula", "rollup", "property", "relation", "file", "other"];
const heading = (kind: ReportKind) =>
  ({
    block: ct("Nicht übernommene Blöcke", "Blocks not carried over"),
    synced: ct("Synchronisierte Blöcke (Inhalt kopiert)", "Synced blocks (content copied)"),
    embed: ct("Einbettungen und Lesezeichen als Link", "Embeds and bookmarks kept as links"),
    formula: ct("Formeln ohne Gegenstück (Werte als Text)", "Formulas without counterpart (values as text)"),
    rollup: ct("Rollups ohne Gegenstück (Werte als Text)", "Rollups without counterpart (values as text)"),
    property: ct("Eigenschaften mit angenähertem Typ", "Properties with an approximated type"),
    relation: ct("Nicht aufgelöste Verknüpfungen", "Relations that could not be resolved"),
    file: ct("Dateien zu groß, fehlend oder nicht geladen", "Files too large, missing or not downloaded"),
    other: ct("Weitere Hinweise", "Other notes"),
  })[kind];

export type ReportSummary = { pageId: string; total: number; counts: Partial<Record<ReportKind, number>> };
// Where an entry's page is now: its address and title, or null when it was
// not written.
export type ReportTarget = (entry: ReportEntry) => { href: string; title: string } | null;

export function reportHtml(source: string, report: ImportReport, target: ReportTarget) {
  const parts = [
    `<p>${esc(
      ct(
        `Was beim Import aus „${source}“ nicht übernommen oder nur angenähert wurde. Die Links führen zu den betroffenen Seiten.`,
        `What the import from “${source}” did not carry over or only approximated. The links lead to the pages concerned.`,
      ),
    )}</p>`,
  ];
  for (const kind of REPORT_KINDS) {
    const entries = report.entries.filter((e) => e.kind === kind);
    const count = report.counts[kind] || 0;
    if (!count) continue;
    const items = entries
      .map((entry) => ({ entry, at: target(entry) }))
      .sort((a, b) => (a.at?.title || "").localeCompare(b.at?.title || "", "de") || a.entry.detail.localeCompare(b.entry.detail, "de", { numeric: true }))
      .map(({ entry, at }) => `<li><p>${at ? `<a href="${esc(at.href)}">${esc(at.title)}</a>: ` : ""}${esc(entry.detail)}</p></li>`);
    parts.push(`<h2>${esc(heading(kind))} (${count})</h2>`);
    if (items.length) parts.push(`<ul>${items.join("")}</ul>`);
    if (count > entries.length) parts.push(`<p>${esc(ct(`… und ${count - entries.length} weitere.`, `… and ${count - entries.length} more.`))}</p>`);
  }
  return cleanHtml(parts.join(""));
}

// Writes the report page at the top of the space; nothing without entries.
export async function writeImportReport(
  user: { id: string },
  workspaceId: string,
  spaceId: string,
  source: string,
  report: ImportReport | undefined,
  target: ReportTarget,
): Promise<ReportSummary | undefined> {
  const total = Object.values(report?.counts || {}).reduce((n, c) => n + (c || 0), 0);
  if (!report || !total) return undefined;
  const title = `${ct("Importbericht", "Import report")}: ${source}`.slice(0, 200);
  const pageId = await createPage(workspaceId, spaceId, user.id, title, "document", null);
  const html = reportHtml(source, report, target);
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  await run("UPDATE pages SET icon=? WHERE id=?", "📋", pageId);
  return { pageId, total, counts: { ...report.counts } };
}

// The source as the report's title names it.
const SOURCE_NAMES: Record<string, string> = {
  affine: "AFFiNE",
  bookstack: "BookStack",
  confluence: "Confluence",
  evernote: "Evernote",
  gdocs: "Google Docs",
  goodnotes: "GoodNotes",
  notion: "Notion",
  obsidian: "Obsidian",
  word: "Microsoft Word",
};
export const sourceName = (source: string, title?: string) => {
  const name = SOURCE_NAMES[source] || source;
  return title && title !== name ? `${name} – ${title}` : name;
};
