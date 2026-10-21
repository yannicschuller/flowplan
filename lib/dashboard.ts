// Dashboard pages (lib/dashboard-schema.ts): saving the tiles and computing
// what each tile shows for the person looking at it. Every tile checks its
// source like the source itself does (requirePage, visible records, journal
// locks); a tile the person may not see yields `{ available: false }` and
// nothing else – no title, no error text.
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { visibleRows } from "./row-access";
import { queryRows } from "./database";
import { relatedData } from "./related-data";
import { computeMetric } from "./dashboard-metric";
import { defaultChart, type ChartConfig } from "./database-chart";
import { journalDayDetails, journalLocked, lockedPageIds, requireUnlocked } from "./journal-extras";
import { myTasks } from "./doc-tasks";
import { markdownToHtml } from "./markdown-import";
import { escaped } from "./document-server";
import { ct } from "./content-locale";
import { parseTiles, tilesSchema, type Tile } from "./dashboard-schema";
import type { Field, Identity, Page, Role, Row, View } from "./types";

export function dashboardTiles(pageId: string): Tile[] {
  return parseTiles(one<{ tiles: string }>("SELECT tiles FROM dashboards WHERE page_id=?", pageId)?.tiles);
}

// Runs inside the command transaction; the caller checked editor rights and locks.
export function saveDashboard(page: Page, input: unknown) {
  if (page.kind !== "dashboard") throw new HttpError(400, "Kein Dashboard.");
  const tiles = tilesSchema.parse(input);
  run(
    "INSERT INTO dashboards(page_id,tiles,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(page_id) DO UPDATE SET tiles=excluded.tiles,updated_at=excluded.updated_at",
    page.id,
    JSON.stringify(tiles),
  );
  // Tile titles and texts in the page's document, for search and previews.
  // Nothing from the sources: those depend on who is looking.
  const html = tiles
    .map((t) => (t.title ? `<h2>${escaped(t.title)}</h2>` : "") + (t.type === "text" ? markdownToHtml(t.text) : ""))
    .join("");
  run(
    "INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html,updated_at=CURRENT_TIMESTAMP",
    page.id,
    html,
  );
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
  return { tiles };
}

// Copies the tiles of a duplicated or imported dashboard; sources that were
// copied along point to their copies.
export function copyDashboard(from: Tile[], to: string, pageIds: Map<string, string>) {
  const tiles = from.map((t) => ("source" in t ? { ...t, source: pageIds.get(t.source) || t.source } : t));
  run(
    "INSERT INTO dashboards(page_id,tiles) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET tiles=excluded.tiles",
    to,
    JSON.stringify(tiles),
  );
}

const unavailable = { available: false as const };
// A source page the person can read, in the dashboard's workspace and not
// behind a journal PIN; otherwise null.
function readableSource(user: Identity, dashboard: Page, id: string, kind: Page["kind"]) {
  try {
    const page = requirePage(user, id);
    if (page.kind !== kind || page.workspace_id !== dashboard.workspace_id) return null;
    requireUnlocked(user, page);
    return page;
  } catch {
    return null;
  }
}
function databaseOf(pageId: string) {
  const raw = one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", pageId);
  return raw ? { fields: JSON.parse(raw.fields) as Field[], views: JSON.parse(raw.views) as View[] } : null;
}
const allRecords: View = { id: "all", name: "", type: "table", filters: [], sorts: [] };

