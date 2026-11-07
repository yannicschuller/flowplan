// A readable copy of chosen pages and databases outside Flowplan: with the
// daily backup (and "Back up now"), each chosen page becomes a Markdown ZIP
// with its sub-pages (lib/markdown-export.ts), as the administrator who set
// it up may read it. With S3 into <prefix>/exports/ in the bucket, without
// into exports/ in the data folder; as many copies are kept as backups.
// Paths inside the ZIP carry ids, so unpacked into a Git working copy the
// diff between two runs stays clean. With FLOWPLAN_ENCRYPTION_KEY the ZIPs
// are encrypted (….zip.enc); the copy pushed to Git is not.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { lockedPageIds } from "./journal-extras";
import { exportFolder, exportMarkdown } from "./markdown-export";
import { instanceSettings } from "./instance-settings";
import { bucketFetch, storageConfig } from "./storage";
import { withContentLocale } from "./content-locale";
import { fixedLanguage, userLocale } from "./user-locale";
import { gitConfig, syncGit, type GitRun } from "./git-export";
import { encryptionEnabled, seal } from "./encryption";
import type { Identity, Page, User } from "./types";
import { filterAsync, mapAsync } from "./each-async";

const dataDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
type Config = { userId: string; pageIds: string[] };
export type ExportRun = { pageId: string; name: string; at: number; bytes: number; error: string | null };

async function state<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>("SELECT value FROM instance_state WHERE key=?", key);
  return row ? (JSON.parse(row.value) as T) : null;
}
async function store(key: string, value: unknown) {
  await run(
    "INSERT INTO instance_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify(value),
  );
}

// The administrator who saves the choice is the one the export reads as.
export async function setMarkdownExport(admin: Identity, input: unknown) {
  if (!admin.isAdmin) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  if (admin.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  // Pages that were deleted since the choice was made drop out silently
  // (a page restored later has to be chosen again); the rest still has to
  // be readable by the administrator.
  const pageIds = await filterAsync([...new Set(z.array(z.uuid()).max(50).parse(input))], async (pageId) =>
    await one("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", pageId),
  );
  for (const pageId of pageIds) await requirePage(admin, pageId);
  if (pageIds.length) await store("markdownExport", { userId: admin.id, pageIds } satisfies Config);
  else await run("DELETE FROM instance_state WHERE key='markdownExport'");
  return await markdownExportStatus();
}

// Pages the administrator may choose: everything they may read.
export async function exportablePages(admin: Identity) {
  const workspaces = await all<{ id: string; name: string }>("SELECT id,name FROM workspaces");
  const result: { id: string; title: string; kind: string; workspace: string; parent: string }[] = [];
  for (const workspace of workspaces) {
    const locked = await lockedPageIds(admin, workspace.id);
    const pages = await filterAsync(await all<Page>(
      "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 AND journal_date IS NULL ORDER BY position",
      workspace.id,
    ), async (page) => !locked.has(page.id) && await pageRole(admin, page));
    const titles = new Map(pages.map((p) => [p.id, p.title]));
    for (const page of pages)
      if (["document", "database", "journal"].includes(page.kind))
        result.push({ id: page.id, title: page.title, kind: page.kind, workspace: workspace.name, parent: page.parent_id ? titles.get(page.parent_id) || "" : "" });
    if (result.length > 2000) break;
  }
  return result;
}

export async function markdownExportStatus() {
  const config = await state<Config>("markdownExport");
  const owner = config ? (await one<{ name: string }>("SELECT name FROM users WHERE id=?", config.userId)) : null;
  const titles = new Map(
    await mapAsync((config?.pageIds || []), async (pid) => [pid, (await one<{ title: string }>("SELECT title FROM pages WHERE id=? AND deleted_at IS NULL", pid))?.title ?? null]),
  );
  return {
    pages: (config?.pageIds || []).map((pid) => ({ id: pid, title: titles.get(pid) })),
    owner: owner?.name || null,
    runs: await state<ExportRun[]>("markdownExportRuns") || [],
    git: await gitStatus(),
  };
}

async function gitStatus() {
  let config: Awaited<ReturnType<typeof gitConfig>> = null;
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
    last: await state<GitRun>("gitExportRun"),
  };
}
// The stored administrator as they would be signed in, without SSO groups:
// reading pages depends on memberships and grants, not on groups.
async function exporter(userId: string): Promise<Identity | null> {
  const user = await one<User>("SELECT * FROM users WHERE id=? AND disabled=0", userId);
  return user ? { ...user, groups: [], isAdmin: false } : null;
}

