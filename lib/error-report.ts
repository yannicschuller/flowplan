// The error details of the monitoring as the browser gets them
// (lib/error-details.ts errorDetails) and the plain-text report of a group
// for an issue – shared by the server and the administration page, so
// nothing here may import Node.js modules.
import type { CallerRole } from "./request-context";

export type ErrorKind = "request" | "worker" | "job";
// One stack frame in Flowplan's code: the source file when the build's
// source map was found (`mapped`), else the compiled file.
export type StackFrame = { fn: string; file: string; line: number; column: number; mapped: boolean };
export type ErrorOccurrence = { at: number; requestId: string; status: number; method: string; node: string; version: string; role: CallerRole | ""; message: string };
export type ErrorGroupView = {
  fingerprint: string;
  kind: ErrorKind;
  route: string;
  action: string;
  name: string;
  message: string;
  status: number;
  frames: StackFrame[];
  dbCode: string;
  count: number;
  inRange: number;
  firstSeen: number;
  lastSeen: number;
  // Failures per step in the range, sparse [time, count] (5 minutes up to
  // 24 hours, hours for 7 days).
  buckets: [number, number][];
  occurrences: ErrorOccurrence[];
};

// A failing third-party service (#514): per place (kind, route or worker,
// command), service and host, the count and last time – counted apart from
// the server errors (lib/error-details.ts upstreamFailures).
export type UpstreamFailureView = {
  key: string;
  kind: ErrorKind;
  route: string;
  action: string;
  service: string;
  host: string;
  status: number;
  message: string;
  count: number;
  inRange: number;
  firstSeen: number;
  lastSeen: number;
};

export const frameText = (f: StackFrame) => `${f.fn ? `${f.fn} ` : ""}(${f.file}:${f.line}:${f.column})`;

// A plain-text report for an issue: what, where, how often, which version –
// no person, no address (the occurrences only by time, id and status).
export function issueReport(g: Pick<ErrorGroupView, "kind" | "route" | "action" | "name" | "message" | "status" | "frames" | "dbCode" | "count" | "firstSeen" | "lastSeen" | "occurrences">) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const versions = [...new Set(g.occurrences.map((o) => o.version).filter(Boolean))];
  const lines = [
    `${g.name}${g.message ? `: ${g.message}` : ""}`,
    "",
    `Where: ${g.route}${g.action ? ` · ${g.action}` : ""}`,
    `Status: ${g.status}`,
    ...(g.dbCode ? [`Database: ${g.dbCode}`] : []),
    `Count: ${g.count} (first ${iso(g.firstSeen)}, last ${iso(g.lastSeen)})`,
    ...(versions.length ? [`Version: ${versions.join(", ")}`] : []),
    "",
    "Stack (Flowplan's code):",
    ...(g.frames.length ? g.frames.map((f) => `  at ${frameText(f)}${f.mapped ? "" : " [compiled]"}`) : ["  (none)"]),
    "",
    "Recent occurrences:",
    ...g.occurrences.slice(0, 5).map((o) => `  ${iso(o.at)} · ${o.status} · ${o.requestId || "–"}${o.node ? ` · ${o.node}` : ""}`),
  ];
  return lines.join("\n");
}
