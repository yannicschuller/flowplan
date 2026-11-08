// The node reference of the documentation (flowplan-docs:
// content/docs/workflow-nodes.md, en/…) names every node of the catalogue,
// so the two cannot drift apart (docs/specs/workflows.md §14). Needs the
// docs checkout in FLOWPLAN_DOCS_DIR (as `npm run help-docs` does).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_TYPES } from "../lib/workflows/catalog";

const dir = process.env.FLOWPLAN_DOCS_DIR;
test("the documentation's node reference names every node of the catalogue", { skip: !dir && "FLOWPLAN_DOCS_DIR is not set" }, () => {
  for (const file of ["workflow-nodes.md", "en/workflow-nodes.md"]) {
    const path = join(dir!, "content", "docs", file);
    assert.ok(existsSync(path), path);
    const text = readFileSync(path, "utf8");
    for (const n of NODE_TYPES) assert.ok(text.includes(`\`${n.type}\``), `${file}: ${n.type}`);
  }
});
test("the in-app help knows the workflow pages", () => {
  const help = readFileSync("lib/ai/help-docs.json", "utf8");
  assert.ok(help.includes("workflow-nodes"));
  assert.ok(help.includes("Workflow-Knopf") || help.includes("Workflow button"));
});