async function listBucket(prefix: string) {
  const response = await bucketFetch(`?list-type=2&prefix=${encodeURIComponent(prefix)}`, { method: "GET" });
  if (!response.ok) throw new Error(`Liste der Exporte: HTTP ${response.status}`);
  return [...(await response.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

export async function lastMarkdownExport() {
  return (await state<ExportRun[]>("markdownExportRuns"))?.[0]?.at ?? null;
}
const zipName = (name: string) => name.endsWith(".zip") || name.endsWith(".zip.enc");

export async function runMarkdownExports(now = Date.now()): Promise<ExportRun[]> {
  const config = await state<Config>("markdownExport");
  if (!config?.pageIds.length) return [];
  const keep = Math.max(1, (await instanceSettings()).backupKeep ?? 7);
  const user = await exporter(config.userId);
  // README, labels, comment and version files in the language of the
  // administrator who set the export up (German if never known).
  const locale = await fixedLanguage(config.userId) ?? await userLocale(config.userId);
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const storage = storageConfig();
  const runs: ExportRun[] = [];
  const done: { pageId: string; folder: string; bytes: Buffer }[] = [];
  for (const pageId of config.pageIds) {
    const title = (await one<{ title: string }>("SELECT title FROM pages WHERE id=?", pageId))?.title || pageId;
    // Stable per page (the id), readable (the title), sortable (the date).
    const base = exportFolder({ id: pageId, title });
    let name = `${base}-${stamp}.zip`;
    try {
      if (!user) throw new Error("Das Konto, das den Export eingerichtet hat, gibt es nicht mehr oder es ist deaktiviert.");
      const encrypted = encryptionEnabled();
      if (encrypted) name += ".enc";
      const { bytes } = await withContentLocale(locale, () => exportMarkdown(user, { pageId, format: "zip", includeSubpages: true, history: true }));
      const stored = seal(bytes as Buffer);
      if (storage) {
        const response = await bucketFetch(`exports/${name}`, {
          method: "PUT",
          body: new Uint8Array(stored),
          headers: { "Content-Type": encrypted ? "application/octet-stream" : "application/zip" },
        });
        if (!response.ok) throw new Error(`Hochladen: HTTP ${response.status}`);
        const prefix = storage.prefix ? `${storage.prefix}/` : "";
        const keys = (await listBucket(`${prefix}exports/${base}-`)).filter(zipName).sort();
        for (const key of keys.slice(0, Math.max(0, keys.length - keep))) await bucketFetch(key.slice(prefix.length), { method: "DELETE" });
      } else {
        const folder = resolve(dataDir(), "exports");
        mkdirSync(folder, { recursive: true });
        writeFileSync(resolve(folder, name), stored);
        const files = readdirSync(folder)
          .filter((f) => f.startsWith(`${base}-`) && zipName(f))
          .sort();
        for (const file of files.slice(0, Math.max(0, files.length - keep))) rmSync(resolve(folder, file));
      }
      runs.push({ pageId, name, at: now, bytes: stored.length, error: null });
      done.push({ pageId, folder: base, bytes: bytes as Buffer });
    } catch (error) {
      runs.push({ pageId, name, at: now, bytes: 0, error: String((error as Error).message || error).slice(0, 300) });
    }
  }
  await store("markdownExportRuns", runs);
  // Into the Git repository, when one is configured (lib/git-export.ts).
  let config_: Awaited<ReturnType<typeof gitConfig>> = null;
  try {
    config_ = gitConfig();
  } catch (error) {
    await store("gitExportRun", { at: now, commit: null, pushed: false, imported: 0, error: (error as Error).message } satisfies GitRun);
  }
  if (config_ && user && done.length) await store("gitExportRun", await syncGit(user, done, await state<GitRun>("gitExportRun")));
  return runs;
}
