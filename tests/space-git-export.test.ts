import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-space-git-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SPACE_GIT_EXPORT;
delete process.env.SPACE_GIT_ALLOWED_HOSTS;
delete process.env.FLOWPLAN_GIT_ALLOW_HTTP;
const { run, one, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { openSecret } = await import("../lib/secret-box");
const { exportArchive, readZip } = await import("../lib/archive");
const { deleteAccount } = await import("../lib/account-deletion");
const { spaceGitStatus, runSpaceGitExport, runDueSpaceGitExports, spaceGitOverview, safeGitHttp } = await import("../lib/space-git-export");

function person(name: string, admin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: admin, disabled: 0, created_at: "" } as Identity;
}
// Ada owns the workspace (and administers the instance), Ben is an editor
// who owns the space "Projekte".
const ada = person("Ada", true),
  ben = person("Ben");
const wid = createWorkspace(ada.id, "Familie");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const as = (user: Identity) => (b: Record<string, unknown>) => command(user, { workspaceId: wid, ...b }) as Record<string, unknown>;
const projects = String(as(ben)({ action: "space.create", name: "Projekte" }).id);
const adaPrivate = String(as(ada)({ action: "space.create", name: "Ada privat", private: true }).id);
const write = (pageId: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const garden = String(as(ben)({ action: "page.create", spaceId: projects, title: "Garten", kind: "document" }).id);
write(garden, "<p>Tomaten pflanzen.</p>");
const shed = String(as(ben)({ action: "page.create", spaceId: projects, title: "Schuppen", kind: "document" }).id);
write(shed, "<p>Dach reparieren.</p>");
const diary = String(as(ada)({ action: "page.create", spaceId: adaPrivate, title: "Tagebuch", kind: "document" }).id);
write(diary, "<p>NUR-FUER-ADA</p>");
// A database in Ben's space with a private record of Ada: Ben may not read it.
const budget = String(as(ben)({ action: "page.create", spaceId: projects, title: "Budget", kind: "database" }).id);
const secretRow = String(as(ada)({ action: "row.create", pageId: budget, cells: { title: "GEHALT-ADA" } }).id);
as(ada)({ action: "row.access", pageId: budget, rowId: secretRow, access: "private", grants: [] });
as(ben)({ action: "row.create", pageId: budget, cells: { title: "Saatgut" } });

const copyOf = (spaceId: string) => join(process.env.FLOWPLAN_DATA_DIR!, "git-export", "spaces", spaceId);
const save = (user: Identity, spaceId: string, b: Record<string, unknown>) => as(user)({ action: "space.gitExport", spaceId, enabled: true, ...b });

test("the Git export of spaces is off unless the administrator turns it on", () => {
  assert.deepEqual(spaceGitStatus(ben, projects), { available: false });
  assert.throws(
    () => save(ben, projects, { url: "https://git.example.org/ben/notes.git", username: "ben", token: "t0ken-value" }),
    /nicht eingeschaltet/,
  );
  assert.equal(spaceGitOverview().enabled, false);
  process.env.SPACE_GIT_EXPORT = "true";
  assert.equal(spaceGitStatus(ben, projects).available, true);
});

test("only the space owner sets it up – not workspace owners, demo accounts or API tokens", async () => {
  const input = { url: "https://git.example.org/ben/notes.git", username: "ben", token: "t0ken-value" };
  assert.throws(() => save(ada, projects, input), (e: { status?: number }) => e.status === 403);
  assert.deepEqual(spaceGitStatus(ada, projects), { available: false });
  await assert.rejects(() => runSpaceGitExport(ada, projects), (e: { status?: number }) => e.status === 403);
  assert.throws(() => save({ ...ben, demo: true }, projects, input), /Demo/);
  await assert.rejects(() => runSpaceGitExport({ ...ben, demo: true }, projects), /Demo/);
  assert.throws(() => save({ ...ben, apiScope: "write" }, projects, input), /API-Token/);
  assert.equal(one("SELECT 1 FROM space_git_exports WHERE space_id=?", projects), undefined);
});

test("only https addresses on allowed servers, never internal ones", () => {
  const base = { username: "ben", token: "t0ken-value" };
  process.env.SPACE_GIT_ALLOWED_HOSTS = "git.example.org, 127.0.0.1";
  assert.throws(() => save(ben, projects, { ...base, url: "https://evil.example.com/ben/notes.git" }), /nicht freigegeben/);
  assert.throws(() => save(ben, projects, { ...base, url: "http://git.example.org/ben/notes.git" }), /https/);
  assert.throws(() => save(ben, projects, { ...base, url: "https://ben:secret@git.example.org/ben/notes.git" }), /Zugangsdaten/);
  // Allowed by name, refused as an internal address.
  assert.throws(() => save(ben, projects, { ...base, url: "https://127.0.0.1/ben/notes.git" }), /Interne Adressen/);
  assert.throws(() => save(ben, projects, { ...base, url: "https://git.example.org/ben/notes.git", branch: "../main" }), /Branch/);
  save(ben, projects, { ...base, url: "https://git.example.org/ben/notes.git" });
  assert.equal(spaceGitStatus(ben, projects).configured, true);
  as(ben)({ action: "space.gitExport", spaceId: projects, enabled: false });
});

test("a host name that resolves to an internal address is refused when the export runs", async () => {
  process.env.SPACE_GIT_ALLOWED_HOSTS = "localhost";
  save(ben, projects, { url: "https://localhost:9/ben/notes.git", username: "ben", token: "t0ken-value" });
  const status = await runSpaceGitExport(ben, projects);
  assert.match(String(status.available && status.last?.error), /Interne Adressen/);
  // The transport asks no other server than the configured one.
  const client = safeGitHttp("https://git.example.org/ben/notes.git", false);
  await assert.rejects(() => client.request({ url: "https://other.example.org/x.git/info/refs" }), /eingetragene Git-Server/);
  await assert.rejects(() => safeGitHttp("https://10.0.0.1/x.git", false).request({ url: "https://10.0.0.1/x.git/info/refs" }), /Interne Adressen/);
  as(ben)({ action: "space.gitExport", spaceId: projects, enabled: false });
  delete process.env.SPACE_GIT_ALLOWED_HOSTS;
});

test("internal addresses only for servers the administrator listed, with SPACE_GIT_ALLOW_PRIVATE", async () => {
  const base = { username: "ben", token: "t0ken-value" };
  // Same host behind a gateway: listed by name and opted in.
  process.env.SPACE_GIT_ALLOWED_HOSTS = "localhost";
  process.env.SPACE_GIT_ALLOW_PRIVATE = "true";
  save(ben, projects, { ...base, url: "https://localhost:9/ben/notes.git" });
  const status = await runSpaceGitExport(ben, projects);
  // Port 9 has no server: the run gets as far as connecting, the address is not refused.
  assert.doesNotMatch(String(status.available && status.last?.error), /Interne Adressen/);
  as(ben)({ action: "space.gitExport", spaceId: projects, enabled: false });
  // Not listed: still refused, also with the opt-in.
  process.env.SPACE_GIT_ALLOWED_HOSTS = "git.example.org";
  await assert.rejects(() => safeGitHttp("https://10.0.0.1/x.git").request({ url: "https://10.0.0.1/x.git/info/refs" }), /Interne Adressen/);
  // Without a list the opt-in does nothing.
  delete process.env.SPACE_GIT_ALLOWED_HOSTS;
  await assert.rejects(() => safeGitHttp("https://127.0.0.1/x.git").request({ url: "https://127.0.0.1/x.git/info/refs" }), /Interne Adressen/);
  assert.equal(spaceGitOverview().allowPrivate, false);
  // Listed but without the opt-in: refused as before.
  process.env.SPACE_GIT_ALLOWED_HOSTS = "127.0.0.1";
  delete process.env.SPACE_GIT_ALLOW_PRIVATE;
  assert.throws(() => save(ben, projects, { ...base, url: "https://127.0.0.1/ben/notes.git" }), /Interne Adressen/);
  process.env.SPACE_GIT_ALLOW_PRIVATE = "true";
  save(ben, projects, { ...base, url: "https://127.0.0.1/ben/notes.git" });
  assert.equal(spaceGitOverview().allowPrivate, true);
  as(ben)({ action: "space.gitExport", spaceId: projects, enabled: false });
  delete process.env.SPACE_GIT_ALLOW_PRIVATE;
  delete process.env.SPACE_GIT_ALLOWED_HOSTS;
});

test("the token is stored sealed for this space and never shown again", async () => {
  save(ben, projects, { url: "https://git.example.org/ben/notes.git", username: "ben", token: "PLAIN-TOKEN-123" });
  const status = spaceGitStatus(ben, projects);
  assert.ok(status.available && status.tokenSet);
  assert.doesNotMatch(JSON.stringify(status), /PLAIN-TOKEN-123/);
  const stored = one<{ token: string }>("SELECT token FROM space_git_exports WHERE space_id=?", projects)!.token;
  assert.match(stored, /^fps1:/);
  assert.equal(openSecret(stored, `space-git:${projects}`), "PLAIN-TOKEN-123");
  assert.throws(() => openSecret(stored, `space-git:${adaPrivate}`));
  // Saving without a token keeps it; a new address needs it again.
  save(ben, projects, { url: "https://git.example.org/ben/notes.git", username: "ben", frequency: "weekly" });
  assert.equal(one<{ token: string }>("SELECT token FROM space_git_exports WHERE space_id=?", projects)!.token, stored);
  assert.throws(() => save(ben, projects, { url: "https://git.example.org/ben/other.git", username: "ben" }), /Zugangstoken neu/);
  // Not in the workspace archive.
  const archive = await readZip(await exportArchive(ada, wid));
  for (const [name, data] of archive) assert.doesNotMatch(data.toString("utf8"), /PLAIN-TOKEN-123|fps1:/, name);
  as(ben)({ action: "space.gitExport", spaceId: projects, enabled: false });
});

// A Git server for the test, in a process of its own (needs git's
// http-backend, which comes with git on Linux).
const backend = "/usr/lib/git-core/git-http-backend";
const repos = mkdtempSync(join(tmpdir(), "flowplan-space-git-remote-"));
let port = 0;
if (existsSync(backend)) {
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", join(repos, "space.git")]);
  execFileSync("git", ["config", "--file", join(repos, "space.git", "config"), "http.receivepack", "true"]);
  const gitServer = spawn(process.execPath, [join(import.meta.dirname, "helpers", "git-http-server.mjs"), repos, "secret-token"]);
  port = await new Promise<number>((done) => gitServer.stdout.once("data", (d: Buffer) => done(Number(String(d).trim()))));
  after(() => gitServer.kill());
}
const clone = () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-space-git-clone-"));
  execFileSync("git", ["clone", "-q", `http://flowplan:secret-token@127.0.0.1:${port}/space.git`, dir]);
  return dir;
};
const local = () => {
  // https only in production; the test server speaks http on localhost.
  process.env.FLOWPLAN_GIT_ALLOW_HTTP = "1";
  process.env.SPACE_GIT_ALLOWED_HOSTS = "127.0.0.1";
};

