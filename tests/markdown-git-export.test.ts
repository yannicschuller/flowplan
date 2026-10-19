import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-git-export-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { exportMarkdown } = await import("../lib/markdown-export");
const { setMarkdownExport, runMarkdownExports, markdownExportStatus, exportablePages } = await import("../lib/scheduled-markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");

function person(name: string, admin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: admin, disabled: 0, created_at: "" } as Identity;
}
const admin = person("Ada", true);
const wid = createWorkspace(admin.id, "Familie");
const space = bootstrap(admin, wid).spaces[0].id;
const act = (b: Record<string, unknown>) => command(admin, { workspaceId: wid, ...b }) as Record<string, unknown>;
const house = String(act({ action: "page.create", spaceId: space, title: "Haus", kind: "document" }).id);
const write = (pageId: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
write(house, "<p>Heizung im Keller.</p>");
act({ action: "page.snapshot", pageId: house });
write(house, "<p>Heizung im Keller, Wartung im Herbst.</p>");
act({ action: "comment.create", pageId: house, body: "Termin vereinbaren" });
const notes = String(act({ action: "page.create", spaceId: space, title: "Notizen", kind: "database", databaseKind: "documents", parentId: house }).id);
const record = String(act({ action: "row.create", pageId: notes, cells: { title: "Versicherung" } }).id);

test("the ZIP export can carry comments and earlier versions", async () => {
  const { bytes } = await exportMarkdown(admin, { pageId: house, format: "zip", includeSubpages: true, history: true });
  const files = await readExportZip(bytes as Buffer);
  const comments = files.get("index.comments.md")?.toString("utf8") || "";
  assert.match(comments, /# Kommentare – Haus/);
  assert.match(comments, /## Ada · .*\n\nTermin vereinbaren/);
  const versions = [...files.keys()].filter((name) => name.startsWith("index.versions/"));
  assert.equal(versions.length, 1);
  assert.match(files.get(versions[0])!.toString("utf8"), /Heizung im Keller\./);
  // Without the option, neither is there.
  const plain = await readExportZip((await exportMarkdown(admin, { pageId: house, format: "zip", includeSubpages: true })).bytes as Buffer);
  assert.ok(![...plain.keys()].some((name) => /\.comments\.md$|\.versions\//.test(name)));
});

test("the scheduled export writes ZIPs next to the backups and keeps as many", async () => {
  const member = person("Ben");
  assert.throws(() => setMarkdownExport(member, [house]), /Administrator/);
  assert.ok(exportablePages(admin).some((p) => p.id === house));
  setMarkdownExport(admin, [house]);
  assert.equal(markdownExportStatus().owner, "Ada");
  run("INSERT INTO instance_settings(key,value) VALUES('backupKeep','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const day of [1, 2, 3]) {
    const [result] = await runMarkdownExports(Date.UTC(2026, 9, day, 3));
    assert.equal(result.error, null);
  }
  const folder = join(process.env.FLOWPLAN_DATA_DIR!, "exports");
  const zips = readdirSync(folder).sort();
  assert.equal(zips.length, 2);
  assert.match(zips[1], /^Haus-[0-9a-f]{8}-2026-10-03-03-00\.zip$/);
  assert.equal(markdownExportStatus().runs[0].error, null);
});

// A Git server for the test, in a process of its own (needs git's
// http-backend, which comes with git on Linux).
const backend = "/usr/lib/git-core/git-http-backend";
const repos = mkdtempSync(join(tmpdir(), "flowplan-git-remote-"));
let port = 0;
if (existsSync(backend)) {
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", join(repos, "notes.git")]);
  execFileSync("git", ["config", "--file", join(repos, "notes.git", "config"), "http.receivepack", "true"]);
  const gitServer = spawn(process.execPath, [join(import.meta.dirname, "helpers", "git-http-server.mjs"), repos, "secret-token"]);
  port = await new Promise<number>((done) => gitServer.stdout.once("data", (d: Buffer) => done(Number(String(d).trim()))));
  after(() => gitServer.kill());
}

test("exports are pushed to Git, and changes made there come back", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  // https only in production; the test server speaks http on localhost.
  process.env.EXPORT_GIT_URL = `http://127.0.0.1:${port}/notes.git`;
  process.env.EXPORT_GIT_TOKEN = "secret-token";
  process.env.EXPORT_GIT_IMPORT = "true";
  process.env.FLOWPLAN_GIT_ALLOW_HTTP = "1";
  await runMarkdownExports(Date.UTC(2026, 9, 4, 3));
  const status = markdownExportStatus().git;
  assert.equal(status.last?.error, null, String(status.last?.error));
  assert.equal(status.last?.pushed, true);
  // A person edits the copy in Git: the record and the page.
  const clone = mkdtempSync(join(tmpdir(), "flowplan-git-clone-"));
  const auth = `http://flowplan:secret-token@127.0.0.1:${port}/notes.git`;
  execFileSync("git", ["clone", "-q", auth, clone]);
  const folder = readdirSync(clone).find((f) => f.startsWith("Haus-"))!;
  assert.ok(existsSync(join(clone, folder, "index.md")));
  const recordDir = join(clone, folder, "records", notes);
  const recordFile = join(recordDir, readdirSync(recordDir).find((f) => f.endsWith(".md") && !f.includes(".versions"))!);
  writeFileSync(recordFile, readFileSync(recordFile, "utf8").replace("# Versicherung", "# Versicherung\n\nPolice Nr. 42"));
  writeFileSync(join(clone, folder, "index.md"), readFileSync(join(clone, folder, "index.md"), "utf8").replace("Wartung im Herbst", "Wartung im Frühjahr"));
  execFileSync("git", ["-C", clone, "-c", "user.name=Ben", "-c", "user.email=ben@example.test", "commit", "-qam", "Notes"]);
  execFileSync("git", ["-C", clone, "push", "-q", "origin", "HEAD:main"]);

  await runMarkdownExports(Date.UTC(2026, 9, 5, 3));
  const second = markdownExportStatus().git.last!;
  assert.equal(second.error, null, String(second.error));
  assert.equal(second.imported, 2);
  assert.match(one<{ content: string }>("SELECT content FROM rows WHERE id=?", record)!.content, /Police Nr\. 42/);
  assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", house)!.html, /Wartung im Frühjahr/);
  // The previous text stays as a version.
  assert.ok(one("SELECT 1 FROM snapshots WHERE page_id=? AND html LIKE '%Wartung im Herbst%'", house));
  // The remote history has both: Flowplan's export and the person's edit.
  execFileSync("git", ["-C", clone, "pull", "-q", "origin", "main"]);
  const log = execFileSync("git", ["-C", clone, "log", "--format=%s"]).toString();
  assert.match(log, /Notes/);
  assert.match(log, /Flowplan export/);
});

test("a repository cannot read server files or reach pages it was not given", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  const other = String(act({ action: "page.create", spaceId: space, title: "Nicht exportiert", kind: "document" }).id);
  write(other, "<p>Bleibt so.</p>");
  const otherDb = String(act({ action: "page.create", spaceId: space, title: "Andere Datenbank", kind: "database" }).id);
  const before = one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", otherDb)!.n;
  const clone = mkdtempSync(join(tmpdir(), "flowplan-git-attack-"));
  execFileSync("git", ["clone", "-q", `http://flowplan:secret-token@127.0.0.1:${port}/notes.git`, clone]);
  const folder = readdirSync(clone).find((f) => f.startsWith("Haus-"))!;
  // A symlink to a file outside the working copy …
  const secretFile = join(mkdtempSync(join(tmpdir(), "flowplan-secret-")), "secret.txt");
  writeFileSync(secretFile, "TOP-SECRET-ENV");
  execFileSync("rm", [join(clone, folder, "index.md")]);
  execFileSync("ln", ["-s", secretFile, join(clone, folder, "index.md")]);
  // … a page and a database that were never exported, named by id.
  mkdirSync(join(clone, folder, "pages"), { recursive: true });
  writeFileSync(join(clone, folder, "pages", `x-${other}.md`), "# Nicht exportiert\n\nÜBERSCHRIEBEN\n");
  mkdirSync(join(clone, folder, "records", otherDb), { recursive: true });
  writeFileSync(join(clone, folder, "records", otherDb, "neu.md"), "---\ntitle: Eingeschleust\n---\n# Eingeschleust\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "-c", "user.name=Eve", "-c", "user.email=eve@example.test", "commit", "-qm", "Attack"]);
  execFileSync("git", ["-C", clone, "push", "-q", "origin", "HEAD:main"]);
  await runMarkdownExports(Date.UTC(2026, 9, 6, 3));
  assert.doesNotMatch(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", house)!.html, /TOP-SECRET-ENV/);
  assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", other)!.html, /Bleibt so/);
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", otherDb)!.n, before);
});
