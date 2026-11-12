// Whiteboard templates of the marketplace (see ./types.ts), built with
// the gallery's helpers (lib/whiteboard-template-gallery.ts). German texts.
import { box, frame, label, line, note, slots, type Draft } from "../whiteboard-template-gallery";
import type { ExtraWhiteboard } from "./types";

const emoji = (id: string, x: number, y: number, value: string, size = 70): Draft => ({ id, type: "emoji", emoji: value, x, y, w: size, h: size });

// Fishbone: six classic cause categories (6 M) along a spine to the problem.
function fishbone(): Draft[] {
  const categories = ["Mensch", "Methode", "Maschine", "Material", "Messung", "Mitwelt"];
  const xs = [80, 520, 960];
  return [
    label("h", 0, -110, 900, "Ursache-Wirkungs-Diagramm (Ishikawa)", 28),
    box("problem", 1380, 330, 300, 140, "Problem / Wirkung:\n…", "#ffe3e3", "rounded", 18),
    line("spine", { x: 0, y: 400 }, "problem"),
    ...categories.flatMap((c, i) => {
      const top = i < 3;
      const x = xs[i % 3];
      const y = top ? 0 : 680;
      return [
        box(`c${i}`, x, y, 220, 70, c, "#dbe4ff", "rounded", 18),
        line(`l${i}`, `c${i}`, { x: x + 260, y: 400 }, "straight", true),
        note(`n${i}a`, x + 40, top ? 100 : 500, "Ursache", "#fff6b6", 130),
        note(`n${i}b`, x + 190, top ? 160 : 440, "", "#fff6b6", 110),
      ];
    }),
    label("hint", 0, 820, 1300, "Je Kategorie Ursachen sammeln, dann mit „Warum?“ nachbohren und die wichtigsten markieren.", 16, false),
  ];
}

