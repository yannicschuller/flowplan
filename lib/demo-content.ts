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
import type { Field, View } from "./types";
import type { WhiteboardItem } from "./whiteboard-model";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
      { id: "role", name: "Rolle", type: "select", options: ["Design", "Entwicklung", "Produkt"] },
      { id: "rate", name: "Stundensatz", type: "number", format: "eur" },
      { id: "email", name: "E-Mail", type: "email" },
    ],
    [view("gallery", "Karten", "gallery", { gallery: { cover: "none", fit: "cover", size: "medium" } }), view("table", "Tabelle", "table")],
    "👥",
  );
  const people = [
    ["Mara Klein", "Design", 85, "mara@example.com"],
    ["Jonas Weber", "Entwicklung", 95, "jonas@example.com"],
    ["Aylin Demir", "Produkt", 90, "aylin@example.com"],
  ].map(([name, role, rate, email], i) => addRow(team, user, i, { title: name, role, rate, email }));

  // ---- Projects: every view, relation, rollup, formula --------------------
  const projects = createPage(workspace, space, user, "Projekte", "database");
  const fields: Field[] = [
    { id: "title", name: "Aufgabe", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Idee", "In Arbeit", "Review", "Erledigt"] },
    { id: "priority", name: "Priorität", type: "select", options: ["Hoch", "Mittel", "Niedrig"] },
    { id: "start", name: "Start", type: "date" },
    { id: "due", name: "Fällig", type: "date" },
    { id: "assignee", name: "Verantwortlich", type: "person" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["Design", "Technik", "Marketing"] },
    { id: "plan", name: "Geplant (h)", type: "number" },
    { id: "hours", name: "Aufwand (h)", type: "number" },
    { id: "done", name: "Abgenommen", type: "checkbox" },
    { id: "team", name: "Team", type: "relation", relationPage: team },
    { id: "rate", name: "Stundensatz Team", type: "rollup", relationField: "team", rollupField: "rate", aggregate: "average" },
    { id: "cost", name: "Kosten", type: "formula", formula: 'round(prop("Aufwand (h)") * prop("Stundensatz Team"), 0)', format: "eur" },
    { id: "files", name: "Anhänge", type: "files" },
  ];
  setDatabase(
    projects,
    fields,
    [
      view("table", "Tabelle", "table", { calculations: { hours: "sum", cost: "sum", done: "percent_checked" } }),
      view("board", "Board", "board", { groupBy: "status" }),
      view("calendar", "Kalender", "calendar", { dateField: "due" }),
      view("timeline", "Timeline", "timeline", { dateField: "start", endDateField: "due" }),
      view("gallery", "Galerie", "gallery"),
      view("list", "Liste", "list", { groupBy: "priority" }),
      view("feed", "Feed", "feed"),
      view("chart", "Diagramm", "chart", {
        chart: {
          kind: "bar",
          xField: "status",
          yField: "plan",
          aggregate: "sum",
          dateBucket: "month",
          order: "label_asc",
          includeEmpty: false,
          showValues: true,
          valueAxisLabel: "Stunden",
          measures: [{ field: "hours", aggregate: "sum" }],
        },
      }),
      view("form", "Formular", "form"),
    ],
    "🚀",
  );
  // Planned hours per entry, compared with the actual effort in the chart.
  const planned = [20, 18, 8, 10, 6, 12];
  const projectRows: [string, string, string, number, number, string[], number, boolean, number[], string][] = [
    ["Neues Onboarding gestalten", "In Arbeit", "Hoch", -4, 6, ["Design"], 16, false, [0, 2], "<h2>Ziel</h2><p>Neue Personen finden sich in fünf Minuten zurecht.</p><ul data-type=\"taskList\">" + task("Interviews auswerten", true) + task("Entwürfe testen") + "</ul>"],
    ["Suche beschleunigen", "Review", "Hoch", -8, 1, ["Technik"], 24, false, [1], "<p>Messung vorher: 420 ms, nachher: 90 ms.</p>"],
    ["Newsletter im Herbst", "Idee", "Mittel", 5, 12, ["Marketing"], 6, false, [2], ""],
    ["Designsystem dokumentieren", "Erledigt", "Mittel", -20, -10, ["Design"], 12, true, [0], "<blockquote><p>Ein Akzent, warmes Papier, dunkle Tinte.</p></blockquote>"],
    ["Offline-Modus testen", "In Arbeit", "Niedrig", -1, 9, ["Technik"], 8, false, [1], ""],
    ["Preisseite überarbeiten", "Idee", "Niedrig", 10, 20, ["Marketing", "Design"], 10, false, [0, 2], ""],
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
  const weekly = addRow(projects, user, projectRows.length, { title: "Wochenplanung", status: "In Arbeit", priority: "Mittel", start: day(0), due: day(0), tags: [], hours: 1 });
  run("UPDATE rows SET recurrence=? WHERE id=?", JSON.stringify({ freq: "weekly", interval: 1, count: 8 }), weekly);
  run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify(fields),
    projects,
  );
  void projectIds;

  // ---- Whiteboard ----------------------------------------------------------
  const board = createPage(workspace, space, user, "Whiteboard: Ideen sammeln", "whiteboard");
  run("UPDATE pages SET icon=? WHERE id=?", "🧠", board);
  setBoard(board, [
    { id: "f1", type: "frame", x: 0, y: 0, w: 520, h: 420, text: "Was wünschen sich Nutzer?", fill: "#e7f5ff" },
    { id: "f2", type: "frame", x: 580, y: 0, w: 520, h: 420, text: "Was bauen wir zuerst?", fill: "#ebfbee" },
    { id: "n1", type: "sticky", x: 30, y: 60, w: 180, h: 160, text: "Schnellere Suche", fill: "#fff6b6", fontSize: 16 },
    { id: "n2", type: "sticky", x: 240, y: 60, w: 180, h: 160, text: "Dunkles Design", fill: "#ffd8a8", fontSize: 16 },
    { id: "n3", type: "sticky", x: 30, y: 240, w: 180, h: 160, text: "Klick mich: verdeckte Antwort", fill: "#d0bfff", fontSize: 16, covered: true },
    { id: "s1", type: "shape", shape: "rounded", x: 640, y: 80, w: 200, h: 90, text: "Suche", fill: "#d3f9d8" },
    { id: "s2", type: "shape", shape: "diamond", x: 880, y: 60, w: 160, h: 130, text: "Test?", fill: "#fff3bf" },
    { id: "s3", type: "shape", shape: "ellipse", x: 740, y: 260, w: 200, h: 100, text: "Release", fill: "#e5dbff" },
    { id: "c1", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s1", x: 0, y: 0 }, to: { id: "s2", x: 0, y: 0 }, endArrow: true, route: "curved" },
    { id: "c2", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s2", x: 0, y: 0 }, to: { id: "s3", x: 0, y: 0 }, endArrow: true, route: "elbow" },
    { id: "t1", type: "text", x: 0, y: 460, w: 700, h: 60, text: "Tipp: V wählt aus, N setzt Zettel, L verbindet – und die Cursor der anderen siehst du live.", fontSize: 18 },
    { id: "e1", type: "emoji", x: 1120, y: 20, w: 80, h: 80, emoji: "🎯" },
  ]);

  // ---- Journal with yesterday's open tasks --------------------------------
  const journal = createPage(workspace, space, user, "Journal", "journal");
  const yesterday = createPage(workspace, space, user, dayTitle(day(-1)), "document", journal);
  run("UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?", day(-1), -Number(day(-1).replaceAll("-", "")), yesterday);
  setDocument(
    yesterday,
    "<p>Gestern: Onboarding-Entwürfe besprochen, Feedback eingearbeitet.</p><ul data-type=\"taskList\">" +
      task("Protokoll verschicken", true) +
      task("Interviewtermine vereinbaren") +
      task("Entwurf für die Preisseite skizzieren") +
      "</ul>",
  );

  // ---- Knowledge with sub pages from templates -----------------------------
  const knowledge = createPage(workspace, space, user, "Wissen", "document");
  const faq = createPage(workspace, space, user, "FAQ", "document", knowledge);
  applyStarterTemplate(faq, user, "faq");
  const howto = createPage(workspace, space, user, "Anleitung", "document", knowledge);
  applyStarterTemplate(howto, user, "howto");
  setDocument(
    knowledge,
    `<p>Wissen wächst als Seitenbaum: ${link(faq, "FAQ")} und ${link(howto, "Anleitung")} sind Unterseiten dieser Seite und stammen aus der Vorlagengalerie.</p>`,
    "📚",
  );

  // ---- Editor tour: every block ---------------------------------------------
  const tour = createPage(workspace, space, user, "Editor-Rundgang", "document");
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
      `<ul data-type="taskList">${task("Erledigte Aufgabe", true)}${task("Offene Aufgabe")}</ul>`,
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
  return welcome;
}
