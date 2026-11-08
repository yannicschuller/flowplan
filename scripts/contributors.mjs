#!/usr/bin/env node
// The "Contributors" section of README.md and README.de.md, generated: the
// people whose pull requests were merged, plus the GitHub accounts the
// repository's commits are linked to. GitHub's own contributor list (and
// contrib.rocks, which draws it) only knows commits whose e-mail belongs to
// an account – contributors who commit with another address were missing.
// Bots, Claude and the release bot are left out.
//
//   node scripts/contributors.mjs            rewrite both READMEs
//   node scripts/contributors.mjs --check    exit 1 when they are out of date
//
// GITHUB_TOKEN (or GH_TOKEN) raises the API limit; without it the public API
// is used. GITHUB_REPOSITORY defaults to yannicschuller/flowplan.
// Release workflow: runs before the release commit, so every release brings
// the list up to date.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.GITHUB_REPOSITORY || "yannicschuller/flowplan";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const START = "<!-- contributors:start -->";
const END = "<!-- contributors:end -->";

// Accounts that never show up, whatever they did.
const EXCLUDED = new Set(["claude", "github-actions", "dependabot", "copilot"]);
export const excluded = (login, type) =>
  type === "Bot" || /\[bot\]$/i.test(login) || EXCLUDED.has(login.toLowerCase().replace(/\[bot\]$/i, ""));

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "flowplan-contributors", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// login → { login, type, prs, commits }
export function collect(pulls, contributors) {
  const people = new Map();
  const add = (user, field, n = 1) => {
    if (!user?.login || excluded(user.login, user.type)) return;
    const p = people.get(user.login) ?? { login: user.login, prs: 0, commits: 0 };
    p[field] += n;
    people.set(user.login, p);
  };
  for (const pr of pulls) if (pr.merged_at) add(pr.user, "prs");
  for (const c of contributors) if (c.login) add(c, "commits", c.contributions);
  return [...people.values()];
}

// The owner first, then by merged pull requests, commits and name.
export function order(people, owner) {
  return [...people].sort(
    (a, b) =>
      Number(b.login === owner) - Number(a.login === owner) ||
      b.prs - a.prs ||
      b.commits - a.commits ||
      a.login.localeCompare(b.login, "en"),
  );
}

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function render(people) {
  const cells = people.map(
    (p) =>
      `  <a href="https://github.com/${escape(p.login)}" title="${escape(p.login)}"><img src="https://github.com/${escape(p.login)}.png?size=96" width="48" height="48" alt="${escape(p.login)}"></a>`,
  );
  return `${START}\n<p>\n${cells.join("\n")}\n</p>\n${END}`;
}

export function replaceSection(text, section) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error("contributors markers missing");
  return text.slice(0, a) + section + text.slice(b + END.length);
}

async function main() {
  const check = process.argv.includes("--check");
  const owner = repo.split("/")[0];
  const [pulls, contributors] = await Promise.all([all(`/repos/${repo}/pulls?state=closed`), all(`/repos/${repo}/contributors`)]);
  const section = render(order(collect(pulls, contributors), owner));
  let stale = false;
  for (const file of ["README.md", "README.de.md"]) {
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    const after = replaceSection(before, section);
    if (after === before) continue;
    stale = true;
    if (!check) writeFileSync(path, after);
  }
  if (check && stale) {
    console.error("README contributors are out of date: node scripts/contributors.mjs");
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
