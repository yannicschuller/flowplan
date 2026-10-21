// Git for the scheduled Markdown export: Flowplan keeps a working copy of a
// repository (Forgejo, Gitea, GitHub, GitLab …), writes every exported page
// into its own folder, commits and pushes. Optionally it first takes over
// what people changed in the repository since the last run: records by
// their flowplan.id (or new ones), documents by the id in their file name.
//
// Configured by the administrator of the server, not in the interface, so
// the access token never lands in the database or a backup:
//   EXPORT_GIT_URL      https://git.example.org/family/notes.git
//   EXPORT_GIT_TOKEN    a token with write access to that repository
//   EXPORT_GIT_USERNAME the user name for the token (default "flowplan")
//   EXPORT_GIT_BRANCH   default "main"
//   EXPORT_GIT_IMPORT   "true": take over changes made in the repository
//
// Deprecated in favour of the Git export each space owner sets up for
// their space (lib/space-git-export.ts, SPACE_GIT_EXPORT); keeps working.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { dirname, posix, resolve } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { HttpClient } from "isomorphic-git";
import { id, one, run, transaction } from "./db";
import { readZip } from "./archive";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { htmlState } from "./document-server";
import { documentChanged } from "./document-live";
import { markdownToHtml } from "./markdown-import";
import { splitFrontmatter } from "./frontmatter";
import { frontmatterAliases, pageAliases, storedAliases } from "./aliases";
import { importMarkdownRecords } from "./markdown-records";
import type { Identity } from "./types";

export type GitConfig = { url: string; branch: string; username: string; token: string; importChanges: boolean };
export function gitConfig(): GitConfig | null {
  const url = process.env.EXPORT_GIT_URL?.trim();
  if (!url) return null;
  // Plain http only for tests against a local server, never in production.
  const scheme = process.env.FLOWPLAN_GIT_ALLOW_HTTP === "1" && process.env.NODE_ENV !== "production" ? "https?" : "https";
  if (!new RegExp(`^${scheme}:\\/\\/[^\\s/@]+(\\/[^\\s]*)?$`).test(url)) throw new Error("EXPORT_GIT_URL muss eine https-Adresse ohne Zugangsdaten sein.");
  return {
    url,
    branch: process.env.EXPORT_GIT_BRANCH?.trim() || "main",
    username: process.env.EXPORT_GIT_USERNAME?.trim() || "flowplan",
    token: process.env.EXPORT_GIT_TOKEN || "",
    importChanges: process.env.EXPORT_GIT_IMPORT === "true",
  };
}

const dir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "git-export");
const author = () => ({ name: process.env.EXPORT_GIT_AUTHOR || "Flowplan", email: process.env.EXPORT_GIT_EMAIL || "flowplan@localhost" });
export type GitRun = { at: number; commit: string | null; pushed: boolean; imported: number; error: string | null };

// Where a working copy lives and how it reaches its remote. The instance
// export uses <data>/git-export with the default transport, the export of
// a space (lib/space-git-export.ts) a folder of its own and a transport
// that refuses internal addresses.
export type GitTarget = { dir: string; url: string; branch: string; username: string; token: string; http?: HttpClient };

