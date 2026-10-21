#!/usr/bin/env node
// Writes facts.json in the repository root from lib/facts.ts – the counts
// the website and the documentation quote (views, property types, question
// types, languages …). Run it after changing one of the lists it counts:
//
//   npm run facts            write facts.json
//   npm run facts -- --check only report whether it is up to date (exit 1)
//
// Runs with tsx (package.json "facts"), so the TypeScript module loads as is.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../facts.json", import.meta.url));
const { factsJson } = await import("../lib/facts.ts");
const next = factsJson();
let current = "";
try {
  current = readFileSync(target, "utf8");
} catch {}
if (process.argv.includes("--check")) {
  if (current === next) console.log("facts.json is up to date.");
  else {
    console.error("facts.json is out of date – run `npm run facts`.");
    process.exit(1);
  }
} else {
  writeFileSync(target, next);
  console.log(current === next ? "facts.json unchanged." : "facts.json written.");
}
