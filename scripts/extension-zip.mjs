#!/usr/bin/env node
// Packs the browser extension for the Chrome Web Store, Edge Add-ons and
// addons.mozilla.org:
//
//   npm run extension:zip   writes extensions/browser/dist/flowplan-<version>.zip
//
// No build step: the files are zipped as they are (manifest.json at the
// root of the archive), with fixed timestamps so the archive is
// reproducible.
import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "browser");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const out = join(root, "dist", `flowplan-${manifest.version}.zip`);
const skip = /(^|\/)(dist|node_modules)(\/|$)|(^|\/)\.|\.md$/;

const walk = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
const files = walk(root)
  .map((path) => relative(root, path).split("\\").join("/"))
  .filter((name) => !skip.test(name));

mkdirSync(dirname(out), { recursive: true });
const zip = new yazl.ZipFile();
const mtime = new Date("2026-01-01T00:00:00Z");
for (const name of files) zip.addBuffer(readFileSync(join(root, name)), name, { mtime });
zip.outputStream.pipe(createWriteStream(out)).on("close", () => {
  console.log(`${relative(process.cwd(), out)} (${files.length} files)`);
});
zip.end();
