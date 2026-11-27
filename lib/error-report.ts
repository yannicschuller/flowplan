// The error details of the monitoring as the browser gets them
// (lib/error-details.ts errorDetails), the internal plain-text report of a
// group, and the public report for a GitHub issue (publicReport,
// githubIssue) – shared by the server and the administration page, so
// nothing here may import Node.js modules.
import type { CallerRole } from "./request-context";

export type ErrorKind = "request" | "worker" | "job";
// One stack frame in Flowplan's code: the source file when the build's
// source map was found (`mapped`), else the compiled file.
export type StackFrame = { fn: string; file: string; line: number; column: number; mapped: boolean };
// `stopping`: the instance was shutting down when it happened (a 503 then
// is expected, lib/error-digest.ts leaves it out).
export type ErrorOccurrence = { at: number; requestId: string; status: number; method: string; node: string; version: string; role: CallerRole | ""; message: string; stopping?: boolean };
// What an administrator did about a signature (error_digest_state,
// lib/error-digest.ts): reported (with the issue's address, if pasted),
// muted until a time.
export type ErrorSignatureMark = { reportedAt: number | null; issueUrl: string; mutedUntil: number | null };
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
  // The build-independent signature (errorSignature, "fp-err-v1-…"): the
  // same error in another build has the same one.
  signature: string;
  mark: ErrorSignatureMark | null;
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

// The internal plain-text report ("Intern kopieren"): what, where, how
// often, which version – no person, no address, but with the request ids
// and the instance names of the last occurrences, to find them in this
// instance's log. Never for a public issue: that is publicReport.
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

/* ---------- The build-independent signature and the public report ---------- */

// The repository issues go to (.github/ISSUE_TEMPLATE/bug_report.yml).
export const ISSUE_REPOSITORY = "yannicschuller/flowplan";
export const isErrorSignature = (value: unknown): value is string => typeof value === "string" && /^fp-err-v1-[0-9a-f]{16}$/.test(value);

// Words that are hosts: a known top-level or internal suffix, or a port
// (not every "a.b": minified property accesses like "t.map" stay).
const HOST_SUFFIX =
  "com|org|net|io|dev|app|cloud|de|at|ch|fr|nl|be|eu|uk|us|it|es|pl|ru|cn|jp|info|biz|me|co|xyz|online|site|tech|internal|local|lan|home|corp|intra|intranet|example|test|invalid|localhost|svc|cluster";
const HOST = new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${HOST_SUFFIX})\\b(?::\\d{1,5})?|\\blocalhost(?::\\d{1,5})?\\b|\\b(?:[a-z0-9-]+\\.)+[a-z0-9-]+:\\d{2,5}\\b`, "gi");
// The message as a template: what stays the same when the same error
// happens again with other values – quoted values "…", numbers N, file
// paths [path], addresses and hosts [url]. Used for the signature and the
// public report; applied to the already scrubbed message.
export function messageTemplate(message: string): string {
  let out = String(message || "");
  // Addresses first: they hold hosts and paths.
  out = out.replace(/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'`<>)\]]*/gi, "[url]");
  // Quoted values: "…", '…' (not an apostrophe inside a word), `…`, „…“ “…” ‘…’ «…».
  out = out
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, '"…"')
    .replace(/`[^`]*`/g, '"…"')
    .replace(/[„“”][^„“”]*[“”]/g, '"…"')
    .replace(/‘[^‘’]*’/g, '"…"')
    .replace(/«[^»]*»/g, '"…"');
  // A quote left open (the message was cut): the rest is its value.
  if ((out.match(/"/g) || []).length % 2) out = out.replace(/"(?!…")[^"]*$/, '"…"');
  // File paths: absolute (Unix, Windows, ~), relative with ./ or ../.
  out = out
    .replace(/(^|[\s(=:,[])(?:~|\.{1,2})?\/(?:[^\s/:,;'")\]]+\/)*[^\s/:,;'")\]]+(?::\d+(?::\d+)?)?/g, "$1[path]")
    .replace(/\b[A-Za-z]:\\(?:[^\s\\:,;'")]+\\)*[^\s\\:,;'")]*/g, "[path]");
  out = out.replace(HOST, "[url]");
  // Numbers (not inside words: "utf8", "v18", "E11000" stay).
  out = out.replace(/\b0x[0-9a-f]+\b/gi, "N").replace(/(?<![\p{L}_])\b\d+(?:[.,]\d+)*\b/gu, "N");
  return out.replace(/\s+/g, " ").trim();
}
// The class of a database error code: PostgreSQL's SQLSTATE class (two
// characters), SQLite's primary result code.
export function databaseCodeClass(code: string): string {
  const pg = /^PostgreSQL ([0-9A-Z]{2})[0-9A-Z]{3}$/.exec(code);
  if (pg) return `PostgreSQL ${pg[1]}`;
  const num = /^SQLite (\d+)/.exec(code);
  if (num) return `SQLite ${Number(num[1]) & 0xff}`;
  const named = /^SQLite (SQLITE_[A-Z]+)/.exec(code);
  if (named) return `SQLite ${named[1]}`;
  return code ? code.split(" ")[0] : "";
}
// A compiled class name is a letter or two in a minified build ("t", "Ab"):
// it changes with every build.
export const stableErrorName = (name: string) => (!name || /^[A-Za-z_$][A-Za-z0-9_$]?$/.test(name) ? "Error" : name);
// A frame in the repository's own source (lib/, app/, components/), mapped
// through the build's source map.
const repoFrame = (f: StackFrame) => f.mapped && /^(?:lib|app|components)\//.test(f.file) && !f.file.includes("node_modules/");
// What the signature is made of (lib/error-details.ts errorSignature hashes
// it): never a compiled chunk name, a minified function or a line.
export function signatureParts(g: Pick<ErrorGroupView, "kind" | "route" | "action" | "name" | "message" | "frames" | "dbCode">): string[] {
  const top = g.frames[0] && repoFrame(g.frames[0]) ? `${g.frames[0].file}#${g.frames[0].fn}` : "";
  return ["v1", g.kind || "request", g.route, g.action, stableErrorName(g.name), databaseCodeClass(g.dbCode), messageTemplate(g.message), top];
}

