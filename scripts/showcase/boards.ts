// Whiteboards of the showcase: a sprint retro with voting, record cards and
// a drawing, and a customer journey with a mind map.
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { writeWhiteboard } from "../../lib/whiteboard";
import type { WhiteboardItem } from "../../lib/whiteboard-model";
import { Ctx } from "./context";
import { handwriting } from "./handwriting";

type Draft = Partial<WhiteboardItem> & { id: string; type: WhiteboardItem["type"] };

function store(pageId: string, drafts: Draft[], meta: Record<string, unknown> = {}) {
  const ids = new Map(drafts.map((d) => [d.id, randomUUID()]));
  const doc = new Y.Doc();
  const items = doc.getMap<Y.Map<unknown>>("items");
  drafts.forEach((draft, z) => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ ...draft, z }))
      if (key !== "id")
        map.set(key, (key === "from" || key === "to") && value && typeof value === "object" ? { ...(value as object), ...((value as { id?: string }).id ? { id: ids.get((value as { id: string }).id) } : {}) } : value);
    items.set(ids.get(draft.id)!, map);
  });
  const metaMap = doc.getMap<unknown>("meta");
  for (const [k, v] of Object.entries(meta)) metaMap.set(k, v);
  writeWhiteboard(pageId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

// Handwriting as whiteboard pen items (points relative to their box).
function penItems(prefix: string, text: string, x: number, y: number, size: number, color: string, seed: number): Draft[] {
  const { strokes } = handwriting(text, { x, y, size, seed, color });
  return strokes.map((s, i) => {
    const xs: number[] = [],
      ys: number[] = [],
      ps: number[] = [];
    for (let k = 0; k + 2 < s.points.length; k += 3) {
      xs.push(s.points[k]);
      ys.push(s.points[k + 1]);
      ps.push(s.points[k + 2]);
    }
    const minX = Math.min(...xs),
      minY = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - minX),
      h = Math.max(1, Math.max(...ys) - minY);
    return {
      id: `${prefix}${i}`,
      type: "pen" as const,
      x: Math.round(minX * 10) / 10,
      y: Math.round(minY * 10) / 10,
      w: Math.round(w * 10) / 10,
      h: Math.round(h * 10) / 10,
      points: xs.flatMap((px, k) => [Math.round(((px - minX) / w) * 1000) / 1000, Math.round(((ys[k] - minY) / h) * 1000) / 1000]),
      pressures: ps,
      stroke: color,
      strokeWidth: 3,
    };
  });
}
// A freehand doodle (a sun over waves) as pen items.
function doodle(x: number, y: number): Draft[] {
  const out: Draft[] = [];
  const circle: number[] = [];
  for (let a = 0; a <= Math.PI * 2.05; a += 0.2) circle.push(0.5 + Math.cos(a) * 0.48, 0.5 + Math.sin(a) * 0.48);
  out.push({ id: "sun", type: "pen", x, y, w: 80, h: 80, points: circle, stroke: "#f08c00", strokeWidth: 4 });
  for (let r = 0; r < 8; r++) {
    const a = (r / 8) * Math.PI * 2;
    const [x1, y1, x2, y2] = [x + 40 + Math.cos(a) * 52, y + 40 + Math.sin(a) * 52, x + 40 + Math.cos(a) * 72, y + 40 + Math.sin(a) * 72];
    const [mx, my] = [Math.min(x1, x2), Math.min(y1, y2)];
    const [w, h] = [Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1))];
    out.push({ id: `ray${r}`, type: "pen", x: mx, y: my, w, h, points: [(x1 - mx) / w, (y1 - my) / h, (x2 - mx) / w, (y2 - my) / h], stroke: "#f08c00", strokeWidth: 4 });
  }
  for (let wv = 0; wv < 2; wv++) {
    const pts: number[] = [];
    for (let i = 0; i <= 40; i++) pts.push(i / 40, 0.5 + Math.sin((i / 40) * Math.PI * 4) * 0.45);
    out.push({ id: `wave${wv}`, type: "pen", x: x - 40, y: y + 110 + wv * 26, w: 160, h: 20, points: pts, stroke: "#1971c2", strokeWidth: 3 });
  }
  return out;
}

