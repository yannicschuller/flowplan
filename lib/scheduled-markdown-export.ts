// A readable copy of chosen pages and databases outside Flowplan: with the
// daily backup (and "Back up now"), each chosen page becomes a Markdown ZIP
// with its sub-pages (lib/markdown-export.ts), as the administrator who set
// it up may read it. With S3 into <prefix>/exports/ in the bucket, without
// into exports/ in the data folder; as many copies are kept as backups.
// Paths inside the ZIP carry ids, so unpacked into a Git working copy the
// diff between two runs stays clean.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { lockedPageIds } from "./journal-extras";
import { exportMarkdown } from "./markdown-export";
import { exportName } from "./export-name";
import { instanceSettings } from "./instance-settings";
import { bucketFetch, storageConfig } from "./storage";
import { withContentLocale } from "./content-locale";
import { gitConfig, syncGit, type GitRun } from "./git-export";
import type { Identity, Page, User } from "./types";

const dataDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
type Config = { userId: string; pageIds: string[] };
export type ExportRun = { pageId: string; name: string; at: number; bytes: number; error: string | null };

function state<T>(key: string): T | null {
  const row = one<{ value: string }>("SELECT value FROM instance_state WHERE key=?", key);
  return row ? (JSON.parse(row.value) as T) : null;
}
function store(key: string, value: unknown) {
  run(
    "INSERT INTO instance_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify(value),
  );
}

// The administrator who saves the choice is the one the export reads as.
export function setMarkdownExport(admin: Identity, input: unknown) {
  if (!admin.isAdmin) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  if (admin.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  const pageIds = [...new Set(z.array(z.uuid()).max(50).parse(input))];
  for (const pageId of pageIds) requirePage(admin, pageId);
  if (pageIds.length) store("markdownExport", { userId: admin.id, pageIds } satisfies Config);
  else run("DELETE FROM instance_state WHERE key='markdownExport'");
  return markdownExportStatus();
}

// Pages the administrator may choose: everything they may read.
export function exportablePages(admin: Identity) {
  const workspaces = all<{ id: string; name: string }>("SELECT id,name FROM workspaces");
  const result: { id: string; title: string; kind: string; workspace: string; parent: string }[] = [];
  for (const workspace of workspaces) {
    const locked = lockedPageIds(admin, workspace.id);
    const pages = all<Page>(
      "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 AND journal_date IS NULL ORDER BY position",
      workspace.id,
    ).filter((page) => !locked.has(page.id) && pageRole(admin, page));
    const titles = new Map(pages.map((p) => [p.id, p.title]));
    for (const page of pages)
      if (["document", "database", "journal"].includes(page.kind))
        result.push({ id: page.id, title: page.title, kind: page.kind, workspace: workspace.name, parent: page.parent_id ? titles.get(page.parent_id) || "" : "" });
    if (result.length > 2000) break;
  }
  return result;
}

export function markdownExportStatus() {
  const config = state<Config>("markdownExport");
  const owner = config ? one<{ name: string }>("SELECT name FROM users WHERE id=?", config.userId) : null;
  const titles = new Map(
    (config?.pageIds || []).map((pid) => [pid, one<{ title: string }>("SELECT title FROM pages WHERE id=? AND deleted_at IS NULL", pid)?.title ?? null]),
  );
  return {
    pages: (config?.pageIds || []).map((pid) => ({ id: pid, title: titles.get(pid) })),
    owner: owner?.name || null,
    runs: state<ExportRun[]>("markdownExportRuns") || [],
    git: gitStatus(),
  };
}

function gitStatus() {
  let config: ReturnType<typeof gitConfig> = null;
  let problem = "";
  try {
    config = gitConfig();
  } catch (error) {
    problem = (error as Error).message;
  }
  return {
    configured: !!config,
    url: config?.url || null,
    branch: config?.branch || null,
    importChanges: !!config?.importChanges,
    problem: problem || (config && !config.token ? "EXPORT_GIT_TOKEN fehlt." : null),
    last: state<GitRun>("gitExportRun"),
  };
}
// The stored administrator as they would be signed in, without SSO groups:
// reading pages depends on memberships and grants, not on groups.
function exporter(userId: string): Identity | null {
  const user = one<User>("SELECT * FROM users WHERE id=? AND disabled=0", userId);
  return user ? { ...user, groups: [], isAdmin: false } : null;
}

async function listBucket(prefix: string) {
  const response = await bucketFetch(`?list-type=2&prefix=${encodeURIComponent(prefix)}`, { method: "GET" });
  if (!response.ok) throw new Error(`Liste der Exporte: HTTP ${response.status}`);
  return [...(await response.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

export async function runMarkdownExports(now = Date.now()): Promise<ExportRun[]> {
  const config = state<Config>("markdownExport");
  if (!config?.pageIds.length) return [];
  const keep = Math.max(1, instanceSettings().backupKeep ?? 7);
  const user = exporter(config.userId);
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const storage = storageConfig();
  const runs: ExportRun[] = [];
  const done: { pageId: string; folder: string; bytes: Buffer }[] = [];
  for (const pageId of config.pageIds) {
    const title = one<{ title: string }>("SELECT title FROM pages WHERE id=?", pageId)?.title || pageId;
    // Stable per page (the id), readable (the title), sortable (the date).
    const base = `${exportName(title).slice(0, 60)}-${pageId.slice(0, 8)}`;
    const name = `${base}-${stamp}.zip`;
    try {
      if (!user) throw new Error("Das Konto, das den Export eingerichtet hat, gibt es nicht mehr oder es ist deaktiviert.");
      const { bytes } = await withContentLocale("de", () => exportMarkdown(user, { pageId, format: "zip", includeSubpages: true, history: true }));
      if (storage) {
        const response = await bucketFetch(`exports/${name}`, { method: "PUT", body: new Uint8Array(bytes), headers: { "Content-Type": "application/zip" } });
        if (!response.ok) throw new Error(`Hochladen: HTTP ${response.status}`);
        const prefix = storage.prefix ? `${storage.prefix}/` : "";
        const keys = (await listBucket(`${prefix}exports/${base}-`)).filter((k) => k.endsWith(".zip")).sort();
        for (const key of keys.slice(0, Math.max(0, keys.length - keep))) await bucketFetch(key.slice(prefix.length), { method: "DELETE" });
      } else {
        const folder = resolve(dataDir(), "exports");
        mkdirSync(folder, { recursive: true });
        writeFileSync(resolve(folder, name), bytes);
        const files = readdirSync(folder)
          .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".zip"))
          .sort();
        for (const file of files.slice(0, Math.max(0, files.length - keep))) rmSync(resolve(folder, file));
      }
      runs.push({ pageId, name, at: now, bytes: bytes.length, error: null });
      done.push({ pageId, folder: base, bytes });
    } catch (error) {
      runs.push({ pageId, name, at: now, bytes: 0, error: String((error as Error).message || error).slice(0, 300) });
    }
  }
  store("markdownExportRuns", runs);
  // Into the Git repository, when one is configured (lib/git-export.ts).
  let config_: ReturnType<typeof gitConfig> = null;
  try {
    config_ = gitConfig();
  } catch (error) {
    store("gitExportRun", { at: now, commit: null, pushed: false, imported: 0, error: (error as Error).message } satisfies GitRun);
  }
  if (config_ && user && done.length) store("gitExportRun", await syncGit(user, done, state<GitRun>("gitExportRun")));
  return runs;
}
