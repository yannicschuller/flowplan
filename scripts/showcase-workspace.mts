// Builds the showcase workspace "Northwind Studio" – every Flowplan feature
// with realistic content – and writes it as a Flowplan archive (ZIP) that
// can be imported under Settings → Data → Backups → "Restore a Flowplan
// archive".
//
//   npm run showcase -- --lang de --out flowplan-showcase-de.zip
//   npm run showcase -- --lang en --out flowplan-showcase-en.zip
//
// Runs against a temporary data folder; nothing touches ./data.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { lang: { type: "string", default: "de" }, out: { type: "string" }, keep: { type: "boolean", default: false } } });
const lang = values.lang === "en" ? "en" : "de";
const out = resolve(values.out || `flowplan-showcase-${lang}.zip`);
const dir = mkdtempSync(join(tmpdir(), "flowplan-showcase-"));
process.env.FLOWPLAN_DATA_DIR = dir;

const { id, run, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive } = await import("../lib/archive");
const { withContentLocale } = await import("../lib/content-locale");
const { Ctx } = await import("./showcase/context");
const D = await import("./showcase/databases");
const B = await import("./showcase/boards");
const P = await import("./showcase/pages");
type Identity = import("../lib/types").Identity;

function account(name: string, email: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, email);
  return { id: uid, name, email, disabled: 0, created_at: "", groups: [], isAdmin: false };
}

try {
  const t = (de: string, en: string) => (lang === "de" ? de : en);
  const me = account("Northwind", "you@northwind.example");
  const team = [
    ["Mara Klein", "mara@northwind.example"],
    ["Jonas Weber", "jonas@northwind.example"],
    ["Aylin Demir", "aylin@northwind.example"],
    ["Lukas Brandt", "lukas@northwind.example"],
  ].map(([name, email]) => ({ ...account(name, email), identity: undefined as unknown as Identity }));
  for (const p of team) p.identity = { id: p.id, name: p.name, email: p.email, disabled: 0, created_at: "", groups: [], isAdmin: false };

  await withContentLocale(lang, async () => {
    const wid = createWorkspace(me.id, "Northwind Studio");
    for (const p of team) run("INSERT INTO members VALUES(?,?,?)", wid, p.id, "editor");
    // The welcome page of a new workspace goes; the showcase brings its own.
    run("DELETE FROM pages WHERE workspace_id=?", wid);
    const studio = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
    run("UPDATE spaces SET name=?,icon=?,icon_color=?,visibility='team' WHERE id=?", "Northwind Studio", "🧭", "orange", studio);
    const personal = id();
    run("INSERT INTO spaces(id,workspace_id,name,owner_id,icon,icon_color,visibility) VALUES(?,?,?,?,?,?,'private')", personal, wid, t("Persönlich", "Personal"), me.id, "🌱", "green");
    run("UPDATE workspaces SET icon=? WHERE id=?", "🧭", wid);

    const c = new Ctx(lang, me, team.map((p) => ({ id: p.id, name: p.name, identity: p.identity })), wid, { studio, personal });
    await D.teamDatabase(c);
    const { projects, clients } = await D.clientsAndProjects(c);
    const { tickets, ids } = await D.ticketsDatabase(c);
    const content = await D.contentCalendar(c);
    const survey = await D.surveyDatabase(c);
    const requests = await D.requestForm(c);
    const retro = B.retroBoard(c, { page: tickets, rows: ids });
    const journey = B.journeyBoard(c);
    const docs = await P.handbook(c, { projects, tickets, journey });
    P.meetingNotes(c, docs.meetings, { tickets });
    const journal = await P.journal(c);
    const notebook = await P.notebook(c);
    const dashboard = P.dashboard(c, { tickets, projects, content, survey, journal });
    P.templates(c);
    const start = await P.startPage(c, {
      ...docs,
      handbook: docs.hb,
      projects,
      clients,
      tickets,
      content,
      survey,
      requests,
      retro,
      journey,
      journal,
      notebook,
      dashboard,
      team: c.pages.team,
    });
    P.homeLayout(c, { start, tickets, content, journal, projects });
    // Order in the sidebar.
    const order = [start, docs.hb, projects, tickets, clients, c.pages.team, content, survey, requests, dashboard, retro, journey];
    order.forEach((pid, i) => run("UPDATE pages SET position=? WHERE id=?", i, pid));
    run("UPDATE pages SET position=? WHERE id=?", 0, journal);
    run("UPDATE pages SET position=? WHERE id=?", 1, notebook);
    for (const pid of [start, projects, tickets, dashboard, journal]) run("INSERT OR IGNORE INTO favorites(user_id,page_id) VALUES(?,?)", me.id, pid);
    // Versions made automatically while building are not part of the story.
    run("DELETE FROM snapshots WHERE kind!='manual'");
    run("DELETE FROM row_snapshots WHERE kind!='manual'");

    const bytes = await exportArchive(me, wid);
    writeFileSync(out, bytes);
    console.log(`${out}: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  });
} finally {
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`data kept in ${dir}`);
}
