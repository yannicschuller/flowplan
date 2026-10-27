// Journal days in Markdown exports sort by their path (#49):
// <journal folder>/2026/10/2026-10-27.md – in the page and space ZIP, the
// scheduled export and its Git repository – and come back: the Git
// re-import finds them (new and old paths), the ZIP import makes them days.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-export-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal } = await import("../lib/journal");
const { exportMarkdown, exportFolder } = await import("../lib/markdown-export");
const { importZip } = await import("../lib/zip-import");
const { writeZip } = await import("../lib/archive");
const { withContentLocale } = await import("../lib/content-locale");
const { setMarkdownExport, runMarkdownExports, markdownExportStatus } = await import("../lib/scheduled-markdown-export");
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
const page = (pageId: string) => one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;
const html = (pageId: string) => String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html);
const write = (pageId: string, body: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), pageId);
const dayCount = (journalId: string) => one<{ n: number }>("SELECT count(*) n FROM pages WHERE parent_id=? AND journal_date IS NOT NULL AND deleted_at IS NULL", journalId)!.n;

const journal = String(act({ action: "page.create", spaceId: space, title: "Tagebuch", kind: "journal" }).id);
write(journal, "<p>Mein Jahr.</p>");
const days = new Map<string, string>();
for (const [date, text] of [
  ["2026-09-30", "Herbstanfang am See."],
  ["2026-10-26", "Laub gerecht."],
  ["2026-10-27", "Kürbissuppe gekocht."],
]) {
  const dayId = rollJournal(admin, page(journal), date, date).dayId;
  write(dayId, `<p>${text}</p>`);
  days.set(date, dayId);
}
// A link from one day to another stays a relative link.
write(days.get("2026-10-27")!, `<p>Kürbissuppe gekocht, wie <a href="/#page=${days.get("2026-10-26")}">gestern</a> geplant.</p>`);
// A journal below another page.
const house = String(act({ action: "page.create", spaceId: space, title: "Haus", kind: "document" }).id);
const logbook = String(act({ action: "page.create", spaceId: space, title: "Baulogbuch", kind: "journal", parentId: house }).id);
const logDay = rollJournal(admin, page(logbook), "2026-10-20", "2026-10-20").dayId;
write(logDay, "<p>Estrich gegossen.</p>");

