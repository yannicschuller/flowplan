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
