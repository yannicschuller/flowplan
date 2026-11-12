#!/usr/bin/env node
// The templates that come with Flowplan as Flowplan Marketplace packages
// (lib/marketplace-official.ts): one `<kind>-<id>.flowplan-template` per
// document and database template, whiteboard and workflow gallery template.
//
//   npm run marketplace-official -- <target-dir> [--previews <dir>]
//
// <target-dir>, e.g. ../flowplan-marketplace/seed/official. `--previews`: a
// folder with `<kind>-<id>.png` pictures (≤ 1 MB) that go in as
// preview/1.png. The output is deterministic: a file is only written when
// its content changed, files of templates that no longer exist are listed
// (not deleted). Every package is checked with the server's own reader
// (lib/marketplace-package.ts readPackage) before it is written.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--previews");
if (!target) {
  console.error("Usage: npm run marketplace-official -- <target-dir> [--previews <dir>]");
  process.exit(1);
}
const previewDir = args.includes("--previews") ? resolve(args[args.indexOf("--previews") + 1]) : null;
// The libraries open a database on first use: never the real one.
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-official-"));
const root = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { officialPackages } = await import("../lib/marketplace-official.ts");
const { readPackage } = await import("../lib/marketplace-package.ts");

const previews = new Map();
if (previewDir)
  for (const name of readdirSync(previewDir))
    if (/\.png$/.test(name)) {
      const bytes = readFileSync(join(previewDir, name));
      if (bytes.length <= 1024 * 1024) previews.set(name.replace(/\.png$/, ""), bytes);
      else console.warn(`skipped ${name}: larger than 1 MB`);
    }

const out = resolve(target);
mkdirSync(out, { recursive: true });
const packages = await officialPackages(version, previews);
const counts = {};
let written = 0;
for (const pkg of packages) {
  await readPackage(pkg.bytes);
  counts[pkg.kind] = (counts[pkg.kind] || 0) + 1;
  const path = join(out, pkg.file);
  if (existsSync(path) && readFileSync(path).equals(pkg.bytes)) continue;
  writeFileSync(path, pkg.bytes);
  written++;
}
const known = new Set(packages.map((p) => p.file));
const stale = readdirSync(out).filter((n) => n.endsWith(".flowplan-template") && !known.has(n));
console.log(`${packages.length} packages (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}), ${written} written, ${packages.length - written} unchanged → ${out}`);
if (stale.length) console.log(`not from Flowplan any more: ${stale.join(", ")}`);
process.exit(0);
