// The "Changed" view of the UI gallery: which screenshots differ from the
// previous run's (the nightly site, gallery.flowplan.org). Pure functions –
// the files, downloads and image decoding are in site.ts – so
// tests/gallery-compare.test.ts can check them without a browser.

// One screenshot as the manifest lists it.
export type ManifestShot = {
  scene: string;
  group: string;
  title: string;
  path: string;
  variant: string;
  // Relative to the site: the full image and the grid's thumbnail.
  file: string;
  thumb: string;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  // SHA-256 of the decoded pixels (RGBA) of the full screenshot: equal
  // means unchanged, without looking at the image.
  hash: string;
  error?: string;
  pageErrors: string[];
  ms: number;
};

// A screenshot of the previous run kept in this site (under before/) so
// its before/after still works once the previous site is replaced.
export type BeforeShot = ManifestShot & { generated: string };

export type Change = {
  scene: string;
  variant: string;
  // Share of the thumbnail's pixels that differ (0…1).
  ratio: number;
  // The previous run's images, kept in this site.
  before: { file: string; thumb: string; width: number; height: number; thumbWidth: number; thumbHeight: number };
};

export type Changes = {
  // The run compared with; null on the first run or when the previous
  // manifest could not be read (`note` says why).
  previous: { generated: string; commit: string; commitShort: string; version: string } | null;
  note?: string;
  changed: Change[];
  // In this run only.
  added: { scene: string; variant: string }[];
  // In the previous run only: its images are kept under before/.
  removed: BeforeShot[];
};

export type Manifest = {
  format: 1;
  generated: string;
  commit: string;
  commitShort: string;
  branch: string;
  version: string;
  seconds: number;
  server: string;
  variants: string[];
  groups: readonly string[];
  shots: ManifestShot[];
  changes: Changes;
};

export const key = (s: { scene: string; variant: string }) => `${s.scene}--${s.variant}`;

// Pairs this run's screenshots with the previous run's. Only `candidates`
// (both present, pixels not identical) need a pixel comparison.
export function pairShots(previous: ManifestShot[], current: ManifestShot[]) {
  const before = new Map(previous.map((s) => [key(s), s]));
  const now = new Set(current.map(key));
  const candidates: { before: ManifestShot; after: ManifestShot }[] = [];
  const added: ManifestShot[] = [];
  let unchanged = 0;
  for (const after of current) {
    const b = before.get(key(after));
    if (!b) added.push(after);
    // A screenshot that failed to save has no hash: compare it like any
    // other (it would show as changed when the previous one exists).
    else if (b.hash && b.hash === after.hash) unchanged++;
    else candidates.push({ before: b, after });
  }
  const removed = previous.filter((s) => !now.has(key(s)));
  return { candidates, added, removed, unchanged };
}

export type Pixels = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

export const DIFF_DEFAULTS = {
  // Colour distance (YIQ, 0…1 of the largest possible) below which a pixel
  // counts as equal: the lossy thumbnail and anti-aliasing stay below it.
  // pixelmatch's default.
  threshold: 0.1,
  // A screenshot is "changed" when more than this share of its pixels
  // differs …
  minRatio: 0.0005,
  // … and at least this many pixels: a caret or a single anti-aliased
  // glyph edge is not a change.
  minPixels: 12,
};

// Squared YIQ distance as in pixelmatch (Kotsarenko & Ramos), alpha
// blended onto white; 35215 is the largest possible value.
function colorDelta(a: Pixels["data"], b: Pixels["data"], i: number) {
  const blend = (c: number, alpha: number) => 255 + ((c - 255) * alpha) / 255;
  const r1 = blend(a[i], a[i + 3]), g1 = blend(a[i + 1], a[i + 3]), b1 = blend(a[i + 2], a[i + 3]);
  const r2 = blend(b[i], b[i + 3]), g2 = blend(b[i + 1], b[i + 3]), b2 = blend(b[i + 2], b[i + 3]);
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const iq = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

// The number of differing pixels of two RGBA images of the same size;
// images of different sizes differ completely.
export function countDiffPixels(a: Pixels, b: Pixels, threshold = DIFF_DEFAULTS.threshold) {
  const total = a.width * a.height;
  if (a.width !== b.width || a.height !== b.height) return { diff: Math.max(total, b.width * b.height), total: Math.max(total, b.width * b.height) };
  const max = 35215 * threshold * threshold;
  let diff = 0;
  for (let i = 0; i < total * 4; i += 4) if (colorDelta(a.data, b.data, i) > max) diff++;
  return { diff, total };
}

export function isChanged({ diff, total }: { diff: number; total: number }, options: Partial<typeof DIFF_DEFAULTS> = {}) {
  const { minRatio, minPixels } = { ...DIFF_DEFAULTS, ...options };
  if (!total) return false;
  return diff >= minPixels && diff / total > minRatio;
}

// Scenes in the manifest's order, changed first by how much they changed.
export function sortChanges(changes: Change[], order: ManifestShot[]) {
  const index = new Map(order.map((s, i) => [key(s), i]));
  return [...changes].sort((a, b) => (index.get(key(a)) ?? 0) - (index.get(key(b)) ?? 0));
}
