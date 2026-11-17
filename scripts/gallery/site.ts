// The gallery's images and the comparison with the previous run: WebP
// thumbnails for the grid (and, with --webp, WebP full images), a hash per
// screenshot, and the "Changed" view's before/after pairs. The nightly site
// (.github/workflows/gallery.yml) passes --webp --compare
// https://gallery.flowplan.org; a local run gets thumbnails only.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  countDiffPixels,
  isChanged,
  key,
  pairShots,
  sortChanges,
  type BeforeShot,
  type Change,
  type Changes,
  type Manifest,
  type ManifestShot,
  type Pixels,
} from "./compare";
import type { Shot } from "./report";

// sharp comes with Next.js (its optionalDependencies; installed on every
// platform with a prebuilt binary). Without it the gallery still works,
// with the PNGs as their own thumbnails and no comparison.
type Sharp = typeof import("sharp").default;
let sharpModule: Sharp | null | undefined;
async function loadSharp() {
  if (sharpModule === undefined) {
    sharpModule = await import("sharp").then((m) => m.default).catch(() => null);
    if (!sharpModule) console.warn("Note: sharp is not installed – no thumbnails, WebP or comparison.");
  }
  return sharpModule;
}

// The grid's thumbnails: the width of the image file (the cards show them
// at about half to two thirds of it, sharp on high-density screens).
export const THUMB_WIDTH = { desktop: 480, phone: 240 } as const;
// Taller screenshots (whole pages) are cut at the device's screen
// proportions, from the top.
const THUMB_ASPECT = { desktop: 900 / 1440, phone: 844 / 390 } as const;
const FULL_QUALITY = 80;
const THUMB_QUALITY = 72;

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