test("a journal's days are exported as <journal folder>/YYYY/MM/YYYY-MM-DD.md with their localized title", async () => {
  const files = await readExportZip(
    (await withContentLocale("en", () => exportMarkdown(admin, { pageId: journal, format: "zip", includeSubpages: true }))).bytes as Buffer,
  );
  const names = [...files.keys()].filter((n) => n.endsWith(".md")).sort();
  assert.deepEqual(names, ["2026/09/2026-09-30.md", "2026/10/2026-10-26.md", "2026/10/2026-10-27.md", "index.md"]);
  const day = files.get("2026/10/2026-10-27.md")!.toString("utf8");
  // Named in German when it was created; exported in the export's language.
  assert.match(day, /^---\nflowplan:\n {2}id: [0-9a-f-]{36}\n {2}date: "?2026-10-27"?\n---\n\n# Tuesday, 27 October 2026\n/);
  assert.match(day, /\[gestern\]\(<?2026-10-26\.md>?\)/);
  // The journal lists its days with the new paths.
  assert.match(files.get("index.md")!.toString("utf8"), /\(<?2026\/10\/2026-10-27\.md>?\)/);
  assert.match(files.get("README.txt")!.toString("utf8"), /<year>\/<month>\/<date>\.md/);
  // A renamed day keeps its own title.
  run("UPDATE pages SET title='Kürbistag' WHERE id=?", days.get("2026-10-27")!);
  const renamed = await readExportZip((await exportMarkdown(admin, { pageId: journal, format: "zip", includeSubpages: true })).bytes as Buffer);
  assert.match(renamed.get("2026/10/2026-10-27.md")!.toString("utf8"), /\n# Kürbistag\n/);
  run("UPDATE pages SET title='Dienstag, 27. Oktober 2026' WHERE id=?", days.get("2026-10-27")!);
});

test("in a space export the days sit below their journal's folder, also for a journal below another page", async () => {
  const files = await readExportZip((await exportMarkdown(admin, { spaceId: space, format: "zip", includeSubpages: true })).bytes as Buffer);
  const folder = exportFolder({ id: journal, title: "Tagebuch" });
  assert.ok(files.has(`${folder}/2026/10/2026-10-26.md`));
  const houseFolder = exportFolder({ id: house, title: "Haus" });
  assert.ok(files.has(`${houseFolder}/pages/Baulogbuch-${logbook}.md`));
  assert.ok(files.has(`${houseFolder}/pages/Baulogbuch-${logbook}/2026/10/2026-10-20.md`));
  assert.ok(![...files.keys()].some((name) => name.includes(days.get("2026-10-26")!)), "no old day paths");
});

test("the ZIP import turns exported days into the days of a journal again", async () => {
  const bytes = (await exportMarkdown(admin, { spaceId: space, format: "zip", includeSubpages: true })).bytes as Buffer;
  // A second copy of one day (an old export unpacked next to it) is no second day.
  const files = await readExportZip(bytes);
  const folder = exportFolder({ id: journal, title: "Tagebuch" });
  files.set(`${folder}/2026/10/2026-10-26 (1).md`, Buffer.from("# Doppelt\n\nNicht nochmal.\n"));
  const target = String(act({ action: "space.create", name: "Wiederhergestellt" }).id);
  const result = await importZip(admin, wid, target, await writeZip(files));
  assert.ok(result.pages > 0);
  const imported = all<Page>("SELECT * FROM pages WHERE space_id=? AND kind='journal'", target);
  assert.equal(imported.length, 2, "both journals are journals again");
  const restored = imported.find((j) => all("SELECT 1 FROM pages WHERE parent_id=?", j.id).length === 3)!;
  const restoredDays = all<Page>("SELECT * FROM pages WHERE parent_id=? ORDER BY journal_date", restored.id);
  assert.deepEqual(restoredDays.map((d) => d.journal_date), ["2026-09-30", "2026-10-26", "2026-10-27"]);
  assert.deepEqual(restoredDays.map((d) => d.icon), ["day", "day", "day"]);
  assert.equal(restoredDays[2].title, "Dienstag, 27. Oktober 2026");
  assert.match(html(restoredDays[2].id), /Kürbissuppe/);
  assert.doesNotMatch(html(restoredDays[2].id), /flowplan|2026-10-27/, "the frontmatter does not land in the text");
  // The link between days points to the imported day.
  assert.match(html(restoredDays[2].id), new RegExp(`#page=${restoredDays[1].id}`));
  // No folder pages "2026" or "10", and the journal does not list its days in its text.
  assert.equal(one("SELECT 1 FROM pages WHERE space_id=? AND title IN ('2026','10','09')", target), undefined);
  assert.doesNotMatch(html(restored.id), /Unterseiten|Sub-pages/);
  assert.match(html(restored.id), /Mein Jahr/);
  const sub = imported.find((j) => j.id !== restored.id)!;
  assert.equal(all<Page>("SELECT * FROM pages WHERE parent_id=?", sub.id)[0]?.journal_date, "2026-10-20");
});

// A Git server for the test (git's http-backend).
const backend = "/usr/lib/git-core/git-http-backend";
const repos = mkdtempSync(join(tmpdir(), "flowplan-journal-remote-"));
let port = 0;
if (existsSync(backend)) {
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", join(repos, "notes.git")]);
  execFileSync("git", ["config", "--file", join(repos, "notes.git", "config"), "http.receivepack", "true"]);
  const gitServer = spawn(process.execPath, [join(import.meta.dirname, "helpers", "git-http-server.mjs"), repos, "secret-token"]);
  port = await new Promise<number>((done) => gitServer.stdout.once("data", (d: Buffer) => done(Number(String(d).trim()))));
  after(() => gitServer.kill());
}
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Ben", "-c", "user.email=ben@example.test", ...args]).toString();
const remote = () => `http://flowplan:secret-token@127.0.0.1:${port}/notes.git`;
const clone = () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-journal-clone-"));
  execFileSync("git", ["clone", "-q", remote(), dir]);
  return dir;
};

test("Git: a repository with the old day paths keeps working, the new paths come back too", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  process.env.EXPORT_GIT_URL = `http://127.0.0.1:${port}/notes.git`;
  process.env.EXPORT_GIT_TOKEN = "secret-token";
  process.env.EXPORT_GIT_IMPORT = "true";
  process.env.FLOWPLAN_GIT_ALLOW_HTTP = "1";
  setMarkdownExport(admin, [journal, house]);
  // What an earlier Flowplan pushed: every day as pages/<title>-<id>.md.
  const old = mkdtempSync(join(tmpdir(), "flowplan-journal-old-"));
  execFileSync("git", ["clone", "-q", remote(), old]);
  const folder = exportFolder({ id: journal, title: "Tagebuch" });
  mkdirSync(join(old, folder, "pages"), { recursive: true });
  writeFileSync(join(old, folder, "index.md"), "# Tagebuch\n\nMein Jahr.\n");
  const oldDay = join(old, folder, "pages", `Montag, 26. Oktober 2026-${days.get("2026-10-26")}.md`);
  writeFileSync(oldDay, "# Montag, 26. Oktober 2026\n\nLaub gerecht.\n");
  git(old, "add", "-A");
  git(old, "commit", "-qm", "Flowplan export (old layout)");
  git(old, "push", "-q", "origin", "HEAD:main");
  const oldCommit = git(old, "rev-parse", "HEAD").trim();
  run(
    "INSERT INTO instance_state(key,value) VALUES('gitExportRun',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify({ at: Date.now(), commit: oldCommit, pushed: true, imported: 0, error: null }),
  );
  // Somebody edits the old file in Git.
  writeFileSync(oldDay, "# Montag, 26. Oktober 2026\n\nLaub gerecht und Äpfel geerntet.\n");
  git(old, "commit", "-qam", "Äpfel");
  git(old, "push", "-q", "origin", "HEAD:main");

  const before = dayCount(journal);
  await runMarkdownExports(Date.UTC(2026, 9, 27, 3));
  let status = markdownExportStatus().git.last!;
  assert.equal(status.error, null, String(status.error));
  assert.equal(status.imported, 1);
  assert.match(html(days.get("2026-10-26")!), /Äpfel geerntet/);
  assert.equal(dayCount(journal), before, "no day twice");
  // The repository now has the new layout; the old file is gone.
  const fresh = clone();
  assert.ok(existsSync(join(fresh, folder, "2026", "10", "2026-10-26.md")));
  assert.ok(!existsSync(join(fresh, folder, "pages")), "old day files removed");
  const houseFolder = exportFolder({ id: house, title: "Haus" });
  const logFile = join(fresh, houseFolder, "pages", `Baulogbuch-${logbook}`, "2026", "10", "2026-10-20.md");
  assert.ok(existsSync(logFile));

  // Edits at the new paths come back: a day of the root journal and one of
  // the journal below "Haus".
  const dayFile = join(fresh, folder, "2026", "10", "2026-10-27.md");
  writeFileSync(dayFile, readFileSync(dayFile, "utf8").replace("Kürbissuppe gekocht", "Kürbissuppe mit Ingwer gekocht"));
  writeFileSync(logFile, readFileSync(logFile, "utf8").replace("Estrich gegossen.", "Estrich gegossen, trocknet."));
  git(fresh, "commit", "-qam", "Neue Pfade");
  git(fresh, "push", "-q", "origin", "HEAD:main");
  await runMarkdownExports(Date.UTC(2026, 9, 28, 3));
  status = markdownExportStatus().git.last!;
  assert.equal(status.error, null, String(status.error));
  assert.equal(status.imported, 2);
  assert.match(html(days.get("2026-10-27")!), /Kürbissuppe mit Ingwer/);
  assert.doesNotMatch(html(days.get("2026-10-27")!), /flowplan:|Dienstag/, "frontmatter and heading stay out");
  assert.match(html(logDay), /trocknet/);
  assert.equal(dayCount(journal), before);

  // The journal is renamed: its folder in Git gets the new title, edits
  // in the renamed folder still find the days.
  act({ action: "page.update", pageId: journal, patch: { title: "Notizbuch des Jahres" } });
  await runMarkdownExports(Date.UTC(2026, 9, 29, 3));
  const renamed = clone();
  const newFolder = exportFolder({ id: journal, title: "Notizbuch des Jahres" });
  assert.ok(!existsSync(join(renamed, folder)));
  const moved = join(renamed, newFolder, "2026", "09", "2026-09-30.md");
  writeFileSync(moved, readFileSync(moved, "utf8").replace("Herbstanfang am See.", "Herbstanfang am See, kalt."));
  git(renamed, "commit", "-qam", "Kalt");
  git(renamed, "push", "-q", "origin", "HEAD:main");
  await runMarkdownExports(Date.UTC(2026, 9, 30, 3));
  assert.equal(markdownExportStatus().git.last!.error, null);
  assert.match(html(days.get("2026-09-30")!), /kalt/);
  // A day file whose date names no day of that journal does nothing.
  const stray = clone();
  const strayFile = join(stray, newFolder, "2026", "10", "2026-10-26.md");
  writeFileSync(strayFile, readFileSync(strayFile, "utf8").replace(/id: [0-9a-f-]{36}/, `id: ${logDay}`).replace("Äpfel", "Birnen"));
  git(stray, "commit", "-qam", "Fremde Id");
  git(stray, "push", "-q", "origin", "HEAD:main");
  await runMarkdownExports(Date.UTC(2026, 9, 31, 3));
  assert.match(html(days.get("2026-10-26")!), /Birnen/, "the path decides, not an id of another journal");
  assert.doesNotMatch(html(logDay), /Birnen/);
  assert.equal(readdirSync(join(renamed, newFolder)).includes("pages"), false);
});
