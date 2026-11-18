// Litestream's memory (lib/litestream-memory.ts, issue #335): its PID from
// the entrypoint's hint or /proc/*/comm, VmRSS from /proc/<pid>/status, the
// threshold max(512 MiB, 25 % of the container's or host's memory) and the
// rule "above the threshold and still climbing over 10 samples". Only fake
// /proc readers here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LITESTREAM_MEMORY,
  findLitestreamPid,
  keepSamples,
  memoryThreshold,
  memoryVerdict,
  processRss,
  currentThreshold,
  type MemorySample,
} from "../lib/litestream-memory";
import { fakeProc } from "./helpers/fake-proc";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MIN = 60_000;

test("the PID: the entrypoint's hint while it still is Litestream, else /proc/*/comm (replicate first)", () => {
  const proc = fakeProc({
    1: { comm: "litestream", cmdline: ["litestream", "replicate", "-config", "/etc/litestream.yml", "-exec", "node server.js"], rssKb: 1 },
    7: { comm: "node", cmdline: ["node", "server.js"] },
  });
  assert.equal(findLitestreamPid(proc, 1), 1);
  assert.equal(findLitestreamPid(proc, null), 1);
  // A stale hint (another process has that PID now) is not trusted.
  assert.equal(findLitestreamPid(proc, 7), 1);
  // The supervised path: no hint, a `litestream restore` would not count before a replicate.
  const supervised = fakeProc({
    1: { comm: "sh" },
    20: { comm: "litestream", cmdline: ["litestream", "restore", "x"] },
    31: { comm: "litestream", cmdline: ["litestream", "replicate", "-config", "/etc/litestream.yml"] },
  });
  assert.equal(findLitestreamPid(supervised), 31);
  // No readable command line: any litestream.
  assert.equal(findLitestreamPid(fakeProc({ 9: { comm: "litestream" } })), 9);
  assert.equal(findLitestreamPid(fakeProc({ 3: { comm: "node" } })), null);
});

test("VmRSS in bytes; null for a process that is gone or has none", () => {
  const proc = fakeProc({ 5: { comm: "litestream", rssKb: 2_150_000 }, 6: { comm: "litestream" } });
  assert.equal(processRss(proc, 5), 2_150_000 * 1024);
  assert.equal(processRss(proc, 6), null);
  assert.equal(processRss(proc, 99), null);
});

test("threshold: max(512 MiB, 25 % of the container limit, else of the host)", () => {
  assert.deepEqual(memoryThreshold(4 * GiB, 64 * GiB), { threshold: GiB, basis: "container", total: 4 * GiB });
  assert.deepEqual(memoryThreshold(null, 8 * GiB), { threshold: 2 * GiB, basis: "host", total: 8 * GiB });
  assert.deepEqual(memoryThreshold(GiB, null), { threshold: 512 * MiB, basis: "floor", total: GiB });
  assert.deepEqual(memoryThreshold(null, null), { threshold: 512 * MiB, basis: "floor", total: null });
  // From cgroup v2 and /proc/meminfo, through the restart tracker's readers.
  const files: Record<string, string> = {
    "/sys/fs/cgroup/memory.max": "max\n",
    "/sys/fs/cgroup/memory.current": "1000\n",
    "/proc/meminfo": "MemTotal:        4194304 kB\nMemAvailable:    1048576 kB\n",
  };
  assert.deepEqual(currentThreshold((p) => files[p] ?? null), { threshold: GiB, basis: "host", total: 4 * GiB });
  files["/sys/fs/cgroup/memory.max"] = String(3 * GiB);
  assert.deepEqual(currentThreshold((p) => files[p] ?? null), { threshold: 768 * MiB, basis: "container", total: 3 * GiB });
});

const series = (rssMiB: number[], pid = 1, start = 0): MemorySample[] => rssMiB.map((r, i) => ({ at: start + i * MIN, pid, rss: r * MiB }));
const T = 512 * MiB;

test("verdict: normal below the threshold, high above it, climbing only on a steady rise over 10 samples and 9 minutes", () => {
  assert.equal(memoryVerdict([], T), "normal");
  assert.equal(memoryVerdict(series([300, 350, 400]), T), "normal");
  // The production incident: +30 MB a minute past 600 MB.
  const climbing = series(Array.from({ length: 10 }, (_, i) => 600 + i * 30));
  assert.equal(memoryVerdict(climbing, T), "climbing");
  // Too few samples, or not long enough yet.
  assert.equal(memoryVerdict(climbing.slice(0, 9), T), "high");
  assert.equal(memoryVerdict(climbing.map((s, i) => ({ ...s, at: i * 50_000 })), T), "high");
  // Above the threshold but flat (a large database, a busy hour).
  assert.equal(memoryVerdict(series(Array(12).fill(900)), T), "high");
  // Rising, but less than max(64 MiB, 10 %).
  assert.equal(memoryVerdict(series(Array.from({ length: 10 }, (_, i) => 900 + i * 5)), T), "high");
  // A saw tooth: memory released in between (a compaction that worked).
  assert.equal(memoryVerdict(series([600, 650, 700, 750, 800, 620, 700, 780, 850, 900]), T), "high");
  // Small jitter (under 5 %) does not break a climb.
  assert.equal(memoryVerdict(series([600, 640, 630, 680, 720, 710, 760, 800, 790, 840]), T), "climbing");
  // The newest sample decides about the threshold.
  assert.equal(memoryVerdict(series(Array.from({ length: 10 }, (_, i) => 300 + i * 20)), T), "normal");
});

test("samples: only the last 15 minutes of the newest process", () => {
  let kept: MemorySample[] = [];
  for (const s of series(Array.from({ length: 20 }, (_, i) => 600 + i * 30))) kept = keepSamples(kept, s);
  assert.equal(kept.length, 16);
  assert.ok(kept.at(-1)!.at - kept[0].at <= LITESTREAM_MEMORY.window);
  assert.equal(memoryVerdict(kept, T), "climbing");
  // A new Litestream (restarted, another PID) starts over.
  kept = keepSamples(kept, { at: 20 * MIN, pid: 2, rss: 40 * MiB });
  assert.deepEqual(kept, [{ at: 20 * MIN, pid: 2, rss: 40 * MiB }]);
  assert.equal(memoryVerdict(kept, T), "normal");
});
