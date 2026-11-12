// payload/workflow-meta.json (lib/marketplace-workflow-meta.ts): the node
// symbols are complete and match the icon package, the official workflow
// packages carry a meta with exactly their node types and both languages of
// their gaps, and no value of a node's settings ever goes in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-meta-"));
const { NODE_TYPES } = await import("../lib/workflows/catalog");
const { NODE_ICON_PATHS } = await import("../lib/workflows/node-icon-paths");
const { workflowMeta, referenceGaps, WORKFLOW_META_PATH } = await import("../lib/marketplace-workflow-meta");
const { officialPackages } = await import("../lib/marketplace-official");
const { readZip } = await import("../lib/archive");
const { readPackage } = await import("../lib/marketplace-package");
const { parseGraph } = await import("../lib/workflows/graph");
const { iconPath } = await import("../scripts/node-icon-paths.mjs");

const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9.,\s-]+$/;

test("every catalogue symbol has its path data, the same as the icon package", async () => {
  for (const name of new Set([...NODE_TYPES.map((n) => n.icon), "Circle"])) {
    assert.ok(NODE_ICON_PATHS[name], `${name} missing – run scripts/node-icon-paths.mjs`);
    assert.match(NODE_ICON_PATHS[name], PATH_DATA, name);
    assert.equal(NODE_ICON_PATHS[name], await iconPath(name), `${name} differs – run scripts/node-icon-paths.mjs`);
  }
});

test("official workflow packages: meta with exactly the node types used, gaps in both languages", async () => {
  const packages = (await officialPackages("0.9.4")).filter((p) => p.kind === "workflow");
  assert.equal(packages.length, 6);
  for (const pkg of packages) {
    const entries = await readZip(pkg.bytes, { foreign: true });
    const workflow = JSON.parse(entries.get("payload/workflow.json")!.toString());
    const meta = JSON.parse(entries.get(WORKFLOW_META_PATH)!.toString());
    assert.equal(meta.format, "flowplan.workflow-meta");
    assert.equal(meta.version, 1);
    const used = [...new Set(workflow.graph.nodes.map((n: { type: string }) => n.type))].sort();
    assert.deepEqual(Object.keys(meta.nodes).sort(), used, pkg.file);
    for (const [type, n] of Object.entries(meta.nodes) as [string, { name: { de: string; en: string }; icon: string; group: string; ai?: boolean }][]) {
      assert.ok(n.name.de && n.name.en, `${pkg.file} ${type}`);
      assert.match(n.icon, PATH_DATA);
      assert.equal(n.group, NODE_TYPES.find((s) => s.type === type)!.category);
      assert.equal(!!n.ai, type.startsWith("ai."));
    }
    // The gaps the import asks for (lib/marketplace-package.ts), each with an English label.
    const parsed = await readPackage(pkg.bytes);
    assert.deepEqual(meta.gaps.map((g: { id: string }) => g.id).sort(), parsed.payload.kind === "workflow" ? parsed.payload.gaps.map((g) => g.id).sort() : null, pkg.file);
    for (const g of meta.gaps) {
      assert.ok(g.label.de && g.label.en, `${pkg.file} ${g.id}`);
      assert.ok(JSON.stringify(workflow.graph).includes(`$ask:${g.id}`), `${pkg.file}: gap ${g.id} is used`);
    }
    assert.ok(meta.gaps.some((g: { label: { de: string; en: string } }) => g.label.de !== g.label.en), `${pkg.file}: English labels`);
  }
});

test("meta never holds a setting's value; reference gaps without people's names", () => {
  const graph = parseGraph({
    nodes: [
      { id: "n_start01", type: "trigger.manual", label: "Start", config: {} },
      { id: "n_http001", type: "http.request", label: "Rufen", config: { method: "POST", url: "https://hooks.example.com/x", headers: [{ name: "Authorization", value: "Bearer dummy-token-000" }], body: "pw=dummy" } },
      { id: "n_mail001", type: "notify.person", label: "Melden", config: { to: ["11111111-1111-4111-8111-111111111111"], title: "Hallo", message: "Text" } },
    ],
    edges: [
      { id: "e_1", from: { node: "n_start01", port: "out" }, to: { node: "n_http001" } },
      { id: "e_2", from: { node: "n_http001", port: "error" }, to: { node: "n_mail001" } },
    ],
  });
  const data = {
    format: "flowplan.workflow" as const,
    version: 1,
    graph,
    references: {
      "11111111-1111-4111-8111-111111111111": { kind: "person" as const, title: "Erika Mustermann" },
      "22222222-2222-4222-8222-222222222222": { kind: "database" as const, title: "Aufgaben", fields: [{ id: "f_used", name: "Status", type: "select" }, { id: "f_unused", name: "Geheim", type: "text" }] },
    },
  };
  (graph.nodes[2].config as Record<string, unknown>).values = { f_used: "x" };
  const meta = workflowMeta(graph, referenceGaps(data, graph));
  const text = JSON.stringify(meta);
  for (const value of ["dummy-token-000", "pw=dummy", "hooks.example.com", "Hallo", "Erika", "Geheim", "Rufen"]) assert.ok(!text.includes(value), value);
  assert.deepEqual(Object.keys(meta.nodes), ["http.request", "notify.person", "trigger.manual"]);
  assert.deepEqual(meta.nodes["http.request"].ports?.error, { de: "Fehler", en: "Error" });
  assert.deepEqual(
    meta.gaps.map((g) => [g.id, g.kind, g.label.de]),
    [
      ["11111111-1111-4111-8111-111111111111", "person", "Person"],
      ["22222222-2222-4222-8222-222222222222", "database", "Datenbank „Aufgaben“"],
      ["f_used", "field", "Eigenschaft „Status“"],
    ],
  );
});
