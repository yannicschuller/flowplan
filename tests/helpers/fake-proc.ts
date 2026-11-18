// A fake /proc for lib/litestream-memory.ts: processes with comm, command
// line and VmRSS (kB); a process without rssKb has no VmRSS line (a zombie).
import type { ProcReader } from "../../lib/litestream-memory";

export function fakeProc(procs: Record<number, { comm: string; cmdline?: string[]; rssKb?: number }>): ProcReader {
  return {
    list: (dir) => (dir === "/proc" ? ["self", "cpuinfo", ...Object.keys(procs)] : []),
    read: (path) => {
      const m = /^\/proc\/(\d+)\/(comm|cmdline|status)$/.exec(path);
      const p = m ? procs[Number(m[1])] : undefined;
      if (!p) return null;
      if (m![2] === "comm") return `${p.comm}\n`;
      if (m![2] === "cmdline") return p.cmdline ? `${p.cmdline.join("\0")}\0` : null;
      return p.rssKb === undefined ? "Name:\tx\nState:\tZ (zombie)\n" : `Name:\t${p.comm}\nVmPeak:\t 9999999 kB\nVmRSS:\t ${p.rssKb} kB\nThreads:\t12\n`;
    },
  };
}