test("one commit per run, only when something changed, with what the owner may read", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  local();
  save(ben, projects, { url: `http://127.0.0.1:${port}/space.git`, username: "flowplan", token: "secret-token", history: true });
  const first = await runSpaceGitExport(ben, projects);
  assert.ok(first.available);
  assert.equal(first.last?.error, null, String(first.last?.error));
  assert.equal(first.last?.pushed, true);
  assert.ok(first.last!.files > 0);
  // Ben cannot read Ada's private record, so it is not exported either.
  assert.ok(!(pageData(ben, budget) as { rows: { id: string }[] }).rows.some((r) => r.id === secretRow));
  let dir = clone();
  const gardenDir = `Garten-${garden.slice(0, 8)}`,
    shedDir = `Schuppen-${shed.slice(0, 8)}`;
  assert.match(readFileSync(join(dir, gardenDir, "index.md"), "utf8"), /Tomaten pflanzen/);
  assert.ok(existsSync(join(dir, "index.md")));
  // git grep exits with 1 when nothing matches.
  assert.throws(() => execFileSync("git", ["-C", dir, "grep", "-q", "-e", "GEHALT-ADA", "-e", "NUR-FUER-ADA"]));
  assert.match(execFileSync("git", ["-C", dir, "grep", "-l", "Saatgut"], { encoding: "utf8" }), /Budget/);

  // Nothing changed: no commit.
  const second = await runSpaceGitExport(ben, projects);
  assert.ok(second.available);
  assert.equal(second.last?.error, null, String(second.last?.error));
  assert.equal(second.last?.pushed, false);
  assert.equal(second.last?.files, 0);
  assert.equal(second.last?.commit, first.last?.commit);

  // A change and a page in the trash: one commit, the deletion included.
  write(garden, "<p>Tomaten und Bohnen pflanzen.</p>");
  as(ben)({ action: "page.delete", pageId: shed });
  const third = await runSpaceGitExport(ben, projects);
  assert.ok(third.available);
  assert.equal(third.last?.error, null, String(third.last?.error));
  assert.equal(third.last?.pushed, true);
  dir = clone();
  assert.match(readFileSync(join(dir, gardenDir, "index.md"), "utf8"), /Bohnen/);
  assert.ok(!existsSync(join(dir, shedDir)));
  const log = execFileSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(log.length, 2);
  assert.match(log[0], /^Flowplan export/);
  // The remote URL in the working copy carries no token.
  assert.doesNotMatch(readFileSync(join(copyOf(projects), ".git", "config"), "utf8"), /secret-token/);
});