export type BuildVersion = { version: string; commit: string };
export type PublicErrorReport = {
  signature: string;
  name: string;
  message: string;
  kind: ErrorKind;
  route: string;
  action: string;
  status: number;
  dbCode: string;
  inRange: number;
  rangeLabel: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  version: string;
  commit: string;
  frames: string[];
};
const PUBLIC_MESSAGE_MAX = 200;
const day = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "");
// The public frames: mapped frames of the project's code as they are,
// compiled ones only as "[compiled]" (their chunk names and minified
// functions say nothing and change with every build), nothing with an
// absolute path (outside the project: a person's home, the server's disk).
export function publicFrames(frames: StackFrame[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const project = f.mapped && !/^(?:[A-Za-z]:[\\/]|[\\/~])/.test(f.file) && !f.file.startsWith("..") && !f.file.includes("node_modules/") && !f.file.includes("://");
    const text = project ? frameText(f) : f.mapped ? "" : "[compiled]";
    if (!text || (text === "[compiled]" && out.at(-1) === "[compiled]")) continue;
    out.push(text);
  }
  return out;
}
// The report for a public GitHub issue – stricter than the instance's own
// view: the message only as its template (≤ 200 characters), frames as
// publicFrames; never request ids, instance or host names, roles, the
// instance's address or single occurrences. Dates only as days.
export function publicReport(
  g: Pick<ErrorGroupView, "signature" | "kind" | "route" | "action" | "name" | "message" | "status" | "frames" | "dbCode" | "count" | "inRange" | "firstSeen" | "lastSeen">,
  build: BuildVersion,
  // The range the in-range count belongs to, in English ("the last 24 hours").
  rangeLabel = "",
): PublicErrorReport {
  const template = messageTemplate(g.message);
  return {
    signature: isErrorSignature(g.signature) ? g.signature : "",
    name: stableErrorName(g.name),
    message: template.length > PUBLIC_MESSAGE_MAX ? `${template.slice(0, PUBLIC_MESSAGE_MAX - 1)}…` : template,
    kind: g.kind,
    route: g.route,
    action: g.action,
    status: g.status,
    dbCode: g.dbCode,
    inRange: g.inRange,
    rangeLabel,
    count: g.count,
    firstSeen: day(g.firstSeen),
    lastSeen: day(g.lastSeen),
    version: /^[0-9A-Za-z.+-]{1,40}$/.test(build.version) ? build.version : "",
    commit: /^[0-9a-f]{7,40}$/.test(build.commit) ? build.commit.slice(0, 12) : "",
    frames: publicFrames(g.frames),
  };
}
const whereLine = (r: PublicErrorReport) => `${r.route}${r.action ? ` · ${r.action}` : ""}`;
const kindNote = (r: PublicErrorReport) => (r.kind === "worker" ? " (background worker)" : r.kind === "job" ? " (background job)" : "");
const versionLine = (r: PublicErrorReport) => `${r.version || "unknown"}${r.commit ? ` (commit ${r.commit})` : ""}`;
const stackLines = (frames: string[]) => ["Stack (Flowplan's code):", ...(frames.length ? frames.map((f) => `  at ${f}`) : ["  (none)"])];