export function retroBoard(c: Ctx, cardRows: { page: string; rows: string[] }) {
  const { t } = c;
  const board = c.page("retro", "studio", t("Retro Sprint 13", "Retro sprint 13"), "whiteboard", null, "🧠");
  const [mara, jonas, aylin, lukas] = c.team.map((p) => p.id);
  const me = c.me.id;
  const votes = (...who: string[]) => Object.fromEntries(who.map((w) => [w, true]));
  const frame = (id: string, x: number, title: string, fill: string): Draft => ({ id, type: "frame", x, y: 0, w: 460, h: 640, text: title, fill });
  const sticky = (id: string, x: number, y: number, text: string, fill: string, extra: Partial<Draft> = {}): Draft => ({ id, type: "sticky", x, y, w: 190, h: 150, text, fill, fontSize: 16, ...extra });
  store(
    board,
    [
      { id: "title", type: "text", x: 0, y: -120, w: 1500, h: 60, text: t("Retro Sprint 13 – Atlas App", "Retro sprint 13 – Atlas app"), fontSize: 36, bold: true },
      { id: "hint", type: "text", x: 0, y: -60, w: 1500, h: 40, text: t("Abstimmung läuft: Klicke auf einen Zettel, um eine Stimme zu geben (max. 3). Unten rechts: Timer und „Folge mir“.", "Voting is on: click a note to vote (max. 3). Bottom right: timer and “Follow me”."), fontSize: 16, textColor: "#495057" },
      frame("f1", 0, t("😊 Gut gelaufen", "😊 Went well"), "#ebfbee"),
      frame("f2", 500, t("🤔 Verbessern", "🤔 To improve"), "#fff4e6"),
      frame("f3", 1000, t("💡 Ideen", "💡 Ideas"), "#e7f5ff"),
      sticky("s1", 20, 70, t("Prototyp-Tests mit echten Pendlern", "Prototype tests with real commuters"), "#b2f2bb", { votes: votes(mara, aylin, me), author: aylin }),
      sticky("s2", 230, 70, t("Daily in 10 Minuten geschafft", "Daily done in 10 minutes"), "#d8f5a2", { votes: votes(jonas), stamps: { [mara]: "👏" }, author: jonas }),
      sticky("s3", 20, 250, t("Designsystem spart Zeit", "Design system saves time"), "#b2f2bb", { votes: votes(jonas, lukas), author: mara }),
      sticky("s4", 520, 70, t("Tickets ohne Akzeptanzkriterien", "Tickets without acceptance criteria"), "#ffd8a8", { votes: votes(mara, jonas, aylin, me), author: jonas }),
      sticky("s5", 730, 70, t("Review-Spalte staut sich", "Review column is congested"), "#ffc9c9", { votes: votes(lukas, me), author: mara }),
      sticky("s6", 520, 250, t("Zu viele Meetings am Mittwoch", "Too many meetings on Wednesday"), "#ffd8a8", { votes: votes(aylin), author: lukas }),
      sticky("s7", 1020, 70, t("WIP-Limit für Review: 2", "WIP limit for review: 2"), "#a5d8ff", { votes: votes(jonas, mara, me), author: me }),
      sticky("s8", 1230, 70, t("Pairing bei Bugs", "Pairing on bugs"), "#bac8ff", { votes: votes(aylin), author: jonas }),
      sticky("s9", 1020, 250, t("Geheim: Wer bringt Kuchen?", "Secret: who brings cake?"), "#d0bfff", { covered: true, author: lukas }),
      { id: "tbl", type: "table", x: 1020, y: 430, w: 420, h: 180, cells: [[t("Maßnahme", "Action"), t("Wer", "Who"), t("Bis", "Due")], [t("Akzeptanzkriterien-Vorlage", "Acceptance criteria template"), "Jonas", c.day(3)], [t("WIP-Limit einstellen", "Set WIP limit"), t("Du", "You"), c.day(1)], [t("Meeting-freier Mittwoch", "Meeting-free Wednesday"), "Aylin", c.day(7)]], header: true },
      { id: "card1", type: "card", x: 520, y: 430, w: 280, h: 120, pageId: cardRows.page, rowId: cardRows.rows[3], fill: "#e0782c" },
      { id: "card2", type: "card", x: 160, y: 470, w: 280, h: 120, pageId: cardRows.page, rowId: cardRows.rows[2], fill: "#2f9e44" },
      { id: "arrow1", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s5", x: 0, y: 0 }, to: { id: "s7", x: 0, y: 0 }, endArrow: true, route: "curved", stroke: "#1971c2", strokeWidth: 2, dashed: true },
      { id: "arrow2", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s4", x: 0, y: 0 }, to: { id: "tbl", x: 0, y: 0 }, endArrow: true, route: "elbow", stroke: "#868e96", strokeWidth: 2 },
      { id: "pin", type: "comment", x: 940, y: 60, w: 28, h: 28, messages: [{ id: "m1", author: mara, name: "Mara Klein", text: t("Sollen wir das Limit direkt im Board einstellen?", "Should we set the limit right on the board?"), at: c.ms(-1, 15) }, { id: "m2", author: me, name: t("Du", "You"), text: t("Ja – ist erledigt, siehe Tickets-Board.", "Yes – done, see the tickets board."), at: c.ms(-1, 16) }], resolved: false },
      { id: "e1", type: "emoji", x: 1380, y: 260, w: 80, h: 80, emoji: "🎉", stamps: { [jonas]: "❤️", [aylin]: "👍" } },
      { id: "i1", type: "emoji", x: 380, y: 260, w: 70, h: 70, emoji: "icon:Rocket:#337ea9" },
      ...doodle(100, 700),
      ...penItems("hw", t("Danke, Team!", "Thanks, team!"), 300, 790, 46, "#c2255c", 11),
    ],
    { voting: { active: true, max: 3, hidden: false } },
  );
  return board;
}

export function journeyBoard(c: Ctx) {
  const { t } = c;
  const board = c.page("journey", "studio", t("Customer Journey & Mindmap", "Customer journey & mind map"), "whiteboard", null, "🗺️");
  const shape = (id: string, x: number, y: number, text: string, kind: WhiteboardItem["shape"], fill: string, w = 170, h = 80): Draft => ({ id, type: "shape", shape: kind, x, y, w, h, text, fill, stroke: "#1f2937", strokeWidth: 2 });
  const link = (id: string, from: string, to: string, extra: Partial<Draft> = {}): Draft => ({ id, type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: from, x: 0, y: 0 }, to: { id: to, x: 0, y: 0 }, endArrow: true, route: "straight", stroke: "#1f2937", strokeWidth: 2, ...extra });
  const steps = [t("Entdecken", "Discover"), t("Registrieren", "Sign up"), t("Rad finden", "Find a bike"), t("Ausleihen", "Rent"), t("Fahren", "Ride"), t("Zurückgeben", "Return")];
  const kinds: WhiteboardItem["shape"][] = ["ellipse", "rounded", "rounded", "diamond", "rounded", "hexagon"];
  const fills = ["#e5dbff", "#dbe4ff", "#d3f9d8", "#fff3bf", "#d3f9d8", "#ffe3e3"];
  const drafts: Draft[] = [
    { id: "jf", type: "frame", x: -20, y: -80, w: 1260, h: 360, text: t("Customer Journey – Atlas App", "Customer journey – Atlas app"), fill: "#f8f9fa" },
    ...steps.map((s, i) => shape(`j${i}`, i * 205, 20, s, kinds[i], fills[i])),
    ...steps.slice(1).map((_, i) => link(`jl${i}`, `j${i}`, `j${i + 1}`, i === 2 ? { route: "curved" } : {})),
    { id: "pain", type: "sticky", x: 600, y: 140, w: 200, h: 120, text: t("Schmerzpunkt: Kaution 50 €", "Pain point: €50 deposit"), fill: "#ffc9c9", fontSize: 15 },
    { id: "win", type: "sticky", x: 820, y: 140, w: 200, h: 120, text: t("Wow-Moment: Schloss öffnet per QR", "Wow moment: lock opens via QR"), fill: "#b2f2bb", fontSize: 15 },
    link("pl", "pain", "j3", { dashed: true, stroke: "#e03131" }),
    // Mind map (select a node and press Tab for a branch).
    { id: "mf", type: "frame", x: -20, y: 340, w: 1260, h: 520, text: t("Mindmap: Launch-Kampagne", "Mind map: launch campaign"), fill: "#fffdf5" },
    shape("m0", 470, 560, t("Launch Atlas", "Launch Atlas"), "rounded", "#dbe4ff", 200, 70),
    shape("m1", 150, 420, "Social Media", "rounded", "#ffffff", 170, 56),
    shape("m2", 150, 560, t("Presse", "Press"), "rounded", "#ffffff", 170, 56),
    shape("m3", 150, 700, t("Events", "Events"), "rounded", "#ffffff", 170, 56),
    shape("m4", 820, 420, t("Partner", "Partners"), "rounded", "#ffffff", 170, 56),
    shape("m5", 820, 560, "Newsletter", "rounded", "#ffffff", 170, 56),
    shape("m6", 820, 700, t("Rabatt-Code", "Promo code"), "star", "#fff3bf", 170, 110),
    shape("m11", -10, 380, "Reels", "parallelogram", "#f1f3f5", 120, 44),
    shape("m12", -10, 450, "LinkedIn", "parallelogram", "#f1f3f5", 120, 44),
    shape("m31", -10, 740, t("Probefahrt-Tag", "Test ride day"), "cloud", "#e3fafc", 140, 70),
    ...["m1", "m2", "m3", "m4", "m5", "m6"].map((m) => link(`k${m}`, "m0", m, { route: "curved", endArrow: false, stroke: "#868e96" })),
    link("k11", "m1", "m11", { route: "curved", endArrow: false, stroke: "#adb5bd" }),
    link("k12", "m1", "m12", { route: "curved", endArrow: false, stroke: "#adb5bd" }),
    link("k31", "m3", "m31", { route: "curved", endArrow: false, stroke: "#adb5bd" }),
    { id: "arrowshape", type: "shape", shape: "arrow", x: 1060, y: 580, w: 140, h: 60, text: "Go!", fill: "#d3f9d8", stroke: "#2f9e44", strokeWidth: 2 },
    { id: "tri", type: "shape", shape: "triangle", x: 1080, y: 680, w: 90, h: 80, fill: "#ffe8cc", stroke: "#f08c00", strokeWidth: 2 },
    { id: "note", type: "text", x: 0, y: 880, w: 1200, h: 40, text: t("Tipp: V wählt aus, N setzt Zettel, L verbindet, P zeichnet, Tab erweitert die Mindmap, K ist der Laserpointer.", "Tip: V selects, N adds a note, L connects, P draws, Tab extends the mind map, K is the laser pointer."), fontSize: 16, textColor: "#495057" },
  ];
  store(board, drafts);
  return board;
}