export const extraWhiteboards: ExtraWhiteboard[] = [
  {
    kind: "whiteboard",
    id: "premortem",
    category: "projects",
    title: { de: "Pre-Mortem", en: "Pre-mortem" },
    tags: ["Pre-Mortem", "Risiko", "Projektstart", "Workshop"],
    summary: {
      de: "Vor dem Start so tun, als wäre das Projekt gescheitert: Gründe sammeln, die wahrscheinlichsten auswählen, Gegenmaßnahmen festlegen.",
      en: "Before starting, imagine the project has failed: collect the reasons, pick the most likely ones, agree on countermeasures.",
    },
    description: {
      de: "Eine Methode, Risiken offen anzusprechen, bevor es zu spät ist.\n\n1. **Scheitern vorstellen**: Jede Person schreibt still 5 Minuten lang Gründe auf Haftnotizen.\n2. **Wahrscheinlichste Ursachen**: gemeinsam clustern, mit Punkten die Top 3 wählen.\n3. **Gegenmaßnahmen**: zu jeder Top-Ursache eine Maßnahme mit Verantwortlichen.\n\nDauer etwa 45 Minuten; die Maßnahmen gehören danach ins Risikoregister.",
      en: "A way to speak about risks openly before it is too late.\n\n1. **Imagine failure**: everyone silently writes reasons on sticky notes for 5 minutes.\n2. **Most likely causes**: cluster together and vote for the top 3.\n3. **Countermeasures**: one action with an owner for each top cause.\n\nTakes about 45 minutes; afterwards the actions belong in the risk register.",
    },
    items: [
      label("h", 0, -90, 1200, "Pre-Mortem: Es ist ein Jahr später – das Projekt ist gescheitert.", 26),
      frame("f1", 0, 0, 640, 680, "1. Was ist schiefgelaufen? (5 min still)", "#fff5f5"),
      ...slots("a", 30, 50, 9, "#ffc9c9", 3, 180, 20),
      frame("f2", 700, 0, 420, 680, "2. Wahrscheinlichste Ursachen (Top 3)", "#fff9db"),
      ...[0, 1, 2].map((i) => box(`t${i}`, 730, 60 + i * 180, 360, 150, `${i + 1}. …`, "#ffffff", "rounded")),
      frame("f3", 1180, 0, 460, 680, "3. Gegenmaßnahmen", "#ebfbee"),
      ...[0, 1, 2].map((i) => note(`m${i}`, 1210, 60 + i * 180, "Maßnahme · wer · bis wann", "#b2f2bb", 150)),
      ...[0, 1, 2].map((i) => line(`l${i}`, `t${i}`, `m${i}`)),
    ],
  },
  {
    kind: "whiteboard",
    id: "mad-sad-glad",
    category: "meetings",
    title: { de: "Retro: Wütend, traurig, froh", en: "Retro: Mad, sad, glad" },
    tags: ["Retrospektive", "Retro", "Gefühle", "Team"],
    summary: {
      de: "Retrospektive über Gefühle: was hat uns geärgert, enttäuscht oder gefreut – und welche Maßnahmen folgen daraus.",
      en: "A retrospective about feelings: what made us mad, sad or glad – and which actions follow.",
    },
    description: {
      de: "Gut für Teams, die über die Sachebene hinaus sprechen wollen.\n\n- Drei Spalten **Wütend**, **Traurig**, **Froh** mit Haftnotizen\n- Feld **Maßnahmen** mit Verantwortlichen\n\nAblauf: 7 Minuten still schreiben, reihum vorstellen, Muster finden, zwei bis drei Maßnahmen vereinbaren.",
      en: "Good for teams that want to talk beyond facts.\n\n- three columns **mad**, **sad**, **glad** with sticky notes\n- an **actions** field with owners\n\nFlow: write silently for 7 minutes, present in turn, find patterns, agree on two or three actions.",
    },
    items: [
      frame("mad", 0, 0, 420, 640, "Wütend", "#fff5f5"),
      emoji("e1", 330, 20, "😠"),
      ...slots("m", 30, 110, 4, "#ffc9c9", 2, 170),
      frame("sad", 460, 0, 420, 640, "Traurig", "#e7f5ff"),
      emoji("e2", 790, 20, "😢"),
      ...slots("s", 490, 110, 4, "#a5d8ff", 2, 170),
      frame("glad", 920, 0, 420, 640, "Froh", "#ebfbee"),
      emoji("e3", 1250, 20, "😊"),
      ...slots("g", 950, 110, 4, "#b2f2bb", 2, 170),
      frame("act", 0, 700, 1340, 260, "Maßnahmen", "#f3f0ff"),
      ...[0, 1, 2].map((i) => note(`a${i}`, 30 + i * 440, 750, "Was · wer · bis wann", "#d0bfff", 170)),
    ],
  },
  {
    kind: "whiteboard",
    id: "fishbone",
    category: "knowledge",
    title: { de: "Ishikawa-Diagramm", en: "Fishbone diagram" },
    tags: ["Ishikawa", "Ursachenanalyse", "Qualität", "Diagramm"],
    summary: {
      de: "Ursache-Wirkungs-Diagramm: ein Problem am Kopf, mögliche Ursachen entlang der sechs Kategorien Mensch, Methode, Maschine, Material, Messung, Mitwelt.",
      en: "Cause-and-effect diagram: a problem at the head, possible causes along six categories – people, method, machine, material, measurement, environment.",
    },
    description: {
      de: "Die Fischgräte hilft, Ursachen systematisch zu sammeln statt bei der ersten zu bleiben.\n\n- **Kopf**: das Problem, möglichst messbar beschrieben\n- **Gräten**: die sechs M als Kategorien – umbenennen, wenn andere besser passen\n- **Haftnotizen** für Ursachen\n\nDanach die wahrscheinlichsten Ursachen markieren und mit Daten prüfen. Passt zum Störungsbericht (Postmortem).",
      en: "The fishbone helps collect causes systematically instead of stopping at the first one.\n\n- **head**: the problem, described measurably if possible\n- **bones**: the six classic categories – rename them when others fit better\n- **sticky notes** for causes\n\nThen mark the most likely causes and check them with data. Goes well with the incident postmortem.",
    },
    items: fishbone(),
  },
  {
    kind: "whiteboard",
    id: "stakeholder-map",
    category: "planning",
    title: { de: "Stakeholder-Matrix", en: "Stakeholder map" },
    tags: ["Stakeholder", "Einfluss", "Kommunikation", "Projekt"],
    summary: {
      de: "Beteiligte nach Einfluss und Interesse einordnen und daraus ableiten, wen man eng einbindet, zufriedenstellt, informiert oder beobachtet.",
      en: "Place stakeholders by influence and interest to decide whom to manage closely, keep satisfied, keep informed or monitor.",
    },
    description: {
      de: "Für den Start eines Projekts oder einer Veränderung.\n\n- Vier Felder nach **Einfluss** (senkrecht) und **Interesse** (waagerecht)\n- Je Feld eine Strategie: **eng einbinden**, **zufriedenstellen**, **informieren**, **beobachten**\n- Ein Feld für **Kommunikationsmaßnahmen**\n\nNamen oder Gruppen auf Haftnotizen schreiben und verschieben, bis die Einordnung passt.",
      en: "For the start of a project or a change.\n\n- four fields by **influence** (vertical) and **interest** (horizontal)\n- one strategy per field: **manage closely**, **keep satisfied**, **keep informed**, **monitor**\n- a field for **communication actions**\n\nWrite names or groups on sticky notes and move them until the placement fits.",
    },
    items: [
      line("y", { x: -20, y: 860 }, { x: -20, y: -20 }),
      line("x", { x: -20, y: 860 }, { x: 940, y: 860 }),
      label("ya", -210, -10, 180, "Hoher Einfluss", 16),
      label("yb", -210, 800, 180, "Geringer Einfluss", 16),
      label("xa", 760, 870, 200, "Hohes Interesse", 16),
      label("xb", 0, 870, 220, "Geringes Interesse", 16),
      frame("q1", 0, 0, 450, 410, "Zufriedenstellen", "#fff9db"),
      frame("q2", 470, 0, 450, 410, "Eng einbinden", "#ffe3e3"),
      frame("q3", 0, 430, 450, 410, "Beobachten", "#f8f9fa"),
      frame("q4", 470, 430, 450, 410, "Informieren", "#e7f5ff"),
      note("n1", 500, 50, "Auftraggeber·in", "#ffc9c9", 140),
      note("n2", 30, 50, "", "#fff6b6", 140),
      note("n3", 500, 480, "", "#a5d8ff", 140),
      note("n4", 30, 480, "", "#e9ecef", 140),
      frame("c", 1000, 0, 520, 840, "Kommunikation", "#ebfbee"),
      {
        id: "ct",
        type: "table",
        x: 1020,
        y: 50,
        w: 480,
        h: 260,
        cells: [["Wer", "Was", "Wie oft"], ["", "", ""], ["", "", ""], ["", "", ""]],
        header: true,
        fontSize: 14,
      },
    ],
  },
  {
    kind: "whiteboard",
    id: "weekly-planner",
    category: "personal",
    title: { de: "Wochenplaner", en: "Weekly planner" },
    tags: ["Woche", "Planung", "Selbstorganisation"],
    summary: {
      de: "Die Woche auf einen Blick: sieben Tagesspalten, die drei Prioritäten, Gewohnheiten zum Abhaken und Platz für Notizen.",
      en: "The week at a glance: seven day columns, the three priorities, habits to tick off and room for notes.",
    },
    description: {
      de: "Ein visueller Wochenplan zum Verschieben.\n\n- **Prioritäten der Woche** oben – maximal drei\n- **Montag bis Sonntag** als Spalten für Termine und Aufgaben\n- **Gewohnheiten** als Tabelle zum Abhaken\n- **Notizen** und ein Feld **Nicht vergessen**\n\nHaftnotizen zwischen den Tagen verschieben, wenn sich Pläne ändern. Jede Woche eine Kopie des Boards anlegen.",
      en: "A visual weekly plan to move things around.\n\n- **priorities of the week** at the top – three at most\n- **Monday to Sunday** as columns for appointments and tasks\n- **habits** as a table to tick off\n- **notes** and a **don't forget** field\n\nMove sticky notes between days when plans change. Copy the board each week.",
    },
    items: [
      frame("p", 0, 0, 1660, 200, "Prioritäten der Woche", "#f3f0ff"),
      ...[0, 1, 2].map((i) => box(`p${i}`, 30 + i * 540, 60, 500, 110, `${i + 1}.`, "#ffffff", "rounded")),
      ...["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"].flatMap((d, i) => [
        frame(`d${i}`, i * 240, 240, 220, 560, d, i < 5 ? "#ffffff" : "#ebfbee"),
        note(`n${i}`, i * 240 + 20, 290, "", i < 5 ? "#fff6b6" : "#b2f2bb", 180),
      ]),
      frame("h", 0, 840, 820, 300, "Gewohnheiten", "#fff9db"),
      {
        id: "ht",
        type: "table",
        x: 20,
        y: 890,
        w: 780,
        h: 220,
        cells: [["Gewohnheit", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"], ["Bewegung", "", "", "", "", "", "", ""], ["Lesen", "", "", "", "", "", "", ""], ["Früh schlafen", "", "", "", "", "", "", ""]],
        header: true,
        fontSize: 14,
      },
      frame("x", 840, 840, 820, 300, "Notizen und nicht vergessen", "#e7f5ff"),
      ...slots("x", 870, 890, 3, "#a5d8ff", 3, 180, 30),
    ],
  },
  {
    kind: "whiteboard",
    id: "wheel-of-life",
    category: "personal",
    title: { de: "Lebensrad", en: "Wheel of life" },
    tags: ["Coaching", "Reflexion", "Ziele", "Balance"],
    summary: {
      de: "Acht Lebensbereiche von 1 bis 10 bewerten, sehen wo es rund läuft und wo nicht, und je Bereich einen nächsten Schritt festlegen.",
      en: "Rate eight areas of life from 1 to 10, see where things run smoothly and where not, and set a next step per area.",
    },
    description: {
      de: "Eine bekannte Coaching-Übung für eine ehrliche Standortbestimmung.\n\n- **Acht Bereiche** rund um die Mitte: Gesundheit, Beziehungen, Familie, Arbeit, Finanzen, Lernen, Freizeit, Sinn\n- In jedem Bereich die **Zufriedenheit von 1 bis 10** eintragen\n- Für die zwei, drei niedrigsten Bereiche einen **nächsten Schritt** notieren\n\nBereiche umbenennen, wenn andere besser zu dir passen. Alle paar Monate wiederholen und vergleichen.",
      en: "A well-known coaching exercise for an honest check-in.\n\n- **eight areas** around the centre: health, relationships, family, work, finances, learning, leisure, meaning\n- enter your **satisfaction from 1 to 10** for each area\n- write a **next step** for the two or three lowest areas\n\nRename areas when others suit you better. Repeat every few months and compare.",
    },
    items: (() => {
      const areas = ["Gesundheit", "Beziehungen", "Familie", "Arbeit", "Finanzen", "Lernen", "Freizeit", "Sinn"];
      const colors = ["#d3f9d8", "#ffe3e3", "#fff3bf", "#dbe4ff", "#e3fafc", "#e5dbff", "#ffe8cc", "#f3d9fa"];
      const cx = 600,
        cy = 600,
        r = 430;
      const out: Draft[] = [box("c", cx - 110, cy - 110, 220, 220, "Ich", "#f8f9fa", "ellipse", 22)];
      areas.forEach((a, i) => {
        const angle = (i / areas.length) * 2 * Math.PI - Math.PI / 2;
        const x = Math.round(cx + r * Math.cos(angle) - 110);
        const y = Math.round(cy + r * Math.sin(angle) - 70);
        out.push(box(`a${i}`, x, y, 220, 140, `${a}\n… / 10`, colors[i], "ellipse", 17));
        out.push(line(`l${i}`, "c", `a${i}`, "straight", false));
      });
      out.push(frame("next", 1240, 0, 480, 1200, "Nächste Schritte", "#ebfbee"));
      out.push(...slots("s", 1270, 50, 6, "#b2f2bb", 2, 200, 20));
      return out;
    })(),
  },
];
