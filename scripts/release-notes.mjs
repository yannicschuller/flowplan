// Release notes from the commits since the last release tag, one line per
// commit with a link to it. Used by .github/workflows/release.yml:
//   node scripts/release-notes.mjs 1.2.3 [--changelog]
// prints the notes; with --changelog it also adds them on top of
// CHANGELOG.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

// Square brackets would turn into links in Markdown.
const escape = (text) => text.replace(/([[\]])/g, "\\$1");
const lines = commits.map((c) => `- ${escape(c.subject)} ([${c.sha.slice(0, 7)}](${url}/commit/${c.sha}))`);
const notes = [
  "## Changes",
  "",
  ...(lines.length ? lines : ["- Maintenance release without code changes."]),
  "",
  previous
    ? `**Full changelog:** [${previous}...v${version}](${url}/compare/${previous}...v${version})`
    : `**Full history:** [commits](${url}/commits/v${version})`,
].join("\n");

if (process.argv.includes("--changelog")) {
  const date = new Date().toISOString().slice(0, 10);
  const section = `## v${version} – ${date}\n\n${lines.join("\n") || "- Maintenance release without code changes."}\n`;
  const head = "# Changelog\n\nAll releases of Flowplan, newest first. Generated from the commits by the release workflow.\n";
  const existing = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
  const start = existing.indexOf("\n## ");
  const older = start === -1 ? "" : `\n${existing.slice(start + 1)}`;
  writeFileSync("CHANGELOG.md", `${head}\n${section}${older}`);
}
process.stdout.write(`${notes}\n`);
