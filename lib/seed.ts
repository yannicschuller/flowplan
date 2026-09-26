import { id, run, all, transaction } from "./db";
import type { Field, View } from "./types";
export const defaultFields: Field[] = [
  { id: "title", name: "Aufgabe", type: "text" },
  {
    id: "status",
    name: "Status",
    type: "select",
    options: ["Nicht begonnen", "In Arbeit", "Erledigt"],
  },
  {
    id: "priority",
    name: "Priorität",
    type: "select",
    options: ["Hoch", "Mittel", "Niedrig"],
  },
  { id: "date", name: "Fällig am", type: "date" },
  { id: "assignee", name: "Verantwortlich", type: "person" },
  {
    id: "tags",
    name: "Tags",
    type: "multiselect",
    options: ["Design", "Produkt", "Entwicklung"],
  },
];
export const defaultViews: View[] = [
  { id: "table", name: "Alle Aufgaben", type: "table", filters: [], sorts: [] },
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
    name: "Kalender",
    type: "calendar",
    filters: [],
    sorts: [],
    dateField: "date",
  },
  { id: "gallery", name: "Galerie", type: "gallery", filters: [], sorts: [] },
  {
    id: "timeline",
    name: "Timeline",
    type: "timeline",
    filters: [],
    sorts: [],
    dateField: "date",
  },
  { id: "list", name: "Liste", type: "list", filters: [], sorts: [] },
  { id: "form", name: "Formular", type: "form", filters: [], sorts: [] },
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
      JSON.stringify(defaultFields),
      JSON.stringify(defaultViews),
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
    const home = createPage(wid, sid, user, "Willkommen bei Flowplan");
    run("UPDATE pages SET icon=? WHERE id=?", "hand", home);
    run(
      "UPDATE documents SET html=? WHERE page_id=?",
      '<h2>Ein guter Ort für große Ideen.</h2><p>Hier kommen Wissen, Projekte und Menschen zusammen. Halte Gedanken fest, plane die nächsten Schritte und bringe gemeinsam mit deinem Team Dinge voran.</p><blockquote><p>Dein Arbeitsbereich. So flexibel wie deine Ideen.</p></blockquote><h2>Mach es zu deinem Flowplan</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Eine erste Seite schreiben</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Ein Projekt mit deinem Team planen</p></div></li></ul><h2>Alles an seinem Platz</h2><p>Nutze Seiten für Notizen und Dokumente. Datenbanken lassen sich als Tabelle, Board, Kalender, Galerie, Liste oder Timeline anzeigen.</p>',
      home,
    );
    if (examples) {
      const project = createPage(wid, sid, user, "Produkt-Roadmap", "database");
      run("UPDATE pages SET icon=? WHERE id=?", "rocket", project);
      const titles = [
        "Onboarding vereinfachen",
        "Designsystem dokumentieren",
        "Mobile Navigation optimieren",
        "Feedback aus Nutzertests",
        "Release vorbereiten",
        "Dokumentation überarbeiten",
      ];
      titles.forEach((title, i) => {
        const date = new Date();
        date.setDate(date.getDate() + i * 2 - 2);
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
          id(),
          project,
          JSON.stringify({
            title,
            status:
              i === 4 ? "Erledigt" : i % 2 ? "Nicht begonnen" : "In Arbeit",
            priority: ["Hoch", "Mittel", "Niedrig"][i % 3],
            date: date.toISOString().slice(0, 10),
            assignee: user,
            tags: [i % 2 ? "Produkt" : "Design"],
          }),
          i,
          user,
          user,
        );
      });
      const notes = createPage(wid, sid, user, "Team-Handbuch");
      run("UPDATE pages SET icon=? WHERE id=?", "book", notes);
      run(
        "UPDATE documents SET html=? WHERE page_id=?",
        "<h2>So arbeiten wir zusammen</h2><p>Wir halten Entscheidungen schriftlich fest, teilen Wissen offen und schaffen Raum für konzentrierte Arbeit.</p><h3>Unser Wochenrhythmus</h3><ul><li>Montag: Prioritäten und Planung</li><li>Mittwoch: Offene Fragen und Feedback</li><li>Freitag: Rückblick auf die Woche</li></ul>",
        notes,
      );
      createPage(wid, sid, user, "Meeting-Notizen", "document", notes);
    }
    return wid;
  });
}
export function ensureWorkspace(user: string) {
  if (!all("SELECT workspace_id FROM members WHERE user_id=?", user).length)
    createWorkspace(user, "Mein Arbeitsbereich", true);
}