test("files of the repository that are not part of the export stay", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  local();
  const dir = clone();
  writeFileSync(join(dir, "LICENSE"), "CC0\n");
  execFileSync("git", ["-C", dir, "add", "LICENSE"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Ben", "-c", "user.email=ben@example.test", "commit", "-qm", "License"]);
  execFileSync("git", ["-C", dir, "push", "-q", "origin", "HEAD:main"]);
  const status = await runSpaceGitExport(ben, projects);
  assert.ok(status.available);
  assert.equal(status.last?.error, null, String(status.last?.error));
  assert.equal(status.last?.pushed, false);
  assert.ok(existsSync(join(clone(), "LICENSE")));
});

test("a repository saved while a run was in progress starts from a fresh copy", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  local();
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", join(repos, "other.git")]);
  execFileSync("git", ["config", "--file", join(repos, "other.git", "config"), "http.receivepack", "true"]);
  // As left behind by a run: the copy of space.git with a file that is no
  // part of the export, kept while the settings already name other.git.
  const stale = mkdtempSync(join(tmpdir(), "flowplan-space-git-stale-"));
  cpSync(copyOf(projects), stale, { recursive: true });
  save(ben, projects, { url: `http://127.0.0.1:${port}/other.git`, username: "flowplan", token: "secret-token" });
  assert.ok(!existsSync(copyOf(projects)), "a new address removes the copy when nothing runs");
  cpSync(stale, copyOf(projects), { recursive: true });
  writeFileSync(join(copyOf(projects), "leftover.txt"), "from the old repository\n");
  const status = await runSpaceGitExport(ben, projects);
  assert.ok(status.available);
  assert.equal(status.last?.error, null, String(status.last?.error));
  assert.equal(status.last?.pushed, true);
  const dir = mkdtempSync(join(tmpdir(), "flowplan-space-git-clone-"));
  execFileSync("git", ["clone", "-q", `http://flowplan:secret-token@127.0.0.1:${port}/other.git`, dir]);
  assert.ok(!existsSync(join(dir, "leftover.txt")), "leftovers of the old copy are not pushed");
  assert.ok(!existsSync(join(dir, "LICENSE")), "nor files of the old repository");
  assert.ok(existsSync(join(dir, `Garten-${garden.slice(0, 8)}`, "index.md")));
  assert.match(readFileSync(join(copyOf(projects), ".git", "config"), "utf8"), /other\.git/);
  // Back to the first repository for the tests that follow.
  save(ben, projects, { url: `http://127.0.0.1:${port}/space.git`, username: "flowplan", token: "secret-token" });
  const back = await runSpaceGitExport(ben, projects);
  assert.ok(back.available && back.last?.error === null, String(back.available && back.last?.error));
});

