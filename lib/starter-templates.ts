import { id, run } from "./db";
import { htmlState } from "./document-server";
import { defaultFields, defaultViews } from "./seed";
import type { Field, View } from "./types";
export const starterTemplates = {
  meeting: {
    name: "Meeting-Notizen",
    kind: "document",
    html: '<h2>Besprechung</h2><p><strong>Datum:</strong> </p><p><strong>Teilnehmende:</strong> </p><h2>Ziel</h2><p>Was möchten wir in dieser Besprechung erreichen?</p><h2>Agenda</h2><ol><li><p>Aktueller Stand</p></li><li><p>Offene Fragen</p></li><li><p>Nächste Schritte</p></li></ol><h2>Entscheidungen</h2><p>Halte fest, was entschieden wurde und warum.</p><h2>Aufgaben</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Aufgabe, Verantwortliche und Termin festlegen</p></div></li></ul>',
  },
  wiki: {
    name: "Team-Wiki",
    kind: "document",
    html: "<h2>Willkommen im Team</h2><p>Hier findest du das Wissen, das wir für unsere tägliche Zusammenarbeit brauchen.</p><h2>Unser Auftrag</h2><p>Beschreibe, wofür dein Team verantwortlich ist.</p><h2>Zusammenarbeit</h2><h3>Kommunikation</h3><p>Welche Kanäle nutzen wir? Wann ist eine Antwort erforderlich?</p><h3>Entscheidungen</h3><p>Wie treffen und dokumentieren wir Entscheidungen?</p><h2>Wichtige Kontakte</h2><table><tbody><tr><th><p>Thema</p></th><th><p>Ansprechperson</p></th></tr><tr><td><p>Onboarding</p></td><td><p></p></td></tr><tr><td><p>Prozesse</p></td><td><p></p></td></tr></tbody></table><h2>Wissenssammlung</h2><p>Erstelle Unterseiten für Prozesse, Projekte und häufige Fragen. Verknüpfe sie mit @.</p>",
  },
  project: { name: "Projektplanung", kind: "database" },
  tasks: { name: "Aufgabenliste", kind: "database" },
} as const;
export type StarterTemplateKey = keyof typeof starterTemplates;
export function applyStarterTemplate(
  pageId: string,
  userId: string,
  key: StarterTemplateKey,
) {
  const template = starterTemplates[key];
  if (template.kind === "document") {
    run(
      "UPDATE documents SET html=?,state=? WHERE page_id=?",
      template.html,
      htmlState(template.html),
      pageId,
    );
    return;
  }
  let fields: Field[] = structuredClone(defaultFields),
    views: View[] = structuredClone(defaultViews);
  if (key === "project") {
    fields.push(
      { id: "start", name: "Startdatum", type: "date" },
      { id: "effort", name: "Aufwand (h)", type: "number" },
      { id: "done", name: "Abgeschlossen", type: "checkbox" },
    );
    views = views.map((v) =>
      v.type === "timeline"
        ? { ...v, dateField: "start", endDateField: "date" }
        : v,
    );
  } else {
    fields = fields.filter((f) =>
      ["title", "status", "date", "assignee", "priority"].includes(f.id),
    );
    views = views.filter((v) =>
      ["table", "board", "calendar", "list"].includes(v.type),
    );
  }
  run(
    "UPDATE databases SET fields=?,views=? WHERE page_id=?",
    JSON.stringify(fields),
    JSON.stringify(views),
    pageId,
  );
  const examples =
    key === "project"
      ? [
          "Projektziel und Erfolgskriterien festlegen",
          "Meilensteine planen",
          "Projektabschluss dokumentieren",
        ]
      : ["Prioritäten für diese Woche festlegen"];
  examples.forEach((title, i) =>
    run(
      "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
      id(),
      pageId,
      JSON.stringify({
        title,
        status: "Nicht begonnen",
        priority: i === 0 ? "Hoch" : "Mittel",
      }),
      i,
      userId,
      userId,
      key === "project"
        ? "<h2>Ergebnis</h2><p>Was soll mit dieser Aufgabe erreicht werden?</p><h2>Akzeptanzkriterien</h2><ul><li><p>Ergebnis überprüfbar beschreiben</p></li></ul>"
        : "",
    ),
  );
}
