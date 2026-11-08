import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, excluded, order, render, replaceSection } from "../scripts/contributors.mjs";

test("contributors: merged pull requests count, bots, Claude and the release bot never", () => {
  assert.equal(excluded("claude", "User"), true);
  assert.equal(excluded("github-actions[bot]", "Bot"), true);
  assert.equal(excluded("dependabot[bot]", "Bot"), true);
  assert.equal(excluded("timthinks", "User"), false);
  const people = collect(
    [
      { merged_at: "2026-11-08", user: { login: "timthinks", type: "User" } },
      { merged_at: "2026-11-08", user: { login: "timthinks", type: "User" } },
      { merged_at: null, user: { login: "someone", type: "User" } },
      { merged_at: "2026-11-01", user: { login: "dependabot[bot]", type: "Bot" } },
      { merged_at: "2026-11-02", user: { login: "scudong", type: "User" } },
    ],
    [
      { login: "claude", type: "User", contributions: 800 },
      { login: "yannicschuller", type: "User", contributions: 279 },
      { login: "github-actions[bot]", type: "Bot", contributions: 37 },
    ],
  );
  const logins = order(people, "yannicschuller").map((p: { login: string }) => p.login);
  // The owner first, then by merged pull requests; a closed but unmerged one does not count.
  assert.deepEqual(logins, ["yannicschuller", "timthinks", "scudong"]);
});

test("contributors: rendered between the markers, names escaped, the rest of the README kept", () => {
  const html = render([{ login: "a<b", prs: 1, commits: 0 }]);
  assert.match(html, /^<!-- contributors:start -->/);
  assert.ok(!html.includes("a<b"));
  assert.match(html, /a&lt;b/);
  const readme = "intro\n<!-- contributors:start -->\nold\n<!-- contributors:end -->\noutro";
  assert.equal(replaceSection(readme, "<!-- contributors:start -->NEW<!-- contributors:end -->"), "intro\n<!-- contributors:start -->NEW<!-- contributors:end -->\noutro");
  assert.throws(() => replaceSection("no markers", "x"));
});
