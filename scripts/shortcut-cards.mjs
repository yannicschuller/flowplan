#!/usr/bin/env node
// Writes lib/template-shortcut-cards.ts, the records of the template
// "Flowplan-Tastenkürzel", from the keymap (scripts/shortcut-card-rows.ts).
// Run after a shortcut changed; tests/study-templates.test.ts
// fails until it is.
//
//   npm run shortcut-cards
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { shortcutCardsModule } = await import("./shortcut-card-rows.ts");
const target = join(root, "lib/template-shortcut-cards.ts");
const text = shortcutCardsModule();
let before = "";
try {
  before = readFileSync(target, "utf8");
} catch {}
if (before === text) console.log("lib/template-shortcut-cards.ts is up to date");
else {
  writeFileSync(target, text);
  console.log("wrote lib/template-shortcut-cards.ts");
}
