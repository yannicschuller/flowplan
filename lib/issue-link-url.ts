// Links to issues, pull requests and merge requests (#654): which provider,
// server, repository and number an address names. Pure, for the server
// (lib/issue-preview.ts, which fetches the status) and the browser (which
// links to ask about at all: issueLinkShape).
//
// Strict on purpose – anything else is no issue link:
//   github.com/<owner>/<repo>/issues/<n>            GitHub issue
//   github.com/<owner>/<repo>/pull/<n>[/files|…]    GitHub pull request
//   gitlab.com/<group>[/<sub>…]/<project>/-/issues/<n>
//   gitlab.com/<group>[/<sub>…]/<project>/-/merge_requests/<n>
//   codeberg.org/<owner>/<repo>/issues/<n>          Forgejo issue
//   codeberg.org/<owner>/<repo>/pulls/<n>           Forgejo pull request
// Other servers only when listed in ISSUE_SYNC_ALLOWED_HOSTS (the same list
// as the issue sync, lib/issue-sync.ts): their provider follows from a
// connection of the issue sync on that server, else from the path
// ("/-/" GitLab, "/pull/" GitHub Enterprise, "/pulls/" Forgejo/Gitea;
// "/issues/" alone could be GitHub or Forgejo – both are tried).
// Only https, no credentials, no "..", segments of letters, digits, ".",
// "_" and "-"; the query and the fragment are ignored.

export type IssueLinkProvider = "github" | "gitlab" | "forgejo";
export type IssueLinkKind = "issue" | "pull";
export type IssueLinkRef = {
  // The provider, or the candidates in the order to try them.
  providers: IssueLinkProvider[];
  // "github.com", or a listed host (with its port, if any).
  host: string;
  // The web address of the server: "https://github.com", or with the path
  // of a self-hosted server (from its issue sync connection).
  web: string;
  repo: string;
  number: number;
  kind: IssueLinkKind;
  // The address in one spelling (cache key, the card's link).
  url: string;
};
// A server the issue sync is connected to: where it is and what it runs.
export type KnownIssueServer = { provider: IssueLinkProvider; web: string };

const SEGMENT = /^[\w.-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const FIXED: Record<string, IssueLinkProvider> = { "github.com": "github", "gitlab.com": "gitlab", "codeberg.org": "forgejo" };
const PULL_TAIL = new Set(["files", "commits", "checks"]);
const MR_TAIL = new Set(["diffs", "commits", "pipelines"]);

const validSegments = (segments: string[]) => segments.every((s) => SEGMENT.test(s) && s !== "." && s !== ".." && !/^\.+$/.test(s));

// Path segments after the server's own path into provider, repository,
// kind and number – or null.
function readPath(segments: string[], provider: IssueLinkProvider | null): { providers: IssueLinkProvider[]; repo: string; number: number; kind: IssueLinkKind } | null {
  if (!validSegments(segments)) return null;
  const dash = segments.indexOf("-");
  if (dash >= 0) {
    // GitLab: <namespace…>/<project>/-/(issues|merge_requests)/<n>[/tail]
    if (provider && provider !== "gitlab") return null;
    const repoParts = segments.slice(0, dash);
    const [what, n, tail, ...rest] = segments.slice(dash + 1);
    if (repoParts.length < 2 || repoParts.includes("-") || rest.length || !NUMBER.test(n || "")) return null;
    if (what === "issues" && tail === undefined) return { providers: ["gitlab"], repo: repoParts.join("/"), number: Number(n), kind: "issue" };
    if (what === "merge_requests" && (tail === undefined || MR_TAIL.has(tail)))
      return { providers: ["gitlab"], repo: repoParts.join("/"), number: Number(n), kind: "pull" };
    return null;
  }
  // GitHub and Forgejo: <owner>/<repo>/(issues|pull|pulls)/<n>[/tail]
  const [owner, name, what, n, tail, ...rest] = segments;
  if (!owner || !name || !NUMBER.test(n || "") || rest.length) return null;
  const repo = `${owner}/${name}`;
  if (what === "issues" && tail === undefined) {
    const providers: IssueLinkProvider[] = provider ? [provider] : ["github", "forgejo"];
    if (provider === "gitlab") return null;
    return { providers, repo, number: Number(n), kind: "issue" };
  }
  if (what === "pull" && (tail === undefined || PULL_TAIL.has(tail)) && (!provider || provider === "github"))
    return { providers: ["github"], repo, number: Number(n), kind: "pull" };
  if (what === "pulls" && (tail === undefined || tail === "files" || tail === "commits") && (!provider || provider === "forgejo"))
    return { providers: ["forgejo"], repo, number: Number(n), kind: "pull" };
  return null;
}

const kindPath = (provider: IssueLinkProvider, kind: IssueLinkKind) =>
  kind === "issue" ? (provider === "gitlab" ? "-/issues" : "issues") : provider === "gitlab" ? "-/merge_requests" : provider === "github" ? "pull" : "pulls";

export function parseIssueUrl(
  raw: string,
  { allowedHosts = [], servers = [] }: { allowedHosts?: readonly string[]; servers?: readonly KnownIssueServer[] } = {},
): IssueLinkRef | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  // Encoded characters, empty segments ("//") and backslashes are refused.
  if (/%|\\/.test(url.pathname) || /\/\//.test(url.pathname)) return null;
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1);
  const fixed = url.port ? undefined : FIXED[hostname];
  if (fixed) {
    const read = readPath(segments, fixed);
    if (!read) return null;
    const web = `https://${hostname}`;
    return { ...read, host: hostname, web, url: `${web}/${read.repo}/${kindPath(read.providers[0], read.kind)}/${read.number}` };
  }
  if (!allowedHosts.includes(host) && !(allowedHosts.includes(hostname) && !url.port)) return null;
  // A connected server: its provider, and its path (a server under a path).
  const known = servers
    .map((server) => {
      try {
        const base = new URL(server.web);
        const path = base.pathname.replace(/\/+$/, "");
        if (base.host.toLowerCase() !== host || base.protocol !== "https:") return null;
        if (path && url.pathname !== path && !url.pathname.startsWith(`${path}/`)) return null;
        return { provider: server.provider, path };
      } catch {
        return null;
      }
    })
    .filter((s): s is { provider: IssueLinkProvider; path: string } => !!s)
    .sort((a, b) => b.path.length - a.path.length);
  for (const server of known) {
    const rest = url.pathname.slice(server.path.length).replace(/\/$/, "").split("/").slice(1);
    const read = readPath(rest, server.provider);
    if (!read) continue;
    const web = `https://${host}${server.path}`;
    return { ...read, host, web, url: `${web}/${read.repo}/${kindPath(server.provider, read.kind)}/${read.number}` };
  }
  const read = readPath(segments, null);
  if (!read) return null;
  const web = `https://${host}`;
  return { ...read, host, web, url: `${web}/${read.repo}/${kindPath(read.providers[0], read.kind)}/${read.number}` };
}

// The browser's first look: could this link be one (any https host, the
// path of an issue or pull request)? The server decides (allowed hosts).
const SHAPE = /^https:\/\/[^/?#\s]+\/(?:[\w.-]+\/)+(?:-\/)?(?:issues|pull|pulls|merge_requests)\/[1-9]\d{0,9}(?:\/[\w-]+)?\/?(?:[?#].*)?$/;
export function issueLinkShape(href: string | null | undefined): boolean {
  return typeof href === "string" && href.length <= 2000 && SHAPE.test(href);
}
