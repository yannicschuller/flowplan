// The running build: version, commit and build time (set in next.config.ts
// when building). A commit given at runtime (Coolify sets SOURCE_COMMIT) wins
// when the build did not know it.
export type BuildInfo = { version: string; commit: string; builtAt: string; node: string; repository: string };

export function buildInfo(): BuildInfo {
  const commit = process.env.FLOWPLAN_COMMIT || process.env["SOURCE_COMMIT"] || process.env["GIT_COMMIT"] || "";
  return {
    version: process.env.FLOWPLAN_VERSION || "",
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : "",
    builtAt: process.env.FLOWPLAN_BUILT_AT || "",
    node: process.version,
    repository: "https://github.com/yannicschuller/flowplan",
  };
}

// The first line Flowplan writes to the server log (instrumentation.ts,
// #194): which version, channel and commit is running, e.g.
// "Flowplan 0.9.3 (beta, build abc1234, built 2026-11-10T09:00:00.000Z, Node.js v26.1.0)".
export function versionLine(build: BuildInfo = buildInfo(), channel = process.env.FLOWPLAN_CHANNEL || "") {
  const c = channel.trim().toLowerCase();
  const details = [
    c === "beta" || c === "release" ? c : "",
    build.commit ? `build ${build.commit.slice(0, 7)}` : "",
    build.builtAt ? `built ${build.builtAt}` : "",
    build.node ? `Node.js ${build.node}` : "",
  ].filter(Boolean);
  return `Flowplan ${build.version || "(version unknown)"}${details.length ? ` (${details.join(", ")})` : ""}`;
}
