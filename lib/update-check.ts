import { buildInfo } from "./build-info";

// Whether a newer Flowplan release than the running one exists, for the
// administration. Asks GitHub for the latest release (at most every 12 hours,
// after a failure again after an hour) and stays silent when that does not
// work. FLOWPLAN_UPDATE_CHECK=false turns it off (instances without internet);
// FLOWPLAN_UPDATE_URL asks a mirror instead.
export type UpdateStatus = { current: string; latest: string; url: string };
type Release = { version: string; url: string };

const RELEASES = "https://api.github.com/repos/yannicschuller/flowplan/releases/latest";
const FRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
let cached: { at: number; release: Release | null; url: string } | null = null;

// 1.2.3 and 1.2.3-beta.1 (with or without "v"); null for anything else.
function parse(version: string) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : [] } : null;
}
// Semantic versioning order: below 0 when a is older than b. A pre-release
// comes before its release (1.2.0-beta.1 < 1.2.0). Unreadable versions count
// as equal, so they never announce an update.
export function compareVersions(a: string, b: string) {
  const x = parse(a),
    y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i],
      q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const updateCheckEnabled = () => !/^(false|0|off|no)$/i.test(process.env.FLOWPLAN_UPDATE_CHECK || "");

async function latestRelease(fetcher: typeof fetch): Promise<Release | null> {
  const url = process.env.FLOWPLAN_UPDATE_URL || RELEASES;
  const now = Date.now();
  if (cached && cached.url === url && now - cached.at < (cached.release ? FRESH_MS : RETRY_MS)) return cached.release;
  let release: Release | null = null;
  try {
    const res = await fetcher(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "flowplan-update-check" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
      const version = typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : "";
      if (parse(version) && !data.draft && !data.prerelease)
        release = { version, url: typeof data.html_url === "string" && data.html_url.startsWith("https://") ? data.html_url : "" };
    }
  } catch {}
  cached = { at: now, release, url };
  return release;
}

// The newer release, or null: none, off, offline, or a build without a
// release version (development).
export async function updateStatus(fetcher: typeof fetch = fetch): Promise<UpdateStatus | null> {
  if (!updateCheckEnabled()) return null;
  const current = buildInfo().version;
  if (!parse(current)) return null;
  const release = await latestRelease(fetcher);
  if (!release || compareVersions(release.version, current) <= 0) return null;
  return { current, latest: release.version, url: release.url };
}

export function resetUpdateCheck() {
  cached = null;
}
