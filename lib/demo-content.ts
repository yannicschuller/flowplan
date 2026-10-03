// Example workspace of the public demo: a few pages that show every part of
// Flowplan – the editor with all blocks, a database with every view,
// relation, rollup and formula, a whiteboard, a journal and templates.
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { id, run } from "./db";
import { htmlState } from "./document-server";
import { createPage } from "./seed";
import { writeWhiteboard } from "./whiteboard";
import { applyStarterTemplate } from "./starter-templates";
import { dayTitle } from "./journal";
import { indexPageTasks } from "./doc-tasks";
import { ct } from "./content-locale";
import type { Field, View } from "./types";
import type { WhiteboardItem } from "./whiteboard-model";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// The same day a month ago (the last day of a shorter month).
const monthAgo = () => {
  const d = new Date();
  const target = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return Math.round((target.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const link = (pageId: string, text: string) => `<a href="/#page=${pageId}">${text}</a>`;
const task = (text: string, done = false) =>
  `<li data-type="taskItem" data-checked="${done}"><label><input type="checkbox"${done ? " checked" : ""}></label><div><p>${text}</p></div></li>`;
const view = (vid: string, name: string, type: View["type"], extra: Record<string, unknown> = {}) =>
  ({ id: vid, name, type, filters: [], sorts: [], ...extra }) as View;

function setDocument(pageId: string, html: string, icon?: string) {
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  if (icon) run("UPDATE pages SET icon=? WHERE id=?", icon, pageId);
}
function setDatabase(pageId: string, fields: Field[], views: View[], icon: string) {
  run("UPDATE databases SET fields=?,views=? WHERE page_id=?", JSON.stringify(fields), JSON.stringify(views), pageId);
  run("UPDATE pages SET icon=? WHERE id=?", icon, pageId);
}
function addRow(pageId: string, user: string, position: number, cells: Record<string, unknown>, content = "") {
  const rid = id();
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
    rid,
    pageId,
    JSON.stringify(cells),
    position,
    user,
    user,
    content,
  );
  return rid;
}

// Whiteboard items from drafts with local ids (connectors refer to them).
function setBoard(pageId: string, drafts: (Partial<WhiteboardItem> & { id: string; type: WhiteboardItem["type"] })[]) {
  const ids = new Map(drafts.map((d) => [d.id, randomUUID()]));
  const doc = new Y.Doc();
  const items = doc.getMap<Y.Map<unknown>>("items");
  drafts.forEach((draft, z) => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ ...draft, z }))
      if (key !== "id")
        map.set(
          key,
          (key === "from" || key === "to") && value && typeof value === "object"
            ? { ...(value as object), id: ids.get((value as { id?: string }).id || "") }
            : value,
        );
    items.set(ids.get(draft.id)!, map);
  });
  writeWhiteboard(pageId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

export function seedDemoShowcase(workspace: string, space: string, user: string) {
  // ---- Team (relation target) -------------------------------------------
  const team = createPage(workspace, space, user, "Team", "database");
  setDatabase(
    team,
    [
      { id: "title", name: "Name", type: "text" },
      { id: "role", name: ct("Rolle", "Role"), type: "select", options: ["Design", ct("Entwicklung", "Engineering"), ct("Produkt", "Product")] },
      { id: "rate", name: ct("Stundensatz", "Hourly rate"), type: "number", format: "eur" },
      { id: "email", name: ct("E-Mail", "Email"), type: "email" },
    ],
    [view("gallery", ct("Karten", "Cards"), "gallery", { gallery: { cover: "none", fit: "cover", size: "medium" } }), view("table", ct("Tabelle", "Table"), "table")],
    "👥",
  );
  const people = [
    ["Mara Klein", "Design", 85, "mara@example.com"],
    ["Jonas Weber", ct("Entwicklung", "Engineering"), 95, "jonas@example.com"],
    ["Aylin Demir", ct("Produkt", "Product"), 90, "aylin@example.com"],
  ].map(([name, role, rate, email], i) => addRow(team, user, i, { title: name, role, rate, email }));

  // ---- Projects: every view, relation, rollup, formula --------------------
  const projects = createPage(workspace, space, user, ct("Projekte", "Projects"), "database");
  const [idea, doing, review, done] = [ct("Idee", "Idea"), ct("In Arbeit", "In progress"), "Review", ct("Erledigt", "Done")];
  const [high, medium, low] = [ct("Hoch", "High"), ct("Mittel", "Medium"), ct("Niedrig", "Low")];
  const tech = ct("Technik", "Engineering");
  const fields: Field[] = [
    { id: "title", name: ct("Aufgabe", "Task"), type: "text" },
    { id: "status", name: "Status", type: "select", options: [idea, doing, review, done] },
    { id: "priority", name: ct("Priorität", "Priority"), type: "select", options: [high, medium, low] },
    { id: "start", name: "Start", type: "date" },
    { id: "due", name: ct("Fällig", "Due"), type: "date" },
    { id: "assignee", name: ct("Verantwortlich", "Assignee"), type: "person" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["Design", tech, "Marketing"] },
    { id: "plan", name: ct("Geplant (h)", "Planned (h)"), type: "number" },
    { id: "hours", name: ct("Aufwand (h)", "Effort (h)"), type: "number" },
    { id: "done", name: ct("Abgenommen", "Approved"), type: "checkbox" },
    { id: "team", name: "Team", type: "relation", relationPage: team },
    { id: "rate", name: ct("Stundensatz Team", "Team hourly rate"), type: "rollup", relationField: "team", rollupField: "rate", aggregate: "average" },
    { id: "cost", name: ct("Kosten", "Cost"), type: "formula", formula: ct('round(prop("Aufwand (h)") * prop("Stundensatz Team"), 0)', 'round(prop("Effort (h)") * prop("Team hourly rate"), 0)'), format: "eur" },
    { id: "files", name: ct("Anhänge", "Attachments"), type: "files" },
  ];
  setDatabase(
    projects,
    fields,
    [
      view("table", ct("Tabelle", "Table"), "table", { calculations: { hours: "sum", cost: "sum", done: "percent_checked" } }),
      view("board", "Board", "board", { groupBy: "status" }),
      view("calendar", ct("Kalender", "Calendar"), "calendar", { dateField: "due" }),
      view("timeline", "Timeline", "timeline", { dateField: "start", endDateField: "due" }),
      view("gallery", ct("Galerie", "Gallery"), "gallery"),
      view("list", ct("Liste", "List"), "list", { groupBy: "priority" }),
      view("feed", "Feed", "feed"),
      view("chart", ct("Diagramm", "Chart"), "chart", {
        chart: {
          kind: "bar",
          xField: "status",
          yField: "plan",
          aggregate: "sum",
          dateBucket: "month",
          order: "label_asc",
          includeEmpty: false,
          showValues: true,
          valueAxisLabel: ct("Stunden", "Hours"),
          measures: [{ field: "hours", aggregate: "sum" }],
        },
      }),
      view("form", ct("Formular", "Form"), "form"),
    ],
    "🚀",
  );
  // Planned hours per entry, compared with the actual effort in the chart.
  const planned = [20, 18, 8, 10, 6, 12];
  const projectRows: [string, string, string, number, number, string[], number, boolean, number[], string][] = [
    [ct("Neues Onboarding gestalten", "Design the new onboarding"), doing, high, -4, 6, ["Design"], 16, false, [0, 2], ct("<h2>Ziel</h2><p>Neue Personen finden sich in fünf Minuten zurecht.</p>", "<h2>Goal</h2><p>New people find their way around in five minutes.</p>") + "<ul data-type=\"taskList\">" + task(ct("Interviews auswerten", "Analyse the interviews"), true) + task(ct("Entwürfe testen", "Test the drafts")) + "</ul>"],
    [ct("Suche beschleunigen", "Speed up search"), review, high, -8, 1, [tech], 24, false, [1], ct("<p>Messung vorher: 420 ms, nachher: 90 ms.</p>", "<p>Measured before: 420 ms, after: 90 ms.</p>")],
    [ct("Newsletter im Herbst", "Autumn newsletter"), idea, medium, 5, 12, ["Marketing"], 6, false, [2], ""],
    [ct("Designsystem dokumentieren", "Document the design system"), done, medium, -20, -10, ["Design"], 12, true, [0], ct("<blockquote><p>Ein Akzent, warmes Papier, dunkle Tinte.</p></blockquote>", "<blockquote><p>One accent, warm paper, dark ink.</p></blockquote>")],
    [ct("Offline-Modus testen", "Test offline mode"), doing, low, -1, 9, [tech], 8, false, [1], ""],
    [ct("Preisseite überarbeiten", "Rework the pricing page"), idea, low, 10, 20, ["Marketing", "Design"], 10, false, [0, 2], ""],
  ];
  const projectIds = projectRows.map(([title, status, priority, start, due, tags, hours, done, members, content], i) =>
    addRow(
      projects,
      user,
      i,
      { title, status, priority, start: day(start), due: day(due), assignee: user, tags, plan: planned[i], hours, done, team: members.map((m) => people[m]) },
      content,
    ),
  );
  // A repeating entry shows series in calendar and timeline.
  const weekly = addRow(projects, user, projectRows.length, { title: ct("Wochenplanung", "Weekly planning"), status: doing, priority: medium, start: day(0), due: day(0), tags: [], hours: 1 });
  run("UPDATE rows SET recurrence=? WHERE id=?", JSON.stringify({ freq: "weekly", interval: 1, count: 8 }), weekly);
  run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify(fields),
    projects,
  );
  void projectIds;

  // ---- Whiteboard ----------------------------------------------------------
  const board = createPage(workspace, space, user, ct("Whiteboard: Ideen sammeln", "Whiteboard: collect ideas"), "whiteboard");
  run("UPDATE pages SET icon=? WHERE id=?", "🧠", board);
  setBoard(board, [
    { id: "f1", type: "frame", x: 0, y: 0, w: 520, h: 420, text: ct("Was wünschen sich Nutzer?", "What do users want?"), fill: "#e7f5ff" },
    { id: "f2", type: "frame", x: 580, y: 0, w: 520, h: 420, text: ct("Was bauen wir zuerst?", "What do we build first?"), fill: "#ebfbee" },
    { id: "n1", type: "sticky", x: 30, y: 60, w: 180, h: 160, text: ct("Schnellere Suche", "Faster search"), fill: "#fff6b6", fontSize: 16 },
    { id: "n2", type: "sticky", x: 240, y: 60, w: 180, h: 160, text: ct("Dunkles Design", "Dark theme"), fill: "#ffd8a8", fontSize: 16 },
    { id: "n3", type: "sticky", x: 30, y: 240, w: 180, h: 160, text: ct("Klick mich: verdeckte Antwort", "Click me: hidden answer"), fill: "#d0bfff", fontSize: 16, covered: true },
    { id: "s1", type: "shape", shape: "rounded", x: 640, y: 80, w: 200, h: 90, text: ct("Suche", "Search"), fill: "#d3f9d8" },
    { id: "s2", type: "shape", shape: "diamond", x: 880, y: 60, w: 160, h: 130, text: "Test?", fill: "#fff3bf" },
    { id: "s3", type: "shape", shape: "ellipse", x: 740, y: 260, w: 200, h: 100, text: "Release", fill: "#e5dbff" },
    { id: "c1", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s1", x: 0, y: 0 }, to: { id: "s2", x: 0, y: 0 }, endArrow: true, route: "curved" },
    { id: "c2", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s2", x: 0, y: 0 }, to: { id: "s3", x: 0, y: 0 }, endArrow: true, route: "elbow" },
    { id: "t1", type: "text", x: 0, y: 460, w: 700, h: 60, text: ct("Tipp: V wählt aus, N setzt Zettel, L verbindet – und die Cursor der anderen siehst du live.", "Tip: V selects, N adds a note, L connects – and you see the others' cursors live."), fontSize: 18 },
    { id: "e1", type: "emoji", x: 1120, y: 20, w: 80, h: 80, emoji: "🎯", stamps: { [user]: "⭐" } },
    // Stamps on a note, a mind map (Tab adds branches), a symbol and a live
    // record card.
    { id: "m0", type: "shape", shape: "rounded", x: 0, y: 600, w: 180, h: 64, text: "Launch", fill: "#dbe4ff", stroke: "#1f2937", strokeWidth: 2 },
    { id: "m1", type: "shape", shape: "rounded", x: 260, y: 520, w: 160, h: 56, text: "Marketing", fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2 },
    { id: "m2", type: "shape", shape: "rounded", x: 260, y: 600, w: 160, h: 56, text: "Support", fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2 },
    { id: "m3", type: "shape", shape: "rounded", x: 260, y: 680, w: 160, h: 56, text: ct("Dokumentation", "Documentation"), fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2 },
    { id: "k1", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "m0", x: 180, y: 632 }, to: { id: "m1", x: 260, y: 548 }, endArrow: false, route: "curved", stroke: "#868e96" },
    { id: "k2", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "m0", x: 180, y: 632 }, to: { id: "m2", x: 260, y: 628 }, endArrow: false, route: "curved", stroke: "#868e96" },
    { id: "k3", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "m0", x: 180, y: 632 }, to: { id: "m3", x: 260, y: 708 }, endArrow: false, route: "curved", stroke: "#868e96" },
    { id: "i1", type: "emoji", x: 480, y: 580, w: 90, h: 90, emoji: "icon:Rocket:#337ea9" },
    { id: "r1", type: "card", x: 640, y: 560, w: 280, h: 120, pageId: projects, rowId: projectIds[0], fill: "#e0782c" },
    { id: "t2", type: "text", x: 0, y: 780, w: 900, h: 60, text: ct("Mindmap: Element wählen und Tab drücken. ⭐ = Stempel (E), K = Laserpointer, „Folge mir“ unten rechts.", "Mind map: select an element and press Tab. ⭐ = stamp (E), K = laser pointer, “Follow me” at the bottom right."), fontSize: 16 },
  ]);

  // ---- Journal with yesterday's open tasks --------------------------------
  const journal = createPage(workspace, space, user, "Journal", "journal");
  const yesterday = createPage(workspace, space, user, dayTitle(day(-1)), "document", journal);
  run("UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?", day(-1), -Number(day(-1).replaceAll("-", "")), yesterday);
  setDocument(
    yesterday,
    ct("<p>Gestern: Onboarding-Entwürfe besprochen, Feedback eingearbeitet.</p>", "<p>Yesterday: discussed the onboarding drafts, worked in the feedback.</p>") +
      "<ul data-type=\"taskList\">" +
      task(ct("Protokoll verschicken", "Send the minutes"), true) +
      task(ct("Interviewtermine vereinbaren", "Schedule interviews")) +
      task(ct("Entwurf für die Preisseite skizzieren", "Sketch a draft for the pricing page")) +
      "</ul>",
  );
  // Template, trackers and a few earlier days: streak, heatmap, trends and
  // "An diesem Tag" have something to show.
  run(
    "INSERT INTO journal_settings(page_id,template,trackers) VALUES(?,?,?)",
    journal,
    ct(
      "<h3>Dankbar für</h3><p></p><h3>Fokus heute</h3><p></p><h3>Rückblick am Abend</h3><p></p>",
      "<h3>Grateful for</h3><p></p><h3>Focus today</h3><p></p><h3>Evening review</h3><p></p>",
    ),
    JSON.stringify([
      { id: "mood", name: ct("Stimmung", "Mood"), kind: "mood" },
      { id: "sleep", name: ct("Schlaf", "Sleep"), kind: "number", unit: "h" },
      { id: "sport", name: ct("Sport", "Exercise"), kind: "check" },
    ]),
  );
  const entry = (pageId: string, values: Record<string, unknown>, place = "") =>
    run("INSERT INTO journal_entries(page_id,data,place,updated_at) VALUES(?,?,?,?)", pageId, JSON.stringify(values), place, Date.now());
  entry(yesterday, { mood: 4, sleep: 7, sport: true }, ct("Büro", "Office"));
  const earlier: [number, string, Record<string, unknown>, string][] = [
    [-2, ct("<h3>Dankbar für</h3><p>Den Kaffee mit Jana und die ruhige Zugfahrt.</p><h3>Rückblick am Abend</h3><p>Die Roadmap steht, das Team ist zufrieden.</p>", "<h3>Grateful for</h3><p>Coffee with Jana and the quiet train ride.</p><h3>Evening review</h3><p>The roadmap is done, the team is happy.</p>"), { mood: 5, sleep: 8, sport: false }, "Hamburg"],
    [-3, ct("<p>Langer Workshop-Tag. Viele Ideen auf dem Whiteboard gesammelt.</p>", "<p>Long workshop day. Collected lots of ideas on the whiteboard.</p>"), { mood: 3, sleep: 6, sport: true }, ct("Büro", "Office")],
    [-4, ct("<p>Kurzer Tag, abends Laufen an der Alster.</p>", "<p>Short day, a run along the Alster in the evening.</p>"), { mood: 4, sleep: 7.5, sport: true }, ""],
    [-7, ct("<p>Wochenstart: Prioritäten sortiert, drei Kundengespräche.</p>", "<p>Start of the week: sorted priorities, three client calls.</p>"), { mood: 3, sleep: 6.5 }, ""],
    [-9, ct("<p>Erster Entwurf der Preisseite, Feedback eingeholt.</p>", "<p>First draft of the pricing page, gathered feedback.</p>"), { mood: 4, sleep: 7 }, ""],
    [monthAgo(), ct("<p>Kick-off für das neue Projekt. Aufregend!</p>", "<p>Kick-off for the new project. Exciting!</p>"), { mood: 5, sleep: 8, sport: true }, "Berlin"],
  ];
  for (const [offset, html, values, place] of earlier) {
    const past = createPage(workspace, space, user, dayTitle(day(offset)), "document", journal);
    run("UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?", day(offset), -Number(day(offset).replaceAll("-", "")), past);
    setDocument(past, html);
    entry(past, values, place);
  }

  // ---- Knowledge with sub pages from templates -----------------------------
  const knowledge = createPage(workspace, space, user, ct("Wissen", "Knowledge"), "document");
  const faq = createPage(workspace, space, user, "FAQ", "document", knowledge);
  applyStarterTemplate(faq, user, "faq");
  const howto = createPage(workspace, space, user, ct("Anleitung", "How-to guide"), "document", knowledge);
  applyStarterTemplate(howto, user, "howto");
  setDocument(
    knowledge,
    ct(
      `<p>Wissen wächst als Seitenbaum: ${link(faq, "FAQ")} und ${link(howto, "Anleitung")} sind Unterseiten dieser Seite und stammen aus der Vorlagengalerie.</p>`,
      `<p>Knowledge grows as a page tree: ${link(faq, "FAQ")} and ${link(howto, "How-to guide")} are sub-pages of this page and come from the template gallery.</p>`,
    ),
    "📚",
  );

  // ---- Editor tour: every block ---------------------------------------------
  const tour = createPage(workspace, space, user, ct("Editor-Rundgang", "Editor tour"), "document");
  // A synced block: the same content here and on the welcome page.
  const synced = createPage(workspace, space, user, ct("Synchronisierter Block", "Synced block"), "document", tour);
  run("UPDATE pages SET synced=1 WHERE id=?", synced);
  setDocument(
    synced,
    ct(
      "<p>📌 <strong>Synchronisiert:</strong> Dieser Hinweis steht im Editor-Rundgang und auf der Willkommensseite. Ändere ihn an einer Stelle – er ändert sich überall.</p>",
      "<p>📌 <strong>Synced:</strong> this note sits in the editor tour and on the welcome page. Change it in one place – it changes everywhere.</p>",
    ),
  );
  const linkedViews = JSON.stringify([view("linked-board", "Board", "board", { groupBy: "status" })]);
  setDocument(
    tour,
    [
      "<p>Diese Seite zeigt, was der Editor kann. Tippe irgendwo <code>/</code> für das Blockmenü oder markiere Text für die Formatierung.</p>",
      "<h2>Text und Formatierung</h2>",
      '<p><strong>Fett</strong>, <em>kursiv</em>, <u>unterstrichen</u>, <s>durchgestrichen</s>, <code>Code</code>, <mark data-color="#fff3bf" style="background-color:#fff3bf">markiert</mark>, <span style="color:#3b3fd8">farbig</span>, E = mc<sup>2</sup>, H<sub>2</sub>O und ein <span data-spoiler="true">verdeckter Spoiler – klick drauf</span>.</p>',
      '<p data-indent="1">Mit Tab eingerückter Absatz.</p>',
      `<p>Erwähnung: <span data-mention="${esc(user)}" class="mention">@Demo-Gast</span> · Link auf eine Seite: ${link(projects, "Projekte")}</p>`,
      "<h2>Listen und Aufgaben</h2>",
      "<ul><li><p>Aufzählung</p><ul><li><p>verschachtelt</p></li></ul></li><li><p>zweiter Punkt</p></li></ul>",
      "<ol><li><p>Nummeriert</p></li><li><p>zweitens</p></li></ol>",
      `<ul data-type="taskList">${task("Erledigte Aufgabe", true)}${task("Offene Aufgabe")}` +
        `<li data-type="taskItem" data-checked="false" data-due="${day(1)}"><label><input type="checkbox"></label><div><p>Aufgabe mit Datum für <span data-mention="${esc(user)}" class="mention">@Demo-Gast</span> – steht unter „Meine Aufgaben“</p></div></li>` +
        `<li data-type="taskItem" data-checked="false" data-due="${day(-2)}"><label><input type="checkbox"></label><div><p>Überfällige Aufgabe</p></div></li></ul>`,
      `<p data-reactions='${JSON.stringify({ "👍": [user], "🎉": [user] })}'>Auf Absätze lässt sich reagieren – Cursor in einen Absatz setzen und rechts auf das Smiley tippen.</p>`,
      "<h2>Vorschläge</h2>",
      `<p>Im Vorschlagsmodus (Stift in der Werkzeugleiste) wird aus Änderungen ein Vorschlag: Das Treffen ist am <span data-suggestion="delete" data-suggestion-id="demo1" data-suggestion-author="${esc(user)}" data-suggestion-name="Demo-Gast" data-suggestion-at="${Date.now()}">Montag</span><span data-suggestion="insert" data-suggestion-id="demo1" data-suggestion-author="${esc(user)}" data-suggestion-name="Demo-Gast" data-suggestion-at="${Date.now()}">Dienstag</span> um 10 Uhr.</p>`,
      "<h2>Synchronisierter Block</h2>",
      `<div data-synced-block="${synced}"></div>`,
      "<h2>Hervorheben und Aufklappen</h2>",
      '<aside data-callout="true"><p>💡 Ein Hinweis-Block für Wichtiges.</p></aside>',
      "<blockquote><p>Ein Zitat.</p></blockquote>",
      "<details><summary>Aufklappbarer Block</summary><div><p>Versteckter Inhalt, bis man ihn öffnet.</p></div></details>",
      "<h2>Code, Formeln und Diagramme</h2>",
      '<pre><code class="language-typescript">const greeting = (name: string) =&gt; `Hallo ${name}!`;</code></pre>',
      '<div data-math="\\int_0^1 x^2\\,dx = \\tfrac{1}{3}" class="math-block"></div>',
      '<p>Inline-Formel: <span data-math="a^2 + b^2 = c^2" class="math-inline"></span></p>',
      `<div data-mermaid="${esc("flowchart LR\n  Idee --> Plan --> Umsetzung --> Release")}" class="mermaid-block"></div>`,
      "<h2>Tabelle und Spalten</h2>",
      "<table><tbody><tr><th><p>Plan</p></th><th><p>Status</p></th></tr><tr><td><p>Onboarding</p></td><td><p>In Arbeit</p></td></tr><tr><td><p>Suche</p></td><td><p>Review</p></td></tr></tbody></table>",
      '<div data-columns="true"><div data-column="true"><h3>Links</h3><p>Zwei Spalten nebeneinander – auf dem Handy untereinander.</p></div><div data-column="true"><h3>Rechts</h3><p>Blöcke lassen sich per Griff zwischen Spalten ziehen.</p></div></div>',
      "<h2>Datenbank und Whiteboard im Dokument</h2>",
      `<div data-linked-database="${randomUUID()}" data-linked-source="${projects}" data-linked-views="${esc(linkedViews)}" data-linked-version="1"></div>`,
      `<div data-whiteboard="${board}" data-whiteboard-height="380"></div>`,
      "<h2>Einbettung</h2>",
      '<iframe src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"></iframe>',
      "<hr>",
      "<p>Text markieren und „Text kommentieren“ wählen startet eine Diskussion direkt an der Stelle.</p>",
    ].join(""),
    "✍️",
  );

  // ---- Welcome page, first in the tree --------------------------------------
  const welcome = createPage(workspace, space, user, "Willkommen in der Demo", "document");
  run("UPDATE pages SET position=-1 WHERE id=?", welcome);
  setDocument(
    welcome,
    `<p>Das ist dein eigener Demo-Arbeitsbereich. Probiere alles aus – er wird gelöscht, sobald du die Demo beendest.</p>` +
      `<div data-synced-block="${synced}"></div>` +
      `<aside data-callout="true"><p>👉 Lieblingsstellen: ${link(tour, "Editor-Rundgang")}, ${link(projects, "Projekte")} (neun Ansichten), ${link(board, "Whiteboard")} und ${link(journal, "Journal")}.</p></aside>` +
      "<h2>Was du hier findest</h2>" +
      `<ul><li><p>${link(tour, "Editor-Rundgang")} – alle Blöcke: Aufgaben, Code, Formeln, Diagramme, Spalten, Spoiler, Einbettungen.</p></li>` +
      `<li><p>${link(projects, "Projekte")} – Tabelle, Board, Kalender, Timeline, Galerie, Liste, Feed, Diagramm und Formular; mit Relation zu ${link(team, "Team")}, Rollup und Formel.</p></li>` +
      `<li><p>${link(board, "Whiteboard")} – Rahmen, Zettel, Formen, Verbindungen und ein verdeckter Zettel.</p></li>` +
      `<li><p>${link(journal, "Journal")} – die offenen Aufgaben von gestern sind heute schon da.</p></li>` +
      `<li><p>${link(knowledge, "Wissen")} – Unterseiten aus der Vorlagengalerie.</p></li></ul>` +
      "<h2>Probier das</h2><ul data-type=\"taskList\">" +
      task("Tippe <code>/</code> in einem Dokument und wähle einen Block") +
      task("Ziehe eine Karte im Board in eine andere Spalte") +
      task("Öffne die Vorlagen unten in der Seitenleiste") +
      task("Drücke ⌘K (Strg+K) und suche nach „Onboarding“") +
      "</ul>",
    "👋",
  );
  // "Meine Aufgaben" shows the tasks of the tour right away.
  indexPageTasks(tour);
  return welcome;
}
