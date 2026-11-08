// Shared setup of the workflow node tests (tests/workflows-*.test.ts): a
// workspace with an owner, an editor, a viewer and a guest, a database
// "Tickets", and helpers to build graphs, save and activate them and read
// runs. Import it after FLOWPLAN_DATA_DIR is set (the database opens on
// first use).
import assert from "node:assert/strict";
import type { Field, Identity } from "../../lib/types";

const { id, run, one, all } = await import("../../lib/db");
const { command, database, bootstrap } = await import("../../lib/api");
const { createWorkspace } = await import("../../lib/seed");
const { workflowGet } = await import("../../lib/workflows/commands");
const { withReadMemo } = await import("../../lib/read-memo");

export async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
export const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer"),
  guest = await user("guest");
export const wid = await createWorkspace(owner.id, "Flows");
const boot = await bootstrap(owner, wid);
export const space = boot.spaces[0].id as string;
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const act = async (body: Record<string, unknown>, who: Identity = owner): Promise<any> => await command(who, body);
export const get = async (path: string, who: Identity = owner) => {
  const url = new URL(`http://x/api/${path}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await withReadMemo(async () => await workflowGet(who, url.pathname.slice(5).split("/"), url))) as any;
};

export const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Doing", "Done"] },
  { id: "category", name: "Kategorie", type: "select", options: ["Bug", "Frage", "Wunsch"] },
  { id: "owner", name: "Owner", type: "person" },
  { id: "body", name: "Body", type: "text" },
  { id: "n", name: "Count", type: "number" },
  { id: "mail", name: "Mail", type: "email" },
];
export async function makeDatabase(title: string, f: Field[] = fields) {
  const dbId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title })).id as string;
  await act({ action: "database.update", pageId: dbId, version: (await database(dbId)).version, fields: f, views: (await database(dbId)).views });
  return dbId;
}
export const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);

let seq = 0;
export const nid = () => `n_w${String(++seq).padStart(6, "0")}`;
export type TestNode = { id: string; type: string; typeVersion: number; label: string; note: string; position: { x: number; y: number }; disabled: boolean; config: Record<string, unknown>; onError?: { retry: number; then: string } };
export const node = (type: string, config: Record<string, unknown>, label?: string, extra: Partial<TestNode> = {}): TestNode => ({
  id: nid(),
  type,
  typeVersion: 1,
  label: label || `${type.split(".").pop()} ${seq}`,
  note: "",
  position: { x: seq * 10, y: 0 },
  disabled: false,
  config,
  ...extra,
});
let edgeSeq = 0;
export const edge = (from: TestNode, to: TestNode, port = "out") => ({ id: `e_${++edgeSeq}`, from: { node: from.id, port }, to: { node: to.id, port: "in" } });
export const chain = (...nodes: TestNode[]) => ({ nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i], n)) });

export async function workflow(title: string, graph: Record<string, unknown>, who: Identity = owner, activate = true) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title }, who)).id as string;
  const saved = await act({ action: "workflow.draft", pageId, graph }, who);
  if (activate) {
    const result = await act({ action: "workflow.activate", pageId }, who);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  }
  return { pageId, issues: saved.issues as { code: string; level: string; nodeId?: string }[] };
}
export async function redraft(pageId: string, graph: Record<string, unknown>, who: Identity = owner) {
  await act({ action: "workflow.draft", pageId, graph }, who);
  const result = await act({ action: "workflow.activate", pageId }, who);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
}
export const runsOf = async (pageId: string) =>
  await all<{ id: string; status: string; error: string | null; mode: string; steps: number; error_kind: string | null }>("SELECT id,status,error,mode,steps,error_kind FROM workflow_runs WHERE page_id=? ORDER BY created_at,seq", pageId);
export const stepsOf = async (runId: string) =>
  await all<{ id: string; node_id: string; status: string; port: string | null; output: string | null; error: string | null; error_kind: string | null; attempt: number; iteration: string; due_at: number }>(
    "SELECT id,node_id,status,port,output,error,error_kind,attempt,iteration,due_at FROM workflow_steps WHERE run_id=? ORDER BY created_at,seq",
    runId,
  );
export const outputOf = async (runId: string, nodeId: string) => {
  const s = (await stepsOf(runId)).filter((x) => x.node_id === nodeId).at(-1);
  return s?.output ? JSON.parse(s.output) : null;
};
export async function manual(pageId: string, inputs: Record<string, unknown> = {}, who: Identity = owner) {
  return await act({ action: "workflow.run", pageId, inputs }, who);
}
export const opsNotices = async (userId: string) => await all<{ body: string; page_id: string }>("SELECT body,page_id FROM notifications WHERE user_id=? AND kind='workflow_ops' ORDER BY created_at,seq", userId);