// The fields of .github/ISSUE_TEMPLATE/bug_report.yml the issue is filled
// with (by their ids), and its title.
export type GithubIssue = { url: string; title: string; fields: { what: string; steps: string; expected: string; diagnostics: string; logs: string } };
export const ISSUE_URL_MAX = 6000;
function issueFields(r: PublicErrorReport, frames: string[], message: string): GithubIssue["fields"] {
  const recent = r.inRange !== r.count ? ` (${r.inRange}${r.rangeLabel ? ` in ${r.rangeLabel}` : " recently"})` : "";
  return {
    what: [
      `The error monitoring of a Flowplan instance recorded this server error (status ${r.status}) ${r.count} ${r.count === 1 ? "time" : "times"} between ${r.firstSeen} and ${r.lastSeen}${recent}.`,
      "",
      `**${r.name}**${message ? `: ${message}` : ""}`,
      "",
      `- Where: \`${whereLine(r)}\`${kindNote(r)}`,
      ...(r.dbCode ? [`- Database: ${r.dbCode}`] : []),
      "",
      `Error signature: ${r.signature}`,
    ].join("\n"),
    steps: "Not known – recorded by the server's error monitoring (Settings → Administration → Monitoring → Errors in detail).",
    expected: "No server error.",
    // The template's "Installation details" (#630): what the error report
    // knows of the server – the version and commit, no instance details.
    diagnostics: `Backend: Flowplan ${versionLine(r)}`,
    logs: stackLines(frames).join("\n"),
  };
}
const issueAddress = (title: string, fields: GithubIssue["fields"]) =>
  `https://github.com/${ISSUE_REPOSITORY}/issues/new?${new URLSearchParams({ template: "bug_report.yml", title, ...fields }).toString()}`;
// What opens a new issue with the report filled in: its title, its fields
// and the address, at most ISSUE_URL_MAX characters – the stack is
// shortened first, then the message. Built in the browser; the server
// never talks to GitHub.
export function githubIssue(r: PublicErrorReport): GithubIssue {
  const title = `Server error: ${r.name} in ${whereLine(r)}`.slice(0, 120);
  let frames = r.frames;
  let message = r.message;
  for (;;) {
    const fields = issueFields(r, frames, message);
    const url = issueAddress(title, fields);
    if (url.length <= ISSUE_URL_MAX) return { url, title, fields };
    if (frames.length) frames = frames.slice(0, -1);
    else if (message.length > 20) message = `${message.slice(0, Math.floor(message.length / 2))}…`;
    else return { url: issueAddress(title.slice(0, 60), { ...fields, what: fields.what.slice(-300) }), title: title.slice(0, 60), fields: { ...fields, what: fields.what.slice(-300) } };
  }
}
export const githubIssueUrl = (r: PublicErrorReport) => githubIssue(r).url;
// GitHub's issue search for the signature: was it reported already?
export const githubSearchUrl = (signature: string) => `https://github.com/${ISSUE_REPOSITORY}/issues?q=${encodeURIComponent(`"${signature}"`)}`;
// The public report as plain text ("Bericht kopieren").
export function publicReportText(r: PublicErrorReport) {
  return [
    `${r.name}${r.message ? `: ${r.message}` : ""}`,
    "",
    `Where: ${whereLine(r)}${kindNote(r)}`,
    `Status: ${r.status}`,
    ...(r.dbCode ? [`Database: ${r.dbCode}`] : []),
    `Count: ${r.count} (first seen ${r.firstSeen}, last seen ${r.lastSeen})`,
    `Version: ${versionLine(r)}`,
    "",
    ...stackLines(r.frames),
    "",
    `Error signature: ${r.signature}`,
  ].join("\n");
}
