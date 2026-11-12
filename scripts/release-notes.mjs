// Release notes for the GitHub release and CHANGELOG.md. Used by
// .github/workflows/release.yml:
//   node scripts/release-notes.mjs 1.2.3 [--changelog]
// prints the notes; with --changelog it also adds them on top of
// CHANGELOG.md.
//
// With curated notes for the version (release-notes/1.2.3.json, #223:
// breaking, security, features, improvements, fixes – short lines in German
// and English) the notes are those sections in English, and the commits
// since the last release tag follow folded away under "All commits".
// Without the file: one line per commit with a link to it, as before (and a
// warning – the release still goes out). The same files feed the server's
// "Neu in Flowplan" dialog (lib/release-notes.ts).
//
// Plain Node.js without dependencies: the workflow runs it before `npm ci`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The sections of a curated file, in their order, with their heading.
export const SECTIONS = [
  ["breaking", "Breaking changes"],
  ["security", "Security"],
  ["features", "New"],
  ["improvements", "Improved"],
  ["fixes", "Bug fixes"],
];
const KEYS = new Set(["$schema", "date", ...SECTIONS.map(([key]) => key)]);
const ITEM_KEYS = new Set(["de", "en", "fr", "zh", "issues"]);

// What is wrong with a curated file (an empty list: nothing). The server
// checks the same with its own schema (lib/release-notes.ts); the tests run
// both on every file.
export function checkNotes(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["not a JSON object"];
  for (const key of Object.keys(data)) if (!KEYS.has(key)) errors.push(`unknown key "${key}"`);
  if (data.date !== undefined && !(typeof data.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.date))) errors.push('"date" is not YYYY-MM-DD');
  let items = 0;
  for (const [key] of SECTIONS) {
    const list = data[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`"${key}" is not a list`);
      continue;
    }
    if (list.length > 60) errors.push(`"${key}" has more than 60 items`);
    list.forEach((item, i) => {
      const where = `${key}[${i}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) return errors.push(`${where} is not an object`);
      items++;
      for (const k of Object.keys(item)) if (!ITEM_KEYS.has(k)) errors.push(`${where}: unknown key "${k}"`);
      for (const lang of ["de", "en", "fr", "zh"]) {
        const text = item[lang];
        if (text === undefined && (lang === "fr" || lang === "zh")) continue;
        if (typeof text !== "string" || text.trim().length < 3) errors.push(`${where}.${lang} is missing`);
        else if (text.trim().length > 300) errors.push(`${where}.${lang} is longer than 300 characters`);
        else if (/[\r\n]/.test(text)) errors.push(`${where}.${lang} has a line break`);
      }
      if (item.issues !== undefined && !(Array.isArray(item.issues) && item.issues.length <= 10 && item.issues.every((n) => Number.isInteger(n) && n > 0)))
        errors.push(`${where}.issues is not a list of issue numbers`);
    });
  }
  if (!items) errors.push("no items");
  return errors;
}

// Square brackets would turn into links in Markdown; a backslash before
// one would undo its escape.
const escape = (text) => text.replace(/([\\[\]])/g, "\\$1");

export const commitLines = (commits, url) => commits.map((c) => `- ${escape(c.subject)} ([${c.sha.slice(0, 7)}](${url}/commit/${c.sha}))`);

// The curated sections in English, empty ones left out.
export function curatedMarkdown(notes, url) {
  const parts = [];
  for (const [key, heading] of SECTIONS) {
    const list = notes[key] || [];
    if (!list.length) continue;
    const lines = list.map((item) => {
      const issues = (item.issues || []).map((n) => `[#${n}](${url}/issues/${n})`);
      // "Fixed it (#12)." – the issues before a closing full stop.
      const text = item.en.trim();
      const [line, stop] = text.endsWith(".") ? [text.slice(0, -1), "."] : [text, ""];
      return `- ${line}${issues.length ? ` (${issues.join(", ")})` : ""}${stop}`;
    });
    parts.push(`### ${heading}\n\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

const NO_CHANGES = "- Maintenance release without code changes.";
// The commits under the curated notes, folded away.
const allCommits = (lines) => `<details>\n<summary>All commits</summary>\n\n${(lines.length ? lines : [NO_CHANGES]).join("\n")}\n\n</details>`;

// The body of the GitHub release.
export function renderNotes({ version, previous, commits, curated, url }) {
  const lines = commitLines(commits, url);
  const body = curated ? `${curatedMarkdown(curated, url)}\n\n${allCommits(lines)}` : ["## Changes", "", ...(lines.length ? lines : [NO_CHANGES])].join("\n");
  const link = previous
    ? `**Full changelog:** [${previous}...v${version}](${url}/compare/${previous}...v${version})`
    : `**Full history:** [commits](${url}/commits/v${version})`;
  return `${body}\n\n${link}`;
}

// The version's section of CHANGELOG.md.
export function changelogSection({ version, date, commits, curated, url }) {
  const lines = commitLines(commits, url);
  const body = curated ? `${curatedMarkdown(curated, url)}\n\n${allCommits(lines)}` : (lines.length ? lines : [NO_CHANGES]).join("\n");
  return `## v${version} – ${date}\n\n${body}\n`;
}

const HEAD = "# Changelog\n\nAll releases of Flowplan, newest first. Written by the release workflow: the curated notes of release-notes/ where a release has them, and its commits.\n";
// CHANGELOG.md with the section on top; a version released again (raised but
// not yet tagged) gets its section replaced.
export function updateChangelog(existing, section, version) {
  const start = existing.indexOf("\n## ");
  let older = start === -1 ? "" : `\n${existing.slice(start + 1)}`;
  if (older.startsWith(`\n## v${version} `)) {
    const next = older.indexOf("\n## ", 1);
    older = next === -1 ? "" : older.slice(next);
  }
  return `${HEAD}\n${section}${older}`;
}

// The curated notes of a version: null without a file; a broken file stops
// the release with the reasons.
export function readCurated(version, dir = "release-notes") {
  const file = `${dir}/${version}.json`;
  if (!existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const errors = checkNotes(data);
  if (errors.length) throw new Error(`${file} is not valid:\n- ${errors.join("\n- ")}`);
  return data;
}

function main() {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    console.error("Usage: node scripts/release-notes.mjs 1.2.3 [--changelog]");
    process.exit(1);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const repo = (process.env.GITHUB_REPOSITORY || "yannicschuller/flowplan").replace(/\.git$/, "");
  const url = `https://github.com/${repo}`;
  let previous = "";
  try {
    previous = git("describe", "--tags", "--abbrev=0", "--match", "v*.*.*", "HEAD");
  } catch {
    // The first release: everything so far.
  }
  const range = previous ? `${previous}..HEAD` : "HEAD";
  const commits = git("log", range, "--no-merges", "--format=%H%x09%s")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    })
    .filter((c) => !/^Release v\d/.test(c.subject));
  let curated;
  try {
    curated = readCurated(version);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!curated) console.error(`No curated notes in release-notes/${version}.json: the notes list the commits only.`);
  if (process.argv.includes("--changelog")) {
    const date = new Date().toISOString().slice(0, 10);
    const existing = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
    writeFileSync("CHANGELOG.md", updateChangelog(existing, changelogSection({ version, date, commits, curated, url }), version));
  }
  process.stdout.write(`${renderNotes({ version, previous, commits, curated, url })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
