// Audit (Nov 2026), two small leaks: ai.rule on a private space's id told
// any member or guest the space's name (and aiRules kept naming spaces the
// person cannot open), and dashboard tiles and sources listed the
// definitions (names, choices) of properties hidden from the reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-rule-dashboard-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { aiRules } = await import("../lib/ai/access");
const { computeMetric, metricSources } = await import("../lib/dashboard-metric");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = await account("Olga"),
  member = await account("Max"),
  guest = await account("Gustav");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await api.command(as, input)) as Result;
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const secret = (await act({ action: "space.create", workspaceId: wid, name: "Übernahme Firma X", private: true })).id;
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const shared = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Geteilt", kind: "document" })).id;
await act({ action: "page.share", pageId: shared, email: guest.email, role: "viewer" });

test("ai.rule does not name a space the person cannot open", async () => {
  for (const who of [member, guest]) {
    let out: unknown;
    assert.equal(await status(async () => (out = await act({ action: "ai.rule", targetId: secret, mode: "exclude" }, who))), 404, JSON.stringify(out));
  }
  // A space they can open works as before.
  const rules = (await act({ action: "ai.rule", targetId: team, mode: "exclude" }, member)).rules as { title: string }[];
  assert.deepEqual(rules.map((r) => r.title), ["Team"]);
  // A rule stored while the person could open the space (or earlier, before
  // this check) does not name it once they cannot.
  await run("INSERT INTO ai_access_rules(user_id,target_id,kind,workspace_id,mode) VALUES(?,?,'space',?,'exclude')", member.id, secret, wid);
  assert.equal(JSON.stringify(await aiRules(member)).includes("Übernahme"), false);
  assert.equal(JSON.stringify(await aiRules(owner)).includes("Übernahme"), false);
});

test("dashboards show no definitions of properties hidden from the reader", async () => {
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Personal", kind: "database", databaseKind: "empty" })).id;
  const d = await api.database(db);
  await act({
    action: "database.update",
    pageId: db,
    version: d.version,
    views: d.views,
    fields: [
      d.fields[0],
      { id: "plan", name: "Kündigungsliste Q3", type: "select", options: ["Alice", "Bob"], access: { read: "owners" } },
      { id: "pay", name: "Abfindung", type: "number", access: { read: "owners" } },
    ],
  });
  await act({ action: "row.create", pageId: db, cells: { [d.fields[0].id]: "Alice", plan: "Alice", pay: 50000 } });
  const dash = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Dash", kind: "dashboard" }, member)).id;
  await act(
    {
      action: "dashboard.save",
      pageId: dash,
      tiles: [{ id: "t1", type: "chart", source: db, view: d.views[0].id, kind: "bar", aggregate: "count", xField: "plan", title: "x" }],
    },
    member,
  );
  const data = ((await api.pageData(member, dash)) as { dashboard: unknown }).dashboard;
  const text = JSON.stringify(data);
  for (const word of ["Kündigungsliste", "Abfindung", '"Bob"']) assert.equal(text.includes(word), false, word);
  assert.equal(JSON.stringify(await metricSources(member, wid)).includes("Abfindung"), false);
  const metric = await status(async () => await computeMetric(member, { source: db, view: "", aggregate: "sum", field: "pay" }));
  assert.equal(metric, 400);
  // The owner still sees everything.
  assert.match(JSON.stringify(((await api.pageData(owner, dash)) as { dashboard: unknown }).dashboard), /Kündigungsliste/);
  assert.equal((await computeMetric(owner, { source: db, view: "", aggregate: "sum", field: "pay" })).value, 50000);
});