test("the scheduler runs spaces whose interval has passed", { skip: !existsSync(backend) && "git http-backend missing" }, async () => {
  local();
  const last = one<{ last_run: string }>("SELECT last_run FROM space_git_exports WHERE space_id=?", projects)!;
  const at = JSON.parse(last.last_run).at as number;
  assert.deepEqual(await runDueSpaceGitExports(at + 3600_000), []);
  const [result] = await runDueSpaceGitExports(at + 86400_000);
  assert.equal(result.error, null);
  // Weekly: a day later is too early.
  save(ben, projects, { url: `http://127.0.0.1:${port}/space.git`, username: "flowplan", frequency: "weekly" });
  assert.deepEqual(await runDueSpaceGitExports(at + 2 * 86400_000), []);
  const overview = spaceGitOverview();
  assert.equal(overview.spaces, 1);
  assert.doesNotMatch(JSON.stringify(overview), /127\.0\.0\.1:\d+|space\.git|Garten/);
});

// A configured export with a working copy, as after a run.
function configured(owner: Identity, spaceId: string) {
  process.env.SPACE_GIT_ALLOWED_HOSTS = "git.example.org";
  save(owner, spaceId, { url: "https://git.example.org/x/notes.git", username: "flowplan", token: "t0ken-value" });
  mkdirSync(join(copyOf(spaceId), ".git"), { recursive: true });
  writeFileSync(join(copyOf(spaceId), "index.md"), "# Copy\n");
}
const gone = (spaceId: string) => {
  assert.equal(one("SELECT 1 FROM space_git_exports WHERE space_id=?", spaceId), undefined);
  assert.ok(!existsSync(copyOf(spaceId)), "working copy removed");
};

test("turning it off removes the token and the working copy", () => {
  assert.ok(existsSync(copyOf(projects)));
  as(ben)({ action: "space.gitExport", spaceId: projects, enabled: false });
  gone(projects);
  assert.equal(readdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "git-export", "spaces")).length, 0);
});