function tileData(user: Identity, dashboard: Page, tile: Tile, cache: { locked?: Set<string> }) {
  switch (tile.type) {
    case "view": {
      const page = readableSource(user, dashboard, tile.source, "database");
      const db = page && databaseOf(page.id);
      if (!page || !db) return unavailable;
      const view = db.views.find((v) => v.id === tile.view && v.type !== "form");
      return { available: true, title: page.title, icon: page.icon, view: view?.id || "", viewName: view?.name || "", role: pageRole(user, page) };
    }
    case "number": {
      const page = readableSource(user, dashboard, tile.source, "database");
      if (!page) return unavailable;
      const metric = computeMetric(user, { source: page.id, view: tile.view, aggregate: tile.aggregate, field: tile.field });
      const progress =
        tile.target && metric.value !== null ? Math.max(0, Math.min(1, metric.value / tile.target)) : null;
      return { available: true, ...metric, target: tile.target, progress };
    }
    case "chart": {
      const page = readableSource(user, dashboard, tile.source, "database");
      const db = page && databaseOf(page.id);
      if (!page || !db) return unavailable;
      const source = db.views.find((v) => v.id === tile.view && v.type !== "form") || allRecords;
      const rows = all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY position", page.id).map(
        (r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row,
      );
      const { related, relatedSchemas } = relatedData(user, page);
      const shown = queryRows(visibleRows(user, page, rows), db.fields, source, "", related, relatedSchemas);
      const base = defaultChart(db.fields);
      const chart: ChartConfig = {
        ...base,
        kind: tile.kind,
        xField: tile.xField || base.xField,
        aggregate: tile.aggregate,
        ...(tile.aggregate !== "count" && tile.yField ? { yField: tile.yField } : {}),
        showLegend: tile.kind === "donut",
      };
      // The chart view draws these rows as they are; the database's own
      // records are in `rows`, related ones (relations, rollups) in `related`.
      return {
        available: true,
        title: page.title,
        fields: db.fields,
        rows: shown,
        related: { ...related, [page.id]: shown },
        view: { ...source, id: tile.id, name: tile.title || source.name, type: "chart", chart } satisfies View,
      };
    }
    case "journal": {
      const page = readableSource(user, dashboard, tile.source, "journal");
      if (!page) return unavailable;
      // Days that count for the streak: something written or tracked, as
      // the journal page counts them (components/journal-view.tsx).
      const days = journalDayDetails(page.id)
        .slice(0, 400)
        .map((d) => ({
          id: d.id,
          date: d.journal_date,
          written: d.words > 0 || Object.keys(d.values).length > 0 || !!d.image,
          excerpt: d.excerpt.slice(0, 120),
        }));
      return { available: true, title: page.title, journalId: page.id, days };
    }
    case "tasks": {
      // "Meine Aufgaben" with a due date; the browser picks today and earlier.
      const tasks = myTasks(user, dashboard.workspace_id).filter((t) => t.due && !t.checked);
      return { available: true, tasks: tasks.slice(0, 100) };
    }
    case "recent": {
      cache.locked ??= lockedPageIds(user, dashboard.workspace_id);
      const pages = all<Page>(
        "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 ORDER BY updated_at DESC LIMIT 300",
        dashboard.workspace_id,
      )
        .filter((p) => p.id !== dashboard.id && !cache.locked!.has(p.id) && !!pageRole(user, p) && !journalLocked(user, p))
        .slice(0, tile.limit)
        .map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, updated_at: p.updated_at }));
      const unread = one<{ n: number }>(
        "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL",
        user.id,
      )!.n;
      return { available: true, pages, unread };
    }
    case "text":
      return { available: true, html: markdownToHtml(tile.text) };
  }
}

export type DashboardSources = {
  databases: { id: string; title: string; views: { id: string; name: string; type: View["type"] }[]; fields: { id: string; name: string; type: Field["type"] }[] }[];
  journals: { id: string; title: string }[];
};
// What an editor can choose from: readable databases and journals of the workspace.
export function dashboardSources(user: Identity, dashboard: Page): DashboardSources {
  const pages = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND kind IN ('database','journal') ORDER BY title",
    dashboard.workspace_id,
  ).filter((p) => readableSource(user, dashboard, p.id, p.kind));
  return {
    databases: pages
      .filter((p) => p.kind === "database")
      .flatMap((p) => {
        const db = databaseOf(p.id);
        if (!db) return [];
        return [
          {
            id: p.id,
            title: p.title,
            views: db.views.filter((v) => v.type !== "form").map((v) => ({ id: v.id, name: v.name, type: v.type })),
            fields: db.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
          },
        ];
      }),
    journals: pages.filter((p) => p.kind === "journal").map((p) => ({ id: p.id, title: p.title })),
  };
}

// Tiles with their data for this person; editors also get the sources.
export function dashboardData(user: Identity, page: Page, role: Role | null) {
  const tiles = dashboardTiles(page.id);
  const cache = {};
  const data: Record<string, unknown> = {};
  for (const tile of tiles) {
    try {
      data[tile.id] = tileData(user, page, tile, cache);
    } catch {
      // A failing source never takes the dashboard down nor tells why.
      data[tile.id] = unavailable;
    }
  }
  return {
    tiles,
    data,
    ...(role && role !== "viewer" ? { sources: dashboardSources(user, page) } : {}),
  };
}

// A plain summary for exports (Markdown, PDF …): what each tile shows,
// sources named only when the exporting person can read them.
export function dashboardSummary(user: Identity, page: Page) {
  const tiles = dashboardTiles(page.id);
  const sourceTitle = (id: string, kind: Page["kind"]) => readableSource(user, page, id, kind)?.title || null;
  const labels: Record<Tile["type"], string> = {
    view: ct("Datenbankansicht", "Database view"),
    number: ct("Kennzahl", "Metric"),
    chart: ct("Diagramm", "Chart"),
    journal: ct("Journal-Serie", "Journal streak"),
    tasks: ct("Meine fälligen Aufgaben", "My due tasks"),
    recent: ct("Zuletzt geändert", "Recently changed"),
    text: ct("Text", "Text"),
  };
  return tiles.map((tile) => {
    const source =
      "source" in tile ? sourceTitle(tile.source, tile.type === "journal" ? "journal" : "database") : null;
    return {
      title: tile.title || labels[tile.type],
      kind: labels[tile.type],
      source: "source" in tile ? source || ct("Nicht verfügbar", "Not available") : null,
      text: tile.type === "text" ? tile.text : "",
    };
  });
}