// Thumbnails, hashes and (webp) the full images as WebP in place of the
// PNGs. Returns the manifest's entries in the order of `shots`.
export async function processShots(out: string, shots: Shot[], { webp }: { webp: boolean }): Promise<ManifestShot[]> {
  const sharp = await loadSharp();
  rmSync(join(out, "thumbs"), { recursive: true, force: true });
  mkdirSync(join(out, "thumbs"), { recursive: true });
  const result = new Map<Shot, ManifestShot>();
  await pool(shots, 4, async (shot) => {
    const entry: ManifestShot = {
      scene: shot.scene,
      group: shot.group,
      title: shot.title,
      path: shot.path,
      variant: shot.variant,
      file: shot.file,
      thumb: shot.file,
      width: 0,
      height: 0,
      thumbWidth: 0,
      thumbHeight: 0,
      hash: "",
      ...(shot.error ? { error: shot.error } : {}),
      pageErrors: shot.pageErrors,
      ms: shot.ms,
    };
    result.set(shot, entry);
    if (!shot.file) return;
    const png = join(out, shot.file);
    const bytes = readFileSync(png);
    if (!sharp) {
      entry.hash = createHash("sha256").update(bytes).digest("hex");
      return;
    }
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    entry.width = info.width;
    entry.height = info.height;
    entry.hash = createHash("sha256").update(`${info.width}x${info.height}:`).update(data).digest("hex");
    const device = shot.variant.startsWith("phone") ? "phone" : "desktop";
    const tw = Math.min(THUMB_WIDTH[device], info.width);
    const fullHeight = Math.round((info.height * tw) / info.width);
    const th = Math.min(fullHeight, Math.round(tw * THUMB_ASPECT[device]));
    const base = shot.file.replace(/^shots\//, "").replace(/\.png$/, "");
    entry.thumb = `thumbs/${base}.webp`;
    entry.thumbWidth = tw;
    entry.thumbHeight = th;
    await sharp(bytes)
      .resize({ width: tw, height: th, fit: "cover", position: "top" })
      .webp({ quality: THUMB_QUALITY, effort: 5 })
      .toFile(join(out, entry.thumb));
    if (webp) {
      entry.file = `shots/${base}.webp`;
      await sharp(bytes).webp({ quality: FULL_QUALITY, effort: 5 }).toFile(join(out, entry.file));
      rmSync(png);
    }
  });
  return shots.map((s) => result.get(s)!);
}

// The previous run: a site (https://…) or a local output directory.
type Previous = { manifest: Manifest; read: (path: string) => Promise<Buffer> };

const SAFE_PATH = /^(?:shots|thumbs|before)\/[a-z0-9-]+(?:\.thumb)?\.(?:webp|png)$/;

async function loadPrevious(source: string): Promise<Previous | string> {
  const remote = /^https?:\/\//.test(source);
  const base = remote ? source.replace(/\/?$/, "/") : resolve(source);
  const read = async (path: string) => {
    // Only image paths of the gallery's own form: the manifest comes from
    // the network.
    if (!SAFE_PATH.test(path)) throw new Error(`unexpected path ${path}`);
    if (!remote) return readFileSync(join(base, path));
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  try {
    let text: string;
    if (remote) {
      const response = await fetch(new URL("manifest.json", base), { signal: AbortSignal.timeout(30_000), cache: "no-store" });
      if (response.status === 404) return "No previous run was published yet – the first run has nothing to compare with.";
      if (!response.ok) return `The previous run's manifest could not be loaded (HTTP ${response.status}).`;
      text = await response.text();
    } else text = readFileSync(join(base, "manifest.json"), "utf8");
    const manifest = JSON.parse(text) as Manifest;
    if (manifest?.format !== 1 || !Array.isArray(manifest.shots))
      return "The previous run's manifest has another format – nothing to compare with this time.";
    return { manifest, read };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return `The previous run's manifest could not be loaded (${String((error as Error).message || error).slice(0, 160)}${cause ? `: ${cause}` : ""}).`;
  }
}

// Compares this run with the previous one and keeps the previous images of
// changed and removed screenshots under before/.
export async function compareWithPrevious(out: string, shots: ManifestShot[], source: string | undefined): Promise<Changes> {
  const empty: Changes = { previous: null, changed: [], added: [], removed: [] };
  rmSync(join(out, "before"), { recursive: true, force: true });
  if (!source) return { ...empty, note: "This run was not compared with another one." };
  const sharp = await loadSharp();
  if (!sharp) return { ...empty, note: "No comparison: sharp is not installed." };
  const loaded = await loadPrevious(source);
  if (typeof loaded === "string") return { ...empty, note: loaded };
  const { manifest: prev, read } = loaded;
  mkdirSync(join(out, "before"), { recursive: true });

  // Both images of a screenshot into before/, renamed after the shot.
  const keep = async (s: ManifestShot) => {
    const name = key(s);
    const file = `before/${name}${extname(s.file) || ".webp"}`;
    const thumb = `before/${name}.thumb${extname(s.thumb) || ".webp"}`;
    writeFileSync(join(out, file), await read(s.file));
    if (s.thumb === s.file) return { file, thumb: file };
    writeFileSync(join(out, thumb), await read(s.thumb));
    return { file, thumb };
  };
  const decode = async (bytes: Buffer): Promise<Pixels> => {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };

  const { candidates, added, removed, unchanged } = pairShots(prev.shots.filter((s) => s.file), shots);
  const changed: Change[] = [];
  let failed = 0;
  await pool(candidates, 6, async ({ before, after }) => {
    try {
      // The thumbnails – both through the same lossy pipeline – decide;
      // a missing new screenshot counts as changed.
      let ratio = 1;
      if (after.file && before.thumb) {
        const counted = countDiffPixels(await decode(await read(before.thumb)), await decode(readFileSync(join(out, after.thumb))));
        if (!isChanged(counted)) return;
        ratio = counted.diff / counted.total;
      }
      const kept = await keep(before);
      changed.push({
        scene: after.scene,
        variant: after.variant,
        ratio: Math.round(ratio * 10000) / 10000,
        before: { ...kept, width: before.width, height: before.height, thumbWidth: before.thumbWidth, thumbHeight: before.thumbHeight },
      });
    } catch (error) {
      failed++;
      console.warn(`Comparison of ${key(after)} failed: ${String((error as Error).message || error).slice(0, 200)}`);
    }
  });
  const removedKept: BeforeShot[] = [];
  await pool(removed, 6, async (s) => {
    try {
      removedKept.push({ ...s, ...(await keep(s)), generated: prev.generated });
    } catch (error) {
      failed++;
      console.warn(`Keeping the removed ${key(s)} failed: ${String((error as Error).message || error).slice(0, 200)}`);
    }
  });
  const order = new Map(prev.shots.map((s, i) => [key(s), i]));
  removedKept.sort((a, b) => order.get(key(a))! - order.get(key(b))!);
  console.log(`Compared with ${prev.commitShort} (${prev.generated}): ${changed.length} changed, ${added.length} new, ${removedKept.length} removed, ${unchanged + candidates.length - changed.length - failed} unchanged${failed ? `, ${failed} not compared` : ""}.`);
  return {
    previous: { generated: prev.generated, commit: prev.commit, commitShort: prev.commitShort, version: prev.version },
    ...(failed ? { note: `${failed} screenshots could not be compared (download failed).` } : {}),
    changed: sortChanges(changed, shots),
    added: added.map((s) => ({ scene: s.scene, variant: s.variant })),
    removed: removedKept,
  };
}

// The published site's extras: its domain for GitHub Pages and no search
// engine indexing (the content is demo data).
export function writeSiteFiles(out: string, cname: string) {
  writeFileSync(join(out, "CNAME"), `${cname}\n`);
  writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
}
