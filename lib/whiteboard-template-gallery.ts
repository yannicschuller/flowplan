// The template gallery of whiteboards: the five classic boards of
// lib/whiteboard-templates.ts and many more, by category, with words to
// find them. Texts come in the reader's language: every builder gets the
// translation function (t(German, English), like the interface).
import { templateItems, type WhiteboardTemplate } from "./whiteboard-templates";
import type { WhiteboardItem } from "./whiteboard-model";

export type Draft = Omit<WhiteboardItem, "z"> & { z?: number };
export type T = (de: string, en: string) => string;
export type GalleryCategory = "retro" | "planning" | "strategy" | "ideas" | "diagrams" | "meetings";
export type GalleryTemplate = {
  id: string;
  category: GalleryCategory;
  name: (t: T) => string;
  description: (t: T) => string;
  // Extra words for the search (both languages).
  keywords: string;
  items: (t: T) => Draft[];
};

const frame = (id: string, x: number, y: number, w: number, h: number, text: string, fill = "#ffffff"): Draft => ({
  id,
  type: "frame",
  x,
  y,
  w,
  h,
  text,
  fill,
});
const note = (id: string, x: number, y: number, text = "", fill = "#fff6b6", size = 160): Draft => ({
  id,
  type: "sticky",
  x,
  y,
  w: size,
  h: size,
  text,
  fill,
  fontSize: 16,
});
const box = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  fill = "#ffffff",
  kind: WhiteboardItem["shape"] = "rectangle",
  fontSize = 16,
): Draft => ({
  id,
  type: "shape",
  shape: kind,
  x,
  y,
  w,
  h,
  text,
  fill,
  stroke: "#1f2937",
  strokeWidth: 2,
  fontSize,
});
// A heading or label on the board.
const label = (id: string, x: number, y: number, w: number, text: string, fontSize = 20, bold = true): Draft => ({
  id,
  type: "text",
  x,
  y,
  w,
  h: Math.round(fontSize * 1.8),
  text,
  fontSize,
  bold,
  align: "left",
});
const line = (
  id: string,
  from: string | { x: number; y: number },
  to: string | { x: number; y: number },
  route: WhiteboardItem["route"] = "straight",
  arrow = true,
): Draft => ({
  id,
  type: "connector",
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  from: typeof from === "string" ? { id: from, x: 0, y: 0 } : from,
  to: typeof to === "string" ? { id: to, x: 0, y: 0 } : to,
  stroke: "#1f2937",
  strokeWidth: 2,
  endArrow: arrow,
  route,
});
// A grid of empty notes inside a frame, as space to write.
const slots = (prefix: string, x: number, y: number, count: number, fill: string, cols = 2, size = 140, gap = 20) =>
  Array.from({ length: count }, (_, i) =>
    note(`${prefix}${i}`, x + (i % cols) * (size + gap), y + Math.floor(i / cols) * (size + gap), "", fill, size),
  );

const classic = (kind: WhiteboardTemplate) => () => templateItems(kind) as Draft[];