// Brings the working copy to the state of the remote branch.
export async function prepareRepo(target: GitTarget) {
  const dir = target.dir;
  const options = { fs, http: target.http || http, dir, onAuth: () => ({ username: target.username, password: target.token }) };
  if (!existsSync(resolve(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await git.init({ fs, dir, defaultBranch: target.branch });
    await git.addRemote({ fs, dir, remote: "origin", url: target.url });
  } else await git.setConfig({ fs, dir, path: "remote.origin.url", value: target.url });
  let remote: string | null = null;
  try {
    await git.fetch({ ...options, remote: "origin", ref: target.branch, singleBranch: true, tags: false });
    remote = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${target.branch}` });
  } catch (error) {
    // An empty repository has no branch yet: the first push creates it.
    if (!/NotFoundError|Could not find|couldn't find|ref/i.test(String((error as Error).message || error))) throw error;
  }
  if (remote) {
    await git.writeRef({ fs, dir, ref: `refs/heads/${target.branch}`, value: remote, force: true });
    await git.checkout({ fs, dir, ref: target.branch, force: true });
  }
  return { options, remote };
}
const prepare = (config: GitConfig) => prepareRepo({ ...config, dir: dir() });

// Stages everything that changed in the working copy, deletions included,
// and pushes one commit – only when something changed, or with `always`
// (the first export into an empty repository).
export async function commitAndPush(target: GitTarget, options: Awaited<ReturnType<typeof prepareRepo>>["options"], at: number, always = false) {
  const status = await git.statusMatrix({ fs, dir: target.dir });
  let changes = 0;
  for (const [file, head, workdir, stage] of status) {
    if (head === 1 && workdir === 1 && stage === 1) continue;
    if (workdir === 0) await git.remove({ fs, dir: target.dir, filepath: file });
    else await git.add({ fs, dir: target.dir, filepath: file });
    changes++;
  }
  if (!changes && !always) return { commit: null, changes };
  const commit = await git.commit({
    fs,
    dir: target.dir,
    author: author(),
    message: `Flowplan export ${new Date(at).toISOString().slice(0, 16).replace("T", " ")}`,
  });
  await git.push({ ...options, remote: "origin", ref: target.branch, remoteRef: target.branch });
  return { commit, changes };
}

// Markdown files that changed in the repository between two commits, read
// from Git's object store (never from the working copy: a symlink there
// could point anywhere on the server). Only regular files count, and only
// what Flowplan exported itself at `from`: existing files, or new records in
// a database folder that was part of the export – a repository cannot reach
// other pages or databases by naming their ids in a path.
async function changedFiles(from: string, to: string) {
  const changed: { path: string; text: string }[] = [];
  const known = new Set<string>(),
    folders = new Set<string>();
  const candidates: { path: string; existed: boolean }[] = [];
  await git.walk({
    fs,
    dir: dir(),
    trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
    map: async (path, [a, b]) => {
      if (path === ".") return true;
      const [typeA, typeB] = [await a?.type(), await b?.type()];
      if (typeA === "tree" || typeB === "tree") return true;
      if (typeA === "blob" && (await a?.mode()) !== 0o120000) {
        known.add(path);
        folders.add(posix.dirname(path));
      }
      // 0o120000: a symbolic link.
      if (typeB !== "blob" || (await b?.mode()) === 0o120000 || !path.endsWith(".md")) return true;
      if ((await a?.oid()) !== (await b?.oid())) candidates.push({ path, existed: typeA === "blob" });
      return true;
    },
  });
  for (const { path, existed } of candidates) {
    const newRecord = !existed && /\/records\/[0-9a-f-]{36}$/.test(posix.dirname(path)) && folders.has(posix.dirname(path));
    if (!(existed && known.has(path)) && !newRecord) continue;
    const { blob } = await git.readBlob({ fs, dir: dir(), oid: to, filepath: path });
    if (blob.length > 2_000_000) continue;
    changed.push({ path, text: Buffer.from(blob).toString("utf8") });
  }
  return changed;
}

function readableBoard(user: Identity, id: string) {
  try {
    return requirePage(user, id).kind === "whiteboard";
  } catch {
    return false;
  }
}
// A document page from its exported file: the text below the title, without
// the list of sub-pages. The previous state is kept as a version.
function updateDocument(user: Identity, pageId: string, markdown: string) {
  const page = requirePage(user, pageId, true);
  if (page.kind !== "document" || page.locked) return false;
  // Journal days behind a PIN stay untouched.
  requireUnlocked(user, page);
  const { data, body: text } = splitFrontmatter(markdown);
  // Aliases come back from the frontmatter (the export writes them there).
  const aliases = frontmatterAliases(data);
  const aliasesChanged = JSON.stringify(aliases) !== JSON.stringify(pageAliases(page));
  if (aliasesChanged) run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(aliases), page.id);
  const body = text.replace(/^\s*#\s+[^\n]*\n+/, "")
    .replace(/\n+## (Unterseiten|Sub-pages)\n[\s\S]*$/, "");
  const html = markdownToHtml(
    body.replace(/^!\[Cover\]\([^)]*\)\n+/, ""),
    (href) => (/^(https?:|mailto:|\/#page=)/i.test(href) ? href : null),
    // Embedded boards come back as embeds when this person may read them.
    { whiteboard: (id) => one<{ workspace_id: string; kind: string }>("SELECT workspace_id,kind FROM pages WHERE id=? AND deleted_at IS NULL", id)?.workspace_id === page.workspace_id && readableBoard(user, id) },
  );
  const current = one<{ html: string; state: Uint8Array | null }>("SELECT html,state FROM documents WHERE page_id=?", page.id);
  if (!current || current.html === html) return aliasesChanged;
  run(
    "INSERT INTO snapshots(id,page_id,state,html,title,created_by,kind) VALUES(?,?,?,?,?,?,'manual')",
    id(),
    page.id,
    current.state || htmlState(current.html),
    current.html,
    page.title,
    user.id,
  );
  run("UPDATE documents SET state=?,html=?,generation=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?", htmlState(html), html, id(), page.id);
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
  documentChanged(page.id);
  return true;
}

// Takes over files changed in the repository: records (by flowplan.id, or
// new ones) and document pages. Database tables (index.md of a database)
// and comment and version files are read-only copies.
async function importChanges(user: Identity, folders: Map<string, string>, from: string, to: string) {
  let imported = 0;
  for (const { path, text } of await changedFiles(from, to)) {
    const [folder, ...rest] = path.split("/");
    // Folders end with the start of the page id; the title part may change.
    const rootId = folders.get(folder.split("-").pop() || "");
    if (!rootId || /\.comments\.md$|\.versions\//.test(path)) continue;
    const inside = rest.join("/");
    try {
      const record = /^records\/([0-9a-f-]{36})\/[^/]+\.md$/.exec(inside);
      if (record) {
        const result = importMarkdownRecords(user, record[1], new Map([[posix.basename(inside), Buffer.from(text)]]), { updateExisting: true });
        imported += (result.created || 0) + (result.updated || 0);
        continue;
      }
      const page = inside === "index.md" ? rootId : /^pages\/.*-([0-9a-f-]{36})\.md$/.exec(inside)?.[1];
      if (page && transaction(() => updateDocument(user, page, text), user)) imported++;
    } catch (error) {
      console.error("Git import skipped", path, (error as Error).message);
    }
  }
  return imported;
}

// Exports go into <folder>/ of the working copy; folders of pages no longer
// exported are left alone.
export async function syncGit(
  user: Identity,
  exports: { pageId: string; folder: string; bytes: Buffer }[],
  last: GitRun | null,
): Promise<GitRun> {
  const at = Date.now();
  const config = gitConfig();
  if (!config) return { at, commit: null, pushed: false, imported: 0, error: null };
  try {
    if (!config.token) throw new Error("EXPORT_GIT_TOKEN fehlt.");
    const { options, remote } = await prepare(config);
    let imported = 0;
    if (config.importChanges && remote && last?.commit && last.commit !== remote)
      imported = await importChanges(user, new Map(exports.map((e) => [e.pageId.slice(0, 8), e.pageId])), last.commit, remote);
    for (const item of exports) {
      const target = resolve(dir(), item.folder);
      // The previous copy of this page, also under an older title.
      for (const old of readdirSync(dir()))
        if (old !== ".git" && old.endsWith(`-${item.pageId.slice(0, 8)}`)) rmSync(resolve(dir(), old), { recursive: true, force: true });
      for (const [name, data] of await readZip(item.bytes, { foreign: true, maxEntries: 20000 })) {
        const path = resolve(target, name);
        if (!path.startsWith(target + "/")) continue;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
      }
    }
    const pushed = await commitAndPush({ ...config, dir: dir() }, options, at, !remote);
    const commit = pushed.commit ?? remote;
    const changes = pushed.changes;
    return { at, commit, pushed: !!changes || !remote, imported, error: null };
  } catch (error) {
    return { at, commit: last?.commit ?? null, pushed: false, imported: 0, error: String((error as Error).message || error).slice(0, 300) };
  }
}

export function gitStatusFiles() {
  return existsSync(dir()) ? readdirSync(dir()).filter((f) => f !== ".git").length : 0;
}
