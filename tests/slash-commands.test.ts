import { test } from "node:test";
import assert from "node:assert/strict";
import { rankCommands } from "../lib/slash-commands";

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
