#!/usr/bin/env node
// The draw.io editor that Flowplan ships (#454): the web app of the pinned
// jgraph/drawio release (scripts/drawio.json, Apache-2.0), served under
// /drawio/<version>/ by app/drawio/[...path]/route.ts. Not in git (about
// 50 MB): the Dockerfile runs this script while building the image, CI's
// browser specs and local development run it before their build.
//
//   node scripts/drawio-fetch.mjs [target]        default: vendor/drawio
//     --archive <draw.war>  use a downloaded archive instead of the network
//     --cache <dir>         keep the downloaded archive there (and reuse it)
//
// The release's draw.war is checked against the pinned SHA-256 before
// anything is unpacked. Only what draw.io's embed mode needs is kept (see
// KEEP): no Java servlets, no development sources, no viewer and
// integration bundles, no templates, plugins or service worker, no source
// maps. A target that already holds this release is left as it is.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import yauzl from "yauzl";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const pin = JSON.parse(readFileSync(join(root, "scripts", "drawio.json"), "utf8"));
export const MARKER = ".flowplan-drawio.json";

// What embed mode loads, at start or later on (shape libraries, layouts,
// imports, math): everything else in the archive stays out.
const KEEP = [
  /^index\.html$/,
  /^favicon\.ico$/,
  /^shortcuts\.svg$/,
  /^js\/(bootstrap|main|PreConfig|PostConfig|math-print)\.js$/,
  /^js\/(app|extensions|stencils|orgchart)\.min\.js$/,
  /^js\/shapes-[\d-]+\.min\.js$/,
  /^js\/(deflate|jszip|sanitizer|rough|libavoid-js|elk|mermaid|orgchart|gliffy|vsd|plantuml|jquery)\//,
  /^math4\//,
  /^mxgraph\/(css|images)\//,
  /^(images|img|shapes|stencils|styles)\//,
  /^resources\/dia(_[A-Za-z-]+)?\.txt$/,
];
const kept = (name) => !name.endsWith("/") && !name.endsWith(".map") && KEEP.some((rule) => rule.test(name));

function args(argv) {
  const options = { target: join(root, "vendor", "drawio"), archive: "", cache: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--archive") options.archive = resolve(argv[++i] || "");
    else if (argv[i] === "--cache") options.cache = resolve(argv[++i] || "");
    else options.target = resolve(argv[i]);
  }
  return options;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(to) {
  console.log(`Downloading draw.io ${pin.version} from ${pin.url} …`);
  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  mkdirSync(dirname(to), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${to}.part`));
  renameSync(`${to}.part`, to);
}

function unpack(archive, into) {
  return new Promise((done, fail) => {
    let files = 0,
      bytes = 0;
    yauzl.open(archive, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return fail(error);
      zip.on("error", fail);
      zip.on("end", () => done({ files, bytes }));
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        if (!kept(name)) return zip.readEntry();
        // yauzl refuses absolute and ".." names already; checked again.
        const path = normalize(join(into, name));
        if (!path.startsWith(into + sep)) return fail(new Error(`Unexpected path in the archive: ${name}`));
        mkdirSync(dirname(path), { recursive: true });
        zip.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          pipeline(stream, createWriteStream(path, { mode: 0o644 })).then(() => {
            files++;
            bytes += entry.uncompressedSize;
            zip.readEntry();
          }, fail);
        });
      });
      zip.readEntry();
    });
  });
}

export async function fetchDrawio(options) {
  const { target } = options;
  try {
    const marker = JSON.parse(readFileSync(join(target, MARKER), "utf8"));
    if (marker.version === pin.version && marker.sha256 === pin.sha256) {
      console.log(`draw.io ${pin.version} is already in ${target}.`);
      return marker;
    }
  } catch {}
  let archive = options.archive;
  if (!archive) {
    archive = join(options.cache || join(root, "vendor"), `draw-${pin.version}.war`);
    if (!existsSync(archive) || (await sha256(archive)) !== pin.sha256) await download(archive);
  }
  const actual = await sha256(archive);
  if (actual !== pin.sha256) throw new Error(`draw.war of ${pin.version} has SHA-256 ${actual}, expected ${pin.sha256}.`);
  const fresh = `${target}.new`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  const { files, bytes } = await unpack(archive, fresh);
  if (!existsSync(join(fresh, "index.html")) || !existsSync(join(fresh, "js", "app.min.js"))) throw new Error("The archive holds no draw.io web app.");
  // draw.io's licence travels with it (THIRD_PARTY_NOTICES.md).
  copyFileSync(join(root, "licenses", "drawio-LICENSE.txt"), join(fresh, "LICENSE"));
  const marker = { version: pin.version, sha256: pin.sha256, files, bytes };
  writeFileSync(join(fresh, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(fresh, target);
  // The archive is only kept where asked (or in vendor/, next to the copy).
  if (!options.archive && !options.cache && statSync(archive).isFile()) rmSync(archive, { force: true });
  console.log(`draw.io ${pin.version}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${target}.`);
  return marker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchDrawio(args(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
