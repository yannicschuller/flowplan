import { test } from "node:test";
import assert from "node:assert/strict";
import { rankCommands, slashSections, rememberSlashCommand, readSlashRecents, type SlashCommand } from "../lib/slash-commands";

const commands = [
  { name: "Text", description: "Einfach losschreiben", keywords: ["p"] },
  { name: "Überschrift 1", description: "Große Überschrift", keywords: ["h1"] },
  { name: "Überschrift 2", description: "Mittlere Überschrift", keywords: ["h2"] },
  { name: "Aufgabenliste", description: "Schritt für Schritt abhaken", keywords: ["todo"] },
  { name: "Tabelle", description: "Zeilen und Spalten", keywords: ["table"] },
  { name: "Zwei Spalten", description: "Inhalte nebeneinander", keywords: ["columns"] },
];
const names = (query: string) => rankCommands(commands, query).map((c) => c.name);

test("aliases, names and descriptions find blocks, best match first", () => {
  assert.equal(names("h2")[0], "Überschrift 2");
  assert.equal(names("todo")[0], "Aufgabenliste");
  assert.equal(names("tab")[0], "Tabelle");
  assert.equal(names("ueberschrift 1")[0], "Überschrift 1");
  assert.equal(names("überschrift")[0], "Überschrift 1");
  assert.deepEqual(names("spalten"), ["Zwei Spalten", "Tabelle"]);
  assert.deepEqual(names(""), commands.map((c) => c.name));
  assert.deepEqual(names("oder"), []);
});

const grouped: SlashCommand[] = [
  { id: "ai", group: "ai", name: "KI-Assistent", description: "Text schreiben lassen", keywords: ["ai"] },
  { id: "text", group: "text", name: "Text", description: "Einfach losschreiben", keywords: ["p"] },
  { id: "h2", group: "text", name: "Überschrift 2", description: "Mittlere Überschrift", keywords: ["h2"] },
  { id: "todo", group: "lists", name: "Aufgabenliste", description: "Schritt für Schritt abhaken", keywords: ["todo"] },
  {
    id: "callout",
    group: "blocks",
    name: "Callout",
    description: "Hervorgehobener Kasten",
    keywords: ["callout", "hinweis"],
    children: [
      { id: "callout-note", group: "blocks", name: "Hinweis", description: "Nützliche Information", keywords: ["note", "hinweis"] },
      { id: "callout-warning", group: "blocks", name: "Warnung", description: "Braucht Aufmerksamkeit", keywords: ["warning", "warnung"] },
    ],
  },
  { id: "table", group: "blocks", name: "Tabelle", description: "Zeilen und Spalten", keywords: ["table"] },
  { id: "synced", name: "Synchronisierter Block", description: "Gleich auf mehreren Seiten", keywords: ["sync"] },
];
const shape = (sections: ReturnType<typeof slashSections<SlashCommand>>) =>
  sections.map((s) => [s.group, s.items.map((i) => i.id)]);

test("without a query the menu shows recents, then the groups in order; second levels stay folded", () => {
  assert.deepEqual(shape(slashSections(grouped, "")), [
    ["ai", ["ai"]],
    ["text", ["text", "h2"]],
    ["lists", ["todo"]],
    ["blocks", ["callout", "table"]],
    ["advanced", ["synced"]],
  ]);
  // Recents first, unknown ids skipped, second-level entries allowed.
  assert.deepEqual(shape(slashSections(grouped, "", ["callout-warning", "gone", "h2"]))[0], [
    "recent",
    ["callout-warning", "h2"],
  ]);
});

test("a query filters across the groups, second levels included, best match first", () => {
  assert.deepEqual(shape(slashSections(grouped, "warn")), [["blocks", ["callout-warning"]]]);
  assert.deepEqual(shape(slashSections(grouped, "h2", ["todo"])), [["text", ["h2"]]]);
  // The group of the best match comes first, "callout" (keyword) before "Hinweis" (name).
  assert.deepEqual(shape(slashSections(grouped, "hinweis")), [["blocks", ["callout", "callout-note"]]]);
  assert.deepEqual(shape(slashSections(grouped, "schreiben")), [["ai", ["ai"]], ["text", ["text"]]]);
  assert.deepEqual(slashSections(grouped, "nothing"), []);
});

test("recently used blocks are kept, newest first, at most five; without storage nothing breaks", () => {
  // No localStorage in Node: reading gives nothing and remembering still returns the list.
  assert.deepEqual(readSlashRecents(), []);
  let recents = rememberSlashCommand("h2", []);
  for (const id of ["todo", "table", "h2", "text", "callout-note", "synced"]) recents = rememberSlashCommand(id, recents);
  assert.deepEqual(recents, ["synced", "callout-note", "text", "h2", "table"]);
});