export const galleryTemplates: GalleryTemplate[] = [
  {
    id: "retro",
    category: "retro",
    name: (t) => t("Retrospektive", "Retrospective"),
    description: (t) => t("Was lief gut, was verbessern wir, welche Maßnahmen folgen.", "What went well, what to improve, which actions follow."),
    keywords: "retro sprint team feedback",
    items: classic("retro"),
  },
  {
    id: "retro4l",
    category: "retro",
    name: (t) => t("4L-Retrospektive", "4L retrospective"),
    description: (t) => t("Liked, Learned, Lacked, Longed for – vier Felder für die Rückschau.", "Liked, learned, lacked, longed for – four fields to look back."),
    keywords: "4l retro liked learned lacked longed",
    items: (t) => [
      frame("f1", 0, 0, 420, 420, t("Gefallen (Liked)", "Liked"), "#ebfbee"),
      frame("f2", 460, 0, 420, 420, t("Gelernt (Learned)", "Learned"), "#e7f5ff"),
      frame("f3", 0, 480, 420, 420, t("Gefehlt (Lacked)", "Lacked"), "#fff5f5"),
      frame("f4", 460, 480, 420, 420, t("Gewünscht (Longed for)", "Longed for"), "#fff9db"),
      ...slots("a", 40, 40, 2, "#b2f2bb"),
      ...slots("b", 500, 40, 2, "#a5d8ff"),
      ...slots("c", 40, 520, 2, "#ffc9c9"),
      ...slots("d", 500, 520, 2, "#fff6b6"),
    ],
  },
  {
    id: "starfish",
    category: "retro",
    name: (t) => t("Seestern-Retrospektive", "Starfish retrospective"),
    description: (t) => t("Beibehalten, mehr davon, weniger davon, aufhören, anfangen.", "Keep doing, more of, less of, stop doing, start doing."),
    keywords: "starfish seestern retro keep stop start",
    items: (t) => [
      box("c", 340, 300, 220, 220, t("Seestern", "Starfish"), "#fff3bf", "star", 18),
      frame("f1", 280, 0, 340, 260, t("Beibehalten", "Keep doing"), "#ebfbee"),
      frame("f2", 660, 220, 340, 260, t("Mehr davon", "More of"), "#e7f5ff"),
      frame("f3", 580, 560, 340, 260, t("Anfangen", "Start doing"), "#f3f0ff"),
      frame("f4", -20, 560, 340, 260, t("Aufhören", "Stop doing"), "#fff5f5"),
      frame("f5", -100, 220, 340, 260, t("Weniger davon", "Less of"), "#fff4e6"),
      note("n1", 310, 40, "", "#b2f2bb", 120),
      note("n2", 690, 260, "", "#a5d8ff", 120),
      note("n3", 610, 600, "", "#d0bfff", 120),
      note("n4", 10, 600, "", "#ffc9c9", 120),
      note("n5", -70, 260, "", "#ffd8a8", 120),
    ],
  },
  {
    id: "kanban",
    category: "planning",
    name: (t) => t("Kanban", "Kanban"),
    description: (t) => t("Offen, in Arbeit, erledigt.", "To do, in progress, done."),
    keywords: "kanban board aufgaben tasks",
    items: classic("kanban"),
  },
  {
    id: "storymap",
    category: "planning",
    name: (t) => t("User Story Map", "User story map"),
    description: (t) => t("Aktivitäten, Schritte und Stories nach Release geordnet.", "Activities, steps and stories ordered by release."),
    keywords: "user story map backlog release produkt product",
    items: (t) => {
      const steps = [t("Aktivität", "Activity"), t("Aktivität", "Activity"), t("Aktivität", "Activity")];
      return [
        label("h", 0, -70, 600, t("User Story Map", "User story map"), 28),
        ...steps.map((s, i) => box(`a${i}`, 200 + i * 420, 0, 380, 80, `${s} ${i + 1}`, "#dbe4ff", "rounded", 18)),
        ...[0, 1, 2].flatMap((i) => [
          note(`s${i}a`, 200 + i * 420, 120, t("Schritt", "Step"), "#ffd8a8", 180),
          note(`s${i}b`, 400 + i * 420, 120, t("Schritt", "Step"), "#ffd8a8", 180),
        ]),
        frame("r1", 180, 340, 1260, 230, t("Release 1 (MVP)", "Release 1 (MVP)"), "#ebfbee"),
        frame("r2", 180, 610, 1260, 230, t("Release 2", "Release 2"), "#e7f5ff"),
        label("l1", 0, 140, 180, t("Schritte", "Steps"), 16),
        label("l0", 0, 20, 180, t("Aktivitäten", "Activities"), 16),
        ...[0, 1, 2].map((i) => note(`u${i}`, 200 + i * 420, 370, t("Story", "Story"), "#fff6b6", 170)),
        ...[0, 1, 2].map((i) => note(`v${i}`, 200 + i * 420, 640, t("Story", "Story"), "#fff6b6", 170)),
      ];
    },
  },
  {
    id: "sprint",
    category: "planning",
    name: (t) => t("Sprint-Planung", "Sprint planning"),
    description: (t) => t("Sprintziel, Kapazität, Backlog und Risiken auf einen Blick.", "Sprint goal, capacity, backlog and risks at a glance."),
    keywords: "sprint planning scrum backlog kapazität capacity",
    items: (t) => [
      frame("g", 0, 0, 1240, 160, t("Sprintziel", "Sprint goal"), "#f3f0ff"),
      label("gt", 30, 50, 900, t("Was wollen wir in diesem Sprint erreichen?", "What do we want to achieve in this sprint?"), 22, false),
      frame("c", 0, 220, 300, 520, t("Kapazität", "Capacity"), "#fff9db"),
      {
        id: "ct",
        type: "table",
        x: 20,
        y: 250,
        w: 260,
        h: 200,
        cells: [[t("Person", "Person"), t("Tage", "Days")], ["", ""], ["", ""], ["", ""]],
        header: true,
        fontSize: 14,
      },
      frame("b", 340, 220, 440, 520, t("Product Backlog", "Product backlog"), "#ffffff"),
      frame("s", 820, 220, 420, 520, t("Sprint Backlog", "Sprint backlog"), "#ebfbee"),
      ...slots("b", 370, 250, 4, "#a5d8ff", 2, 180),
      ...slots("s", 850, 250, 2, "#b2f2bb", 2, 170),
      frame("r", 0, 800, 1240, 220, t("Risiken und Abhängigkeiten", "Risks and dependencies"), "#fff5f5"),
      ...slots("r", 30, 830, 3, "#ffc9c9", 3, 150),
    ],
  },
  {
    id: "timeline",
    category: "planning",
    name: (t) => t("Projektzeitplan", "Project timeline"),
    description: (t) => t("Phasen und Meilensteine auf einer Zeitachse.", "Phases and milestones on a time axis."),
    keywords: "timeline zeitplan roadmap meilenstein milestone gantt",
    items: (t) => {
      const phases = [t("Planung", "Planning"), t("Umsetzung", "Delivery"), t("Test", "Testing"), t("Start", "Launch")];
      const colors = ["#e7f5ff", "#ebfbee", "#fff9db", "#f3f0ff"];
      return [
        label("h", 0, -80, 600, t("Projektzeitplan", "Project timeline"), 28),
        line("axis", { x: 0, y: 300 }, { x: 1640, y: 300 }),
        ...phases.map((p, i) => frame(`p${i}`, i * 410, 0, 390, 250, p, colors[i])),
        ...phases.map((_, i) => note(`n${i}`, i * 410 + 20, 40, t("Aufgabe", "Task"), "#fff6b6", 150)),
        ...[0, 1, 2, 3].map((i) =>
          box(`m${i}`, i * 410 + 370, 280, 40, 40, "", "#e03131", "diamond"),
        ),
        ...[0, 1, 2, 3].map((i) => label(`ml${i}`, i * 410 + 250, 330, 200, `${t("Meilenstein", "Milestone")} ${i + 1}`, 14, false)),
      ];
    },
  },
  {
    id: "okr",
    category: "strategy",
    name: (t) => t("OKR", "OKRs"),
    description: (t) => t("Ein Ziel, messbare Schlüsselergebnisse und Initiativen.", "One objective, measurable key results and initiatives."),
    keywords: "okr objectives key results ziele goals",
    items: (t) => [
      frame("o", 0, 0, 360, 600, t("Ziel (Objective)", "Objective"), "#f3f0ff"),
      note("on", 40, 60, t("Was wollen wir erreichen?", "What do we want to achieve?"), "#d0bfff", 280),
      frame("k", 400, 0, 460, 600, t("Schlüsselergebnisse", "Key results"), "#e7f5ff"),
      ...[0, 1, 2].map((i) =>
        box(`k${i}`, 430, 50 + i * 180, 400, 150, `${t("Ergebnis", "Key result")} ${i + 1}: ${t("von … auf …", "from … to …")}`, "#ffffff", "rounded"),
      ),
      frame("i", 900, 0, 420, 600, t("Initiativen", "Initiatives"), "#ebfbee"),
      ...slots("i", 930, 40, 4, "#b2f2bb", 2, 170),
    ],
  },
  {
    id: "swot",
    category: "strategy",
    name: (t) => t("SWOT-Analyse", "SWOT analysis"),
    description: (t) => t("Stärken, Schwächen, Chancen, Risiken.", "Strengths, weaknesses, opportunities, threats."),
    keywords: "swot stärken schwächen strengths weaknesses",
    items: classic("swot"),
  },
  {
    id: "lean",
    category: "strategy",
    name: (t) => t("Lean Canvas", "Lean canvas"),
    description: (t) => t("Geschäftsidee auf einer Seite: Problem, Lösung, Kunden, Zahlen.", "A business idea on one page: problem, solution, customers, numbers."),
    keywords: "lean canvas startup geschäftsmodell business",
    items: (t) => [
      frame("p", 0, 0, 280, 560, t("Problem", "Problem"), "#fff5f5"),
      frame("s", 300, 0, 280, 270, t("Lösung", "Solution"), "#ebfbee"),
      frame("m", 300, 290, 280, 270, t("Kennzahlen", "Key metrics"), "#e7f5ff"),
      frame("v", 600, 0, 280, 560, t("Alleinstellungsmerkmal", "Unique value proposition"), "#f3f0ff"),
      frame("a", 900, 0, 280, 270, t("Unfairer Vorteil", "Unfair advantage"), "#fff9db"),
      frame("c", 900, 290, 280, 270, t("Kanäle", "Channels"), "#e6fcf5"),
      frame("k", 1200, 0, 280, 560, t("Kundensegmente", "Customer segments"), "#fff4e6"),
      frame("co", 0, 600, 730, 240, t("Kostenstruktur", "Cost structure"), "#f8f9fa"),
      frame("r", 750, 600, 730, 240, t("Einnahmequellen", "Revenue streams"), "#f8f9fa"),
    ],
  },
  {
    id: "bmc",
    category: "strategy",
    name: (t) => t("Business Model Canvas", "Business model canvas"),
    description: (t) => t("Neun Bausteine eines Geschäftsmodells.", "Nine building blocks of a business model."),
    keywords: "business model canvas geschäftsmodell osterwalder",
    items: (t) => [
      frame("kp", 0, 0, 280, 560, t("Schlüsselpartner", "Key partners"), "#f8f9fa"),
      frame("ka", 300, 0, 280, 270, t("Schlüsselaktivitäten", "Key activities"), "#e7f5ff"),
      frame("kr", 300, 290, 280, 270, t("Schlüsselressourcen", "Key resources"), "#e7f5ff"),
      frame("vp", 600, 0, 280, 560, t("Wertangebote", "Value propositions"), "#f3f0ff"),
      frame("cr", 900, 0, 280, 270, t("Kundenbeziehungen", "Customer relationships"), "#fff4e6"),
      frame("ch", 900, 290, 280, 270, t("Kanäle", "Channels"), "#fff4e6"),
      frame("cs", 1200, 0, 280, 560, t("Kundensegmente", "Customer segments"), "#fff4e6"),
      frame("co", 0, 600, 730, 240, t("Kostenstruktur", "Cost structure"), "#fff5f5"),
      frame("rs", 750, 600, 730, 240, t("Einnahmequellen", "Revenue streams"), "#ebfbee"),
    ],
  },
  {
    id: "journey",
    category: "strategy",
    name: (t) => t("Customer Journey", "Customer journey"),
    description: (t) => t("Phasen der Kundschaft mit Handlungen, Berührungspunkten und Gefühlen.", "Customer phases with actions, touchpoints and feelings."),
    keywords: "customer journey kundenreise ux touchpoints",
    items: (t) => {
      const phases = [t("Aufmerksam werden", "Awareness"), t("Abwägen", "Consideration"), t("Kaufen", "Purchase"), t("Nutzen", "Use"), t("Treue", "Loyalty")];
      const rows = [t("Handlungen", "Actions"), t("Berührungspunkte", "Touchpoints"), t("Gefühle", "Feelings"), t("Probleme", "Pain points"), t("Chancen", "Opportunities")];
      const fills = ["#e7f5ff", "#f3f0ff", "#fff9db", "#fff5f5", "#ebfbee"];
      return [
        label("h", 0, -110, 700, t("Customer Journey", "Customer journey"), 28),
        ...phases.map((p, c) => box(`p${c}`, 200 + c * 260, -40, 240, 60, p, "#dbe4ff", "rounded", 16)),
        ...rows.flatMap((r, i) => [
          label(`r${i}`, 0, 40 + i * 190 + 70, 190, r, 16),
          ...phases.map((_, c) => box(`c${i}_${c}`, 200 + c * 260, 40 + i * 190, 240, 170, "", fills[i], "rectangle", 14)),
        ]),
      ];
    },
  },
  {
    id: "empathy",
    category: "ideas",
    name: (t) => t("Empathy Map", "Empathy map"),
    description: (t) => t("Was eine Person sagt, denkt, tut und fühlt.", "What a person says, thinks, does and feels."),
    keywords: "empathy map persona design thinking ux",
    items: (t) => [
      frame("s", 0, 0, 440, 360, t("Sagt", "Says"), "#e7f5ff"),
      frame("th", 480, 0, 440, 360, t("Denkt", "Thinks"), "#f3f0ff"),
      frame("d", 0, 400, 440, 360, t("Tut", "Does"), "#ebfbee"),
      frame("f", 480, 400, 440, 360, t("Fühlt", "Feels"), "#fff4e6"),
      box("p", 360, 290, 200, 180, t("Person", "Persona"), "#ffffff", "ellipse", 18),
      frame("pa", 0, 800, 440, 240, t("Probleme", "Pains"), "#fff5f5"),
      frame("ga", 480, 800, 440, 240, t("Gewinne", "Gains"), "#fff9db"),
    ],
  },
  {
    id: "brainstorm",
    category: "ideas",
    name: (t) => t("Brainstorming", "Brainstorm"),
    description: (t) => t("Eine Frage in der Mitte, Platz für Ideen und Cluster.", "A question in the middle, room for ideas and clusters."),
    keywords: "brainstorming ideen ideas workshop cluster",
    items: (t) => [
      box("q", 360, 0, 360, 140, t("Unsere Frage: Wie könnten wir …?", "Our question: How might we …?"), "#e5dbff", "cloud", 18),
      frame("i", 0, 200, 1080, 420, t("Ideen", "Ideas"), "#fffdf2"),
      ...slots("i", 30, 240, 6, "#fff6b6", 6, 150, 25),
      frame("c1", 0, 680, 340, 300, t("Cluster A", "Cluster A"), "#e7f5ff"),
      frame("c2", 370, 680, 340, 300, t("Cluster B", "Cluster B"), "#ebfbee"),
      frame("c3", 740, 680, 340, 300, t("Cluster C", "Cluster C"), "#fff4e6"),
    ],
  },
  {
    id: "mindmap",
    category: "ideas",
    name: (t) => t("Mindmap", "Mind map"),
    description: (t) => t("Ein Thema in der Mitte mit vier Ästen.", "A topic in the middle with four branches."),
    keywords: "mindmap mind map ideen ideas",
    items: classic("mindmap"),
  },
  {
    id: "eisenhower",
    category: "planning",
    name: (t) => t("Eisenhower-Matrix", "Eisenhower matrix"),
    description: (t) => t("Aufgaben nach Dringlichkeit und Wichtigkeit.", "Tasks by urgency and importance."),
    keywords: "eisenhower matrix prioritäten priorities dringend urgent wichtig important",
    items: (t) => [
      label("ur", 120, -60, 420, t("Dringend", "Urgent"), 18),
      label("nu", 580, -60, 420, t("Nicht dringend", "Not urgent"), 18),
      label("im", -150, 170, 140, t("Wichtig", "Important"), 18),
      label("ni", -150, 590, 140, t("Nicht wichtig", "Not important"), 18),
      frame("q1", 0, 0, 440, 400, t("Sofort erledigen", "Do first"), "#fff5f5"),
      frame("q2", 460, 0, 440, 400, t("Einplanen", "Schedule"), "#e7f5ff"),
      frame("q3", 0, 420, 440, 400, t("Abgeben", "Delegate"), "#fff9db"),
      frame("q4", 460, 420, 440, 400, t("Weglassen", "Eliminate"), "#f8f9fa"),
      note("n1", 30, 40, "", "#ffc9c9", 140),
      note("n2", 490, 40, "", "#a5d8ff", 140),
    ],
  },
  {
    id: "impact",
    category: "planning",
    name: (t) => t("Aufwand-Nutzen-Matrix", "Impact/effort matrix"),
    description: (t) => t("Schnelle Erfolge zuerst: Nutzen gegen Aufwand.", "Quick wins first: impact against effort."),
    keywords: "impact effort aufwand nutzen matrix priorisierung prioritization",
    items: (t) => [
      line("y", { x: -20, y: 840 }, { x: -20, y: -20 }),
      line("x", { x: -20, y: 840 }, { x: 920, y: 840 }),
      label("ya", -200, -10, 170, t("Hoher Nutzen", "High impact"), 16),
      label("xa", 760, 850, 200, t("Hoher Aufwand", "High effort"), 16),
      frame("q1", 0, 0, 440, 400, t("Schnelle Erfolge", "Quick wins"), "#ebfbee"),
      frame("q2", 460, 0, 440, 400, t("Große Projekte", "Major projects"), "#e7f5ff"),
      frame("q3", 0, 420, 440, 400, t("Lückenfüller", "Fill-ins"), "#fff9db"),
      frame("q4", 460, 420, 440, 400, t("Undankbare Aufgaben", "Thankless tasks"), "#fff5f5"),
    ],
  },
  {
    id: "flow",
    category: "diagrams",
    name: (t) => t("Flussdiagramm", "Flowchart"),
    description: (t) => t("Start, Schritte, eine Entscheidung und das Ende.", "Start, steps, a decision and the end."),
    keywords: "flussdiagramm flowchart prozess process",
    items: classic("flow"),
  },
  {
    id: "decision",
    category: "diagrams",
    name: (t) => t("Entscheidungsbaum", "Decision tree"),
    description: (t) => t("Eine Frage, Optionen und ihre Folgen.", "A question, options and their outcomes."),
    keywords: "decision tree entscheidung baum optionen options",
    items: (t) => [
      box("q", 300, 0, 240, 140, t("Entscheidung?", "Decision?"), "#fff3bf", "diamond"),
      box("a", 60, 230, 220, 80, t("Option A", "Option A"), "#dbe4ff", "rounded"),
      box("b", 560, 230, 220, 80, t("Option B", "Option B"), "#dbe4ff", "rounded"),
      box("a1", -60, 400, 180, 80, t("Ergebnis", "Outcome"), "#d3f9d8", "rounded", 14),
      box("a2", 200, 400, 180, 80, t("Ergebnis", "Outcome"), "#ffe3e3", "rounded", 14),
      box("b1", 460, 400, 180, 80, t("Ergebnis", "Outcome"), "#d3f9d8", "rounded", 14),
      box("b2", 720, 400, 180, 80, t("Ergebnis", "Outcome"), "#ffe3e3", "rounded", 14),
      { ...line("l1", "q", "a"), text: t("Ja", "Yes") },
      { ...line("l2", "q", "b"), text: t("Nein", "No") },
      line("l3", "a", "a1"),
      line("l4", "a", "a2"),
      line("l5", "b", "b1"),
      line("l6", "b", "b2"),
    ],
  },
  {
    id: "org",
    category: "diagrams",
    name: (t) => t("Organigramm", "Org chart"),
    description: (t) => t("Leitung, Bereiche und Teams.", "Leadership, departments and teams."),
    keywords: "organigramm org chart team struktur structure hierarchie",
    items: (t) => {
      const heads = [0, 1, 2];
      return [
        box("ceo", 420, 0, 240, 90, t("Geschäftsführung", "Leadership"), "#e5dbff", "rounded", 18),
        ...heads.map((i) => box(`h${i}`, i * 380 + 60, 200, 220, 80, `${t("Bereich", "Department")} ${i + 1}`, "#dbe4ff", "rounded")),
        ...heads.flatMap((i) => [
          box(`t${i}a`, i * 380, 380, 160, 70, t("Team", "Team"), "#ffffff", "rounded", 14),
          box(`t${i}b`, i * 380 + 180, 380, 160, 70, t("Team", "Team"), "#ffffff", "rounded", 14),
        ]),
        ...heads.map((i) => line(`l${i}`, "ceo", `h${i}`, "elbow", false)),
        ...heads.flatMap((i) => [line(`m${i}a`, `h${i}`, `t${i}a`, "straight", false), line(`m${i}b`, `h${i}`, `t${i}b`, "straight", false)]),
      ];
    },
  },
  {
    id: "agenda",
    category: "meetings",
    name: (t) => t("Besprechungsagenda", "Meeting agenda"),
    description: (t) => t("Ziel, Ablauf mit Zeiten, Notizen und Aufgaben.", "Goal, schedule with times, notes and action items."),
    keywords: "agenda meeting besprechung protokoll minutes",
    items: (t) => [
      frame("f", 0, 0, 1000, 900, t("Besprechung", "Meeting"), "#ffffff"),
      label("g", 30, 30, 900, t("Ziel: …", "Goal: …"), 22),
      {
        id: "a",
        type: "table",
        x: 30,
        y: 100,
        w: 940,
        h: 240,
        cells: [
          [t("Zeit", "Time"), t("Thema", "Topic"), t("Verantwortlich", "Owner")],
          ["10:00", t("Begrüßung", "Welcome"), ""],
          ["10:10", "", ""],
          ["10:30", "", ""],
          ["10:50", t("Nächste Schritte", "Next steps"), ""],
        ],
        header: true,
        fontSize: 15,
      },
      label("nh", 30, 370, 400, t("Notizen", "Notes"), 18),
      { ...note("n", 30, 420, "", "#fff6b6", 200), w: 440, h: 440 },
      label("th", 520, 370, 400, t("Aufgaben", "Action items"), 18),
      { ...note("t", 520, 420, `- ${t("Aufgabe", "Task")}\n- ${t("Aufgabe", "Task")}`, "#d8f5a2", 200), w: 450, h: 440 },
    ],
  },
  {
    id: "icebreaker",
    category: "meetings",
    name: (t) => t("Eisbrecher", "Icebreaker"),
    description: (t) => t("Ankommen: Stimmung, ein Bild und zwei Wahrheiten, eine Lüge.", "Warm-up: mood, a picture and two truths and a lie."),
    keywords: "icebreaker eisbrecher check-in warm-up team",
    items: (t) => [
      frame("m", 0, 0, 480, 420, t("Wie geht es dir heute? (Emoji)", "How are you today? (emoji)"), "#fff9db"),
      ...["😀", "🙂", "😐", "😴", "🤯"].map((emoji, i): Draft => ({ id: `e${i}`, type: "emoji", emoji, x: 30 + i * 88, y: 40, w: 70, h: 70 })),
      frame("w", 520, 0, 480, 420, t("Zwei Wahrheiten, eine Lüge", "Two truths and a lie"), "#e7f5ff"),
      ...slots("w", 550, 40, 3, "#a5d8ff", 2, 140),
      frame("p", 1040, 0, 480, 420, t("Dein Wochenende in einem Bild", "Your weekend in one picture"), "#ebfbee"),
      ...slots("p", 1070, 40, 2, "#b2f2bb", 2, 190),
    ],
  },
];

export const galleryCategories: { id: GalleryCategory; name: (t: T) => string }[] = [
  { id: "retro", name: (t) => t("Retrospektiven", "Retrospectives") },
  { id: "planning", name: (t) => t("Planung", "Planning") },
  { id: "strategy", name: (t) => t("Strategie", "Strategy") },
  { id: "ideas", name: (t) => t("Ideen", "Ideas") },
  { id: "diagrams", name: (t) => t("Diagramme", "Diagrams") },
  { id: "meetings", name: (t) => t("Besprechungen", "Meetings") },
];

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("de");
// Templates matching the search (name, description, keywords) and category.
export function findTemplates(query: string, t: T, category: GalleryCategory | "" = "") {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return galleryTemplates.filter((template) => {
    if (category && template.category !== category) return false;
    const text = fold(`${template.name(t)} ${template.description(t)} ${template.keywords}`);
    return words.every((w) => text.includes(w));
  });
}
