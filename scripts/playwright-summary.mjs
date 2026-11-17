// The failed and flaky browser specs of a Playwright run as Markdown, with
// file and line – for the job summary of browser.yml ($GITHUB_STEP_SUMMARY).
// Reads Playwright's JSON report (reporter "json").
//
//   node scripts/playwright-summary.mjs results.json [title] >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const [file, heading = "Browser specs"] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.log(`### ${heading}\n\nNo report (${file || "no file given"}): the run ended before its results were written.\n`);
  process.exit(0);
}
const report = JSON.parse(readFileSync(file, "utf8"));
// Spec files are relative to the test directory; shown from the repository.
const where = (spec) => relative(process.cwd(), join(report.config?.rootDir ?? "", spec.file));
const rows = { unexpected: [], flaky: [] };
const firstLine = (text = "") =>
  text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
const cell = (text) => text.replace(/\|/g, "\\|").slice(0, 200);
function walk(suite, titles = []) {
  const path = suite.title && !suite.title.endsWith(".ts") ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests ?? []) {
      if (!(test.status in rows)) continue;
      const failed = (test.results ?? []).find((r) => r.status !== "passed" && r.status !== "skipped");
      const error = failed?.error ?? failed?.errors?.[0];
      rows[test.status].push(
        `| \`${where(spec)}:${spec.line}\` | ${test.projectName} | ${cell([...path, spec.title].join(" › "))} | ${cell(firstLine(error?.message))} |`,
      );
    }
  for (const child of suite.suites ?? []) walk(child, path);
}
for (const suite of report.suites ?? []) walk(suite);

const stats = report.stats ?? {};
const lines = [`### ${heading}`, ""];
lines.push(
  `${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, ${stats.flaky ?? 0} flaky, ${stats.skipped ?? 0} skipped in ${Math.round((stats.duration ?? 0) / 1000)} s.`,
  "",
);
for (const [status, title] of [
  ["unexpected", "Failed"],
  ["flaky", "Flaky (passed on the retry)"],
]) {
  if (!rows[status].length) continue;
  lines.push(`**${title}**`, "", "| Spec | Project | Test | Error |", "| --- | --- | --- | --- |", ...rows[status], "");
}
for (const error of report.errors ?? []) lines.push(`Error outside a test: ${cell(firstLine(error.message))}`, "");
console.log(lines.join("\n"));
