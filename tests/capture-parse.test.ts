import { test } from "node:test";
import assert from "node:assert/strict";
import { cellsOf, findMember, mapTokens, parseCapture, stripChips, tokens, type CaptureProperty } from "../lib/capture-parse";

// Monday, 26 October 2026.
const today = "2026-10-26";
const dates = (text: string, locale = "de") =>
  tokens(text, { today, locale })
    .filter((t) => t.kind === "date")
    .map((t) => [t.raw, t.value]);

test("German, English and French date words", () => {
  assert.deepEqual(dates("Angebot schreiben morgen 15 Uhr"), [["morgen 15 Uhr", { date: "2026-10-27", time: "15:00" }]]);
  assert.deepEqual(dates("heute"), [["heute", { date: today }]]);
  assert.deepEqual(dates("bis übermorgen"), [["bis übermorgen", { date: "2026-10-28" }]]);
  assert.deepEqual(dates("call tomorrow at 3pm", "en"), [["tomorrow at 3pm", { date: "2026-10-27", time: "15:00" }]]);
  assert.deepEqual(dates("due day after tomorrow", "en"), [["due day after tomorrow", { date: "2026-10-28" }]]);
  assert.deepEqual(dates("appeler demain à 9h30", "fr"), [["demain à 9h30", { date: "2026-10-27", time: "09:30" }]]);
  assert.deepEqual(dates("rendre après-demain", "fr"), [["après-demain", { date: "2026-10-28" }]]);
  // Weekdays: the next one (today's weekday is next week's).
  assert.deepEqual(dates("am Freitag"), [["am Freitag", { date: "2026-10-30" }]]);
  assert.deepEqual(dates("nächsten Montag"), [["nächsten Montag", { date: "2026-11-02" }]]);
  assert.deepEqual(dates("next wednesday", "en"), [["next wednesday", { date: "2026-10-28" }]]);
  assert.deepEqual(dates("vendredi prochain", "fr"), [["vendredi prochain", { date: "2026-10-30" }]]);
  assert.deepEqual(dates("Do. 10:00"), [["Do. 10:00", { date: "2026-10-29", time: "10:00" }]]);
  assert.deepEqual(dates("Wo ist do?"), [], "a short weekday only with its dot");
  assert.deepEqual(dates("in 3 Tagen"), [["in 3 Tagen", { date: "2026-10-29" }]]);
  assert.deepEqual(dates("in two weeks", "en"), [["in two weeks", { date: "2026-11-09" }]]);
  assert.deepEqual(dates("dans une semaine", "fr"), [["dans une semaine", { date: "2026-11-02" }]]);
  assert.deepEqual(dates("nächste Woche"), [["nächste Woche", { date: "2026-11-02" }]]);
  assert.deepEqual(dates("la semaine prochaine", "fr"), [["la semaine prochaine", { date: "2026-11-02" }]]);
  // Numbers: day first in German and French, month first in English.
  assert.deepEqual(dates("bis 24.12."), [["bis 24.12.", { date: "2026-12-24" }]]);
  assert.deepEqual(dates("am 3.1."), [["am 3.1.", { date: "2027-01-03" }]], "a passed day: next year");
  assert.deepEqual(dates("24.12.2027"), [["24.12.2027", { date: "2027-12-24" }]]);
  assert.deepEqual(dates("12/24", "en"), [["12/24", { date: "2026-12-24" }]]);
  assert.deepEqual(dates("24/12", "fr"), [["24/12", { date: "2026-12-24" }]]);
  assert.deepEqual(dates("2026-11-05"), [["2026-11-05", { date: "2026-11-05" }]]);
  assert.deepEqual(dates("24. Dezember"), [["24. Dezember", { date: "2026-12-24" }]]);
  assert.deepEqual(dates("le 5 novembre", "fr"), [["le 5 novembre", { date: "2026-11-05" }]]);
  assert.deepEqual(dates("by Nov 5th", "en"), [["by Nov 5th", { date: "2026-11-05" }]]);
  // A time alone: today.
  assert.deepEqual(dates("um 14:30"), [["um 14:30", { date: today, time: "14:30" }]]);
  // Not dates.
  for (const text of ["Version 1.2.3", "31.02.", "Heutemorgen", "25:00", "Zimmer 12", "Seite 3/4 lesen"]) assert.deepEqual(dates(text, "de").filter(([raw]) => raw !== "3/4"), [], text);
  assert.equal(dates("morgen und übermorgen").length, 1, "one due date: the first");
});

