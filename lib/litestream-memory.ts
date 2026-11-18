// Litestream's memory (issue #335). A stuck replica shows in Litestream's
// memory long before the bucket check (lib/litestream-health.ts) sees L0
// files older than an hour: every failed level-1 compaction retry (every
// 30 s) buffers all L0 files since the corrupt one, so the resident set
// grows by tens of MB a minute – in production to 2.1 GB within an hour or
// two, until the kernel's OOM killer ended Litestream and, as the
// container's main process (`replicate -exec`), the whole container.
//
// Reading: the app runs as the same user as Litestream, so
// /proc/<pid>/status (VmRSS) is readable. The PID comes from the entrypoint
// (pid= in <data>/.flowplan-replicating on the exec path, where Litestream
// keeps the entrypoint's PID) and is checked against /proc/<pid>/comm;
// otherwise /proc/*/comm is scanned for "litestream" (the supervised path,
// whose Litestream may have been restarted). Only /proc is read – cheap
// enough for one sample a minute.
//
// The rule (memoryVerdict), on the samples of the last 15 minutes of one
// Litestream process:
//   threshold = max(512 MiB, 25 % of the container's memory limit or,
//               without one, of the host's MemTotal);
//   high      = the newest sample above the threshold (the hint in
//               Administration → Überwachung, whatever the reason);
//   climbing  = high, and at least 10 samples spanning at least 9 minutes,
//               the newest at least max(64 MiB, 10 %) above the oldest, and
//               no sample below 95 % of the highest one before it – a
//               Litestream that works releases its buffers after a
//               compaction (a saw tooth); a stuck one only grows.
// Climbing counts as a stuck replica (the same path as old L0 files).
import { readFileSync, readdirSync } from "node:fs";
import { containerMemory, hostMemory } from "./restarts/tracker";

const MINUTE = 60_000;
const MiB = 1024 * 1024;
export const LITESTREAM_MEMORY = {
  // One sample a minute (only /proc).
  interval: MINUTE,
  // The samples looked at.
  window: 15 * MINUTE,
  minSamples: 10,
  minSpan: 9 * MINUTE,
  floor: 512 * MiB,
  share: 0.25,
  minRise: 64 * MiB,
  minRiseShare: 0.1,
  // A drop below this share of the highest sample before it: memory was
  // released, not climbing.
  dropShare: 0.95,
  // Right after Litestream started (the first snapshot, catching up),
  // climbing is only "high".
  settle: 15 * MINUTE,
} as const;

export type ProcReader = { read: (path: string) => string | null; list: (dir: string) => string[] };
export const realProc: ProcReader = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

const isLitestream = (proc: ProcReader, pid: number) => proc.read(`/proc/${pid}/comm`)?.trim() === "litestream";

// Litestream's PID: the entrypoint's hint when it still is Litestream,
// else the first `litestream replicate` in /proc (any litestream when no
// command line is readable). null when none runs here.
export function findLitestreamPid(proc: ProcReader = realProc, hint: number | null = null): number | null {
  if (hint && isLitestream(proc, hint)) return hint;
  let any: number | null = null;
  for (const name of proc.list("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!isLitestream(proc, pid)) continue;
    const cmdline = proc.read(`/proc/${pid}/cmdline`);
    if (cmdline?.split("\0").includes("replicate")) return pid;
    any ??= pid;
  }
  return any;
}

// VmRSS of a process in bytes; null when it is gone or unreadable.
export function processRss(proc: ProcReader, pid: number): number | null {
  const kb = /^VmRSS:\s+(\d+) kB$/m.exec(proc.read(`/proc/${pid}/status`) ?? "")?.[1];
  return kb ? Number(kb) * 1024 : null;
}

// The threshold and what it is based on.
export type MemoryBasis = { threshold: number; basis: "container" | "host" | "floor"; total: number | null };
export function memoryThreshold(containerLimit: number | null, hostTotal: number | null): MemoryBasis {
  const total = containerLimit ?? hostTotal;
  const basis = containerLimit ? "container" : hostTotal ? "host" : "floor";
  const share = total ? total * LITESTREAM_MEMORY.share : 0;
  return share > LITESTREAM_MEMORY.floor ? { threshold: Math.round(share), basis, total } : { threshold: LITESTREAM_MEMORY.floor, basis: "floor", total };
}
export function currentThreshold(read?: (path: string) => string | null): MemoryBasis {
  const trimmed = read ? (path: string) => read(path)?.trim() ?? null : undefined;
  return memoryThreshold(containerMemory(trimmed).limit, hostMemory(trimmed).total);
}

export type MemorySample = { at: number; pid: number; rss: number };
export type MemoryVerdict = "normal" | "high" | "climbing";

// The samples kept: the last window, of the newest process only (a new PID
// is a new Litestream and starts over).
export function keepSamples(samples: MemorySample[], next: MemorySample): MemorySample[] {
  return [...samples.filter((s) => s.pid === next.pid && next.at - s.at <= LITESTREAM_MEMORY.window && s.at < next.at), next];
}

export function memoryVerdict(samples: MemorySample[], threshold: number): MemoryVerdict {
  const newest = samples.at(-1);
  if (!newest || newest.rss <= threshold) return "normal";
  const L = LITESTREAM_MEMORY;
  const window = samples.filter((s) => s.pid === newest.pid && newest.at - s.at <= L.window);
  const oldest = window[0];
  if (window.length < L.minSamples || newest.at - oldest.at < L.minSpan) return "high";
  if (newest.rss - oldest.rss < Math.max(L.minRise, oldest.rss * L.minRiseShare)) return "high";
  let highest = 0;
  for (const s of window) {
    if (s.rss < highest * L.dropShare) return "high";
    highest = Math.max(highest, s.rss);
  }
  return "climbing";
}

export type LitestreamMemory = {
  at: number;
  pid: number;
  rss: number;
  threshold: number;
  basis: MemoryBasis["basis"];
  total: number | null;
  verdict: MemoryVerdict;
  // Over the kept samples: the lowest and how long they span.
  lowest: number;
  spanMs: number;
};
