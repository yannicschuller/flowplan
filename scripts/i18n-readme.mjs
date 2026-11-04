#!/usr/bin/env node
// Writes the translation coverage table into README.md and README.de.md,
// between <!-- i18n:start --> and <!-- i18n:end -->.
//
//   npm run i18n:readme
//
// The numbers come from `npm run i18n -- --check` (scripts/i18n.mjs), the
// language names and flags from LANGUAGES in lib/i18n.ts. German and English
// sit side by side in the code and are always complete.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const check = execFileSync(process.execPath, [join(root, "scripts/i18n.mjs"), "--check"], { encoding: "utf8" });
const total = Number(check.match(/^(\d+) texts in the code\./m)?.[1]);
if (!total) throw new Error("Unexpected output from scripts/i18n.mjs:\n" + check);
const coverage = new Map([...check.matchAll(/^([a-z]{2}(?:-[A-Z]{2})?): (\d+)\/(\d+) translated/gm)].map((m) => [m[1], Number(m[2])]));

// LANGUAGES = { de: { name: "Deutsch", tag: "de-DE", flag: "🇩🇪" }, … }
const source = readFileSync(join(root, "lib/i18n.ts"), "utf8");
const block = source.match(/export const LANGUAGES = \{([\s\S]*?)\n\} as const;/)?.[1];
if (!block) throw new Error("LANGUAGES not found in lib/i18n.ts");
const languages = [...block.matchAll(/^\s*"?([a-z]{2}(?:-[A-Z]{2})?)"?: \{ name: "([^"]+)", tag: "[^"]+", flag: "([^"]+)" \}/gm)].map(([, code, name, flag]) => ({ code, name, flag }));
// Catalogues that exist but are not offered in the app yet.
for (const code of coverage.keys())
  if (!languages.some((l) => l.code === code)) languages.push({ code, name: code, flag: "🏳️", draft: true });

const number = (n, locale) => n.toLocaleString(locale === "de" ? "de-DE" : "en-GB");
const bar = (pct) => `![${pct} %](https://img.shields.io/badge/${pct}%25-${pct === 100 ? "2ea44f" : pct >= 90 ? "a3c51c" : pct >= 50 ? "dfb317" : "e05d44"}?style=flat-square)`;

function table(locale) {
  const de = locale === "de";
  const head = de
    ? ["Sprache", "Code", "Übersetzt", "Stand"]
    : ["Language", "Code", "Translated", "Coverage"];
  const lines = [`| ${head.join(" | ")} |`, "| --- | --- | ---: | --- |"];
  for (const l of languages) {
    const sourceLang = l.code === "de" || l.code === "en";
    const done = sourceLang ? total : coverage.get(l.code) ?? 0;
    const pct = Math.floor((done / total) * 100);
    const note = sourceLang ? (de ? " (im Code)" : " (in the code)") : l.draft ? (de ? " (noch nicht in der App)" : " (not in the app yet)") : "";
    lines.push(`| ${l.flag} ${l.name}${note} | \`${l.code}\` | ${number(done, locale)} / ${number(total, locale)} | ${bar(pct)} |`);
  }
  lines.push("", de ? "<sub>Erzeugt mit `npm run i18n:readme` aus `locales/`.</sub>" : "<sub>Generated from `locales/` with `npm run i18n:readme`.</sub>");
  return lines.join("\n");
}

const START = "<!-- i18n:start -->";
const END = "<!-- i18n:end -->";
for (const [file, locale] of [["README.md", "en"], ["README.de.md", "de"]]) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${file}: markers ${START} … ${END} missing`);
  const next = `${text.slice(0, a + START.length)}\n${table(locale)}\n${text.slice(b)}`;
  if (next !== text) writeFileSync(path, next);
  console.log(`${file}: ${languages.length} languages, ${total} texts`);
}