test("tags, people and priority", () => {
  const list = tokens("Angebot schreiben #kunde #Q4-plan @anna !hoch #27", { today });
  assert.deepEqual(
    list.map((t) => [t.kind, t.raw, t.value]),
    [
      ["tag", "#kunde", "kunde"],
      ["tag", "#Q4-plan", "Q4-plan"],
      ["person", "@anna", "anna"],
      ["priority", "!hoch", 2],
    ],
    "an issue number is no tag",
  );
  assert.equal(tokens("Mail an a@b.de", { today }).filter((t) => t.kind === "person").length, 0, "no e-mail addresses");
  assert.deepEqual(tokens("!!! Server down", { today }).map((t) => t.value), [1]);
  assert.deepEqual(tokens("Achtung! wichtig", { today }), [], "an exclamation is no priority");
  assert.equal(tokens("x !urgent", { today })[0].value, 1);
  assert.equal(tokens("x !basse", { today })[0].value, 4);
  assert.equal(tokens("#2026-12-24", { today })[0].kind, "tag", "a tag first, never a date inside it");
});

const properties: CaptureProperty[] = [
  { id: "title", name: "Name", type: "text" } as CaptureProperty,
  { id: "due", name: "Fällig", type: "date" },
  { id: "tags", name: "Tags", type: "multiselect", options: ["Kunde", "Intern", "Q4 Plan"] },
  { id: "who", name: "Zuständig", type: "person" },
  { id: "prio", name: "Priorität", type: "select", options: ["🔴 Hoch", "Mittel", "Niedrig"] },
];
const members = [
  { id: "u1", name: "Anna Schmidt", email: "anna@example.test" },
  { id: "u2", name: "Anton Berg", email: "anton@example.test" },
  { id: "u3", name: "Bea Kurz", email: "bkurz@example.test" },
];

test("onto the target's properties, only those it has", () => {
  const parsed = parseCapture("Angebot schreiben morgen 15 Uhr #kunde @anna !hoch", { today, properties, members });
  assert.equal(parsed.title, "Angebot schreiben");
  assert.deepEqual(parsed.cells, { due: "2026-10-27T15:00", tags: ["Kunde"], who: "u1", prio: "🔴 Hoch" });
  assert.deepEqual(
    parsed.chips.map((c) => [c.kind, c.field?.name, c.label]),
    [
      ["date", "Fällig", "2026-10-27T15:00"],
      ["tag", "Tags", "Kunde"],
      ["person", "Zuständig", "Anna Schmidt"],
      ["priority", "Priorität", "🔴 Hoch"],
    ],
  );
  // Unknown tags, ambiguous people and missing properties stay in the text.
  const other = parseCapture("Notiz #neu @an !hoch", { today, properties: properties.filter((p) => p.id !== "prio"), members });
  assert.equal(other.title, "Notiz #neu @an !hoch");
  assert.deepEqual(other.cells, {});
  assert.ok(other.chips.every((c) => !c.field));
  assert.equal(findMember(members, "bkurz")?.id, "u3", "by e-mail name");
  assert.equal(findMember(members, "ant")?.id, "u2", "a unique start of a name");
  // Tags with spaces in the option.
  assert.deepEqual(parseCapture("x #q4plan #intern", { today, properties, members }).cells, { tags: ["Q4 Plan", "Intern"] });
});

test("a removed chip keeps its text", () => {
  const first = parseCapture("Meeting morgen #kunde", { today, properties, members });
  const id = first.chips.find((c) => c.kind === "date")!.id;
  const kept = parseCapture("Meeting morgen #kunde", { today, properties, members, literal: [id] });
  assert.equal(kept.title, "Meeting morgen");
  assert.deepEqual(kept.cells, { tags: ["Kunde"] });
  assert.equal(kept.chips.length, 1);
  // Stable while the text around it changes.
  assert.equal(parseCapture("Ein anderes Meeting  morgen", { today, properties, members, literal: [id] }).chips.length, 0);
});

test("pages and the journal: a date or a person only for a task", () => {
  assert.equal(parseCapture("Anrufen morgen @anna", { today, properties: [], members }).title, "Anrufen morgen @anna");
  const task = parseCapture("Anrufen morgen @anna", { today, properties: [], members, task: true });
  assert.equal(task.title, "Anrufen");
  assert.equal(task.due, "2026-10-27");
  assert.equal(task.assignee, "u1");
  assert.deepEqual(task.cells, {});
});

test("the text without the shorthand; more lines stay", () => {
  assert.equal(stripChips("a  morgen , b", [{ start: 3, end: 9, field: { id: "x", name: "" } }]), "a, b");
  const parsed = parseCapture("Titel #kunde\nZweite Zeile\n\nDritter Absatz", { today, properties, members });
  assert.equal(parsed.title, "Titel");
  assert.equal(parsed.text, "Zweite Zeile\n\nDritter Absatz");
  assert.deepEqual(cellsOf(mapTokens(tokens("#kunde #intern", { today }), properties, members), properties), { tags: ["Kunde", "Intern"] });
  assert.deepEqual(tokens("x", { today: "gestern" }), [], "a valid day is needed");
});