test("a new owner, the trash, leaving, becoming a guest or deleting the account end it", () => {
  // Leaving the workspace hands the space to another owner.
  configured(ben, projects);
  as(ben)({ action: "workspace.leave", confirmName: "Familie", transferTo: ada.id });
  gone(projects);
  assert.equal(one<{ owner_id: string }>("SELECT owner_id FROM spaces WHERE id=?", projects)!.owner_id, ada.id);
  run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  run("UPDATE spaces SET owner_id=? WHERE id=?", ben.id, projects);
  // The space in the trash.
  configured(ben, projects);
  as(ben)({ action: "space.delete", spaceId: projects, version: one<{ version: number }>("SELECT version FROM spaces WHERE id=?", projects)!.version, confirmName: "Projekte" });
  gone(projects);
  as(ben)({ action: "space.restore", spaceId: projects, version: one<{ version: number }>("SELECT version FROM spaces WHERE id=?", projects)!.version });
  // Removed from the workspace (their spaces go to the owner acting).
  configured(ben, projects);
  as(ada)({ action: "member.role", userId: ben.id, role: "remove" });
  gone(projects);
  assert.equal(one<{ owner_id: string }>("SELECT owner_id FROM spaces WHERE id=?", projects)!.owner_id, ada.id);
  // Made a guest.
  const cleo = person("Cleo");
  run("INSERT INTO members VALUES(?,?,?)", wid, cleo.id, "editor");
  const cleoSpace = String(as(cleo)({ action: "space.create", name: "Cleo" }).id);
  configured(cleo, cleoSpace);
  as(ada)({ action: "member.guest", userId: cleo.id, guest: true });
  gone(cleoSpace);
  // The account deleted.
  const dan = person("Dan");
  run("INSERT INTO members VALUES(?,?,?)", wid, dan.id, "editor");
  const danSpace = String(as(dan)({ action: "space.create", name: "Dan" }).id);
  configured(dan, danSpace);
  run("UPDATE users SET disabled=1 WHERE id=?", dan.id);
  command(ada, { action: "admin.deleteUser", userId: dan.id });
  gone(danSpace);
});

test("a deactivated owner pauses the export instead of ending it", async () => {
  const fay = person("Fay");
  run("INSERT INTO members VALUES(?,?,?)", wid, fay.id, "editor");
  const faySpace = String(as(fay)({ action: "space.create", name: "Fay" }).id);
  configured(fay, faySpace);
  run("UPDATE users SET disabled=1 WHERE id=?", fay.id);
  assert.deepEqual(await runDueSpaceGitExports(), []);
  // Settings, sealed token and working copy stay; the status says why.
  const row = one<{ token: string; last_run: string }>("SELECT token,last_run FROM space_git_exports WHERE space_id=?", faySpace);
  assert.ok(row?.token);
  assert.ok(existsSync(copyOf(faySpace)), "working copy kept");
  const last = JSON.parse(row!.last_run) as { error: string; pushed: boolean };
  assert.match(last.error, /deaktiviert/);
  assert.equal(last.pushed, false);
  assert.ok(spaceGitOverview().failing.some((f) => f.owner === "Fay" && /deaktiviert/.test(f.error)));
  // Enabled again: the export is still set up for the owner.
  run("UPDATE users SET disabled=0 WHERE id=?", fay.id);
  const status = spaceGitStatus(fay, faySpace);
  assert.equal(status.available && status.configured, true);
  as(fay)({ action: "space.gitExport", spaceId: faySpace, enabled: false });
  gone(faySpace);
});

test("an export whose owner lost the space ends at the next run", async () => {
  const eve = person("Eve");
  run("INSERT INTO members VALUES(?,?,?)", wid, eve.id, "editor");
  const eveSpace = String(as(eve)({ action: "space.create", name: "Eve" }).id);
  configured(eve, eveSpace);
  // Changed behind Flowplan's back, without the trigger's column.
  run("DROP TRIGGER space_git_owner");
  try {
    run("UPDATE spaces SET owner_id=? WHERE id=?", ada.id, eveSpace);
  } finally {
    run(
      "CREATE TRIGGER space_git_owner AFTER UPDATE OF owner_id ON spaces WHEN OLD.owner_id IS NOT NEW.owner_id BEGIN DELETE FROM space_git_exports WHERE space_id=NEW.id; END",
    );
  }
  assert.ok(one("SELECT 1 FROM space_git_exports WHERE space_id=?", eveSpace));
  await runDueSpaceGitExports();
  gone(eveSpace);
});
