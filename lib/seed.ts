import { id, run, all, transaction } from "./db";
import type { Field, View } from "./types";
import { ct } from "./content-locale";
// A new database starts as a task list, in the language of the request.
export const defaultFields = (): Field[] => [
  { id: "title", name: ct("Aufgabe", "Task"), type: "text" },
  {
    id: "status",
    name: "Status",
    type: "select",
    options: [ct("Nicht begonnen", "Not started"), ct("In Arbeit", "In progress"), ct("Erledigt", "Done")],
  },
  {
    id: "priority",
    name: ct("Priorität", "Priority"),
    type: "select",
    options: [ct("Hoch", "High"), ct("Mittel", "Medium"), ct("Niedrig", "Low")],
  },
  { id: "date", name: ct("Fällig am", "Due"), type: "date" },
  { id: "assignee", name: ct("Verantwortlich", "Assignee"), type: "person" },
  {
    id: "tags",
    name: "Tags",
    type: "multiselect",
    options: ["Design", ct("Produkt", "Product"), ct("Entwicklung", "Engineering")],
  },
];
export const defaultViews = (): View[] => [
  { id: "table", name: ct("Alle Aufgaben", "All tasks"), type: "table", filters: [], sorts: [] },
  {
    id: "board",
    name: "Board",
    type: "board",
    filters: [],
    sorts: [],
    groupBy: "status",
  },
  {
    id: "calendar",
    name: ct("Kalender", "Calendar"),
    type: "calendar",
    filters: [],
    sorts: [],
    dateField: "date",
  },
  { id: "gallery", name: ct("Galerie", "Gallery"), type: "gallery", filters: [], sorts: [] },
  {
    id: "timeline",
    name: "Timeline",
    type: "timeline",
    filters: [],
    sorts: [],
    dateField: "date",
  },
  { id: "list", name: ct("Liste", "List"), type: "list", filters: [], sorts: [] },
  { id: "form", name: ct("Formular", "Form"), type: "form", filters: [], sorts: [] },
];
export function createPage(
  workspace: string,
  space: string,
  user: string,
  title: string,
  kind = "document",
  parent: string | null = null,
) {
  const pid = id();
  run(
    "INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon) VALUES(?,?,?,?,?,?,?,?,?)",
    pid,
    workspace,
    space,
    parent,
    title,
    kind,
    user,
    Date.now(),
    kind === "whiteboard" ? "whiteboard" : kind === "journal" ? "journal" : "file",
  );
  if (kind === "database")
    run(
      "INSERT INTO databases(page_id,fields,views) VALUES(?,?,?)",
      pid,
      JSON.stringify(defaultFields()),
      JSON.stringify(defaultViews()),
    );
  else run("INSERT INTO documents(page_id) VALUES(?)", pid);
  return pid;
}
export function createWorkspace(user: string, name: string, examples = false) {
  return transaction(() => {
    const wid = id(),
      sid = id();
    run(
      "INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)",
      wid,
      name,
      user,
    );
    run("INSERT INTO members VALUES(?,?,?)", wid, user, "owner");
    run(
      "INSERT INTO spaces(id,workspace_id,name,owner_id) VALUES(?,?,?,?)",
      sid,
      wid,
      "Teamspace",
      user,
    );
    const home = createPage(wid, sid, user, ct("Willkommen bei Flowplan", "Welcome to Flowplan"));
    run("UPDATE pages SET icon=? WHERE id=?", "hand", home);
    run(
      "UPDATE documents SET html=? WHERE page_id=?",
      ct(
        '<h2>Ein guter Ort für große Ideen.</h2><p>Hier kommen Wissen, Projekte und Menschen zusammen. Halte Gedanken fest, plane die nächsten Schritte und bringe gemeinsam mit deinem Team Dinge voran.</p><blockquote><p>Dein Arbeitsbereich. So flexibel wie deine Ideen.</p></blockquote><h2>Mach es zu deinem Flowplan</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Eine erste Seite schreiben</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Ein Projekt mit deinem Team planen</p></div></li></ul><h2>Alles an seinem Platz</h2><p>Nutze Seiten für Notizen und Dokumente. Datenbanken lassen sich als Tabelle, Board, Kalender, Galerie, Liste oder Timeline anzeigen.</p>',
        '<h2>A good place for big ideas.</h2><p>Knowledge, projects and people come together here. Capture thoughts, plan the next steps and move things forward with your team.</p><blockquote><p>Your workspace. As flexible as your ideas.</p></blockquote><h2>Make it your Flowplan</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Write a first page</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Plan a project with your team</p></div></li></ul><h2>Everything in its place</h2><p>Use pages for notes and documents. Databases can be shown as a table, board, calendar, gallery, list or timeline.</p>',
      ),
      home,
    );
    if (examples) {
      const project = createPage(wid, sid, user, ct("Produkt-Roadmap", "Product roadmap"), "database");
      run("UPDATE pages SET icon=? WHERE id=?", "rocket", project);
      const titles = [
        ct("Onboarding vereinfachen", "Simplify onboarding"),
        ct("Designsystem dokumentieren", "Document the design system"),
        ct("Mobile Navigation optimieren", "Improve mobile navigation"),
        ct("Feedback aus Nutzertests", "Feedback from user tests"),
        ct("Release vorbereiten", "Prepare the release"),
        ct("Dokumentation überarbeiten", "Revise the documentation"),
      ];
      const [status, priority] = [defaultFields()[1].options!, defaultFields()[2].options!];
      titles.forEach((title, i) => {
        const date = new Date();
        date.setDate(date.getDate() + i * 2 - 2);
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
          id(),
          project,
          JSON.stringify({
            title,
            status: i === 4 ? status[2] : i % 2 ? status[0] : status[1],
            priority: priority[i % 3],
            date: date.toISOString().slice(0, 10),
            assignee: user,
            tags: [i % 2 ? ct("Produkt", "Product") : "Design"],
          }),
          i,
          user,
          user,
        );
      });
      const notes = createPage(wid, sid, user, ct("Team-Handbuch", "Team handbook"));
      run("UPDATE pages SET icon=? WHERE id=?", "book", notes);
      run(
        "UPDATE documents SET html=? WHERE page_id=?",
        ct(
          "<h2>So arbeiten wir zusammen</h2><p>Wir halten Entscheidungen schriftlich fest, teilen Wissen offen und schaffen Raum für konzentrierte Arbeit.</p><h3>Unser Wochenrhythmus</h3><ul><li>Montag: Prioritäten und Planung</li><li>Mittwoch: Offene Fragen und Feedback</li><li>Freitag: Rückblick auf die Woche</li></ul>",
          "<h2>How we work together</h2><p>We write decisions down, share knowledge openly and make room for focused work.</p><h3>Our weekly rhythm</h3><ul><li>Monday: priorities and planning</li><li>Wednesday: open questions and feedback</li><li>Friday: looking back on the week</li></ul>",
        ),
        notes,
      );
      createPage(wid, sid, user, ct("Meeting-Notizen", "Meeting notes"), "document", notes);
    }
    return wid;
  });
}
export function ensureWorkspace(user: string) {
  if (!all("SELECT workspace_id FROM members WHERE user_id=?", user).length)
    createWorkspace(user, ct("Mein Arbeitsbereich", "My workspace"), true);
}
